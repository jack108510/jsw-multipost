// ============ Amplr Background Worker v2.1.3 ============
// Orchestrates posting queue, AI refinement, and scheduled posts via chrome.alarms.

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const EXT_VERSION = chrome.runtime.getManifest?.().version || 'unknown';
const CONNECTION_STATUS_KEY = 'extension_status';
const DAILY_GROUP_SCAN_ALARM = 'daily-group-scan';
const DAILY_GROUP_SCAN_HOUR_LOCAL = 7;
const DAILY_GROUP_SCAN_MINUTE_LOCAL = 15;

// Software-level anti-bot safety controls. These reduce automated-looking
// posting patterns and stop when Facebook shows block/checkpoint signals.
// They are safeguards, not stealth/captcha-bypass logic.
const ANTI_BOT = {
  maxGroupsPerJob: 8,
  hardCooldownDays: 2,
  minDelaySeconds: 90,
  maxDelaySeconds: 210,
  scheduleJitterMinutes: 75,
  skipBanRisk: new Set(['medium', 'high']),
  dailyUserPostCap: 24
};

function randInt(min, max) {
  min = Math.ceil(min); max = Math.floor(max);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomAntiBotDelaySeconds(requestedFloor = 0) {
  const floor = Math.max(Number(requestedFloor) || 0, ANTI_BOT.minDelaySeconds);
  const ceiling = Math.max(floor, ANTI_BOT.maxDelaySeconds);
  return randInt(floor, ceiling);
}

// ============ HANDLE MESSAGES FROM POPUP ============
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_POSTING') {
    runPostingQueue(msg, sender);
  } else if (msg.type === 'IMPORT_GROUPS') {
    importFacebookGroups(msg.identity || msg.identityMeta || null);
  }
});

// ============ POSTING QUEUE ============
async function runPostingQueue(_payload, sender) {
  // Legacy popup posting is disabled because it has no identity contract.
  // Real posting must flow through dashboard jobs, where every group target carries
  // identity_name / identity_key / identity_url and the content script verifies the
  // composer actor before clicking Post.
  sendProgress({
    text: 'Posting disabled here — use the dashboard queue so Amplr can switch and verify the selected Facebook identity first.',
    progress: '100',
    done: true,
    success: false,
    error_code: 'posting_disabled_identity_verified_queue_required'
  }, sender);
  notify('Posting disabled here — use the dashboard queue with a selected Facebook identity.');
  return;
}

function sendProgress(data) {
  chrome.runtime.sendMessage({ type: 'POST_PROGRESS', ...data }).catch(() => {});
}

function notify(message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Amplr',
    message
  });
}

// ============ AI API (duplicated from popup for background use) ============
async function callAI(userMessage, settings, variationIndex = 0) {
  const { aiProvider, apiKey, aiModel, aiPrompt, aiTemp } = settings;

  // Ollama (local, free) — default provider
  if (aiProvider === 'ollama' || (!aiProvider && !apiKey)) {
    return callOllama(
      aiModel || 'qwen3:8b',
      aiPrompt || null,
      userMessage,
      variationIndex,
      aiTemp || 0.85
    );
  }

  let systemContent = aiPrompt || 'Rewrite this into an engaging Facebook group post. Keep the same message but vary the hook, structure, and wording. Sound natural and human. Output ONLY the rewritten post, nothing else.';
  if (variationIndex > 0) {
    systemContent += ` This is variation #${variationIndex + 1}. Make it noticeably different from previous versions.`;
  }

  const messages = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userMessage }
  ];

  if (aiProvider === 'anthropic') {
    return callAnthropic(apiKey, aiModel || 'claude-3-5-sonnet-20241022', messages, aiTemp || 0.7);
  } else if (aiProvider === 'gemini') {
    return callGemini(apiKey, aiModel || 'gemini-1.5-flash', messages, aiTemp || 0.7);
  } else if (aiProvider === 'openrouter') {
    return callOpenRouter(apiKey, aiModel || 'openai/gpt-4o-mini', messages, aiTemp || 0.7);
  } else {
    return callOpenAI(apiKey, aiModel || 'gpt-4o-mini', messages, aiTemp || 0.7);
  }
}

async function callOllama(model, customPrompt, userMessage, variationIndex, temp) {
  const system = customPrompt ||
    'Act like a QuillBot-style paraphraser for Facebook group posts. Preserve the original meaning, offer, facts, tone level, links, and call to action. Rewrite the wording and sentence structure naturally without adding new claims, hype, emojis, hashtags, or extra details. Do not make it more salesy. Output ONLY the paraphrased post text, nothing else.';
  const user = `Paraphrase this Facebook post (variant #${variationIndex + 1}) like QuillBot would: keep the same meaning and links, but change phrasing, sentence order where natural, and word choice. Do not expand the message or invent benefits.\n\nOriginal:\n${userMessage}`;

  const res = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      options: { temperature: temp },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data = await res.json();
  const raw = data.message?.content || '';
  // Strip <think>...</think> blocks that qwen3 sometimes outputs
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

async function callOpenAI(key, model, messages, temp) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model, messages, temperature: temp, max_tokens: 500 })
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

async function callAnthropic(key, model, messages, temp) {
  const systemMsg = messages.find(m => m.role === 'system')?.content || '';
  const userMsgs = messages.filter(m => m.role !== 'system');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model, max_tokens: 500, temperature: temp,
      system: systemMsg,
      messages: userMsgs.map(m => ({ role: m.role, content: m.content }))
    })
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}`);
  const data = await res.json();
  return data.content[0].text.trim();
}

async function callGemini(key, model, messages, temp) {
  const systemMsg = messages.find(m => m.role === 'system')?.content || '';
  const contents = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      systemInstruction: { parts: [{ text: systemMsg }] },
      generationConfig: { temperature: temp, maxOutputTokens: 500 }
    })
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const data = await res.json();
  return data.candidates[0].content.parts[0].text.trim();
}

async function callOpenRouter(key, model, messages, temp) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model, messages, temperature: temp, max_tokens: 500 })
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

// ============================================================
// DASHBOARD PAIRING — SUPABASE POLLING (v2.1, secondary channel)
// ============================================================
const SB_URL = 'https://xacehhtgvubcqdoltazg.supabase.co';
const SB_ANON_KEY = 'sb_publishable_1TNu5hqotJ7GGQXfjliivQ_ttK51EAA';
let dashSession = null;

async function getStoredSession() {
  const data = await chrome.storage.local.get(['jsw_session']);
  let session = data.jsw_session;
  if (!session || !session.userId) return null;

  // Supabase access tokens expire. If we keep using the old token, the
  // dashboard heartbeat silently stops and Amplr looks "unpaired" again.
  const expiresMs = session.expiresAt ? Number(session.expiresAt) * 1000 : 0;
  const shouldRefresh = session.refreshToken && (!expiresMs || expiresMs - Date.now() < 120000);
  if (!shouldRefresh) {
    dashSession = session;
    return session;
  }

  try {
    const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'apikey': SB_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refreshToken })
    });
    const refreshed = await res.json();
    if (!res.ok || !refreshed.access_token) throw new Error(refreshed.error_description || refreshed.msg || 'Refresh failed');

    session = {
      ...session,
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token || session.refreshToken,
      expiresAt: refreshed.expires_at || Math.floor(Date.now() / 1000) + (refreshed.expires_in || 3600),
    };
    await chrome.storage.local.set({ jsw_session: session });
    dashSession = session;
    return session;
  } catch (e) {
    console.warn('[JSW] Supabase session refresh failed:', e.message);
    // If the token is already expired and refresh failed, continuing with the
    // stale access token only makes heartbeat/job calls fail silently. Clear the
    // paired session so the popup shows login instead of a fake connected state.
    if (expiresMs && expiresMs <= Date.now()) {
      await writeExtensionStatus(session, 'offline', { error: 'Supabase session expired and refresh failed' });
      await chrome.storage.local.remove(['jsw_session']);
      dashSession = null;
      return null;
    }
    dashSession = session;
    return session;
  }
}

// ─── Remote logging ───
async function extLog(level, message) {
  const text = typeof message === 'string' ? message : JSON.stringify(message);
  const prefix = `[${level.toUpperCase()}] ${text}`;
  if (level === 'error') console.error('[JSW]', prefix);
  else console.log('[JSW]', prefix);

  if (!dashSession || !dashSession.userId || !dashSession.accessToken) return;
  try {
    await fetch(`${SB_URL}/rest/v1/jsw_ext_logs`, {
      method: 'POST',
      headers: {
        'apikey': SB_ANON_KEY,
        'Authorization': `Bearer ${dashSession.accessToken}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ user_id: dashSession.userId, level, message: text })
    });
  } catch (e) { /* silent — don't recurse */ }
}

// Listen for login/logout from popup
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'PAIRING_CONNECTED') {
    dashSession = msg.pairing;
    startDashPolling().catch(e => console.warn('[JSW] start polling failed:', e.message));
    writeHeartbeat();
    extLog('info', `Session connected, polling started for ${dashSession.userId} on v${EXT_VERSION}`);
  } else if (msg.type === 'PAIRING_DISCONNECTED') {
    const previousSession = dashSession;
    stopDashPolling();
    dashSession = null;
    if (previousSession?.userId) writeExtensionStatus(previousSession, 'offline', { disconnected_at: new Date().toISOString() });
    extLog('info', 'Session disconnected');
  }
});

// On startup, resume polling if already logged in
chrome.runtime.onStartup.addListener(loadSessionAndResume);
chrome.runtime.onInstalled.addListener(loadSessionAndResume);
// MV3 service workers restart without firing onStartup/onInstalled — call on load too
loadSessionAndResume();

async function loadSessionAndResume() {
  const session = await getStoredSession();
  if (session && session.userId) {
    dashSession = session;
    await startDashPolling();
    extLog('info', `Resumed polling for user ${dashSession.userId} on v${EXT_VERSION}`);
  } else {
    extLog('warn', `No valid stored session on startup for v${EXT_VERSION}`);
  }
}

async function startDashPolling() {
  if (!dashSession?.userId) return;

  // Reset alarms before creating them so repeated popup opens do not leave stale schedules.
  await chrome.alarms.clear('poll-jobs');
  await chrome.alarms.clear('amplr_heartbeat');
  await chrome.alarms.clear('check-post-results');
  await chrome.alarms.clear(DAILY_GROUP_SCAN_ALARM);

  // Write first so the dashboard flips online immediately after reload/sign-in.
  try { await writeHeartbeat(); } catch (e) { console.warn('[JSW] heartbeat write failed during startup:', e.message); }

  // Poll immediately, then via alarms (MV3 service workers can sleep between events).
  pollPendingJobs();
  pollGroupLookups();
  await chrome.alarms.create('poll-jobs', { periodInMinutes: 0.5 }); // every 30s
  await chrome.alarms.create('amplr_heartbeat', { periodInMinutes: 0.5 }); // every 30s
  await chrome.alarms.create('check-post-results', { periodInMinutes: 360 }); // every 6h
  await scheduleDailyGroupScanAlarm();
}

function nextDailyGroupScanTime() {
  const next = new Date();
  next.setHours(DAILY_GROUP_SCAN_HOUR_LOCAL, DAILY_GROUP_SCAN_MINUTE_LOCAL, 0, 0);
  if (next.getTime() <= Date.now() + 60 * 1000) next.setDate(next.getDate() + 1);
  return next;
}

async function scheduleDailyGroupScanAlarm() {
  const when = nextDailyGroupScanTime();
  await chrome.alarms.create(DAILY_GROUP_SCAN_ALARM, { when: when.getTime(), periodInMinutes: 24 * 60 });
  extLog('info', `Daily group scan scheduled for ${when.toLocaleString()}`);
}

async function stopDashPolling() {
  await chrome.alarms.clear('poll-jobs');
  await chrome.alarms.clear('amplr_heartbeat');
  await chrome.alarms.clear('check-post-results');
  await chrome.alarms.clear(DAILY_GROUP_SCAN_ALARM);
}

// Heartbeat and poll-jobs alarm handler
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'amplr_heartbeat') writeHeartbeat();
  else if (alarm.name === 'poll-jobs') { pollPendingJobs(); pollGroupLookups(); }
  else if (alarm.name === 'check-post-results') { checkPostResults(); }
  else if (alarm.name === DAILY_GROUP_SCAN_ALARM) { enqueueDailyGroupScan(); }
});

// ─── Group name lookup ───
async function pollGroupLookups() {
  const session = await getStoredSession();
  if (!session || !session.userId) return;
  if (!dashSession) dashSession = session;

  try {
    const url = `${SB_URL}/rest/v1/jsw_group_lookups?user_id=eq.${encodeURIComponent(session.userId)}&status=eq.pending&order=created_at.asc&limit=1`;
    const res = await fetch(url, {
      headers: {
        'apikey': SB_ANON_KEY,
        'Authorization': `Bearer ${session.accessToken}`
      }
    });

    if (!res.ok) return;
    const lookups = await res.json();
    if (!lookups || !lookups.length) return;

    const lookup = lookups[0];
    extLog('info', 'Processing group name lookup: ' + lookup.group_url);

    // Claim it
    const claimed = await sbUpdateLookup(lookup.id, { status: 'processing' });
    if (!claimed) {
      extLog('warn', 'Could not claim lookup (already claimed?)');
      return;
    }

    // Open the group page and grab the title
    const groupName = await fetchGroupNameFromFB(lookup.group_url);

    await sbUpdateLookup(lookup.id, {
      status: 'done',
      group_name: groupName || null,
      resolved_at: new Date().toISOString()
    });
    extLog('info', 'Group name resolved: ' + lookup.group_url + ' → ' + (groupName || 'FAILED'));
  } catch (e) {
    extLog('error', 'Group lookup error: ' + e.message);
  }
}

async function fetchGroupNameFromFB(groupUrl) {
  try {
    extLog('info', 'Opening FB group page: ' + groupUrl);
    const tab = await chrome.tabs.create({ url: groupUrl, active: false });
    await new Promise(r => setTimeout(r, 5000)); // wait for page load

    const [{ result: title }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // FB group pages have the name in the title or h1
        const og = document.querySelector('meta[property="og:title"]')?.content;
        if (og) return og.replace(/\s*\|\s*Facebook\s*$/i, '').trim();
        const h1 = document.querySelector('h1')?.textContent;
        if (h1) return h1.trim();
        return document.title.replace(/\s*\|\s*Facebook\s*$/i, '').trim();
      }
    });

    await chrome.tabs.remove(tab.id);
    extLog('info', 'Scraped group name: ' + (title || 'NONE'));
    return title || null;
  } catch (e) {
    extLog('error', 'Failed to fetch group name: ' + e.message);
    return null;
  }
}

async function sbUpdateLookup(lookupId, patch) {
  try {
    const session = await getStoredSession();
    if (!session) return false;
    const res = await fetch(`${SB_URL}/rest/v1/jsw_group_lookups?id=eq.${lookupId}`, {
      method: 'PATCH',
      headers: {
        'apikey': SB_ANON_KEY,
        'Authorization': `Bearer ${session.accessToken}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(patch)
    });
    return res.ok;
  } catch (e) {
    console.warn('[JSW] sbUpdateLookup error:', e.message);
    return false;
  }
}

// Write heartbeat so the dashboard knows the extension is running
async function writeHeartbeat() {
  try {
    // Read/refresh from storage every time — survives service worker restarts
    const session = await getStoredSession();
    if (!session || !session.userId) return;

    const heartbeatAt = new Date().toISOString();
    const res = await fetch(`${SB_URL}/rest/v1/jsw_settings?on_conflict=user_id`, {
      method: 'POST',
      headers: {
        'apikey': SB_ANON_KEY,
        'Authorization': `Bearer ${session.accessToken}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({ user_id: session.userId, ext_heartbeat: heartbeatAt })
    });
    if (!res.ok) console.warn('[JSW] heartbeat failed:', res.status, await res.text());
    await writeExtensionStatus(session, 'online', { last_seen: heartbeatAt });
  } catch (e) {
    console.warn('[JSW] heartbeat error:', e.message);
    if (dashSession?.userId) {
      writeExtensionStatus(dashSession, 'degraded', { error: e.message }).catch(() => {});
    }
  }
}

async function writeExtensionStatus(session, status = 'online', extra = {}) {
  if (!session?.userId || !session?.accessToken) return false;
  try {
    await upsertAmplrData(session, CONNECTION_STATUS_KEY, {
      status,
      version: EXT_VERSION,
      user_id: session.userId,
      email: session.email || null,
      last_seen: new Date().toISOString(),
      poll_interval_seconds: 30,
      service_worker: 'active',
      ...extra
    });
    return true;
  } catch (e) {
    console.warn('[JSW] extension status write failed:', e.message);
    return false;
  }
}

function broadcastDashStatus(text, color) {
  chrome.runtime.sendMessage({ type: 'DASH_JOB_STATUS', text, color }).catch(() => {});
}

function isFacebookDefenseError(value) {
  const text = String(value || '').toLowerCase();
  return /checkpoint|confirm your identity|temporarily blocked|action blocked|try again later|we limit how often|unusual activity|security check|account restricted/.test(text);
}

function skippedResult(target, reason, warning, extra = {}) {
  return {
    group_url: target.url,
    group_name: target.name || target.group_name || null,
    identity_name: target.identity_name || null,
    identity_key: target.identity_key || null,
    status: 'skipped',
    skip_reason: reason,
    warnings: warning ? [warning] : [],
    skipped_at: new Date().toISOString(),
    ...extra
  };
}

async function countRecentPostedResults(session, sinceIso) {
  try {
    const res = await fetch(`${SB_URL}/rest/v1/jsw_post_results?user_id=eq.${encodeURIComponent(session.userId)}&posted_at=gte.${encodeURIComponent(sinceIso)}&select=id`, {
      headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}` }
    });
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) ? rows.length : null;
  } catch (e) {
    extLog('warn', 'recent post cap check failed: ' + e.message);
    return null;
  }
}

// Fetch pending jobs for this paired user via REST API
async function pollPendingJobs() {
  const session = await getStoredSession();
  if (!session || !session.userId) return;

  try {
    const now = new Date().toISOString();
    // Pick up: (a) immediate pending jobs with no scheduled_for, OR
    //          (b) scheduled jobs whose time has arrived
    const url = `${SB_URL}/rest/v1/jsw_post_jobs?user_id=eq.${encodeURIComponent(session.userId)}&status=eq.pending&order=created_at.asc&limit=1&select=*` +
      `&or=(scheduled_for.is.null,scheduled_for.lte.${encodeURIComponent(now)})`;
    const res = await fetch(url, {
      headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}` }
    });

    if (!res.ok) { extLog('warn', 'Job poll failed: ' + res.status); return; }

    const jobs = await res.json();
    if (jobs && jobs.length > 0) {
      const job = jobs[0];
      extLog('info', 'Found pending job: ' + job.id);
      if (!dashSession) dashSession = session;
      await executeDashJob(job);

      // If this is a repeating job, re-queue it for next occurrence
      if (job.repeat_days?.length && job.repeat_time) {
        await requeueRepeatingJob(job, session);
      }
    }
  } catch (e) {
    extLog('error', 'Dash poll error: ' + e.message);
  }
}

// Re-queue a repeating job for its next scheduled occurrence
async function requeueRepeatingJob(job, session) {
  try {
    const days = job.repeat_days;
    if (!days || !days.length) return; // guard: no days = no requeue
    const [hours, minutes] = job.repeat_time.split(':').map(Number);
    const now = new Date();
    let next = new Date(now);
    next.setSeconds(0, 0);
    next.setHours(hours, minutes);
    // Always advance at least one day, then find next matching weekday
    for (let i = 0; i < 8; i++) {
      next.setDate(next.getDate() + 1);
      if (days.includes(next.getDay())) break;
    }
    // Add forward-only jitter after the base repeat day is selected so
    // recurring schedules do not fire at the exact same minute every run.
    next.setMinutes(next.getMinutes() + randInt(0, ANTI_BOT.scheduleJitterMinutes));
    await fetch(`${SB_URL}/rest/v1/jsw_post_jobs`, {
      method: 'POST',
      headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        user_id: session.userId,
        message: job.message,
        image_url: job.image_url || null,
        groups: job.groups,
        delay: Math.max(job.delay || 30, ANTI_BOT.minDelaySeconds),
        ai_enabled: job.ai_enabled,
        ai_prompt: job.ai_prompt || null,
        first_comment: job.first_comment || null,
        status: 'pending',
        scheduled_for: next.toISOString(),
        repeat_days: job.repeat_days,
        repeat_time: job.repeat_time,
      })
    });
    extLog('info', `Re-queued repeating job for ${next.toISOString()}`);
  } catch (e) {
    extLog('warn', 'requeueRepeatingJob error: ' + e.message);
  }
}

async function getPostingIdentityByNameOrKey(name, key) {
  try {
    const session = await getStoredSession();
    if (!session || !session.userId) return null;
    const identities = await getStoredPostingIdentities(session);
    const norm = v => String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();
    const wantedName = norm(name);
    const wantedKey = norm(key);
    if (wantedKey === '__load_all__') return { __all: identities };
    return identities.find(i =>
      (wantedName && norm(i.name) === wantedName) ||
      (wantedKey && [i.id, i.url, i.name].some(v => norm(v) === wantedKey))
    ) || null;
  } catch (e) {
    extLog('warn', 'getPostingIdentityByNameOrKey error: ' + e.message);
    return null;
  }
}

async function getStoredPostingIdentities(session = null) {
  session = session || await getStoredSession();
  if (!session || !session.userId) return [];
  const res = await fetch(`${SB_URL}/rest/v1/amplr_data?user_id=eq.${session.userId}&key=eq.posting_identities&select=value`, {
    headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}` }
  });
  if (!res.ok) return [];
  const rows = await res.json();
  const value = rows?.[0]?.value;
  return Array.isArray(value) ? value : (value?.identities || []);
}

async function enrichFacebookIdentityTarget(target = {}) {
  const identityName = target.identity_name || target.identityName || target.profile_name || target.profileName || target.page_name || target.pageName || target.name || null;
  const identityKey = target.identity_key || target.identityKey || target.profile_key || target.profileKey || target.page_key || target.pageKey || target.key || identityName || null;
  const stored = identityName || identityKey ? await getPostingIdentityByNameOrKey(identityName, identityKey) : null;
  const explicitIdentityUrl = target.identity_url || target.identityUrl || target.profile_url || target.profileUrl || target.page_url || target.pageUrl || null;
  const genericUrl = target.url && /^https:\/\/(www\.)?facebook\.com\/profile\.php\?id=\d+/i.test(String(target.url)) ? target.url : null;
  const identityUrl = explicitIdentityUrl || genericUrl || stored?.url || null;
  const identityType = target.identity_type || target.identityType || target.profile_type || target.profileType || target.page_type || target.pageType || target.type || stored?.type || (facebookPageIdFromUrl(identityUrl) ? 'page' : 'facebook identity');
  const resolvedName = identityName || stored?.name || null;
  const resolvedKey = identityKey || stored?.id || stored?.url || resolvedName || null;
  return {
    ...target,
    identity_name: resolvedName,
    identity_key: resolvedKey,
    identity_type: identityType,
    identity_url: identityUrl
  };
}

function normalizeImportTarget(target) {
  if (!target || typeof target !== 'object') return null;
  const identityName = target.identity_name || target.profile_name || target.page_name || target.name || null;
  const identityKey = target.identity_key || target.profile_key || target.page_key || target.key || identityName || null;
  const identityUrl = target.identity_url || target.url || target.profile_url || target.page_url || null;
  const identityType = target.identity_type || target.type || (target.page_name ? 'Facebook Page' : 'Facebook profile');
  if (!identityName && !identityUrl) return null;
  return { name: identityName, key: identityKey, type: identityType, url: identityUrl };
}

async function getImportTargetsForJob(job, session = null) {
  const rawTargets = Array.isArray(job.groups) ? job.groups : [];
  let targets = rawTargets.map(normalizeImportTarget).filter(Boolean);
  if (job.ai_prompt && !targets.length) targets = [{ name: job.ai_prompt, key: job.ai_prompt, type: null, url: null }];
  if (!targets.length) targets = (await getStoredPostingIdentities(session)).map(identity => normalizeImportTarget({
    identity_name: identity.name,
    identity_key: identity.id || identity.url || identity.name,
    identity_type: identity.type,
    identity_url: identity.url
  })).filter(Boolean);
  const seen = new Set();
  return targets.filter(target => {
    const dedupeKey = String(target.key || target.name || target.url || '').trim().toLowerCase();
    if (!dedupeKey || seen.has(dedupeKey)) return false;
    seen.add(dedupeKey);
    return true;
  });
}

async function getExistingGroupUrlsByIdentity(session, identityKeys = []) {
  const validKeys = identityKeys.map(key => String(key || '').trim()).filter(Boolean);
  const out = new Map();
  for (const key of validKeys) out.set(key, new Set());
  if (!session?.userId || !validKeys.length) return out;
  for (const normalizedKey of validKeys) {
    const res = await fetch(`${SB_URL}/rest/v1/jsw_groups?user_id=eq.${encodeURIComponent(session.userId)}&identity_key=eq.${encodeURIComponent(normalizedKey)}&select=group_url`, {
      headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}` }
    });
    if (!res.ok) continue;
    const rows = await res.json();
    out.set(normalizedKey, new Set((rows || []).map(r => r.group_url).filter(Boolean)));
  }
  return out;
}

async function deleteGroupsForIdentity(session, identityKey) {
  if (!session?.userId || !identityKey) return false;
  const res = await fetch(`${SB_URL}/rest/v1/jsw_groups?user_id=eq.${encodeURIComponent(session.userId)}&identity_key=eq.${encodeURIComponent(identityKey)}`, {
    method: 'DELETE',
    headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}`, 'Prefer': 'return=minimal' }
  });
  if (!res.ok) throw new Error(`Could not remove unverified groups for ${identityKey}: ${await res.text()}`);
  return true;
}

async function getKnownAccountLevelGroupSets(session) {
  const sets = [];
  if (!session?.userId) return sets;
  const res = await fetch(`${SB_URL}/rest/v1/jsw_groups?user_id=eq.${encodeURIComponent(session.userId)}&select=identity_name,identity_key,identity_type,group_url`, {
    headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}` }
  });
  if (!res.ok) return sets;
  const rows = await res.json();
  const byIdentity = new Map();
  (rows || []).forEach(row => {
    if (isPageIdentityType(row.identity_type)) return;
    const key = row.identity_key || row.identity_name || '__account__';
    if (!byIdentity.has(key)) byIdentity.set(key, new Set());
    if (row.group_url) byIdentity.get(key).add(row.group_url);
  });
  for (const [identityKey, urls] of byIdentity.entries()) {
    if (urls.size) sets.push({ identityKey, urls, signature: [...urls].sort().join('\n') });
  }
  return sets;
}

async function assessAccountLevelGroupOverlap(session, identityName, identityType, groups = []) {
  if (!isPageIdentityType(identityType)) return null;
  const pageUrls = new Set((groups || []).map(g => g?.url || g?.group_url).filter(Boolean));
  if (!pageUrls.size) return null;
  const accountSets = await getKnownAccountLevelGroupSets(session);
  let worst = null;
  for (const account of accountSets) {
    const overlap = [...pageUrls].filter(url => account.urls.has(url)).length;
    const coverage = overlap / pageUrls.size;
    const assessment = {
      type: 'account_level_overlap',
      identity_name: identityName,
      account_identity_key: account.identityKey,
      overlap,
      scanned_count: pageUrls.size,
      account_count: account.urls.size,
      coverage,
      high_overlap: overlap >= 5 && coverage >= 0.8
    };
    if (!worst || assessment.coverage > worst.coverage) worst = assessment;
  }
  return worst;
}

async function getKnownAccountLevelGroupSignatures(session) {
  const sets = await getKnownAccountLevelGroupSets(session);
  return new Set(sets.map(item => item.signature).filter(Boolean));
}

function groupUrlSignature(groups = []) {
  return [...new Set((groups || []).map(g => g?.url || g?.group_url).filter(Boolean))].sort().join('\n');
}

function isPageIdentityType(type) {
  return /^page|facebook page|business/i.test(String(type || ''));
}

function friendlyGroupScanMissReason(error) {
  const message = String(error?.message || error || '');
  if (/active Facebook identity|same account-level groups|not verified/i.test(message)) {
    return 'Facebook returned an account-level groups page instead of a verified profile/page-specific list.';
  }
  if (/message channel closed|receiving end does not exist|Extension context invalidated|Could not establish connection/i.test(message)) {
    return 'Facebook did not return a group list for this profile/page during this pass.';
  }
  if (/No groups found/i.test(message)) return 'No joined groups were visible for this profile/page.';
  if (/not signed in|logged into Facebook/i.test(message)) return 'Facebook session was not available for this profile/page.';
  return 'No group list was available for this profile/page during this pass.';
}

async function runImportGroupsJob(job, session) {
  const targets = await getImportTargetsForJob(job, session);
  if (!targets.length) throw new Error('No synced Facebook profiles/pages found. Sync profiles first.');
  const beforeByIdentity = await getExistingGroupUrlsByIdentity(session, targets.map(t => t.key || t.name).filter(Boolean));
  const perIdentity = [];
  const errors = [];
  const scanSignatures = [];
  let accountLevelGroupSignature = null;
  const knownAccountLevelGroupSignatures = await getKnownAccountLevelGroupSignatures(session);

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const storedIdentity = await getPostingIdentityByNameOrKey(target.name, target.key);
    const mergedTarget = {
      name: target.name || storedIdentity?.name || null,
      key: target.key || storedIdentity?.id || storedIdentity?.url || storedIdentity?.name || target.name || null,
      type: target.type || storedIdentity?.type || null,
      url: target.url || storedIdentity?.url || null
    };
    if (!mergedTarget.name || !mergedTarget.key) throw new Error('Group import target is missing a Facebook profile/page owner. Sync profiles first.');
    const label = mergedTarget.name || mergedTarget.key || `profile ${i + 1}`;
    await sbUpdateJob(job.id, { result: { group_scan_guard_version: 'fb-groups-scraper-v2', text: `Scanning ${label} (${i + 1}/${targets.length})...`, current_identity: label, target_index: i + 1, target_count: targets.length } });
    try {
      const result = await importFacebookGroupsForJob(job.id, mergedTarget, { finalizeJob: false, progressPrefix: `${label}: ` });
      const resultSignature = groupUrlSignature(result?.groups || []);
      const isPageTarget = isPageIdentityType(mergedTarget.type);
      if (!isPageTarget && resultSignature) accountLevelGroupSignature = accountLevelGroupSignature || resultSignature;
      const pageSourceProof = isPageTarget && result?.page_scan_strategy === 'page_groups_tab' && result?.scan_source_url && !isGenericJoinedGroupsUrl(result.scan_source_url);
      if (isPageTarget && !pageSourceProof && resultSignature && (knownAccountLevelGroupSignatures.has(resultSignature) || (accountLevelGroupSignature && resultSignature === accountLevelGroupSignature))) {
        await deleteGroupsForIdentity(session, mergedTarget.key);
        throw new Error(`same account-level groups returned for ${mergedTarget.name}`);
      }
      const overlapAssessment = await assessAccountLevelGroupOverlap(session, mergedTarget.name, mergedTarget.type, result?.groups || []);
      const warnings = [];
      if (overlapAssessment?.high_overlap) {
        warnings.push({
          ...overlapAssessment,
          severity: pageSourceProof ? 'warning' : 'blocked',
          message: pageSourceProof
            ? 'Saved because the scrape source was the Page-specific Groups tab, but the URL set overlaps the account-level profile list.'
            : 'Blocked because the scrape did not have Page-specific source proof and overlapped the account-level profile list.'
        });
        if (!pageSourceProof) {
          await deleteGroupsForIdentity(session, mergedTarget.key);
          throw new Error(`same account-level groups returned for ${mergedTarget.name}`);
        }
      }
      scanSignatures.push({ identity_key: mergedTarget.key, identity_name: mergedTarget.name, identity_type: mergedTarget.type, signature: resultSignature, page_source_proof: pageSourceProof });
      const before = beforeByIdentity.get(String(mergedTarget.key)) || new Set();
      const newGroups = (result?.groups || []).filter(g => g?.url && !before.has(g.url)).map(g => ({ group_name: g.name || null, group_url: g.url, group_avatar_url: g.group_avatar_url || null }));
      perIdentity.push({
        identity_name: mergedTarget.name || null,
        group_scan_guard_version: result?.group_scan_guard_version || null,
        identity_key: mergedTarget.key,
        identity_type: mergedTarget.type || null,
        count: result?.count || 0,
        avatar_count: result?.avatar_count || 0,
        scan_source_url: result?.scan_source_url || null,
        page_scan_strategy: result?.page_scan_strategy || null,
        debug: result?.debug || null,
        warnings,
        new_count: newGroups.length,
        new_groups: newGroups.slice(0, 50)
      });
    } catch (e) {
      const reason = friendlyGroupScanMissReason(e);
      errors.push({
        identity_name: mergedTarget.name || null,
        identity_key: mergedTarget.key || null,
        status: 'not_scanned',
        reason,
        raw_error: e.message
      });
      perIdentity.push({
        identity_name: mergedTarget.name || null,
        identity_key: mergedTarget.key || null,
        identity_type: mergedTarget.type || null,
        count: 0,
        new_count: 0,
        status: 'not_scanned',
        reason
      });
    }
  }

  const signatureCounts = new Map();
  scanSignatures.forEach(item => {
    if (!item.signature) return;
    signatureCounts.set(item.signature, (signatureCounts.get(item.signature) || 0) + 1);
  });
  const quarantinedKeys = new Set();
  for (const item of scanSignatures) {
    if (!item.signature || signatureCounts.get(item.signature) < 2 || !isPageIdentityType(item.identity_type) || item.page_source_proof) continue;
    try { await deleteGroupsForIdentity(session, item.identity_key); } catch (e) { extLog('warn', e.message); }
    quarantinedKeys.add(String(item.identity_key));
    errors.push({
      identity_name: item.identity_name || null,
      identity_key: item.identity_key || null,
      status: 'not_scanned',
      reason: 'Facebook returned the same group list as another identity, so this Page scan was quarantined.',
      raw_error: 'duplicate group URL signature'
    });
  }
  if (quarantinedKeys.size) {
    for (let i = 0; i < perIdentity.length; i++) {
      if (!quarantinedKeys.has(String(perIdentity[i].identity_key))) continue;
      perIdentity[i] = {
        identity_name: perIdentity[i].identity_name || null,
        identity_key: perIdentity[i].identity_key || null,
        identity_type: perIdentity[i].identity_type || null,
        count: 0,
        new_count: 0,
        status: 'not_scanned',
        reason: 'Facebook returned the same group list as another identity, so this Page scan was quarantined.'
      };
    }
  }

  const totalGroups = perIdentity.reduce((sum, item) => sum + (item.count || 0), 0);
  const totalNew = perIdentity.reduce((sum, item) => sum + (item.new_count || 0), 0);
  const notScanned = perIdentity.filter(item => item.status === 'not_scanned').length;
  const scanned = perIdentity.length - notScanned;
  const status = scanned > 0 ? 'done' : 'failed';
  const isDailyScan = !!(job.daily_scan || job.result?.daily_scan);
  const label = isDailyScan ? 'Daily group scan' : 'Group scan';
  const scanText = status === 'done'
    ? `${label} complete: ${totalGroups} groups across ${targets.length} profiles/pages · ${totalNew} new${notScanned ? ` · ${notScanned} profile/page${notScanned === 1 ? '' : 's'} not scanned` : ''}`
    : `${label} could not scan any synced profiles/pages`;
  await sbUpdateJob(job.id, {
    status,
    result: {
      group_scan_guard_version: 'fb-groups-scraper-v2',
      text: scanText,
      daily_scan: isDailyScan,
      target_count: targets.length,
      scanned_count: scanned,
      not_scanned_count: notScanned,
      total_groups: totalGroups,
      total_new_groups: totalNew,
      identities: perIdentity,
      not_scanned: errors
    },
    error: status === 'failed' ? errors.map(e => `${e.identity_name || e.identity_key}: ${e.reason}`).join('; ') : null,
    completed_at: new Date().toISOString()
  });
}

async function enqueueDailyGroupScan() {
  const session = await getStoredSession();
  if (!session || !session.userId) return;
  if (!dashSession) dashSession = session;
  try {
    const targets = await getImportTargetsForJob({ groups: [] }, session);
    if (!targets.length) {
      extLog('warn', 'Daily group scan skipped: no synced posting identities');
      return;
    }
    const since = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
    const dupeRes = await fetch(`${SB_URL}/rest/v1/jsw_post_jobs?user_id=eq.${encodeURIComponent(session.userId)}&message=eq.__import_groups__&created_at=gte.${encodeURIComponent(since)}&status=in.(pending,processing,done)&select=id,status,result&limit=10`, {
      headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}` }
    });
    if (dupeRes.ok) {
      const existing = await dupeRes.json();
      if (existing?.some(row => row?.result?.daily_scan)) {
        extLog('info', 'Daily group scan already queued/completed recently; skipping duplicate');
        return;
      }
    }
    const res = await fetch(`${SB_URL}/rest/v1/jsw_post_jobs`, {
      method: 'POST',
      headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({
        user_id: session.userId,
        message: '__import_groups__',
        groups: targets.map(t => ({ identity_name: t.name, identity_key: t.key, identity_type: t.type, identity_url: t.url, import_groups: true })),
        status: 'pending',
        delay: 0,
        ai_enabled: false,
        scheduled_for: null,
        result: { daily_scan: true, text: `Daily group scan queued for ${targets.length} synced profiles/pages.` }
      })
    });
    if (!res.ok) throw new Error(await res.text());
    extLog('info', `Daily group scan queued for ${targets.length} profiles/pages`);
    pollPendingJobs();
  } catch (e) {
    extLog('warn', 'enqueueDailyGroupScan failed: ' + e.message);
  }
}

async function runComposerProbeJob(job, session) {
  let items = Array.isArray(job.groups) ? job.groups : [];
  if (typeof job.groups === 'string') {
    try { items = JSON.parse(job.groups); } catch (_) { items = []; }
  }
  if (!Array.isArray(items)) items = [];
  const resolvedItems = [];
  for (const item of items) {
    resolvedItems.push(typeof item === 'string' ? { url: item } : await enrichFacebookIdentityTarget(item));
  }
  const identity = resolvedItems.find(g => g && (g.identity_name || g.identityName)) || {};
  const identityName = identity.identity_name || identity.identityName || job.ai_prompt || null;
  const identityUrl = identity.identity_url || identity.identityUrl || null;
  const targets = resolvedItems.filter(g => g?.url || g?.group_url).slice(0, 5);
  const results = [];
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const url = target.url || target.group_url;
    await sbUpdateJob(job.id, { result: { text: `Probing ${identityName} composer access ${i + 1}/${targets.length}...`, identity_name: identityName, current_group: target.name || target.group_name || url } });
    let tab = null;
    try {
      const isPageProbe = !!identityUrl && /^https:\/\/(www\.)?facebook\.com\/profile\.php\?id=\d+/i.test(String(identityUrl));
      if (isPageProbe) {
        tab = await chrome.tabs.create({ url: identityUrl, active: true });
        await sleep(8000);
        const switchResponse = await sendTabMessageWithRetry(tab.id, { type: 'SWITCH_FACEBOOK_IDENTITY', identityName, identityUrl });
        let activeResponse = null;
        try { activeResponse = await sendTabMessageWithRetry(tab.id, { type: 'GET_FACEBOOK_ACTIVE_IDENTITY', expectedIdentity: identityName }); } catch (_) {}
        const directVerified = !!switchResponse?.success || facebookIdentityNameMatches(activeResponse?.activeIdentity, identityName);
        // The Page URL is the best context for switching. Once Facebook confirms it,
        // the group composer is opened as a read-only final check. If it is not yet
        // confirmed, retain the normal group-side fallback rather than declaring the
        // selector error itself a final result.
        if (!directVerified) extLog('warn', `Page switch was not confirmed for ${identityName}; attempting group-side composer recovery.`);
        await sleep(2500);
        await chrome.tabs.update(tab.id, { url });
        await sleep(8000);
        const response = await sendTabMessageWithRetry(tab.id, { type: 'PROBE_GROUP_COMPOSER_IDENTITY', identityName, identityUrl, identityType: identity.identity_type || identity.identityType || identity.type || null, skipSwitch: directVerified });
        results.push({ group_name: target.name || target.group_name || null, group_url: url, success: !!response?.success, reset_response: target._reset_response || null, reset_error: target._reset_error || null, switch_success: directVerified, switch_response: switchResponse, active_before_group: activeResponse?.activeIdentity || null, ...response });
      } else {
        tab = await chrome.tabs.create({ url, active: true });
        await sleep(7000);
        const response = await sendTabMessageWithRetry(tab.id, { type: 'PROBE_GROUP_COMPOSER_IDENTITY', identityName, identityUrl, identityType: identity.identity_type || identity.identityType || identity.type || null });
        results.push({ group_name: target.name || target.group_name || null, group_url: url, success: !!response?.success, ...response });
      }
    } catch (e) {
      results.push({ group_name: target.name || target.group_name || null, group_url: url, success: false, error: e.message });
    } finally {
      if (tab?.id) { try { await chrome.tabs.remove(tab.id); } catch (_) {} }
      await sleep(1000);
    }
  }
  const allowed = results.filter(r => r.success && r.composerIdentityVerified);
  await sbUpdateJob(job.id, {
    status: 'done',
    result: {
      text: `Composer probe complete: ${allowed.length}/${results.length} groups allow ${identityName}`,
      identity_name: identityName,
      tested_count: results.length,
      allowed_count: allowed.length,
      results
    },
    completed_at: new Date().toISOString()
  });
}

async function runGlobalIdentitySwitchProbeJob(job, session) {
  let items = Array.isArray(job.groups) ? job.groups : [];
  if (typeof job.groups === 'string') {
    try { items = JSON.parse(job.groups); } catch (_) { items = []; }
  }
  if (!Array.isArray(items) || !items.length) {
    const saved = await fetch(`${SB_URL}/rest/v1/amplr_data?user_id=eq.${encodeURIComponent(session.userId)}&key=eq.posting_identities&select=value&limit=1`, {
      headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}` }
    });
    if (saved.ok) {
      const rows = await saved.json();
      items = rows?.[0]?.value?.identities || [];
    }
  }
  const identities = [];
  for (const item of items) {
    const resolved = await enrichFacebookIdentityTarget(item || {});
    const name = resolved.identity_name || resolved.name || null;
    if (!name || isForbiddenPostingIdentityName(name)) continue;
    identities.push({
      name,
      type: resolved.identity_type || resolved.type || null,
      url: resolved.identity_url || resolved.url || null,
      key: resolved.identity_key || resolved.key || resolved.id || null
    });
  }

  const results = [];
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url: 'https://www.facebook.com/', active: true });
    await sleep(7000);
    for (let i = 0; i < identities.length; i++) {
      const identity = identities[i];
      await sbUpdateJob(job.id, { result: { text: `Testing global Facebook switch ${i + 1}/${identities.length}: ${identity.name}`, current_identity: identity.name, target_index: i + 1, target_count: identities.length } });
      const startedAtUrl = tab.url || null;
      let switchResponse = null;
      let verifyHome = null;
      let ok = false;
      let error = null;
      try {
        const isManagedPage = /^page$/i.test(String(identity.type || '')) || (!!identity.url && /^https:\/\/(www\.)?facebook\.com\/profile\.php\?id=\d+/i.test(String(identity.url)));
        if (isManagedPage && identity.url) {
          // Prefer Facebook's Page profile context when a synchronized stable URL exists.
          // The content script verifies the active identity after attempting the Page action.
          await chrome.tabs.update(tab.id, { url: identity.url, active: true });
          await sleep(8000);
          switchResponse = await sendTabMessageWithRetry(tab.id, { type: 'SWITCH_FACEBOOK_IDENTITY', identityName: identity.name, identityUrl: identity.url });
        } else if (isManagedPage) {
          // Legacy fallback for older records that have no Page URL yet.
          await chrome.tabs.update(tab.id, { url: 'https://www.facebook.com/pages/?category=your_pages', active: true });
          await sleep(8000);
          switchResponse = await sendTabMessageWithRetry(tab.id, { type: 'SWITCH_FACEBOOK_MANAGED_PAGE', identityName: identity.name });
        } else {
          await chrome.tabs.update(tab.id, { url: 'https://www.facebook.com/', active: true });
          await sleep(5000);
          switchResponse = await sendTabMessageWithRetry(tab.id, { type: 'SWITCH_FACEBOOK_IDENTITY', identityName: identity.name, identityUrl: identity.url || null });
        }
        await sleep(7000);
        await chrome.tabs.update(tab.id, { url: 'https://www.facebook.com/', active: true });
        await sleep(7000);
        verifyHome = await sendTabMessageWithRetry(tab.id, { type: 'GET_FACEBOOK_ACTIVE_IDENTITY', expectedIdentity: identity.name });
        // A verified Facebook active identity is authoritative. The switch-control
        // selector is diagnostic evidence only because Facebook hides that control
        // once a Page is already active or changes its Pages Manager layout.
        ok = facebookIdentityNameMatches(verifyHome?.activeIdentity, identity.name);
        if (!ok) error = switchResponse?.error || `Home active identity verified as ${verifyHome?.activeIdentity || 'unknown'}, not ${identity.name}`;
      } catch (e) {
        error = e.message;
      }
      results.push({
        identity_name: identity.name,
        identity_type: identity.type,
        identity_url: identity.url,
        success: ok,
        error,
        started_at_url: startedAtUrl,
        switch_response: switchResponse,
        switch_control_confirmed: !!switchResponse?.success,
        verified_home_identity: verifyHome?.activeIdentity || null,
        verified_home_url: verifyHome?.pageUrl || null
      });
      await sleep(1500);
    }
  } finally {
    if (tab?.id) { try { await chrome.tabs.remove(tab.id); } catch (_) {} }
  }

  const successCount = results.filter(r => r.success).length;
  await sbUpdateJob(job.id, {
    status: successCount === results.length ? 'done' : 'failed',
    result: {
      text: `Global identity switch probe complete: ${successCount}/${results.length} identities verified`,
      tested_count: results.length,
      success_count: successCount,
      results,
      extension_version: EXT_VERSION
    },
    completed_at: new Date().toISOString()
  });
}

// Claim a job (set status=processing) then run it
async function executeDashJob(job) {
  dashSession = await getStoredSession();
  if (!dashSession) return;
  // Special job: import groups from Facebook
  if (job.message === '__sync_identities__') {
    const claimed = await sbUpdateJob(job.id, {
      status: 'processing',
      started_at: new Date().toISOString(),
      result: { text: 'Opening Facebook identity switcher...' }
    });
    if (!claimed) return;
    extLog('info', 'Running sync_identities job ' + job.id);
    try {
      await syncFacebookIdentitiesForJob(job.id);
    } catch (e) {
      await sbUpdateJob(job.id, {
        status: 'failed',
        result: { error: e.message },
        completed_at: new Date().toISOString()
      });
    }
    return;
  }

  if (job.message === '__import_groups__') {
    const claimed = await sbUpdateJob(job.id, {
      status: 'processing',
      started_at: new Date().toISOString()
    });
    if (!claimed) return;
    extLog('info', 'Running import_groups job ' + job.id);
    try {
      await runImportGroupsJob(job, dashSession);
    } catch (e) {
      await sbUpdateJob(job.id, {
        status: 'failed',
        result: { error: e.message },
        completed_at: new Date().toISOString()
      });
    }
    return;
  }

  if (job.message === '__probe_page_group_access__') {
    const claimed = await sbUpdateJob(job.id, {
      status: 'processing',
      started_at: new Date().toISOString(),
      result: { text: 'Starting no-post composer permission probe...' }
    });
    if (!claimed) return;
    extLog('info', 'Running composer probe job ' + job.id);
    try {
      await runComposerProbeJob(job, dashSession);
    } catch (e) {
      await sbUpdateJob(job.id, {
        status: 'failed',
        result: { error: e.message },
        completed_at: new Date().toISOString()
      });
    }
    return;
  }

  if (job.message === '__probe_global_identity_switch__') {
    const claimed = await sbUpdateJob(job.id, {
      status: 'processing',
      started_at: new Date().toISOString(),
      result: { text: 'Starting global Facebook identity switch probe...' }
    });
    if (!claimed) return;
    extLog('info', 'Running global identity switch probe job ' + job.id);
    try {
      await runGlobalIdentitySwitchProbeJob(job, dashSession);
    } catch (e) {
      await sbUpdateJob(job.id, {
        status: 'failed',
        result: { error: e.message },
        completed_at: new Date().toISOString()
      });
    }
    return;
  }

  // Try to claim it via PATCH
  const claimed = await sbUpdateJob(job.id, {
    status: 'processing',
    started_at: new Date().toISOString()
  });
  if (!claimed) {
    extLog('warn', 'Job already claimed, skipping: ' + job.id);
    return;
  }

  extLog('info', 'Executing job ' + job.id);
  broadcastDashStatus('Processing job...', '#eab308');

  let groups = job.groups || [];
  if (!Array.isArray(groups)) {
    try { groups = JSON.parse(groups); } catch (e) { groups = []; }
  }
  let groupTargets = groups.map(g => typeof g === 'string' ? { url:g } : g).filter(g => g && g.url);
  const cappedTargets = groupTargets.slice(ANTI_BOT.maxGroupsPerJob);
  if (cappedTargets.length) {
    groupTargets = groupTargets.slice(0, ANTI_BOT.maxGroupsPerJob);
  }
  const groupUrls = groupTargets.map(g => g.url);

  extLog('info', 'Job ' + job.id + ' — ' + groupUrls.length + ' groups');

  const jobWarnings = [];
  if (job.scheduled_for) {
    const lateMinutes = Math.round((Date.now() - new Date(job.scheduled_for).getTime()) / 60000);
    if (lateMinutes > 5) {
      const warning = {
        type: 'late_scheduled_job',
        late_minutes: lateMinutes,
        scheduled_for: job.scheduled_for,
        message: `Scheduled job is running ${lateMinutes} minutes late. Continuing because Amplr warns but does not block.`
      };
      jobWarnings.push(warning);
      extLog('warn', warning.message);
      broadcastDashStatus(`Late scheduled job warning: ${lateMinutes}m`, '#eab308');
    }
  }

  let settings = {
    aiEnabled: job.ai_enabled,
    aiPrompt: job.ai_prompt || null,
    apiKey: dashSession?.ai_key || null,
    aiProvider: dashSession?.ai_provider || 'ollama',
    aiModel: dashSession?.ai_model || 'qwen3:8b',
    aiVariations: true,
    aiTemp: 0.85
  };

  let successCount = 0;
  let lastError = null;
  const perGroupResults = cappedTargets.map(t => skippedResult(t, 'max_groups_per_job', {
    type: 'max_groups_per_job',
    max_groups_per_job: ANTI_BOT.maxGroupsPerJob,
    message: `Skipped because anti-bot defense limits one job to ${ANTI_BOT.maxGroupsPerJob} groups.`
  }));

  if (cappedTargets.length) {
    jobWarnings.push({
      type: 'max_groups_per_job',
      skipped_count: cappedTargets.length,
      max_groups_per_job: ANTI_BOT.maxGroupsPerJob,
      message: `Anti-bot defense limited this job to ${ANTI_BOT.maxGroupsPerJob} groups and skipped ${cappedTargets.length}.`
    });
  }

  // Load cooldown setting, but never allow less than the hard anti-bot floor.
  const cooldownDays = Math.max(dashSession?.cooldown_days ?? ANTI_BOT.hardCooldownDays, ANTI_BOT.hardCooldownDays);

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  let recentPostedCount = await countRecentPostedResults(dashSession, since24h);

  // Pre-fetch all group cooldown data in one query (avoids N+1 per group)
  let groupCooldownMap = {};
  try {
    const inList = groupUrls.map(u => encodeURIComponent(u)).join(',');
    const gcRes = await fetch(`${SB_URL}/rest/v1/jsw_groups?user_id=eq.${dashSession.userId}&group_url=in.(${inList})&select=group_url,identity_key,last_posted_at,ban_risk`, {
      headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${dashSession.accessToken}` }
    });
    const gcData = await gcRes.json();
    if (Array.isArray(gcData)) {
      gcData.forEach(g => { groupCooldownMap[`${g.identity_key || '__legacy__'}::${g.group_url}`] = g; });
    }
  } catch (e) {
    extLog('warn', 'Failed to pre-fetch group cooldown data: ' + e.message);
  }

  for (let i = 0; i < groupUrls.length; i++) {
    const target = groupTargets[i] || { url: groupUrls[i] };
    const groupUrl = target.url;
    const identityName = target.identity_name || job.identity_name || null;
    const identityKey = target.identity_key || job.identity_key || (identityName || '__legacy__');
    const storedIdentity = identityName ? await getPostingIdentityByNameOrKey(identityName, identityKey) : null;
    const identityUrl = target.identity_url || job.identity_url || storedIdentity?.url || null;
    const identityType = target.identity_type || job.identity_type || storedIdentity?.type || null;
    let finalText = job.message;

    if (!identityName || isForbiddenPostingIdentityName(identityName)) {
      const warning = {
        type: 'identity_required',
        message: 'Skipped because no valid Facebook posting identity was attached to this job. Resync/select a profile before posting.'
      };
      perGroupResults.push(skippedResult(target, 'identity_required', warning));
      broadcastDashStatus(`Identity required ${i + 1}/${groupUrls.length}`, '#eab308');
      continue;
    }

    // ── Cooldown awareness — warning only, never blocks posting ──
    let cooldownWarning = null;
    try {
      const gd = groupCooldownMap[`${identityKey}::${groupUrl}`] || groupCooldownMap[`__legacy__::${groupUrl}`];
      const lastPosted = gd?.last_posted_at;
      const banRisk = String(gd?.ban_risk || 'low').toLowerCase();
      if (ANTI_BOT.skipBanRisk.has(banRisk)) {
        cooldownWarning = {
          type: 'ban_risk_skip',
          ban_risk: banRisk,
          message: `Skipped because this group is marked ${banRisk} risk.`
        };
        perGroupResults.push(skippedResult(target, 'ban_risk', cooldownWarning));
        broadcastDashStatus(`Skipped risk group ${i + 1}/${groupUrls.length}`, '#eab308');
        continue;
      }
      if (lastPosted && cooldownDays > 0) {
        const daysSince = (Date.now() - new Date(lastPosted).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSince < cooldownDays) {
          cooldownWarning = {
            type: 'cooldown_skip',
            days_since_last_post: Number(daysSince.toFixed(2)),
            cooldown_days: cooldownDays,
            message: `Skipped because this group was posted to ${daysSince.toFixed(1)} days ago. Hard cooldown is ${cooldownDays} days.`
          };
          extLog('warn', `${groupUrl} — anti-bot cooldown skip (${daysSince.toFixed(1)} days since last post)`);
          perGroupResults.push(skippedResult(target, 'cooldown', cooldownWarning));
          broadcastDashStatus(`Cooldown skip ${i + 1}/${groupUrls.length}`, '#eab308');
          continue;
        }
      }
      if (recentPostedCount !== null && recentPostedCount >= ANTI_BOT.dailyUserPostCap) {
        cooldownWarning = {
          type: 'daily_post_cap',
          daily_user_post_cap: ANTI_BOT.dailyUserPostCap,
          recent_posted_count: recentPostedCount,
          message: `Skipped because anti-bot defense hit the ${ANTI_BOT.dailyUserPostCap}/24h posting cap.`
        };
        perGroupResults.push(skippedResult(target, 'daily_post_cap', cooldownWarning));
        broadcastDashStatus(`Daily cap skip ${i + 1}/${groupUrls.length}`, '#eab308');
        continue;
      }
    } catch (e) {
      extLog('warn', 'Cooldown warning check error: ' + e.message);
    }

    // Ollama doesn't need an API key — always attempt if ai_enabled
    const canUseAI = settings.aiEnabled && (settings.aiProvider === 'ollama' || settings.apiKey);
    if (canUseAI) {
      try {
        finalText = await callAI(job.message, settings, i);
      } catch (e) {
        console.warn('[JSW] AI refine failed, using original:', e.message);
      }
    }

    let tab = null;
    try {
      tab = await chrome.tabs.create({ url: groupUrl, active: true });
      await sleep(5000);

      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'POST_TO_PAGE',
        message: finalText,
        imageUrl: job.image_url || '',
        identityName,
        identityUrl,
        identityType
      });

      if (response?.success && response?.composerIdentityVerified === true) {
        successCount++;
        const postedAt = new Date().toISOString();
        const postUrl = response?.postUrl || null;
        const evidenceFound = !!response?.evidenceFound;
        extLog('info', `Posted ${i + 1}/${groupUrls.length} → ${groupUrl}${postUrl ? ' (' + postUrl + ')' : evidenceFound ? ' (evidence matched)' : ' (submitted, no permalink found)'}`);
        perGroupResults.push({
          group_url: groupUrl,
          group_name: target.name || target.group_name || null,
          identity_name: identityName || response?.activeIdentity || response?.identityUsed || null,
          identity_key: identityKey || null,
          identity_used: response?.identityUsed || response?.composerIdentity || response?.activeIdentity || identityName || null,
          active_identity: response?.activeIdentity || null,
          composer_identity: response?.composerIdentity || null,
          composer_identity_verified: response?.composerIdentityVerified === true,
          identity_switched: response?.identitySwitched === true,
          status: 'posted',
          post_url: postUrl,
          evidence_found: evidenceFound,
          matched_text: response?.matchedText || null,
          page_url: response?.pageUrl || null,
          final_message: finalText,
          warnings: cooldownWarning ? [cooldownWarning] : [],
          posted_at: postedAt
        });
        broadcastDashStatus(`Posted ${i + 1}/${groupUrls.length}`, '#4ecca3');
        // Update last_posted_at for cooldown tracking
        fetch(`${SB_URL}/rest/v1/jsw_groups?user_id=eq.${dashSession.userId}&identity_key=eq.${encodeURIComponent(identityKey || '__legacy__')}&group_url=eq.${encodeURIComponent(groupUrl)}`, {
          method: 'PATCH',
          headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${dashSession.accessToken}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ last_posted_at: postedAt })
        }).catch(e => extLog('warn', 'last_posted_at update error: ' + e.message));

        if (recentPostedCount !== null) recentPostedCount++;

        // Record post result for ban detection
        fetch(`${SB_URL}/rest/v1/jsw_post_results`, {
          method: 'POST',
          headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${dashSession.accessToken}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ user_id: dashSession.userId, group_url: groupUrl, post_url: postUrl, job_id: job.id, posted_at: postedAt })
        }).catch(e => extLog('warn', 'jsw_post_results insert error: ' + e.message));

        // First comment automation
        if (job.first_comment) {
          await sleep(4000); // let FB process the post
          try {
            await postFirstComment(tab.id, job.first_comment);
            extLog('info', 'First comment posted on ' + groupUrl);
          } catch(e) {
            extLog('warn', 'First comment failed: ' + e.message);
          }
        }

      } else if (response?.error_code === 'not_group_member') {
        lastError = response?.error || 'Not accepted into group';
        const warning = {
          type: 'not_group_member_skip',
          message: lastError
        };
        perGroupResults.push(skippedResult(target, 'not_group_member', warning));
        jobWarnings.push(warning);
        extLog('warn', `Skipped ${i + 1}/${groupUrls.length} → ${groupUrl}: not accepted/member`);
        broadcastDashStatus(`Skipped not-joined group ${i + 1}/${groupUrls.length}`, '#eab308');
      } else {
        lastError = response?.error || 'Unknown error';
        const defenseTriggered = isFacebookDefenseError(lastError) || response?.error_code === 'facebook_defense';
        perGroupResults.push({
          group_url: groupUrl,
          group_name: target.name || target.group_name || null,
          identity_name: identityName || response?.identity_active || null,
          identity_key: identityKey || null,
          identity_used: response?.composer_identity || response?.identity_active || null,
          active_identity: response?.identity_active || null,
          composer_identity: response?.composer_identity || null,
          composer_identity_verified: response?.composer_identity_verified === true,
          error_code: response?.error_code || null,
          status: 'failed',
          error: lastError,
          warnings: cooldownWarning ? [cooldownWarning] : [],
          final_message: finalText,
          failed_at: new Date().toISOString()
        });
        extLog('error', `Failed ${i + 1}/${groupUrls.length} → ${groupUrl}: ${lastError}`);
        broadcastDashStatus(`Failed ${i + 1}/${groupUrls.length}`, '#e94560');
        if (defenseTriggered) {
          jobWarnings.push({ type: 'facebook_defense_stop', message: `Stopped batch after Facebook defense signal: ${lastError}` });
          lastError = `Stopped after Facebook defense signal: ${lastError}`;
          break;
        }
      }

      await sleep(1000);
      if (tab) {
        await chrome.tabs.remove(tab.id);
        tab = null;
      }
    } catch (e) {
      lastError = e.message;
      const defenseTriggered = isFacebookDefenseError(lastError) || e.code === 'facebook_defense';
      perGroupResults.push({
        group_url: groupUrl,
        group_name: target.name || target.group_name || null,
        identity_name: identityName || e.identity_active || null,
        identity_key: identityKey || null,
        identity_used: e.composer_identity || e.identity_active || null,
        active_identity: e.identity_active || null,
        composer_identity: e.composer_identity || null,
        composer_identity_verified: false,
        error_code: e.code || null,
        status: 'failed',
        error: e.message,
        warnings: cooldownWarning ? [cooldownWarning] : [],
        final_message: finalText,
        failed_at: new Date().toISOString()
      });
      extLog('error', `Error on group ${i + 1} (${groupUrl}): ${e.message}`);
      broadcastDashStatus(`Error on group ${i + 1}`, '#e94560');
      if (tab) {
        try { await chrome.tabs.remove(tab.id); } catch (_) {}
        tab = null;
      }
      if (defenseTriggered) {
        jobWarnings.push({ type: 'facebook_defense_stop', message: `Stopped batch after Facebook defense signal: ${lastError}` });
        lastError = `Stopped after Facebook defense signal: ${lastError}`;
        break;
      }
    }

    if (i < groupUrls.length - 1) {
      const waitSeconds = randomAntiBotDelaySeconds(job.delay || 0);
      broadcastDashStatus(`Anti-bot wait ${waitSeconds}s...`, '#6a6a8a');
      await sleep(waitSeconds * 1000);
    }
  }

  // Mark done or failed
  const success = successCount > 0;
  const failedCount = perGroupResults.filter(r => r.status === 'failed').length;
  const skippedCount = perGroupResults.filter(r => r.status === 'skipped').length;
  const completedWithoutHardFailure = success || (skippedCount > 0 && failedCount === 0);
  const completedAt = new Date().toISOString();
  await sbUpdateJob(job.id, {
    status: completedWithoutHardFailure ? 'done' : 'failed',
    error: completedWithoutHardFailure ? null : (lastError || 'All groups failed'),
    result: {
      success_count: successCount,
      total_groups: groupUrls.length,
      failed_count: failedCount,
      skipped_count: skippedCount,
      warnings: jobWarnings,
      results: perGroupResults,
      completed_at: completedAt
    },
    completed_at: completedAt
  });

  extLog(completedWithoutHardFailure ? 'info' : 'error', `Job ${job.id} ${completedWithoutHardFailure ? 'DONE' : 'FAILED'} — ${successCount}/${groupUrls.length} posted, ${skippedCount} skipped`);

  broadcastDashStatus(
    completedWithoutHardFailure ? `Done — ${successCount}/${groupUrls.length} posted${skippedCount ? `, ${skippedCount} skipped` : ''}` : 'Job failed',
    completedWithoutHardFailure ? '#4ecca3' : '#e94560'
  );

  notify(completedWithoutHardFailure
    ? `Dashboard job complete — ${successCount}/${groupUrls.length} groups posted${skippedCount ? `, ${skippedCount} skipped` : ''}.`
    : `Dashboard job failed: ${lastError}`
  );

  // ── Webhook delivery (fire-and-forget, best-effort) ──
  if (job.webhook_url) {
    fireWebhook(job, completedWithoutHardFailure, successCount, groupUrls.length, lastError);
  }
}

// Fire a webhook to the caller's endpoint with job completion details
async function fireWebhook(job, success, successCount, totalGroups, lastError) {
  const payload = {
    event:       success ? 'job.completed' : 'job.failed',
    job_id:      job.id,
    status:      success ? 'done' : 'failed',
    success_count: successCount,
    total_groups:  totalGroups,
    error:       lastError || null,
    completed_at: new Date().toISOString(),
  };

  // Retry up to 3 times with exponential backoff
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(job.webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Amplr-Webhook/1.0',
          'X-Amplr-Event': payload.event,
          'X-Amplr-Job-Id': job.id,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000), // 10s timeout
      });

      if (res.ok) {
        extLog('info', `Webhook delivered for job ${job.id} (attempt ${attempt})`);
        return;
      }

      extLog('warn', `Webhook attempt ${attempt} failed with HTTP ${res.status} for job ${job.id}`);
    } catch (e) {
      extLog('warn', `Webhook attempt ${attempt} error for job ${job.id}: ${e.message}`);
    }

    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 2000 * attempt)); // 2s, 4s
    }
  }

  extLog('error', `Webhook delivery failed after 3 attempts for job ${job.id}`);
}

// ── First comment: post a follow-up comment on the newly-created post ──
async function postFirstComment(tabId, commentText) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (text) => {
      // Find an active comment box in the page
      const commentBoxes = document.querySelectorAll(
        '[aria-label="Write a comment\u2026"], [aria-label="Write a comment"], [data-lexical-editor="true"]'
      );
      const box = [...commentBoxes].find(el => el.isContentEditable || el.tagName === 'DIV');
      if (!box) throw new Error('Comment box not found');
      box.focus();
      // Insert text into the contenteditable div
      document.execCommand('insertText', false, text);
      // Click the submit / Comment button after a short pause
      setTimeout(() => {
        const submitBtns = document.querySelectorAll('[aria-label="Comment"], button[type="submit"]');
        if (submitBtns.length > 0) submitBtns[submitBtns.length - 1].click();
      }, 800);
    },
    args: [commentText]
  });
  await sleep(2000); // wait for comment to post
}

// Update a job row via Supabase REST PATCH
async function sbUpdateJob(jobId, patch) {
  try {
    const session = await getStoredSession();
    if (!session) return false;
    const res = await fetch(`${SB_URL}/rest/v1/jsw_post_jobs?id=eq.${jobId}`, {
      method: 'PATCH',
      headers: {
        'apikey': SB_ANON_KEY,
        'Authorization': `Bearer ${session.accessToken}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(patch)
    });
    return res.ok;
  } catch (e) {
    console.warn('[JSW] sbUpdateJob error:', e.message);
    return false;
  }
}

// ============================================================
// SYNC FACEBOOK POSTING IDENTITIES
// Opens Facebook, asks content script to scrape the profile/Page switcher,
// and stores results in amplr_data.key = posting_identities.
// ============================================================
function normalizeIdentityNameForMerge(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function facebookPageIdFromUrl(url) {
  const match = String(url || '').match(/profile\.php\?id=(\d+)/i);
  return match?.[1] || null;
}

function isPlaceholderPostingIdentityName(name) {
  return /^(unnamed(?: page| profile)?|unknown(?: page| profile)?|new page)$/i.test(String(name || '').trim());
}

function isForbiddenPostingIdentityName(name) {
  const cleaned = String(name || '').trim().replace(/\s+/g, ' ');
  if (!cleaned || isPlaceholderPostingIdentityName(cleaned)) return true;
  if (cleaned.length > 90) return true;
  if (/^(quick switch profiles?|see all profiles?|see all pages?|settings(?:\s*(?:&|and)?\s*privacy)?|help(?:\s*(?:&|and)?\s*support)?|report a problem|give feedback|meta verified|meta business suite|display & accessibility|privacy|terms|privacy policy|advertising|ad choices|cookies|more|active|edit|manage|back to previous(?: page)?|select an option|available voices?,?\s*switch|unread chats?|chatsallhas new content.*|log out)$/i.test(cleaned)) return true;
  if (/^(?:[A-Z]\s*){1,3}$/i.test(cleaned.replace(/\./g, ''))) return true;
  if (/^\d+$/.test(cleaned)) return true;
  if (/^\d+\s*(?:m|h|d|w|mo|y)$/i.test(cleaned)) return true;
  if (/^(facebook|facebook menu|meta|pages?|profiles?|home|watch|marketplace|groups?|notifications?|menu|account controls(?: and settings)?|account|your)$/i.test(cleaned)) return true;
  if (/\b(number of unread notifications|new notification|notifications?|unread chats?|chat history is missing|available voices|privacy shortcuts|professional dashboard|ad center|create post|composer|search facebook|view all|sponsored|contacts|meta ai|profile photo|profile picture|online status indicator)\b/i.test(cleaned)) return true;
  if (/^https?:\/\//i.test(cleaned)) return true;
  return false;
}

function postingIdentityUrlAllowed(url) {
  if (!url) return true;
  try {
    const u = new URL(url, 'https://www.facebook.com');
    if (!/facebook\.com$/i.test(u.hostname.replace(/^www\./, ''))) return false;
    return !/(\/settings|\/help|\/privacy|\/policies|\/business|\/ads|\/ad_|\/groups\/|\/marketplace|\/events|\/friends|\/messages|\/notifications|\/stories\/)/i.test(u.pathname);
  } catch (_) { return true; }
}

function hasStrongPostingIdentityEvidence(item) {
  const url = String(item?.url || '');
  if (item?.source === 'pages_manager') return /profile\.php\?id=\d+/i.test(url);
  if (item?.source === 'account_switcher' || item?.source === 'active_account') return true;
  return !!item?.is_active && !!item?.name;
}

function isValidPostingIdentityRecord(item) {
  return !!item
    && !isForbiddenPostingIdentityName(item.name)
    && postingIdentityUrlAllowed(item.url || '')
    && hasStrongPostingIdentityEvidence(item);
}

function mergePostingIdentities(...lists) {
  const merged = new Map();
  for (const list of lists) {
    for (const item of (Array.isArray(list) ? list : [])) {
      const name = String(item?.name || '').trim().replace(/\s+/g, ' ');
      if (!name || isForbiddenPostingIdentityName(name) || !postingIdentityUrlAllowed(item?.url || '')) continue;
      const key = normalizeIdentityNameForMerge(name);
      const prev = merged.get(key) || {};
      merged.set(key, {
        ...prev,
        ...item,
        id: facebookPageIdFromUrl(item.url) || item.id || facebookPageIdFromUrl(prev.url) || prev.id || item.url || key,
        name,
        type: item.type || prev.type || (facebookPageIdFromUrl(item.url || prev.url) ? 'page' : 'facebook identity'),
        url: item.url || prev.url || null,
        avatar_url: item.avatar_url || item.picture_url || item.profile_picture_url || item.photo_url || item.image_url || prev.avatar_url || prev.picture_url || prev.profile_picture_url || prev.photo_url || prev.image_url || null,
        is_active: !!(prev.is_active || item.is_active)
      });
    }
  }
  return [...merged.values()];
}

async function sendTabMessageWithRetry(tabId, message, attempts = 5) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (e) {
      lastError = e;
      const msg = String(e?.message || e || '');
      if (/Receiving end does not exist|Could not establish connection/i.test(msg)) {
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
          await sleep(800);
        } catch (injectErr) {
          lastError = injectErr;
        }
      }
      await sleep(1200);
    }
  }
  throw lastError;
}

async function syncFacebookIdentitiesForJob(jobId) {
  const session = await getStoredSession();
  if (!session || !session.userId) {
    await sbUpdateJob(jobId, { status: 'failed', result: { error: 'Not signed in' }, completed_at: new Date().toISOString() });
    return;
  }

  let tab;
  try {
    await sbUpdateJob(jobId, { result: { text: 'Opening Facebook...' } });
    tab = await chrome.tabs.create({ url: 'https://www.facebook.com/', active: false });
    await sleep(5000);

    await sbUpdateJob(jobId, { result: { text: 'Reading Facebook profile/Page switcher...' } });
    const switcherResponse = await sendTabMessageWithRetry(tab.id, { type: 'SYNC_FACEBOOK_IDENTITIES' });
    if (!switcherResponse?.success) throw new Error(switcherResponse?.error || 'Identity sync failed');

    await sbUpdateJob(jobId, { result: { text: 'Reading managed Facebook Pages...' } });
    await chrome.tabs.update(tab.id, { url: 'https://www.facebook.com/pages/?category=your_pages' });
    await sleep(6500);
    let pagesResponse = { success: false, pages: [] };
    try {
      pagesResponse = await sendTabMessageWithRetry(tab.id, { type: 'SCRAPE_FACEBOOK_MANAGED_PAGES' });
    } catch (e) {
      extLog('warn', 'Managed Pages scrape skipped: ' + e.message);
    }
    if (pagesResponse && !pagesResponse.success) {
      extLog('warn', 'Managed Pages scrape failed: ' + (pagesResponse.error || 'unknown'));
    }

    // Hard reset the saved identity list from current Facebook evidence only.
    // Older scraper versions over-collected account-menu junk; preserving existing
    // rows keeps those bad Pages/profiles alive forever.
    const scrapedIdentities = [...(switcherResponse.identities || []), ...(pagesResponse?.pages || [])].filter(isValidPostingIdentityRecord);
    const combined = mergePostingIdentities(scrapedIdentities);
    const identities = combined.filter(isValidPostingIdentityRecord).map((i, idx) => ({
      id: i.id || i.url || i.name || `identity-${idx + 1}`,
      name: i.name || `Identity ${idx + 1}`,
      type: i.type || 'facebook identity',
      url: i.url || null,
      avatar_url: i.avatar_url || i.picture_url || i.profile_picture_url || i.photo_url || i.image_url || null,
      is_active: !!i.is_active,
      source: i.source || null,
      synced_at: new Date().toISOString()
    }));
    const avatarCount = identities.filter(i => !!i.avatar_url).length;
    if (!identities.length) throw new Error('No Facebook identities found');

    await upsertAmplrData(session, 'posting_identities', {
      identities,
      active_identity: switcherResponse.active_identity || identities.find(i => i.is_active)?.name || null,
      synced_at: new Date().toISOString(),
      sources: {
        switcher_count: (switcherResponse.identities || []).length,
        managed_pages_count: (pagesResponse?.pages || []).length,
        avatar_count: avatarCount,
        extension_version: EXT_VERSION
      }
    });

    await chrome.tabs.remove(tab.id);
    tab = null;
    await sbUpdateJob(jobId, {
      status: 'done',
      result: {
        count: identities.length,
        identities,
        active_identity: switcherResponse.active_identity || null,
        switcher_count: (switcherResponse.identities || []).length,
        managed_pages_count: (pagesResponse?.pages || []).length,
        avatar_count: avatarCount,
        extension_version: EXT_VERSION,
        text: `Synced ${identities.length} posting identities · ${avatarCount} profile pictures`
      },
      completed_at: new Date().toISOString()
    });
    extLog('info', `Synced ${identities.length} posting identities`);
  } catch (e) {
    if (tab) { try { await chrome.tabs.remove(tab.id); } catch (_) {} }
    extLog('error', 'syncFacebookIdentitiesForJob error: ' + e.message);
    await sbUpdateJob(jobId, { status: 'failed', result: { error: e.message }, completed_at: new Date().toISOString() });
  }
}

async function upsertAmplrData(session, key, value) {
  const res = await fetch(`${SB_URL}/rest/v1/amplr_data?on_conflict=user_id,key`, {
    method: 'POST',
    headers: {
      'apikey': SB_ANON_KEY,
      'Authorization': `Bearer ${session.accessToken}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify({ user_id: session.userId, key, value, updated_at: new Date().toISOString() })
  });
  if (!res.ok) throw new Error('amplr_data save failed: ' + await res.text());
}

// ============================================================
// IMPORT FACEBOOK GROUPS
// Opens facebook.com/groups/joins, scrolls to load all,
// scrapes name + URL, saves to jsw_groups via Supabase REST.
// ============================================================
function facebookIdentityNameMatches(actual, expected) {
  const norm = value => String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const a = norm(actual);
  const e = norm(expected);
  return !!a && !!e && (a === e || a.includes(e) || e.includes(a));
}

async function assertFacebookActiveIdentity(tabId, expectedName, context = 'group import') {
  if (!expectedName) throw new Error(`Cannot verify active Facebook identity for ${context}`);
  let response = null;
  try {
    response = await chrome.tabs.sendMessage(tabId, { type: 'GET_FACEBOOK_ACTIVE_IDENTITY' });
  } catch (e) {
    throw new Error(`Active Facebook identity not verified for ${expectedName}: ${e.message}`);
  }
  const active = response?.activeIdentity || null;
  if (!response?.success || !facebookIdentityNameMatches(active, expectedName)) {
    throw new Error(`Active Facebook identity not verified for ${expectedName}. Facebook showed ${active || 'unknown'} on ${response?.pageUrl || 'current page'}. Refusing to save same account-level groups.`);
  }
  return active;
}

function facebookPageGroupsUrl(identityUrl) {
  if (!identityUrl) return null;
  try {
    const url = new URL(identityUrl);
    if (!/facebook\.com$/i.test(url.hostname.replace(/^www\./, ''))) return null;
    if (/^\/profile\.php$/i.test(url.pathname) && url.searchParams.get('id')) {
      url.searchParams.set('sk', 'groups');
      return url.href;
    }
    const path = url.pathname.replace(/\/+$/, '');
    if (path && path !== '/') return `https://www.facebook.com${path}/groups`;
  } catch (_) {}
  return null;
}

function isGenericJoinedGroupsUrl(pageUrl) {
  try {
    const url = new URL(pageUrl);
    return /facebook\.com$/i.test(url.hostname.replace(/^www\./, '')) && /^\/groups\/joins\/?$/i.test(url.pathname);
  } catch (_) {
    return /facebook\.com\/groups\/joins\/?/i.test(String(pageUrl || ''));
  }
}

function assertPageGroupScanSource(identityName, identityType, scanSourceUrl, options = {}) {
  if (!isPageIdentityType(identityType)) return;
  if (isGenericJoinedGroupsUrl(scanSourceUrl) && !options.allowGenericJoinedGroupsForVerifiedPageSwitch) {
    throw new Error(`Refusing to save Page groups for ${identityName}: scanner landed on the generic account /groups/joins page instead of the Page's own Groups tab.`);
  }
}

async function switchFacebookIdentityNative(tabId, identityName, options = {}) {
  const locate = await sendTabMessageWithRetry(tabId, { type: 'LOCATE_FACEBOOK_IDENTITY_SWITCH_TARGET', identityName, force: options.force === true });
  if (locate?.already_active) return { switched: false, already_active: true, active_identity: locate.active_identity || identityName, debug: locate };
  if (!locate?.success || !locate?.found) throw new Error(locate?.error || `Could not locate Facebook identity ${identityName}`);
  const target = { tabId };
  await chrome.tabs.update(tabId, { active: true });
  await sleep(300);
  await chrome.debugger.attach(target, '1.3');
  try {
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: locate.x, y: locate.y, button: 'none' });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: locate.x, y: locate.y, button: 'left', clickCount: 1 });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: locate.x, y: locate.y, button: 'left', clickCount: 1 });
  } finally {
    try { await chrome.debugger.detach(target); } catch (_) {}
  }
  await sleep(8000);
  let active = null;
  try {
    const activeRes = await sendTabMessageWithRetry(tabId, { type: 'GET_FACEBOOK_ACTIVE_IDENTITY' });
    active = activeRes?.activeIdentity || null;
  } catch (_) {}
  return { switched: true, active_identity: active || identityName, debug: locate };
}

async function clickFacebookPageProfileSwitchButton(tabId, identityName) {
  try {
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (expectedName) => {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const expected = norm(expectedName).toLowerCase();
        const visible = (el) => {
          const box = el?.getBoundingClientRect?.();
          return !!box && box.width > 0 && box.height > 0 && box.bottom >= 0 && box.right >= 0;
        };
        const candidates = [...document.querySelectorAll('[role="button"], button, a[href]')]
          .filter(visible)
          .map(el => {
            let root = el;
            for (let i = 0; root?.parentElement && i < 5; i++) root = root.parentElement;
            return { el, text: norm(el.innerText || el.textContent || el.getAttribute('aria-label') || ''), context: norm(root?.innerText || root?.textContent || '') };
          })
          .filter(item => /\bSwitch\b/i.test(item.text));
        const target = candidates.find(item => item.text.toLowerCase().includes(expected) && /switch into|switch to|continue as|use facebook as/i.test(item.text))
          || candidates.find(item => /^(switch|switch now)$/i.test(item.text) && item.context.toLowerCase().includes(expected) && /switch into|switch to|continue as|use facebook as/i.test(item.context));
        if (!target) return { found: false, title: document.title, pageUrl: location.href, bodyTextSample: norm(document.body?.innerText || '').slice(0, 1200), candidates: candidates.map(c => c.text).slice(0, 20) };
        try { target.el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
        const box = target.el.getBoundingClientRect();
        return { found: true, title: document.title, pageUrl: location.href, text: target.text, x: box.left + box.width / 2, y: box.top + box.height / 2, outerHTML: String(target.el.outerHTML || '').slice(0, 3000), parentHTML: String(target.el.parentElement?.outerHTML || '').slice(0, 5000), bodyTextSample: norm(document.body?.innerText || '').slice(0, 1200), candidates: candidates.map(c => c.text).slice(0, 20) };
      },
      args: [identityName]
    });
    const info = probe?.result || {};
    if (!info.found) return { clicked: false, ...info };
    await chrome.tabs.update(tabId, { active: true });
    await sleep(500);
    const target = { tabId };
    await chrome.debugger.attach(target, '1.3');
    try {
      const evalClick = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression: `(() => { const norm=s=>String(s||'').replace(/\\s+/g,' ').trim(); const expected=${JSON.stringify(identityName.toLowerCase())}; const visible=el=>{const b=el&&el.getBoundingClientRect&&el.getBoundingClientRect();return !!b&&b.width>0&&b.height>0}; const els=[...document.querySelectorAll('[role="button"],button,a[href]')].filter(visible); for (const el of els){ let root=el; for(let i=0;root&&root.parentElement&&i<5;i++) root=root.parentElement; const text=norm(el.innerText||el.textContent||el.getAttribute('aria-label')||''); const ctx=norm(root&&root.innerText||root&&root.textContent||''); if (/^(Switch|Switch Now)$/i.test(text) && ctx.toLowerCase().includes(expected) && /switch into|switch to|continue as|use facebook as/i.test(ctx)) { try{el.scrollIntoView({block:'center',inline:'center'}); el.focus&&el.focus(); const r=el.getBoundingClientRect(); const opts={bubbles:true,cancelable:true,view:window,clientX:r.left+r.width/2,clientY:r.top+r.height/2}; for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) el.dispatchEvent(new MouseEvent(t,opts)); el.click&&el.click(); return {clicked:true,text,ctx:ctx.slice(0,500),x:opts.clientX,y:opts.clientY};}catch(e){return {clicked:false,error:e.message,text,ctx:ctx.slice(0,500)}} } } return {clicked:false}; })()`, returnByValue: true });
      try { if (evalClick?.result?.value?.x && evalClick?.result?.value?.y) { info.x = evalClick.result.value.x; info.y = evalClick.result.value.y; info.evalClick = evalClick.result.value; } } catch (_) {}
      await sleep(800);
      await chrome.debugger.sendCommand(target, 'Page.bringToFront').catch(() => {});
      for (let n = 0; n < 3; n++) {
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.x, y: info.y, button: 'none', pointerType: 'mouse' });
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
        await sleep(700);
      }
      for (const key of ['Enter', ' ']) {
        const code = key === ' ' ? 'Space' : 'Enter';
        const vk = key === ' ' ? 32 : 13;
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk });
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
        await sleep(1200);
      }
    } finally {
      try { await chrome.debugger.detach(target); } catch (_) {}
    }
    await sleep(8000);
    const [after] = await chrome.scripting.executeScript({ target: { tabId }, func: (expectedName) => {
      const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
      const strip = v => norm(v).replace(/\s*['’]\s*s\s+(Timeline|profile|page)$/i, '').replace(/\s+(facebook identity|profile|page)$/i, '').replace(/['’]s$/i, '').trim().toLowerCase();
      const expected = strip(expectedName);
      const bad = name => /^(profile picture|photo|your profile|active|facebook|meta|pages?|profiles?|home|watch|marketplace|groups?|notifications?|menu)$/i.test(norm(name || ''));
      const candidates = [];
      const push = value => { const n = norm(value); if (n && !bad(n)) candidates.push(n); };
      document.querySelectorAll('[aria-label="Your profile"], [aria-label*="Your profile"], [aria-label$="profile"], a[aria-label*="profile"], [role="banner"] [aria-label*="profile"]').forEach(el => {
        push(el.querySelector?.('img[alt]')?.getAttribute('alt'));
        const label = el.getAttribute?.('aria-label') || '';
        if (!/Your profile/i.test(label)) push(label);
      });
      document.querySelectorAll('[role="dialog"], [role="menu"], [aria-label*="Account"]').forEach(root => {
        [...root.querySelectorAll('[role="button"], a[href], div')].forEach(el => {
          const rawText = el.innerText || el.textContent || '';
          const text = norm(rawText);
          if (!/See your profile|View your profile|Active/i.test(text)) return;
          rawText.split('\n').map(norm).filter(Boolean).forEach(push);
          push(el.querySelector?.('img[alt]')?.getAttribute('alt'));
        });
      });
      const activeIdentity = candidates.find(c => strip(c) === expected) || candidates[0] || null;
      return { title: document.title, pageUrl: location.href, activeIdentity, verified: !!activeIdentity && strip(activeIdentity) === expected, bodyTextSample: norm(document.body?.innerText || '').slice(0, 1200) };
    }, args: [identityName] });
    const afterResult = after?.result || null;
    return { clicked: true, success: !!afterResult?.verified, active_identity: afterResult?.activeIdentity || null, ...info, after: afterResult };
  } catch (e) {
    try { await chrome.debugger.detach({ tabId }); } catch (_) {}
    return { clicked: false, error: e.message };
  }
}

// Job-aware version: updates job progress and result in jsw_post_jobs
async function importFacebookGroupsForJob(jobId, identityMeta = null, options = {}) {
  const groupScanGuardVersion = 'fb-groups-scraper-v2';
  const identityName = typeof identityMeta === 'string' ? identityMeta : (identityMeta?.name || identityMeta?.identity_name || null);
  const identityKey = (typeof identityMeta === 'object' && (identityMeta?.key || identityMeta?.identity_key)) ? (identityMeta.key || identityMeta.identity_key) : identityName;
  const identityType = (typeof identityMeta === 'object' && (identityMeta?.type || identityMeta?.identity_type)) ? (identityMeta.type || identityMeta.identity_type) : null;
  const identityUrl = (typeof identityMeta === 'object' && (identityMeta?.url || identityMeta?.identity_url)) ? (identityMeta.url || identityMeta.identity_url) : null;
  const finalizeJob = options.finalizeJob !== false;
  const progressPrefix = options.progressPrefix || '';
  const session = await getStoredSession();
  if (!session || !session.userId) {
    await sbUpdateJob(jobId, { status: 'failed', result: { error: 'Not signed in' }, completed_at: new Date().toISOString() });
    return;
  }
  if (!identityName || !identityKey) {
    throw new Error('Group import refused: missing Facebook profile/page owner. Sync profiles first.');
  }

  const updateProgress = async (text) => {
    await sbUpdateJob(jobId, { result: { text: progressPrefix + text } });
    chrome.runtime.sendMessage({ type: 'IMPORT_GROUPS_PROGRESS', text: progressPrefix + text }).catch(() => {});
  };

  let tab;
  try {
    await updateProgress('Opening your Facebook groups...');
    const isManagedPageUrl = /^page$/i.test(String(identityType || '')) || (!!identityUrl && /^https:\/\/(www\.)?facebook\.com\/profile\.php\?id=\d+/i.test(String(identityUrl)));
    let pageScanStrategy = null;
    let allowGenericJoinedGroupsForVerifiedPageSwitch = false;
    let pageSwitchDebug = null;
    if (isManagedPageUrl) {
      const pageGroupsUrl = facebookPageGroupsUrl(identityUrl);
      if (!pageGroupsUrl) throw new Error(`Could not build Page-specific groups URL for ${identityName}`);

      // New scraper path: use the Pages Manager "Switch Now" card first.
      // Page profiles and /groups/joins are not identity-scoped unless Facebook
      // has actually switched the acting profile to that Page.
      await updateProgress(`Switching to ${identityName} from Pages Manager...`);
      tab = await chrome.tabs.create({ url: 'https://www.facebook.com/pages/?category=your_pages', active: true });
      await sleep(8000);
      let managerSwitch = null;
      try {
        managerSwitch = await sendTabMessageWithRetry(tab.id, { type: 'SWITCH_FACEBOOK_MANAGED_PAGE', identityName });
        pageSwitchDebug = managerSwitch;
      } catch (switchError) {
        pageSwitchDebug = { success: false, error: switchError.message, strategy: 'pages_manager_switch' };
        extLog('warn', `Pages Manager switch failed for ${identityName}: ${switchError.message}`);
      }

      if (managerSwitch?.success) {
        await updateProgress(`Opening ${identityName} joined groups...`);
        await chrome.tabs.update(tab.id, { url: 'https://www.facebook.com/groups/joins/?nav_source=tab&ordering=viewer_added' });
        await sleep(9000);
        await assertFacebookActiveIdentity(tab.id, identityName, 'page group import');
        allowGenericJoinedGroupsForVerifiedPageSwitch = true;
        pageScanStrategy = 'pages_manager_switch_then_joined_groups';
      } else {
        // Safe fallback: scrape only the Page-specific Groups tab. If it is empty,
        // return zero instead of contaminating the Page with account-level groups.
        await updateProgress(`Opening ${identityName} page groups tab...`);
        await chrome.tabs.update(tab.id, { url: identityUrl });
        await sleep(8000);
        await chrome.tabs.update(tab.id, { url: pageGroupsUrl });
        await sleep(7000);
        pageScanStrategy = 'page_groups_tab';
      }
    } else {
      tab = await chrome.tabs.create({ url: 'https://www.facebook.com/groups/joins/?nav_source=tab&ordering=viewer_added', active: true });
      await sleep(5000);
      if (identityName) {
        await updateProgress(`Switching to ${identityName}...`);
        const switchRes = await chrome.tabs.sendMessage(tab.id, { type: 'SWITCH_FACEBOOK_IDENTITY', identityName, identityUrl });
        if (!switchRes?.success) throw new Error(switchRes?.error || `Could not switch to ${identityName}`);
        await sleep(4000);
        await chrome.tabs.update(tab.id, { url: 'https://www.facebook.com/groups/joins/?nav_source=tab&ordering=viewer_added' });
        await sleep(5000);
      }
    }

    let groups = [];
    let scanSourceUrl = null;
    let prevCount = -1;
    let passes = 0;
    let lastDebug = null;
    const MAX_PASSES = 30;

    const MIN_PASSES = 5;
    while (passes < MAX_PASSES && (passes < MIN_PASSES || groups.length !== prevCount)) {
      prevCount = groups.length;
      passes++;

      if (passes <= 2) {
        const [expanded] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
            const candidates = [...document.querySelectorAll('a[href*="/groups/joins"], [role="button"], button')]
              .filter(el => /^See all$/i.test(norm(el.innerText || el.textContent || el.getAttribute('aria-label') || '')));
            const target = candidates.find(el => /groups\/joins/i.test(el.href || '')) || candidates[0];
            if (!target) return { clicked: false };
            try { target.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
            target.click();
            return { clicked: true, href: target.href || null, text: norm(target.innerText || target.textContent || target.getAttribute('aria-label') || '') };
          }
        });
        if (expanded?.result?.clicked) await sleep(3500);
      }

      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const found = new Map();
          const pageUrl = location.href;
          const skipSlugs = new Set(['discover', 'feed', 'joins', 'create', 'search', 'membership', 'notifications']);
          const cleanName = (text) => {
            const t = (text || '')
              .replace(/\u00a0/g, ' ')
              .replace(/\s+/g, ' ')
              .replace(/^(Unread|Group:|Facebook group:)\s*/i, '')
              .replace(/Last active.*$/i, '')
              .replace(/\b\d+[smhdw]\b.*$/i, '')
              .trim();
            const notificationMatch = t.match(/\bin\s+(.+?):\s*["“]/i);
            if (notificationMatch) return notificationMatch[1].trim();
            const crosspostMatch = t.match(/crossposted to\s+(.+?)(?:\.\s*\d+[smhdw]?|\.?$)/i);
            if (crosspostMatch) return crosspostMatch[1].trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
            if (/^[A-Z0-9 &'’/()_-]+$/.test(t) && /[A-Z]/.test(t) && t.length > 6) return t.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
            return t;
          };
          const badName = (text) => {
            const t = cleanName(text);
            if (t.length < 3 || t.length > 90) return true;
            if (/^\d+$/.test(t)) return true;
            // Facebook often puts action buttons next to group links. Never save
            // button/action copy as the group name.
            if (/^(new|see all|join|join group|joined|joined group|visit group|view group|member|members|post|posts|comment|comments|notification|notifications)$/i.test(t)) return true;
            if (/\b(left a comment|commented|reacted|shared a post|posted in|new post|see all|sponsored|crossposted|your post was|make progress|grow your audience|follow a few steps)\b/i.test(t)) return true;
            if (/[.!?]\s+[A-Z0-9].*[.!?]/.test(t)) return true;
            return false;
          };
          const slugToName = (slug) => {
            const decoded = decodeURIComponent(slug || '').trim();
            if (/^\d+$/.test(decoded)) return '';
            return decoded
              .replace(/[-_.]+/g, ' ')
              .replace(/\b\w/g, c => c.toUpperCase())
              .trim();
          };
          const imageUrlFromBackground = (backgroundImage) => {
            const match = String(backgroundImage || '').match(/url\(["']?([^"')]+)["']?\)/i);
            return match?.[1] || null;
          };
          const bestSrcFromSet = (srcset='') => {
            const entries = String(srcset || '').split(',')
              .map(part => part.trim().split(/\s+/))
              .filter(parts => parts[0])
              .map(parts => ({ url: parts[0], score: parseFloat(parts[1]) || 1 }));
            entries.sort((a,b) => b.score - a.score);
            return entries[0]?.url || null;
          };
          const cleanImageUrl = (value) => {
            if (!value) return null;
            try { value = new URL(value, location.href).href; } catch (_) {}
            if (!/^(https?:|data:image\/)/i.test(value)) return null;
            if (/static\.xx\.fbcdn\.net\/rsrc|emoji\.php|images\/emoji/i.test(value)) return null;
            return value;
          };
          const extractGroupAvatarUrl = (a) => {
            const roots = [];
            const addRoot = node => { if (node && !roots.includes(node)) roots.push(node); };
            addRoot(a);
            addRoot(a.closest('[role=article], [role=listitem], div'));
            let cur = a;
            for (let i = 0; i < 5 && cur; i++, cur = cur.parentElement) addRoot(cur);
            const candidates = [];
            for (const root of roots) {
              const imgs = [root.matches?.('img') ? root : null, ...root.querySelectorAll?.('img') || []].filter(Boolean);
              imgs.forEach(img => {
                const alt = cleanName(img.getAttribute?.('alt') || '');
                const cls = String(img.className || '');
                const box = img.getBoundingClientRect?.();
                const width = box?.width || img.naturalWidth || 0;
                const height = box?.height || img.naturalHeight || 0;
                if (box && (width < 28 || height < 28)) return;
                const url = cleanImageUrl(img.currentSrc || bestSrcFromSet(img.getAttribute?.('srcset')) || img.src || img.getAttribute?.('src'));
                if (!url) return;
                const iconPenalty = /emoji|icon|logo|verified|chevron|caret|sprite/i.test(`${alt} ${cls}`) ? 100000 : 0;
                const shapeBonus = Math.abs(width - height) <= Math.max(10, Math.min(width, height) * 0.4) ? 5000 : 0;
                candidates.push({ url, score: (width * height) + shapeBonus - iconPenalty });
              });
              const bgNodes = [root, ...root.querySelectorAll?.('[style*="background"], [class]') || []];
              bgNodes.forEach(node => {
                const box = node.getBoundingClientRect?.();
                if (box && (box.width < 28 || box.height < 28)) return;
                const inlineBg = cleanImageUrl(imageUrlFromBackground(node.style?.backgroundImage || node.style?.background || ''));
                const computedBg = cleanImageUrl(imageUrlFromBackground(window.getComputedStyle?.(node)?.backgroundImage || ''));
                const url = inlineBg || computedBg;
                if (url) candidates.push({ url, score: ((box?.width || 40) * (box?.height || 40)) + 1000 });
              });
            }
            return candidates.filter(c => c.score > 0).sort((a,b) => b.score - a.score)[0]?.url || null;
          };
          const candidateTexts = (a) => {
            const out = [];
            const push = (v) => { v = cleanName(v); if (v && !out.includes(v)) out.push(v); };
            const container = a.closest('[role=article], [role=listitem], div');
            push(a.getAttribute('aria-label'));
            const img = a.querySelector('img[alt]') || container?.querySelector('img[alt]');
            if (img) push(img.getAttribute('alt'));
            let el = a;
            for (let i = 0; i < 5 && el; i++, el = el.parentElement) {
              el.querySelectorAll('strong, h1, h2, h3, span[dir=auto], a[role=link] span').forEach(n => push(n.textContent));
            }
            push(a.textContent);
            return out;
          };

          document.querySelectorAll('a[href*="/groups/"]').forEach(a => {
            const href = a.href || '';
            const match = href.match(/facebook\.com\/groups\/([^/?#]+)/);
            if (!match) return;
            const slug = decodeURIComponent(match[1]);
            if (skipSlugs.has(slug)) return;
            if (found.has(slug)) return;
            const name = candidateTexts(a).find(t => !badName(t)) || slugToName(slug);
            if (!name || badName(name)) return;
            found.set(slug, { name, url: `https://www.facebook.com/groups/${encodeURIComponent(slug)}/`, group_avatar_url: extractGroupAvatarUrl(a) });
          });
          const rawGroupLinks = [...document.querySelectorAll('a[href*="/groups/"]')]
            .slice(0, 80)
            .map(a => ({ text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160), href: a.href }));
          const debug = {
            title: document.title,
            pageUrl,
            bodyTextSample: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 2000),
            rawGroupLinkCount: rawGroupLinks.length,
            rawGroupLinks
          };
          return { pageUrl, groups: [...found.values()], debug };
        }
      });

      if (result?.result?.debug) lastDebug = result.result.debug;
      if (result?.result?.pageUrl) {
        scanSourceUrl = result.result.pageUrl;
        assertPageGroupScanSource(identityName, identityType, scanSourceUrl, { allowGenericJoinedGroupsForVerifiedPageSwitch });
      }
      const scrapedGroups = Array.isArray(result?.result) ? result.result : (result?.result?.groups || []);
      if (scrapedGroups.length) {
        const existingSlugs = new Set(groups.map(g => g.url));
        groups = [...groups, ...scrapedGroups.filter(g => !existingSlugs.has(g.url))];
      }

      await updateProgress(`Found ${groups.length} groups, scrolling...`);
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.scrollBy(0, window.innerHeight * 3) });
      await sleep(2500);
    }

    await chrome.tabs.remove(tab.id);
    tab = null;

    if (groups.length === 0) {
      const emptyResult = {
        group_scan_guard_version: groupScanGuardVersion,
        count: 0,
        avatar_count: 0,
        identity_name: identityName,
        identity_key: identityKey,
        identity_type: identityType || null,
        scan_source_url: scanSourceUrl,
        page_scan_strategy: pageScanStrategy || null,
        warnings: [],
        debug: { ...(lastDebug || {}), pageSwitchDebug },
        groups: [],
        text: `No visible joined groups found for ${identityName}`
      };
      if (finalizeJob) {
        await sbUpdateJob(jobId, { status: 'done', result: emptyResult, completed_at: new Date().toISOString() });
      }
      return emptyResult;
    }

    const groupScanWarnings = [];
    if (isPageIdentityType(identityType)) {
      const overlap = await assessAccountLevelGroupOverlap(session, identityName, identityType, groups);
      const pageSourceProof = pageScanStrategy === 'page_groups_tab' && scanSourceUrl && !isGenericJoinedGroupsUrl(scanSourceUrl);
      if (overlap?.high_overlap) {
        groupScanWarnings.push({
          ...overlap,
          severity: pageSourceProof ? 'warning' : 'blocked',
          message: pageSourceProof
            ? 'Saved because the scrape source was the Page-specific Groups tab, but the URL set overlaps the account-level profile list.'
            : 'Blocked because the scrape did not have Page-specific source proof and overlapped the account-level profile list.'
        });
        if (!pageSourceProof) throw new Error(`same account-level groups returned for ${identityName}`);
      }
    }

    await updateProgress(`Saving ${groups.length} groups...`);

    const rows = groups.map(g => ({
      user_id: session.userId,
      group_url: g.url,
      group_name: g.name || null,
      group_avatar_url: g.group_avatar_url || g.avatar_url || g.image_url || null,
      identity_name: identityName,
      identity_key: identityKey,
      identity_type: identityType || null
    }));
    const saveGroupRows = async (chunk, includeAvatars = true) => {
      const bodyRows = includeAvatars ? chunk : chunk.map(({ group_avatar_url, ...row }) => row);
      const saveRes = await fetch(`${SB_URL}/rest/v1/jsw_groups?on_conflict=user_id,identity_key,group_url`, {
        method: 'POST',
        headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(bodyRows)
      });
      if (saveRes.ok) return true;
      const text = await saveRes.text();
      if (includeAvatars && /group_avatar_url|schema cache|column/i.test(text)) {
        extLog('warn', 'group_avatar_url column missing; saving groups without avatars until migration is applied');
        return saveGroupRows(chunk, false);
      }
      throw new Error('Group save failed: ' + text);
    };
    const CHUNK = 50;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await saveGroupRows(rows.slice(i, i + CHUNK));
    }

    extLog('info', `Imported ${groups.length} groups via job ${jobId}`);
    const groupAvatarCount = groups.filter(g => !!(g.group_avatar_url || g.avatar_url || g.image_url)).length;
    const importResult = { group_scan_guard_version: groupScanGuardVersion, count: groups.length, avatar_count: groupAvatarCount, identity_name: identityName, identity_key:identityKey, identity_type: identityType || null, scan_source_url: scanSourceUrl, page_scan_strategy: pageScanStrategy || null, warnings: groupScanWarnings, debug: { ...(lastDebug || {}), pageSwitchDebug }, groups, text: `Imported ${groups.length} groups for ${identityName} · ${groupAvatarCount} photos` };
    if (finalizeJob) {
      await sbUpdateJob(jobId, { status: 'done', result: importResult, completed_at: new Date().toISOString() });
    }
    chrome.runtime.sendMessage({ type: 'IMPORT_GROUPS_DONE', count: groups.length, groups }).catch(() => {});
    return importResult;

  } catch (e) {
    extLog('error', 'importFacebookGroupsForJob error: ' + e.message);
    if (tab) { try { await chrome.tabs.remove(tab.id); } catch (_) {} }
    if (finalizeJob) {
      await sbUpdateJob(jobId, { status: 'failed', result: { error: e.message }, completed_at: new Date().toISOString() });
      return null;
    }
    throw e;
  }
}

async function importFacebookGroups(identityMeta = null) {
  const identityName = typeof identityMeta === 'string' ? identityMeta : (identityMeta?.name || identityMeta?.identity_name || null);
  const identityKey = (typeof identityMeta === 'object' && (identityMeta?.key || identityMeta?.identity_key)) ? (identityMeta.key || identityMeta.identity_key) : identityName;
  const identityType = (typeof identityMeta === 'object' && (identityMeta?.type || identityMeta?.identity_type)) ? (identityMeta.type || identityMeta.identity_type) : null;
  const identityUrl = (typeof identityMeta === 'object' && (identityMeta?.url || identityMeta?.identity_url)) ? (identityMeta.url || identityMeta.identity_url) : null;
  const session = await getStoredSession();
  if (!session || !session.userId) {
    chrome.runtime.sendMessage({ type: 'IMPORT_GROUPS_ERROR', error: 'Not signed in' });
    return;
  }
  if (!identityName || !identityKey) {
    chrome.runtime.sendMessage({ type: 'IMPORT_GROUPS_ERROR', error: 'Group import refused: missing Facebook profile/page owner. Sync profiles first.' });
    return;
  }

  let tab;
  try {
    chrome.runtime.sendMessage({ type: 'IMPORT_GROUPS_PROGRESS', text: 'Opening your Facebook groups...' });

    const isManagedPageUrl = /^page$/i.test(String(identityType || '')) || (!!identityUrl && /^https:\/\/(www\.)?facebook\.com\/profile\.php\?id=\d+/i.test(String(identityUrl)));
    let pageScanStrategy = null;
    if (isManagedPageUrl) {
      const pageGroupsUrl = facebookPageGroupsUrl(identityUrl);
      if (!pageGroupsUrl) throw new Error(`Could not build Page-specific groups URL for ${identityName}`);
      chrome.runtime.sendMessage({ type: 'IMPORT_GROUPS_PROGRESS', text: `Opening ${identityName} page groups tab...` });
      tab = await chrome.tabs.create({ url: identityUrl, active: false });
      await sleep(8000);
      await chrome.tabs.update(tab.id, { url: pageGroupsUrl });
      await sleep(7000);
      pageScanStrategy = 'page_groups_tab';
      chrome.runtime.sendMessage({ type: 'IMPORT_GROUPS_PROGRESS', text: `Verifying active identity for ${identityName}...` }).catch(() => {});
      await assertFacebookActiveIdentity(tab.id, identityName, 'group import');
    } else {
      tab = await chrome.tabs.create({ url: 'https://www.facebook.com/groups/joins/?nav_source=tab&ordering=viewer_added', active: true });
      await sleep(5000);
      if (identityName) {
        chrome.runtime.sendMessage({ type: 'IMPORT_GROUPS_PROGRESS', text: `Switching to ${identityName}...` });
        const switchRes = await chrome.tabs.sendMessage(tab.id, { type: 'SWITCH_FACEBOOK_IDENTITY', identityName, identityUrl });
        if (!switchRes?.success) throw new Error(switchRes?.error || `Could not switch to ${identityName}`);
        await sleep(4000);
        await chrome.tabs.update(tab.id, { url: 'https://www.facebook.com/groups/joins/?nav_source=tab&ordering=viewer_added' });
        await sleep(5000);
      }
    }

    // Scroll and collect — runs multiple passes until no new groups appear
    let groups = [];
    let scanSourceUrl = null;
    let prevCount = -1;
    let passes = 0;
    const MAX_PASSES = 30;

    const MIN_PASSES = 5;
    while (passes < MAX_PASSES && (passes < MIN_PASSES || groups.length !== prevCount)) {
      prevCount = groups.length;
      passes++;

      if (passes <= 2) {
        const [expanded] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
            const candidates = [...document.querySelectorAll('a[href*="/groups/joins"], [role="button"], button')]
              .filter(el => /^See all$/i.test(norm(el.innerText || el.textContent || el.getAttribute('aria-label') || '')));
            const target = candidates.find(el => /groups\/joins/i.test(el.href || '')) || candidates[0];
            if (!target) return { clicked: false };
            try { target.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
            target.click();
            return { clicked: true, href: target.href || null, text: norm(target.innerText || target.textContent || target.getAttribute('aria-label') || '') };
          }
        });
        if (expanded?.result?.clicked) await sleep(3500);
      }

      // Scrape current DOM
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const found = new Map();
          const pageUrl = location.href;
          const skipSlugs = new Set(['discover', 'feed', 'joins', 'create', 'search', 'membership', 'notifications']);
          const cleanName = (text) => {
            const t = (text || '')
              .replace(/\u00a0/g, ' ')
              .replace(/\s+/g, ' ')
              .replace(/^(Unread|Group:|Facebook group:)\s*/i, '')
              .replace(/Last active.*$/i, '')
              .replace(/\b\d+[smhdw]\b.*$/i, '')
              .trim();
            const notificationMatch = t.match(/\bin\s+(.+?):\s*["“]/i);
            if (notificationMatch) return notificationMatch[1].trim();
            const crosspostMatch = t.match(/crossposted to\s+(.+?)(?:\.\s*\d+[smhdw]?|\.?$)/i);
            if (crosspostMatch) return crosspostMatch[1].trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
            if (/^[A-Z0-9 &'’/()_-]+$/.test(t) && /[A-Z]/.test(t) && t.length > 6) return t.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
            return t;
          };
          const badName = (text) => {
            const t = cleanName(text);
            if (t.length < 3 || t.length > 90) return true;
            if (/^\d+$/.test(t)) return true;
            // Facebook often puts action buttons next to group links. Never save
            // button/action copy as the group name.
            if (/^(new|see all|join|join group|joined|joined group|visit group|view group|member|members|post|posts|comment|comments|notification|notifications)$/i.test(t)) return true;
            if (/\b(left a comment|commented|reacted|shared a post|posted in|new post|see all|sponsored|crossposted|your post was|make progress|grow your audience|follow a few steps)\b/i.test(t)) return true;
            if (/[.!?]\s+[A-Z0-9].*[.!?]/.test(t)) return true;
            return false;
          };
          const slugToName = (slug) => {
            const decoded = decodeURIComponent(slug || '').trim();
            if (/^\d+$/.test(decoded)) return '';
            return decoded
              .replace(/[-_.]+/g, ' ')
              .replace(/\b\w/g, c => c.toUpperCase())
              .trim();
          };
          const imageUrlFromBackground = (backgroundImage) => {
            const match = String(backgroundImage || '').match(/url\(["']?([^"')]+)["']?\)/i);
            return match?.[1] || null;
          };
          const bestSrcFromSet = (srcset='') => {
            const entries = String(srcset || '').split(',')
              .map(part => part.trim().split(/\s+/))
              .filter(parts => parts[0])
              .map(parts => ({ url: parts[0], score: parseFloat(parts[1]) || 1 }));
            entries.sort((a,b) => b.score - a.score);
            return entries[0]?.url || null;
          };
          const cleanImageUrl = (value) => {
            if (!value) return null;
            try { value = new URL(value, location.href).href; } catch (_) {}
            if (!/^(https?:|data:image\/)/i.test(value)) return null;
            if (/static\.xx\.fbcdn\.net\/rsrc|emoji\.php|images\/emoji/i.test(value)) return null;
            return value;
          };
          const extractGroupAvatarUrl = (a) => {
            const roots = [];
            const addRoot = node => { if (node && !roots.includes(node)) roots.push(node); };
            addRoot(a);
            addRoot(a.closest('[role=article], [role=listitem], div'));
            let cur = a;
            for (let i = 0; i < 5 && cur; i++, cur = cur.parentElement) addRoot(cur);
            const candidates = [];
            for (const root of roots) {
              const imgs = [root.matches?.('img') ? root : null, ...root.querySelectorAll?.('img') || []].filter(Boolean);
              imgs.forEach(img => {
                const alt = cleanName(img.getAttribute?.('alt') || '');
                const cls = String(img.className || '');
                const box = img.getBoundingClientRect?.();
                const width = box?.width || img.naturalWidth || 0;
                const height = box?.height || img.naturalHeight || 0;
                if (box && (width < 28 || height < 28)) return;
                const url = cleanImageUrl(img.currentSrc || bestSrcFromSet(img.getAttribute?.('srcset')) || img.src || img.getAttribute?.('src'));
                if (!url) return;
                const iconPenalty = /emoji|icon|logo|verified|chevron|caret|sprite/i.test(`${alt} ${cls}`) ? 100000 : 0;
                const shapeBonus = Math.abs(width - height) <= Math.max(10, Math.min(width, height) * 0.4) ? 5000 : 0;
                candidates.push({ url, score: (width * height) + shapeBonus - iconPenalty });
              });
              const bgNodes = [root, ...root.querySelectorAll?.('[style*="background"], [class]') || []];
              bgNodes.forEach(node => {
                const box = node.getBoundingClientRect?.();
                if (box && (box.width < 28 || box.height < 28)) return;
                const inlineBg = cleanImageUrl(imageUrlFromBackground(node.style?.backgroundImage || node.style?.background || ''));
                const computedBg = cleanImageUrl(imageUrlFromBackground(window.getComputedStyle?.(node)?.backgroundImage || ''));
                const url = inlineBg || computedBg;
                if (url) candidates.push({ url, score: ((box?.width || 40) * (box?.height || 40)) + 1000 });
              });
            }
            return candidates.filter(c => c.score > 0).sort((a,b) => b.score - a.score)[0]?.url || null;
          };
          const candidateTexts = (a) => {
            const out = [];
            const push = (v) => { v = cleanName(v); if (v && !out.includes(v)) out.push(v); };
            const container = a.closest('[role=article], [role=listitem], div');
            push(a.getAttribute('aria-label'));
            const img = a.querySelector('img[alt]') || container?.querySelector('img[alt]');
            if (img) push(img.getAttribute('alt'));
            let el = a;
            for (let i = 0; i < 5 && el; i++, el = el.parentElement) {
              el.querySelectorAll('strong, h1, h2, h3, span[dir=auto], a[role=link] span').forEach(n => push(n.textContent));
            }
            push(a.textContent);
            return out;
          };

          document.querySelectorAll('a[href*="/groups/"]').forEach(a => {
            const href = a.href || '';
            const match = href.match(/facebook\.com\/groups\/([^/?#]+)/);
            if (!match) return;
            const slug = decodeURIComponent(match[1]);
            if (skipSlugs.has(slug)) return;
            if (found.has(slug)) return;
            const name = candidateTexts(a).find(t => !badName(t)) || slugToName(slug);
            if (!name || badName(name)) return;
            const cleanUrl = `https://www.facebook.com/groups/${encodeURIComponent(slug)}/`;
            found.set(slug, { name, url: cleanUrl, group_avatar_url: extractGroupAvatarUrl(a) });
          });

          return { pageUrl, groups: [...found.values()] };
        }
      });

      if (result?.result?.pageUrl) {
        scanSourceUrl = result.result.pageUrl;
        assertPageGroupScanSource(identityName, identityType, scanSourceUrl);
      }
      const scrapedGroups = Array.isArray(result?.result) ? result.result : (result?.result?.groups || []);
      if (scrapedGroups.length) {
        const existingSlugs = new Set(groups.map(g => g.url));
        const newOnes = scrapedGroups.filter(g => !existingSlugs.has(g.url));
        groups = [...groups, ...newOnes];
      }

      chrome.runtime.sendMessage({
        type: 'IMPORT_GROUPS_PROGRESS',
        text: `Found ${groups.length} groups, scrolling...`
      });

      // Scroll down to trigger lazy load
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.scrollBy(0, window.innerHeight * 3)
      });

      await sleep(2500);
    }

    await chrome.tabs.remove(tab.id);
    tab = null;

    if (groups.length === 0) {
      chrome.runtime.sendMessage({ type: 'IMPORT_GROUPS_ERROR', error: 'No groups found — make sure you\'re logged in to Facebook' });
      return;
    }

    if (isPageIdentityType(identityType)) {
      const overlap = await assessAccountLevelGroupOverlap(session, identityName, identityType, groups);
      const pageSourceProof = pageScanStrategy === 'page_groups_tab' && scanSourceUrl && !isGenericJoinedGroupsUrl(scanSourceUrl);
      if (overlap?.high_overlap && !pageSourceProof) {
        throw new Error(`same account-level groups returned for ${identityName}`);
      }
    }

    // Save to Supabase — upsert by (user_id, identity_key, group_url)
    chrome.runtime.sendMessage({ type: 'IMPORT_GROUPS_PROGRESS', text: `Saving ${groups.length} groups...` });

    const rows = groups.map(g => ({
      user_id:    session.userId,
      group_url:  g.url,
      group_name: g.name || null,
      group_avatar_url: g.group_avatar_url || g.avatar_url || g.image_url || null,
      identity_name: identityName,
      identity_key: identityKey,
      identity_type: identityType || null
    }));

    // Batch in chunks of 50
    const saveGroupRows = async (chunk, includeAvatars = true) => {
      const bodyRows = includeAvatars ? chunk : chunk.map(({ group_avatar_url, ...row }) => row);
      const saveRes = await fetch(`${SB_URL}/rest/v1/jsw_groups?on_conflict=user_id,identity_key,group_url`, {
        method: 'POST',
        headers: {
          'apikey': SB_ANON_KEY,
          'Authorization': `Bearer ${session.accessToken}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(bodyRows)
      });
      if (saveRes.ok) return true;
      const text = await saveRes.text();
      if (includeAvatars && /group_avatar_url|schema cache|column/i.test(text)) {
        extLog('warn', 'group_avatar_url column missing; saving groups without avatars until migration is applied');
        return saveGroupRows(chunk, false);
      }
      throw new Error('Group save failed: ' + text);
    };
    const CHUNK = 50;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await saveGroupRows(rows.slice(i, i + CHUNK));
    }

    extLog('info', `Imported ${groups.length} groups for user ${session.userId}${identityName ? ' / ' + identityName : ''}`);
    chrome.runtime.sendMessage({ type: 'IMPORT_GROUPS_DONE', count: groups.length, groups, identity_name: identityName, identity_key: identityKey, identity_type: identityType || null });

  } catch (e) {
    extLog('error', 'importFacebookGroups error: ' + e.message);
    chrome.runtime.sendMessage({ type: 'IMPORT_GROUPS_ERROR', error: e.message });
    if (tab) {
      try { await chrome.tabs.remove(tab.id); } catch (_) {}
    }
  }
}

// ============================================================
// BAN/REMOVAL DETECTION — checks if posted URLs are still live
// Runs every 6 hours via the 'check-post-results' alarm
// ============================================================
async function checkPostResults() {
  const session = await getStoredSession();
  if (!session) return;

  // Get posts from last 48h that haven't been checked yet and have a post_url
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  try {
    const res = await fetch(`${SB_URL}/rest/v1/jsw_post_results?user_id=eq.${session.userId}&checked_at=is.null&posted_at=gte.${since}&post_url=not.is.null&select=*`, {
      headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}` }
    });
    const results = await res.json();
    if (!results?.length) return;

    extLog('info', `checkPostResults: checking ${Math.min(results.length, 10)} of ${results.length} results`);

    for (const r of results.slice(0, 10)) { // max 10 per check cycle
      try {
        // Try to fetch the post URL to see if it still exists
        const checkRes = await fetch(r.post_url, { method: 'HEAD' });
        const stillLive = checkRes.ok && checkRes.status < 400;

        // Update result row with check outcome
        await fetch(`${SB_URL}/rest/v1/jsw_post_results?id=eq.${r.id}`, {
          method: 'PATCH',
          headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ checked_at: new Date().toISOString(), still_live: stillLive })
        });

        // If removed, increment removal_count and escalate ban_risk
        if (!stillLive) {
          extLog('warn', `Post removed detected for group: ${r.group_url}`);
          const groupRes = await fetch(`${SB_URL}/rest/v1/jsw_groups?user_id=eq.${session.userId}&group_url=eq.${encodeURIComponent(r.group_url)}&select=removal_count`, {
            headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}` }
          });
          const groups = await groupRes.json();
          const newCount = (groups?.[0]?.removal_count || 0) + 1;
          const banRisk = newCount >= 3 ? 'high' : newCount >= 1 ? 'medium' : 'low';
          await fetch(`${SB_URL}/rest/v1/jsw_groups?user_id=eq.${session.userId}&group_url=eq.${encodeURIComponent(r.group_url)}`, {
            method: 'PATCH',
            headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
            body: JSON.stringify({ removal_count: newCount, ban_risk: banRisk })
          });
          extLog('warn', `Group ${r.group_url} ban_risk updated to ${banRisk} (removal_count: ${newCount})`);
        }

        await sleep(2000); // don't hammer FB
      } catch(e) {
        extLog('warn', 'checkPostResults error: ' + e.message);
      }
    }
  } catch (e) {
    extLog('error', 'checkPostResults fetch error: ' + e.message);
  }
}
