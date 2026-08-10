// ================================================================
// Amplr REST API — Supabase Edge Function
// Version: 1.0.0
// Auth: Bearer <api_key> (X-Amplr-Key header also accepted)
//
// Endpoints:
//   POST   /amplr-api/jobs          — create a post job
//   GET    /amplr-api/jobs          — list jobs (status filter, pagination)
//   GET    /amplr-api/jobs/:id      — get single job
//   DELETE /amplr-api/jobs/:id      — cancel/delete a job
//   GET    /amplr-api/groups        — list saved groups for user
//   POST   /amplr-api/keys/rotate   — rotate the calling API key
//   GET    /amplr-api/status        — health + extension heartbeat
// ================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SB_URL    = Deno.env.get('SUPABASE_URL')!;
const SB_SVC    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!; // bypasses RLS for key lookup
const RATE_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_DEFAULT = 30;  // requests per minute per key

// ── helpers ──────────────────────────────────────────────────────

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Amplr-Version': '1.0.0' },
  });

const err = (msg: string, status = 400, code?: string) =>
  json({ error: msg, code: code ?? 'BAD_REQUEST' }, status);

async function hashKey(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(raw)
  );
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `amplr_${b64}`;
}

// ── auth middleware ───────────────────────────────────────────────

interface AuthResult {
  userId: string;
  keyId: string;
  scopes: string[];
  supabase: ReturnType<typeof createClient>;
}

async function authenticate(req: Request): Promise<AuthResult | Response> {
  const rawKey =
    req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ||
    req.headers.get('X-Amplr-Key') ||
    new URL(req.url).searchParams.get('api_key');

  if (!rawKey) return err('Missing API key. Use Authorization: Bearer <key>', 401, 'UNAUTHORIZED');

  const hashed = await hashKey(rawKey);
  const svc = createClient(SB_URL, SB_SVC);

  const { data: key, error } = await svc
    .from('jsw_api_keys')
    .select('id, user_id, scopes, rate_limit, request_count, window_start, revoked_at')
    .eq('key_hash', hashed)
    .maybeSingle();

  if (error || !key) return err('Invalid API key', 401, 'UNAUTHORIZED');
  if (key.revoked_at) return err('API key has been revoked', 401, 'REVOKED');

  // ── rate limiting (sliding window, stored in DB) ──
  const now = Date.now();
  const windowStart = key.window_start ? new Date(key.window_start).getTime() : 0;
  const limit = key.rate_limit ?? RATE_LIMIT_DEFAULT;

  let newCount = key.request_count ?? 0;
  let newWindowStart = key.window_start;

  if (now - windowStart > RATE_WINDOW_MS) {
    newCount = 1;
    newWindowStart = new Date(now).toISOString();
  } else {
    newCount += 1;
  }

  if (newCount > limit) {
    const retryAfter = Math.ceil((RATE_WINDOW_MS - (now - windowStart)) / 1000);
    return new Response(
      JSON.stringify({ error: 'Rate limit exceeded', code: 'RATE_LIMITED', retry_after: retryAfter }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfter),
          'X-RateLimit-Limit': String(limit),
          'X-RateLimit-Remaining': '0',
        },
      }
    );
  }

  // Update counters (fire-and-forget — don't block the request)
  svc.from('jsw_api_keys').update({
    request_count: newCount,
    window_start: newWindowStart,
    last_used_at: new Date().toISOString(),
  }).eq('id', key.id).then(() => {});

  // Create a user-scoped client (RLS enforced)
  const { data: authData } = await svc.auth.admin.getUserById(key.user_id);
  const userToken = authData?.user ? await svc.auth.admin.generateLink({
    type: 'magiclink',
    email: authData.user.email!,
  }) : null;

  // For API calls we use the service key but filter by user_id manually — simpler + reliable
  return {
    userId: key.user_id,
    keyId: key.id,
    scopes: key.scopes ?? ['jobs:write', 'jobs:read', 'groups:read'],
    supabase: svc,
  };
}

function hasScope(auth: AuthResult, scope: string): boolean {
  return auth.scopes.includes(scope) || auth.scopes.includes('*');
}

// ── route handlers ────────────────────────────────────────────────

async function createJob(req: Request, auth: AuthResult): Promise<Response> {
  if (!hasScope(auth, 'jobs:write')) return err('Insufficient scope — requires jobs:write', 403, 'FORBIDDEN');

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return err('Invalid JSON body'); }

  const { message, groups, delay, image_url, ai_enabled, ai_prompt, webhook_url } = body as {
    message?: string;
    groups?: string[];
    delay?: number;
    image_url?: string;
    ai_enabled?: boolean;
    ai_prompt?: string;
    webhook_url?: string;
  };

  if (!message || typeof message !== 'string' || !message.trim())
    return err('`message` is required');
  if (!Array.isArray(groups) || groups.length === 0)
    return err('`groups` must be a non-empty array of Facebook group URLs');
  if (groups.length > 200)
    return err('Maximum 200 groups per job');
  if (delay !== undefined && (typeof delay !== 'number' || delay < 5 || delay > 3600))
    return err('`delay` must be between 5 and 3600 seconds');
  if (webhook_url && !/^https?:\/\/.+/.test(webhook_url as string))
    return err('`webhook_url` must be a valid HTTPS URL');

  const { data, error } = await auth.supabase
    .from('jsw_post_jobs')
    .insert({
      user_id:     auth.userId,
      message:     message.trim(),
      groups:      groups,
      delay:       delay ?? 30,
      image_url:   image_url ?? null,
      ai_enabled:  ai_enabled ?? false,
      ai_prompt:   ai_prompt ?? null,
      webhook_url: webhook_url ?? null,
      status:      'pending',
    })
    .select()
    .single();

  if (error) {
    console.error('createJob error:', error);
    return err('Failed to create job', 500, 'SERVER_ERROR');
  }

  return json({ job: data }, 201);
}

async function listJobs(req: Request, auth: AuthResult): Promise<Response> {
  if (!hasScope(auth, 'jobs:read')) return err('Insufficient scope — requires jobs:read', 403, 'FORBIDDEN');

  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  const limit  = Math.min(Number(url.searchParams.get('limit') ?? 20), 100);
  const offset = Number(url.searchParams.get('offset') ?? 0);

  let q = auth.supabase
    .from('jsw_post_jobs')
    .select('*', { count: 'exact' })
    .eq('user_id', auth.userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) q = q.eq('status', status);

  const { data, error, count } = await q;
  if (error) return err('Failed to list jobs', 500, 'SERVER_ERROR');

  return json({ jobs: data, total: count, limit, offset });
}

async function getJob(jobId: string, auth: AuthResult): Promise<Response> {
  if (!hasScope(auth, 'jobs:read')) return err('Insufficient scope — requires jobs:read', 403, 'FORBIDDEN');

  const { data, error } = await auth.supabase
    .from('jsw_post_jobs')
    .select('*')
    .eq('id', jobId)
    .eq('user_id', auth.userId)
    .maybeSingle();

  if (error) return err('Failed to fetch job', 500, 'SERVER_ERROR');
  if (!data) return err('Job not found', 404, 'NOT_FOUND');

  return json({ job: data });
}

async function deleteJob(jobId: string, auth: AuthResult): Promise<Response> {
  if (!hasScope(auth, 'jobs:write')) return err('Insufficient scope — requires jobs:write', 403, 'FORBIDDEN');

  // Only allow cancelling pending jobs
  const { data: job } = await auth.supabase
    .from('jsw_post_jobs')
    .select('id, status')
    .eq('id', jobId)
    .eq('user_id', auth.userId)
    .maybeSingle();

  if (!job) return err('Job not found', 404, 'NOT_FOUND');
  if (job.status === 'processing') return err('Cannot cancel a job that is currently processing', 409, 'CONFLICT');

  const { error } = await auth.supabase
    .from('jsw_post_jobs')
    .update({ status: 'cancelled' })
    .eq('id', jobId)
    .eq('user_id', auth.userId);

  if (error) return err('Failed to cancel job', 500, 'SERVER_ERROR');

  return json({ cancelled: true, id: jobId });
}

async function listGroups(req: Request, auth: AuthResult): Promise<Response> {
  if (!hasScope(auth, 'groups:read')) return err('Insufficient scope — requires groups:read', 403, 'FORBIDDEN');

  const url = new URL(req.url);
  const limit  = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
  const offset = Number(url.searchParams.get('offset') ?? 0);
  const identityKey = url.searchParams.get('identity_key');

  let query = auth.supabase
    .from('jsw_groups')
    .select('*', { count: 'exact' })
    .eq('user_id', auth.userId);

  if (identityKey) query = query.eq('identity_key', identityKey);

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return err('Failed to list groups', 500, 'SERVER_ERROR');

  return json({ groups: data, total: count, limit, offset });
}

async function rotateKey(auth: AuthResult): Promise<Response> {
  const newRaw = generateApiKey();
  const newHash = await hashKey(newRaw);

  const { error } = await auth.supabase
    .from('jsw_api_keys')
    .update({
      key_hash:     newHash,
      rotated_at:   new Date().toISOString(),
      request_count: 0,
      window_start:  null,
      last_used_at:  null,
    })
    .eq('id', auth.keyId);

  if (error) return err('Failed to rotate key', 500, 'SERVER_ERROR');

  return json({
    api_key: newRaw,
    message: 'Store this key now — it will not be shown again.',
  });
}

async function getStatus(auth: AuthResult): Promise<Response> {
  const { data: settings } = await auth.supabase
    .from('jsw_settings')
    .select('ext_heartbeat')
    .eq('user_id', auth.userId)
    .maybeSingle();

  const heartbeat = settings?.ext_heartbeat;
  const extensionOnline = heartbeat
    ? Date.now() - new Date(heartbeat).getTime() < 90_000 // 90s threshold
    : false;

  const { count: pendingCount } = await auth.supabase
    .from('jsw_post_jobs')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', auth.userId)
    .eq('status', 'pending');

  return json({
    ok: true,
    extension_online: extensionOnline,
    extension_last_seen: heartbeat ?? null,
    pending_jobs: pendingCount ?? 0,
    api_version: '1.0.0',
  });
}

// ── router ────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, X-Amplr-Key, Content-Type',
        'Access-Control-Max-Age':       '86400',
      },
    });
  }

  const url  = new URL(req.url);
  const path = url.pathname.replace(/^\/amplr-api/, '').replace(/\/$/, '');
  const method = req.method.toUpperCase();

  // Authenticate every request
  const authResult = await authenticate(req);
  if (authResult instanceof Response) return authResult;

  try {
    // POST /jobs
    if (method === 'POST' && path === '/jobs')
      return await createJob(req, authResult);

    // GET /jobs
    if (method === 'GET' && path === '/jobs')
      return await listJobs(req, authResult);

    // GET /jobs/:id
    const jobMatch = path.match(/^\/jobs\/([^/]+)$/);
    if (jobMatch) {
      const jobId = jobMatch[1];
      if (method === 'GET')    return await getJob(jobId, authResult);
      if (method === 'DELETE') return await deleteJob(jobId, authResult);
    }

    // GET /groups
    if (method === 'GET' && path === '/groups')
      return await listGroups(req, authResult);

    // POST /keys/rotate
    if (method === 'POST' && path === '/keys/rotate')
      return await rotateKey(authResult);

    // GET /status
    if (method === 'GET' && path === '/status')
      return await getStatus(authResult);

    return err('Not found', 404, 'NOT_FOUND');
  } catch (e) {
    console.error('Unhandled error:', e);
    return err('Internal server error', 500, 'SERVER_ERROR');
  }
});
