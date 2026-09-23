// ============ Amplr Background Worker v2.1.3 ============
// Orchestrates posting queue, AI refinement, and scheduled posts via chrome.alarms.

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Manifest V3 may suspend an idle service worker after roughly 30 seconds.
// Posting batches intentionally wait 90–210 seconds between groups, so a plain
// timer can strand a claimed local-fallback job after a successful/ambiguous
// submission. Keep the worker alive with a harmless extension API call while
// that deliberate anti-bot delay is in progress.
async function sleepWithWorkerKeepalive(ms) {
  const intervalMs = 15_000;
  let timer = null;
  try {
    timer = setInterval(() => {
      chrome.runtime.getPlatformInfo().catch(() => {});
    }, intervalMs);
    await sleep(ms);
  } finally {
    if (timer) clearInterval(timer);
  }
}

const EXT_VERSION = chrome.runtime.getManifest?.().version || 'unknown';
const WORKER_INSTALL_ID_KEY = 'reachr_worker_install_id';
let workerInstallIdPromise = null;
async function getWorkerInstallId() {
  if (!workerInstallIdPromise) workerInstallIdPromise = (async () => {
    const stored = await chrome.storage.local.get(WORKER_INSTALL_ID_KEY);
    if (typeof stored?.[WORKER_INSTALL_ID_KEY] === 'string' && stored[WORKER_INSTALL_ID_KEY]) return stored[WORKER_INSTALL_ID_KEY];
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ [WORKER_INSTALL_ID_KEY]: id });
    return id;
  })();
  return workerInstallIdPromise;
}
const CONNECTION_STATUS_KEY = 'extension_status';
const DAILY_GROUP_SCAN_ALARM = 'daily-group-scan';
const DAILY_GROUP_SCAN_HOUR_LOCAL = 7;
const DAILY_GROUP_SCAN_MINUTE_LOCAL = 15;
const LOCAL_FALLBACK_JOB_QUEUE_KEY = 'amplr_local_fallback_jobs';
const LOCAL_FALLBACK_RESULT_LOG_KEY = 'amplr_local_fallback_results';

// Software-level anti-bot safety controls. These reduce automated-looking
// posting patterns and stop when Facebook shows block/checkpoint signals.
// They are safeguards, not stealth/captcha-bypass logic.
const ANTI_BOT = {
  maxGroupsPerJob: 8,
  hardCooldownDays: 0,
  minDelaySeconds: 15,
  maxDelaySeconds: 35,
  scheduleJitterMinutes: 75,
  skipBanRisk: new Set(['medium', 'high']),
  dailyUserPostCap: 120
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

function clampInt(value, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function runnerControlsFromSettings(settings = {}) {
  return {
    maxGroupsPerJob: clampInt(settings.maxGroups ?? settings.max_groups_per_job, ANTI_BOT.maxGroupsPerJob, 1, 100),
    cooldownDays: clampInt(settings.cooldown_days, ANTI_BOT.hardCooldownDays, 0, 30),
    dailyPostCap: clampInt(settings.daily_post_cap ?? settings.dailyUserPostCap, ANTI_BOT.dailyUserPostCap, 1, 200),
    scheduleJitterMinutes: clampInt(settings.jitter ?? settings.schedule_jitter_minutes, ANTI_BOT.scheduleJitterMinutes, 0, 180),
    minDelaySeconds: Math.max(clampInt(settings.delay ?? settings.default_delay, ANTI_BOT.minDelaySeconds, 1, 3600), ANTI_BOT.minDelaySeconds)
  };
}

async function fetchDashboardRunnerControls(session = null) {
  session = session || dashSession || await getStoredSession();
  if (!session?.userId || !session?.accessToken) return runnerControlsFromSettings({});
  const merged = {};
  try {
    const res = await fetch(`${SB_URL}/rest/v1/amplr_data?user_id=eq.${session.userId}&key=eq.settings&select=value`, {
      headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}` }
    });
    if (res.ok) {
      const rows = await res.json();
      Object.assign(merged, rows?.[0]?.value || {});
    }
  } catch (e) {
    extLog('warn', 'runner controls amplr_data load failed: ' + e.message);
  }
  try {
    const res = await fetch(`${SB_URL}/rest/v1/jsw_settings?user_id=eq.${session.userId}&select=default_delay,max_groups_per_job,daily_post_cap,cooldown_days,schedule_jitter_minutes`, {
      headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}` }
    });
    if (res.ok) {
      const rows = await res.json();
      Object.assign(merged, rows?.[0] || {});
    }
  } catch (e) {
    extLog('warn', 'runner controls jsw_settings load failed: ' + e.message);
  }
  return runnerControlsFromSettings(merged);
}

function slugifyTrackingValue(value, fallback = 'unknown') {
  const cleaned = String(value || '')
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

function trackingCampaignName(job) {
  const text = JSON.stringify({ message: job?.message, groups: job?.groups, campaign: job?.campaign_name }, null, 0).toLowerCase();
  if (/rose|wildrose|front desk|website lead|small business automation/.test(text)) return 'wildrose-rose';
  if (/empty slot|emptyslot|last-minute vet|vet appointment|clinic openings/.test(text)) return 'empty-slot';
  const firstGroup = Array.isArray(job?.groups) ? job.groups[0] : null;
  return slugifyTrackingValue(job?.campaign_name || firstGroup?.identity_name || 'amplr-campaign', 'amplr-campaign');
}

function creativeTrackingId(job, finalText) {
  const explicit = job?.creative_id || job?.creative_name || job?.ad_name || null;
  if (explicit) return slugifyTrackingValue(explicit, 'creative');
  let hash = 0;
  const source = String(finalText || job?.message || 'creative');
  for (let i = 0; i < source.length; i++) hash = ((hash << 5) - hash + source.charCodeAt(i)) | 0;
  return `copy-${Math.abs(hash).toString(36)}`;
}

function shouldTrackOutboundUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (!/^https?:$/.test(url.protocol)) return false;
    if (host.includes('facebook.com') || host.includes('fb.com') || host.includes('messenger.com')) return false;
    return true;
  } catch (_) {
    return false;
  }
}

function addTrackingParamsToMessage(message, { job, target, groupUrl, finalText } = {}) {
  const source = String(message || '');
  const urls = source.match(/https?:\/\/[^\s<>)"']+/g) || [];
  if (!urls.length) return { message: source, tracked_url_count: 0, tracking: null };

  const campaign = trackingCampaignName(job || {});
  const creative = creativeTrackingId(job || {}, finalText || source);
  const groupName = target?.name || target?.group_name || groupUrl || 'group';
  const groupSlug = slugifyTrackingValue(groupName, 'group');
  let trackedCount = 0;
  let output = source;

  [...new Set(urls)].forEach(raw => {
    const trailing = (raw.match(/[.,!?;:]+$/) || [''])[0];
    const cleanRaw = trailing ? raw.slice(0, -trailing.length) : raw;
    if (!shouldTrackOutboundUrl(cleanRaw)) return;
    try {
      const u = new URL(cleanRaw);
      const actor = slugifyTrackingValue(target?.identity_name || target?.profile_name || job?.identity_name || 'unknown-actor', 'unknown-actor');
      const groupUrlSlug = slugifyTrackingValue(groupUrl || target?.url || groupName || 'group', 'group');
      const jobId = job?.id ? String(job.id).slice(0, 12) : '';
      u.searchParams.set('utm_source', 'facebook_group');
      u.searchParams.set('utm_medium', 'reachr');
      u.searchParams.set('utm_campaign', campaign);
      u.searchParams.set('utm_content', creative);
      u.searchParams.set('utm_term', groupSlug);
      u.searchParams.set('reachr_campaign', campaign);
      u.searchParams.set('reachr_group', groupSlug);
      u.searchParams.set('reachr_group_url', groupUrlSlug);
      u.searchParams.set('reachr_actor', actor);
      if (jobId) {
        u.searchParams.set('reachr_job', jobId);
        u.searchParams.set('amplr_job', jobId.slice(0, 8));
      }
      u.searchParams.set('amplr_group', groupSlug);
      const tracked = u.toString() + trailing;
      output = output.split(raw).join(tracked);
      trackedCount++;
    } catch (_) {}
  });

  return {
    message: output,
    tracked_url_count: trackedCount,
    tracking: trackedCount ? { campaign, creative, group: groupSlug } : null
  };
}

// ============ HANDLE MESSAGES FROM POPUP ============
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_POSTING') {
    runPostingQueue(msg, sender);
  } else if (msg.type === 'IMPORT_GROUPS') {
    importFacebookGroups(msg.identity || msg.identityMeta || null);
  } else if (msg.type === 'CHECK_FACEBOOK_SESSION') {
    requireFacebookSessionForGroupScan()
      .then(() => sendResponse({ available: true }))
      .catch(error => sendResponse({ available: false, code: error?.code || 'facebook_login_required', error: error?.message || 'Facebook login required.' }));
    return true;
  } else if (msg.type === 'NATIVE_TYPE_FACEBOOK_DRAFT') {
    // Some Facebook composer variants ignore isolated-world DOM input events.
    // The content script has already focused its verified visible textbox; send
    // native DevTools text only to that same tab, then let content re-verify.
    // Bound debugger I/O so a hung DevTools transport cannot leave the outer
    // POST_TO_PAGE channel open until its much longer delivery timeout.
    (async () => {
      const tabId = sender?.tab?.id;
      // MessageSender fields are supplied by Chrome, not by the message body.
      // URL/frame/documentId identify a top-level content document (Chrome 106+).
      // Optional origin/lifecycle/id, when supplied, must not contradict it.
      let senderUrl;
      try { senderUrl = new URL(sender?.url); } catch (_) {}
      if (!Number.isInteger(tabId) || tabId < 0 || sender?.frameId !== 0
          || !senderUrl || senderUrl.protocol !== 'https:'
          || !/^(?:[a-z0-9-]+\.)*facebook\.com$/.test(senderUrl.hostname)
          || senderUrl.username || senderUrl.password || senderUrl.port
          || (sender.origin !== undefined && sender.origin !== senderUrl.origin)
          || (sender.id !== undefined && sender.id !== chrome.runtime.id)
          || (sender.documentLifecycle !== undefined && sender.documentLifecycle !== 'active')
          || typeof sender.documentId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(sender.documentId)
          || typeof msg.editorToken !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(msg.editorToken)
          || typeof msg.documentToken !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(msg.documentToken)
          || typeof msg.documentUrl !== 'string' || msg.documentUrl !== sender.url
          || typeof msg.text !== 'string' || !msg.text) {
        return sendResponse({ ok: false, error: 'invalid_native_type_request' });
      }
      const target = { tabId };
      if (nativeTypeOperations.has(tabId)) {
        return sendResponse({ ok: false, error: 'native_type_busy' });
      }
      const operation = { documentId: sender.documentId };
      nativeTypeOperations.set(tabId, operation);
      const ownsOperation = () => nativeTypeOperations.get(tabId) === operation;
      let attached = false;
      let attachPending = true;
      let cleanupPromise;
      let cancelled = false;
      const deadline = Date.now() + 7000;
      const expired = () => cancelled || !ownsOperation() || Date.now() >= deadline;
      const cleanup = () => {
        // A pending attach can still acquire this tab after the response timeout.
        // Keep ownership until that attach settles and its detach completes.
        if (attachPending || !ownsOperation()) return;
        if (!cleanupPromise) cleanupPromise = (async () => {
          if (attached) {
            try { await chrome.debugger.detach(target); } catch (_) { return; }
          }
          if (ownsOperation()) nativeTypeOperations.delete(tabId);
        })();
        return cleanupPromise;
      };
      let timer;
      try {
        await Promise.race([
          (async () => {
            try {
              await chrome.debugger.attach(target, '1.3');
              attached = true;
            } finally {
              attachPending = false;
              if (expired()) await cleanup();
            }
            if (expired()) throw new Error('native_type_timeout');
            // Background renderers may ignore selection/newlines without focus.
            // Emulate renderer focus only; never raise the user's OS window.
            await chrome.debugger.sendCommand(target, 'Emulation.setFocusEmulationEnabled', { enabled: true });
            if (expired()) throw new Error('native_type_timeout');
            const focused = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
              expression: `(() => {
                const editorToken = ${JSON.stringify(msg.editorToken)};
                const documentToken = ${JSON.stringify(msg.documentToken)};
                if (!editorToken || !documentToken || location.href !== ${JSON.stringify(msg.documentUrl)} || document.documentElement.getAttribute('data-reachr-native-document') !== documentToken) return false;
                const boxes = [...document.querySelectorAll('[data-reachr-native-editor]')].filter(el => el.getAttribute('data-reachr-native-editor') === editorToken);
                if (boxes.length !== 1) return false;
                const box = boxes[0];
                if (!box.isConnected || box.ownerDocument !== document || !box.isContentEditable || !box.closest('[role="dialog"]') || !box.getBoundingClientRect().height) return false;
                if (document.activeElement !== box && !box.contains(document.activeElement)) return false;
                const range = document.createRange();
                range.selectNodeContents(box);
                const selection = document.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
                return true;
              })()`, returnByValue: true
            });
            if (expired()) throw new Error('native_type_timeout');
            if (focused?.result?.value !== true) throw new Error('native_composer_focus_unverified');
            await chrome.debugger.sendCommand(target, 'Input.insertText', { text: msg.text });
            // Dispatched commands cannot be recalled; late completion is not success.
            if (expired()) throw new Error('native_type_timeout');
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              cancelled = true;
              reject(new Error('native_type_timeout'));
            }, 7000);
          })
        ]);
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || 'native_type_failed' });
      } finally {
        if (timer) clearTimeout(timer);
        await cleanup();
      }
    })();
    return true;
  }
});

// Held per tab, not per document: navigation must not admit competing input.
const nativeTypeOperations = new Map();

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

async function getStoredDashboardIdentity() {
  // This is deliberately identity-only: it is used to scope local duplicate
  // holds while dashboard authentication is unavailable, never to authorize a
  // remote call or recover credentials.
  const data = await chrome.storage.local.get(['jsw_session']);
  const session = data.jsw_session;
  const userId = session?.userId || session?.user?.id || session?.user_id || null;
  return typeof userId === 'string' && userId ? userId : null;
}

const sessionRefreshFlights = new Map();

async function getStoredSession() {
  const revision = sessionAuthRevision;
  const data = await chrome.storage.local.get(['jsw_session']);
  if (revision !== sessionAuthRevision) return null;
  let session = data.jsw_session;
  if (!session || !session.userId) return null;

  // Supabase access tokens expire. If we keep using the old token, the
  // dashboard heartbeat silently stops and Amplr looks "unpaired" again.
  const declaredExpiresMs = session.expiresAt ? Number(session.expiresAt) * 1000 : 0;
  let tokenExpiresMs = 0;
  try {
    const payload = String(session.accessToken || '').split('.')[1];
    if (payload) {
      const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
      const exp = JSON.parse(atob(normalized)).exp;
      if (Number.isFinite(Number(exp))) tokenExpiresMs = Number(exp) * 1000;
    }
  } catch (_) {}
  // Treat the token's signed expiration as authoritative when present. This
  // prevents a stale storage field from keeping an already-expired JWT alive.
  const expiresMs = tokenExpiresMs || declaredExpiresMs;
  const shouldRefresh = session.refreshToken && (!expiresMs || expiresMs - Date.now() < 120000);
  if (!shouldRefresh) {
    dashSession = session;
    return session;
  }

  const key = JSON.stringify([session.userId, session.accessToken, session.refreshToken, session.expiresAt]);
  if (!sessionRefreshFlights.has(key)) {
    const flight = refreshStoredSession(session, expiresMs, revision).finally(() => sessionRefreshFlights.delete(key));
    sessionRefreshFlights.set(key, flight);
  }
  return sessionRefreshFlights.get(key);
}

async function refreshStoredSession(session, expiresMs, revision) {
  const original = JSON.stringify(session);
  const isCurrent = async () => {
    const { jsw_session: current } = await chrome.storage.local.get('jsw_session');
    return revision === sessionAuthRevision && JSON.stringify(current) === original;
  };
  try {
    const controller = new AbortController();
    let timer;
    let refreshed;
    try {
      refreshed = await Promise.race([
        (async () => {
          const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=refresh_token`, {
            method: 'POST',
            headers: { 'apikey': SB_ANON_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: session.refreshToken }),
            signal: controller.signal,
          });
          if (!res.ok) throw Object.assign(new Error(`Supabase auth HTTP ${res.status}`), { status: res.status });
          const body = await res.json();
          if (!body?.access_token) throw new Error('Invalid Supabase refresh response');
          return body;
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('Supabase auth refresh timeout'));
            controller.abort();
          }, 10_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }

    if (!await isCurrent()) return null;
    session = {
      ...session,
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token || session.refreshToken,
      expiresAt: refreshed.expires_at || Math.floor(Date.now() / 1000) + (refreshed.expires_in || 3600),
      refreshPending: false,
    };
    delete session.refreshError;
    delete session.lastRefreshAttempt;
    return await withSessionAuthWrite(async () => {
      if (!await isCurrent()) return null;
      await chrome.storage.local.set({ jsw_session: session });
      if (revision !== sessionAuthRevision) return null;
      dashSession = session;
      return session;
    });
  } catch (e) {
    if (!await isCurrent()) return null;
    console.warn('[JSW] Supabase session refresh failed:', e.message);
    // Keep the refresh token for passwordless reconnect/retry. Clearing storage
    // on a transient Supabase/Auth outage forces Jack back through a password
    // form even though the browser still has a reusable refresh token.
    const transient = /Failed to fetch|NetworkError|timeout|522|5\d\d/i.test(String(e?.message || e));
    if (expiresMs && expiresMs <= Date.now()) {
      session = { ...session, refreshPending: transient, refreshError: String(e?.message || e), lastRefreshAttempt: Date.now() };
      const saved = await withSessionAuthWrite(async () => {
        if (!await isCurrent()) return false;
        await chrome.storage.local.set({ jsw_session: session });
        if (revision !== sessionAuthRevision) return false;
        dashSession = null;
        return true;
      });
      if (!saved) return null;
      // Reporting is best-effort and must never gate local auth/fallback progress.
      Promise.resolve().then(() => writeExtensionStatus(session, 'offline', {
        error: transient ? 'Supabase auth temporarily unavailable; will retry saved session' : 'Supabase session expired and refresh failed'
      })).catch(() => {});
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
let sessionAuthRevision = 0;
let sessionAuthWriteTail = Promise.resolve();
function withSessionAuthWrite(operation) {
  const result = sessionAuthWriteTail.then(operation);
  sessionAuthWriteTail = result.catch(() => {});
  return result;
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PAIRING_CONNECTED') {
    dashSession = msg.pairing;
    startDashPolling().catch(e => console.warn('[JSW] start polling failed:', e.message));
    writeHeartbeat();
    extLog('info', `Session connected, polling started for ${dashSession.userId} on v${EXT_VERSION}`);
  } else if ((msg.type === 'DASHBOARD_SESSION_IMPORT' || msg.type === 'POPUP_SESSION_IMPORT') && msg.session?.userId && msg.session?.accessToken && msg.session?.refreshToken) {
    // Separate popup admission from the existing dashboard bridge contract.
    // Content scripts (including dashboard tabs) cannot impersonate popup login.
    if (msg.type === 'POPUP_SESSION_IMPORT' &&
        (sender?.id !== chrome.runtime.id || sender?.url !== chrome.runtime.getURL('popup.html') || sender?.tab)) {
      sendResponse?.({ ok: false, error: 'invalid_popup_session_sender' });
      return false;
    }
    sessionAuthRevision++;
    // Scheduler ownership belongs to this installation/account, not a fresh
    // dashboard auth payload. Re-login must not silently disable the cutover,
    // and a different account must never inherit it. Persist before polling.
    withSessionAuthWrite(async () => {
      const { jsw_session: previous } = await chrome.storage.local.get('jsw_session');
      const imported = { ...msg.session, durableSchedulerV1:
        previous?.userId === msg.session.userId && previous?.durableSchedulerV1 === true };
      await chrome.storage.local.set({ jsw_session: imported,
        ...(msg.type === 'DASHBOARD_SESSION_IMPORT' ? { amplr_onboarding_done: true }
          : previous?.userId !== imported.userId ? { amplr_onboarding_done: false } : {}) });
      dashSession = imported;
      return imported;
    }).then(async imported => {
      sendResponse?.({ ok: true, session: imported });
      await startDashPolling();
      writeHeartbeat();
      extLog('info', `Dashboard session imported, polling started for ${imported.userId} on v${EXT_VERSION}`);
    }, e => {
      sendResponse?.({ ok: false, error: e.message });
      console.warn('[JSW] session import failed:', e.message);
    }).catch(e => console.warn('[JSW] session polling startup failed:', e.message));
    return true;
  } else if (msg.type === 'QUEUE_LOCAL_FALLBACK_JOB' && msg.job) {
    saveLocalFallbackJob(msg.job)
      .then(job => {
        chrome.alarms.create('poll-jobs', { periodInMinutes: 0.5 }).catch(() => {});
        pollLocalFallbackJobs().catch(() => {});
        startDashPolling().catch(() => {});
        sendResponse?.({ ok: true, job });
      })
      .catch(error => sendResponse?.({ ok: false, error: error.message }));
    return true;
  } else if (msg.type === 'GET_LOCAL_FALLBACK_JOB' && msg.jobId) {
    readLocalFallbackJobs()
      .then(jobs => sendResponse?.({ ok: true, job: jobs.find(job => job.id === msg.jobId) || null }))
      .catch(error => sendResponse?.({ ok: false, error: error.message }));
    return true;
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
  const revision = sessionAuthRevision;
  const session = await getStoredSession();
  // A popup/dashboard import can complete while a suspended worker is
  // refreshing its startup snapshot. That newer import owns dashSession and
  // polling; this stale continuation must not clear or overwrite it.
  if (revision !== sessionAuthRevision) return;
  if (session && session.userId) {
    dashSession = session;
    await startDashPolling();
    extLog('info', `Resumed polling for user ${dashSession.userId} on v${EXT_VERSION}`);
  } else {
    dashSession = null;
    if (await hasPendingLocalFallbackJobs()) {
      await startLocalFallbackPolling();
      extLog('warn', `Dashboard session unavailable; resumed local fallback polling on v${EXT_VERSION}`);
    } else {
      extLog('warn', `No valid stored session on startup for v${EXT_VERSION}`);
    }
  }
}

async function hasPendingLocalFallbackJobs() {
  const jobs = await readLocalFallbackJobs();
  return jobs.some(job => job?.status === 'pending');
}

async function startLocalFallbackPolling() {
  // Local fallback is intentionally independent of dashboard authentication.
  // Its executor still requires a valid Facebook session before it claims work.
  await chrome.alarms.clear('poll-jobs');
  await chrome.alarms.create('poll-jobs', { periodInMinutes: 0.5 });
  pollFacebookWork();
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
  pollFacebookWork();
  await chrome.alarms.create('poll-jobs', { periodInMinutes: 0.5 }); // every 30s
  await chrome.alarms.create('amplr_heartbeat', { periodInMinutes: 0.5 }); // every 30s
  await chrome.alarms.create('check-post-results', { periodInMinutes: 360 }); // every 6h
  // Pause unattended group scans until joined-group provenance can be verified.
  await chrome.alarms.clear(DAILY_GROUP_SCAN_ALARM);
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

// One cycle across all sources; busy ticks are skipped, never queued up.
let facebookPollInFlight = false;
async function pollFacebookWork() {
  if (facebookPollInFlight || activeDashJobId !== null) return false;
  facebookPollInFlight = true;
  try {
    // Claiming a job is a state change. Authenticate before touching either
    // queue so a stale/expired Facebook session cannot strand a local job in
    // `processing` before the per-target checks run.
    await requireFacebookSessionForGroupScan();
    await pollPendingJobs();
    await pollLocalFallbackJobs();
    await pollGroupLookups();
    return true;
  } catch (e) {
    extLog('error', 'Facebook poll cycle failed: ' + e.message);
    return false;
  } finally {
    facebookPollInFlight = false;
  }
}

// Heartbeat and poll-jobs alarm handler
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'amplr_heartbeat') writeHeartbeat();
  else if (alarm.name === 'poll-jobs') { pollFacebookWork(); }
  else if (alarm.name === 'check-post-results') { checkPostResults(); }
  else if (alarm.name === DAILY_GROUP_SCAN_ALARM) { chrome.alarms.clear(DAILY_GROUP_SCAN_ALARM); }
});

// ─── Group name lookup ───
async function pollGroupLookups() {
  if (activeDashJobId !== null) return false;
  activeDashJobId = 'group-lookup';
  try {
    return await pollGroupLookupsUnlocked();
  } finally {
    activeDashJobId = null;
  }
}

async function pollGroupLookupsUnlocked() {
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
    const claiming = patch.status === 'processing';
    const res = await fetch(`${SB_URL}/rest/v1/jsw_group_lookups?id=eq.${encodeURIComponent(lookupId)}${claiming ? '&status=eq.pending' : ''}`, {
      method: 'PATCH',
      headers: {
        'apikey': SB_ANON_KEY,
        'Authorization': `Bearer ${session.accessToken}`,
        'Content-Type': 'application/json',
        'Prefer': claiming ? 'return=representation' : 'return=minimal'
      },
      body: JSON.stringify(patch)
    });
    if (!res.ok) return false;
    if (!claiming) return true;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length === 1 && String(rows[0].id) === String(lookupId);
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
      worker_install_id: await getWorkerInstallId(),
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

// DOM attribution is not independent publication verification. A legacy success
// without explicit proof is still an attempted submission, never a publication.
function submissionEvidenceOutcome(response, groupUrl) {
  let attributableUrl = null;
  let candidateUrl = null;
  try {
    const post = new URL(response?.postUrl);
    const group = new URL(groupUrl);
    const postPath = post.pathname.match(/^\/groups\/([^/]+)\/(?:posts|permalink)\/([0-9]+)\/?$/);
    const groupPath = group.pathname.match(/^\/groups\/([^/]+)\/?$/);
    if (post.protocol === 'https:' && /^(www\.|m\.)?facebook\.com$/.test(post.hostname)
        && !post.username && !post.password && !post.port && postPath && groupPath
        && postPath[1] === groupPath[1]) attributableUrl = post.href;
  } catch (_) {}
  // A candidate remains a manual-review link only: validate it as tightly as a
  // post URL, but never allow it to influence verification or posted status.
  try {
    const candidate = new URL(response?.candidatePermalink);
    const group = new URL(groupUrl);
    const candidatePath = candidate.pathname.match(/^\/groups\/([^/]+)\/(?:posts|permalink)\/([0-9]+)\/?$/);
    const groupPath = group.pathname.match(/^\/groups\/([^/]+)\/?$/);
    if (candidate.protocol === 'https:' && /^(www\.|m\.)?facebook\.com$/.test(candidate.hostname)
        && !candidate.username && !candidate.password && !candidate.port && candidatePath && groupPath
        && candidatePath[1] === groupPath[1]) candidateUrl = candidate.href;
  } catch (_) {}
  const verified = response?.success === true && response?.submitted === true
    && response?.composerIdentityVerified === true && response?.publicationVerified === true
    && response?.evidenceFound === true && response?.evidenceStatus === 'matched_new_permalink'
    && !!attributableUrl;
  return {
    ...(response?.submitted === true && response?.composerIdentityVerified === true
      && response?.submissionDeliveryUnknown !== true && response?.publicationVerified !== true
      && response?.evidenceStatus === 'pending_approval' ? { pending_approval: true } : {}),
    status: verified ? 'posted' : 'submitted_unconfirmed',
    publication_verified: verified,
    post_url: attributableUrl,
    evidence_status: response?.evidenceStatus || 'legacy_unconfirmed',
    // Use the deployed durable reason field; adding a new payload column would
    // break older dashboard schemas. The prefix makes non-verification explicit.
    evidence_reason: response?.evidenceReason || (candidateUrl ? `candidate_permalink_unattributed:${candidateUrl}` : null)
  };
}

async function countRecentPostedResults(session, sinceIso) {
  try {
    const res = await fetch(`${SB_URL}/rest/v1/jsw_post_results?user_id=eq.${encodeURIComponent(session.userId)}&posted_at=gte.${encodeURIComponent(sinceIso)}&select=id&limit=1`, {
      headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}`, 'Prefer': 'count=exact' }
    });
    if (!res.ok) return null;
    // PostgREST may paginate rows; only its exact total covers the full window.
    const range = res.headers.get('content-range');
    const match = /^(?:\d+-\d+|\*)\/(\d+)$/.exec(range || '');
    const count = match ? Number(match[1]) : NaN;
    return Number.isSafeInteger(count) && count >= 0 ? count : null;
  } catch (e) {
    extLog('warn', 'recent post cap check failed: ' + e.message);
    return null;
  }
}

async function readLocalFallbackJobs() {
  const data = await chrome.storage.local.get([LOCAL_FALLBACK_JOB_QUEUE_KEY]);
  return Array.isArray(data[LOCAL_FALLBACK_JOB_QUEUE_KEY]) ? data[LOCAL_FALLBACK_JOB_QUEUE_KEY] : [];
}

async function writeLocalFallbackJobs(jobs) {
  await chrome.storage.local.set({ [LOCAL_FALLBACK_JOB_QUEUE_KEY]: jobs });
}

// Serialize every queue read/modify/write, not just execution: dashboard enqueue
// can arrive while a claim or completion is awaiting chrome.storage.
let localFallbackMutation = Promise.resolve();
async function saveLocalFallbackJob(payload) {
  if (payload?.occurrence_id != null) throw new Error('Durable occurrence must remain in the cloud queue');
  const operation = localFallbackMutation.then(async () => {
  const now = new Date().toISOString();
  const jobs = await readLocalFallbackJobs();
  const job = {
    ...payload,
    id: payload.id || `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    status: payload.status || 'pending',
    created_at: payload.created_at || now,
    updated_at: now,
    local_fallback: true,
    local_fallback_synced: false,
    result: payload.result || { text: 'Queued locally because Supabase is temporarily unavailable.' }
  };
  jobs.push(job);
  // Bound terminal history only. Never evict unfinished, paused or unknown work.
  const terminalStatuses = new Set(['done', 'failed', 'cancelled', 'canceled']);
  let historyToDrop = Math.max(0, jobs.filter(j => terminalStatuses.has(j?.status)).length - 100);
  const retained = jobs.filter(j => {
    if (historyToDrop > 0 && terminalStatuses.has(j?.status)) {
      historyToDrop--;
      return false;
    }
    return true;
  });
  await writeLocalFallbackJobs(retained);
  extLog('warn', `Queued local fallback job ${job.id}`);
  return job;
  });
  localFallbackMutation = operation.catch(() => {});
  return operation;
}

async function updateLocalFallbackJob(jobId, patch, expected = {}) {
  const operation = localFallbackMutation.then(async () => {
  const jobs = await readLocalFallbackJobs();
  const now = new Date().toISOString();
  let found = false;
  const next = jobs.map(job => {
    if (job.id !== jobId) return job;
    // Compare-and-set protects claims and lifecycle checkpoints from a stale
    // service worker completing a newer execution owner's job.
    if (expected.status && job.status !== expected.status) return job;
    if (expected.execution_owner && job.execution_owner !== expected.execution_owner) return job;
    if (patch.status === 'processing' && job.status !== 'pending') return job;
    found = true;
    return { ...job, ...patch, updated_at: now };
  });
  if (found) await writeLocalFallbackJobs(next);
  return found;
  });
  localFallbackMutation = operation.catch(() => {});
  return operation;
}

// BEGIN LOCAL EXECUTION LIFECYCLE
// Local fallback is the only runner available during a dashboard-auth outage.
// Keep its state machine in chrome.storage so a worker death cannot silently
// turn an ambiguous Facebook command into a retryable pending job.
const LOCAL_EXECUTION_LEASE_MS = 5 * 60 * 1000;
function newLocalExecutionLease() {
  const now = new Date();
  return {
    owner: (globalThis.crypto?.randomUUID?.() || `lease-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    started_at: now.toISOString(),
    expires_at: new Date(now.getTime() + LOCAL_EXECUTION_LEASE_MS).toISOString()
  };
}
async function claimLocalExecutionLifecycle(job) {
  const lease = newLocalExecutionLease();
  const claimed = await updateLocalFallbackJob(job.id, {
    status: 'processing',
    started_at: lease.started_at,
    execution_phase: 'claimed',
    execution_owner: lease.owner,
    execution_started_at: lease.started_at,
    execution_updated_at: lease.started_at,
    execution_lease_expires_at: lease.expires_at,
    result: { text: 'Claimed locally; Facebook command has not been dispatched.' }
  }, { status: 'pending' });
  return claimed ? lease : null;
}
async function checkpointLocalExecutionLifecycle(job, lease, phase, details = {}) {
  if (!lease?.owner) return false;
  const now = new Date();
  return updateLocalFallbackJob(job.id, {
    ...details,
    execution_phase: phase,
    execution_updated_at: now.toISOString(),
    execution_lease_expires_at: new Date(now.getTime() + LOCAL_EXECUTION_LEASE_MS).toISOString()
  }, { status: 'processing', execution_owner: lease.owner });
}
async function reconcileExpiredLocalExecutionLeases() {
  const jobs = await readLocalFallbackJobs();
  const now = Date.now();
  let reconciled = 0;
  for (const job of jobs) {
    if (job?.status !== 'processing') continue;
    const expiry = Date.parse(job.execution_lease_expires_at || '');
    // Legacy processing rows lack a lease and are just as ambiguous. Pause all
    // such work; only an operator with independent evidence may reconcile it.
    if (!Number.isFinite(expiry) || expiry <= now) {
      const paused = await updateLocalFallbackJob(job.id, {
        status: 'paused',
        execution_phase: 'manual_review',
        execution_updated_at: new Date().toISOString(),
        error: 'Execution lease expired; manual review required. This job will not be replayed automatically.',
        result: { ...(job.result || {}), execution_phase: 'manual_review', auto_retry_allowed: false }
      }, { status: 'processing', ...(job.execution_owner ? { execution_owner: job.execution_owner } : {}) });
      if (paused) reconciled++;
    }
  }
  return reconciled;
}
// END LOCAL EXECUTION LIFECYCLE

// BEGIN DASHBOARD EXECUTION LIFECYCLE
// The dashboard queue has the same failure mode as local fallback: a suspended
// MV3 worker can disappear after a Facebook command but before its completion
// write. Keep the authoritative claim in Supabase and fail closed if the
// lifecycle RPC migration is absent or unavailable.
const DASHBOARD_EXECUTION_LEASE_MS = 5 * 60 * 1000;
function newDashboardExecutionLease() {
  const now = new Date();
  return {
    owner: (globalThis.crypto?.randomUUID?.() || `dash-lease-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    started_at: now.toISOString(),
    expires_at: new Date(now.getTime() + DASHBOARD_EXECUTION_LEASE_MS).toISOString()
  };
}
async function dashboardLifecycleRpc(name, body) {
  const session = await getStoredSession();
  if (!session?.accessToken) return null;
  const response = await fetch(`${SB_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${name} HTTP ${response.status}`);
  return response.json();
}
async function claimDashboardExecutionLifecycle(job) {
  const lease = newDashboardExecutionLease();
  try {
    const result = await dashboardLifecycleRpc('reachr_claim_post_job', {
      p_job_id: job.id, p_execution_owner: lease.owner,
      p_lease_seconds: Math.ceil(DASHBOARD_EXECUTION_LEASE_MS / 1000)
    });
    const claimed = result === true || result?.claimed === true;
    return claimed ? lease : null;
  } catch (e) {
    extLog('warn', `Dashboard lifecycle claim deferred: ${e.message}`);
    return null;
  }
}
async function updateDashboardJobWithExpected(jobId, patch, expected = {}) {
  const session = await getStoredSession();
  if (!session?.accessToken) return false;
  const filters = [`id=eq.${encodeURIComponent(jobId)}`];
  if (expected.status) filters.push(`status=eq.${encodeURIComponent(expected.status)}`);
  if (expected.execution_owner) filters.push(`execution_owner=eq.${encodeURIComponent(expected.execution_owner)}`);
  try {
    const response = await fetch(`${SB_URL}/rest/v1/jsw_post_jobs?${filters.join('&')}`, {
      method: 'PATCH',
      headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify(patch)
    });
    if (!response.ok) return false;
    const rows = await response.json();
    return Array.isArray(rows) && rows.length === 1 && String(rows[0].id) === String(jobId);
  } catch (e) {
    extLog('warn', `Dashboard lifecycle update deferred: ${e.message}`);
    return false;
  }
}
async function checkpointDashboardExecutionLifecycle(job, lease, phase, details = {}) {
  if (!lease?.owner) return false;
  const now = new Date();
  // `result` carries campaign admission/reconciliation metadata. A lifecycle
  // checkpoint must add its progress note without destroying that envelope.
  const checkpointDetails = details?.result && typeof details.result === 'object'
    ? { ...details, result: { ...(job.result || {}), ...details.result } }
    : details;
  return updateDashboardJobWithExpected(job.id, {
    ...checkpointDetails, execution_phase: phase, execution_updated_at: now.toISOString(),
    execution_lease_expires_at: new Date(now.getTime() + DASHBOARD_EXECUTION_LEASE_MS).toISOString()
  }, { status: 'processing', execution_owner: lease.owner });
}
async function completeDashboardExecutionLifecycle(job, lease, patch) {
  if (!lease?.owner) return false;
  return updateDashboardJobWithExpected(job.id, patch, { status: 'processing', execution_owner: lease.owner });
}
async function reconcileExpiredDashboardExecutionLeases() {
  try {
    const result = await dashboardLifecycleRpc('reachr_reconcile_expired_post_jobs', {});
    return Number.isInteger(result) && result >= 0 ? result : 0;
  } catch (e) {
    // A failed reconciliation must never turn a processing row back into pending.
    extLog('warn', `Dashboard lifecycle reconciliation deferred: ${e.message}`);
    return 0;
  }
}
async function pauseDashboardPendingJob(job, reason, result = {}) {
  try {
    const session = await getStoredSession();
    if (!session?.accessToken) return false;
    const url = `${SB_URL}/rest/v1/jsw_post_jobs?id=eq.${encodeURIComponent(job.id)}&status=eq.pending`;
    const headers = { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };
    const now = new Date().toISOString();
    const patch = {
      status: 'paused', execution_phase: 'manual_review', execution_updated_at: now,
      error: reason, result: { ...(job.result || {}), ...result, execution_phase: 'manual_review',
        execution_updated_at: now, auto_retry_allowed: false, manual_review_required: true }
    };
    let res = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(patch) });
    if (!res.ok) {
      const error = await res.json().catch(() => null);
      // Only an explicit missing lifecycle column permits a legacy-schema pause.
      // Never relax auth or the pending-only guard, or retry ambiguous failures.
      const missingLifecycleColumn = res.status === 400 && (
        (error?.code === 'PGRST204' && /^Could not find the '(execution_phase|execution_updated_at)' column of 'jsw_post_jobs' in the schema cache$/.test(error.message))
        || (error?.code === '42703' && /^column "(execution_phase|execution_updated_at)" of relation "jsw_post_jobs" does not exist$/.test(error.message))
      );
      if (!missingLifecycleColumn) return false;
      delete patch.execution_phase;
      delete patch.execution_updated_at;
      res = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(patch) });
    }
    if (!res.ok) return false;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length === 1 && String(rows[0]?.id) === String(job.id);
  } catch (e) {
    extLog('warn', `Dashboard pending pause deferred: ${e.message}`);
    return false;
  }
}

async function admitScheduledCampaignBatch(job, session) {
  const runId = job?.result?.run_id;
  const batchIndex = Number(job?.result?.batch_index);
  if (!runId || !Number.isInteger(batchIndex) || batchIndex < 1) return true;
  if (batchIndex === 1) {
    const scheduledAt = Date.parse(job.scheduled_for || '');
    if (!Number.isFinite(scheduledAt)) {
      await pauseDashboardPendingJob(job, 'Campaign scheduled time is missing; no post was attempted.', { error_code: 'schedule_time_missing' });
      return false;
    }
    if (Date.now() - scheduledAt > 15 * 60 * 1000) {
      await pauseDashboardPendingJob(job, 'Campaign worker missed the 15-minute start window; no post was attempted.', { error_code: 'schedule_start_missed' });
      return false;
    }
    return true;
  }
  const url = `${SB_URL}/rest/v1/jsw_post_jobs?user_id=eq.${encodeURIComponent(session.userId)}`
    + `&result->>run_id=eq.${encodeURIComponent(runId)}`
    + `&result->>batch_index=eq.${batchIndex - 1}&select=id,status,result&limit=1`;
  const response = await fetch(url, { headers: { apikey: SB_ANON_KEY, Authorization: `Bearer ${session.accessToken}` } });
  if (!response.ok) return false;
  const previous = (await response.json())[0];
  if (!previous) return false;
  if (previous.status === 'done') return true;
  if (['failed', 'paused', 'cancelled', 'canceled'].includes(previous.status)) {
    await pauseDashboardPendingJob(job, 'Previous campaign batch needs review; this batch was not posted.', { error_code: 'previous_batch_not_completed' });
  }
  return false;
}

// END DASHBOARD EXECUTION LIFECYCLE

async function appendLocalFallbackResult(jobId, result) {
  const data = await chrome.storage.local.get([LOCAL_FALLBACK_RESULT_LOG_KEY]);
  const log = Array.isArray(data[LOCAL_FALLBACK_RESULT_LOG_KEY]) ? data[LOCAL_FALLBACK_RESULT_LOG_KEY] : [];
  log.push({ job_id: jobId, recorded_at: new Date().toISOString(), result });
  await chrome.storage.local.set({ [LOCAL_FALLBACK_RESULT_LOG_KEY]: log.slice(-200) });
}

async function pollLocalFallbackJobs() {
  if (activeDashJobId !== null) return false;
  const reconciled = await reconcileExpiredLocalExecutionLeases();
  if (reconciled) extLog('warn', `Paused ${reconciled} expired local execution lease(s) for manual review`);
  const jobs = await readLocalFallbackJobs();
  // A prior worker may have stopped mid-post. Never auto-reclaim or overlap an
  // unresolved processing record; an operator must reconcile its real outcome.
  if (jobs.some(j => j?.status === 'processing')) return false;
  const now = new Date();
  const dueJobs = jobs.filter(j => j?.status === 'pending' && (!j.scheduled_for || new Date(j.scheduled_for) <= now));
  // An uncertainty hold can reject a pending job before it is claimed. Do not
  // let that one campaign starve unrelated local-fallback work behind it.
  // executeDashJob remains the sole admission/claim boundary and still
  // serializes all Facebook work through activeDashJobId.
  for (const job of dueJobs) {
    extLog('warn', `Running local fallback job ${job.id}`);
    if ((await executeDashJob({ ...job, local_fallback: true })) !== false) return true;
  }
  return false;
}

// Database owns durable occurrence admission. The account-scoped session flag is
// absent/OFF for existing installations; no local fallback on ambiguous RPC results.
async function tickDurableSchedules(session) {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/reachr_schedule_tick_approved`, {
    method: 'POST',
    headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' },
    body: '{}'
  });
  if (!res.ok) throw new Error(`Durable schedule tick HTTP ${res.status}`);
  return res.json();
}

let durableScheduleRpcMissingUntil = 0;

// Fetch pending jobs for this paired user via REST API
async function pollPendingJobs() {
  if (activeDashJobId !== null) return false;
  const session = await getStoredSession();
  if (!session || !session.userId) {
    return false; // The shared cycle checks local fallback exactly once.
  }

  try {
    const reconciled = await reconcileExpiredDashboardExecutionLeases();
    if (reconciled) extLog('warn', `Paused ${reconciled} expired dashboard execution lease(s) for manual review`);
    if (Date.now() >= durableScheduleRpcMissingUntil) {
      try { await tickDurableSchedules(session); }
      catch (e) {
        // Older databases can keep running legacy jobs while the migration is
        // installed. Do not claim a campaign was scheduled when this RPC fails.
        if (/HTTP (404|400)/.test(e.message)) durableScheduleRpcMissingUntil = Date.now() + 10 * 60 * 1000;
        extLog('warn', `Durable scheduler admission deferred: ${e.message}`);
      }
    }
    const now = new Date().toISOString();
    // Pick up: (a) immediate pending jobs with no scheduled_for, OR
    //          (b) scheduled jobs whose time has arrived
    const url = `${SB_URL}/rest/v1/jsw_post_jobs?user_id=eq.${encodeURIComponent(session.userId)}&status=eq.pending&order=created_at.asc&limit=1&select=*` +
      `&or=(scheduled_for.is.null,scheduled_for.lte.${encodeURIComponent(now)})`;
    const res = await fetch(url, {
      headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}` }
    });

    if (!res.ok) {
      extLog('warn', 'Job poll failed: ' + res.status + ' — checking local fallback queue');
      return false;
    }

    const jobs = await res.json();
    if (jobs && jobs.length > 0) {
      const job = jobs[0];
      extLog('info', 'Found pending job: ' + job.id);
      if (!dashSession) dashSession = session;
      const executed = await executeDashJob(job);

      // If this is a repeating job, re-queue it for next occurrence
      if (executed !== false && executed?.autoRepeatAllowed !== false && !job.occurrence_id && job.repeat_days?.length && job.repeat_time) {
        await requeueRepeatingJob(job, session);
      }
    }
  } catch (e) {
    extLog('error', 'Dash poll error: ' + e.message + ' — checking local fallback queue');
    return false;
  }
}

// Re-queue a repeating job for its next scheduled occurrence
async function requeueRepeatingJob(job, session) {
  try {
    const controls = await fetchDashboardRunnerControls(session);
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
    next.setMinutes(next.getMinutes() + randInt(0, controls.scheduleJitterMinutes));
    await fetch(`${SB_URL}/rest/v1/jsw_post_jobs`, {
      method: 'POST',
      headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        user_id: session.userId,
        message: job.message,
        image_url: job.image_url || null,
        groups: job.groups,
        delay: Math.max(job.delay || 30, controls.minDelaySeconds),
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

const GROUP_SCAN_GUARD_VERSION = 'fb-groups-scraper-v4';

async function getGroupRowsForIdentity(session, identityKey) {
  const rows = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const url = `${SB_URL}/rest/v1/jsw_groups?user_id=eq.${encodeURIComponent(session.userId)}&identity_key=eq.${encodeURIComponent(identityKey)}&select=id,group_url,group_name&order=id.asc&limit=${pageSize}&offset=${offset}`;
    const response = await fetch(url, { headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}` } });
    if (!response.ok) throw new Error(`Could not read saved groups for ${identityKey}: ${await response.text()}`);
    const page = await response.json();
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

async function getOldNameKeyedGroupRows(session, identity) {
  const name = String(identity?.name || '').trim();
  const currentKey = String(identity?.key || '');
  if (!name || !currentKey) return [];
  const aliases = new Set([
    name.toLowerCase(),
    name.toLowerCase().replace(/\s+/g, '-'),
    name.toLowerCase().replace(/\s+/g, '_'),
    String(identity?.url || '').toLowerCase()
  ].filter(Boolean));
  const rows = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const url = `${SB_URL}/rest/v1/jsw_groups?user_id=eq.${encodeURIComponent(session.userId)}&identity_name=eq.${encodeURIComponent(name)}&select=id,identity_key,identity_type,group_url,group_name&order=id.asc&limit=${pageSize}&offset=${offset}`;
    const response = await fetch(url, { headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}` } });
    if (!response.ok) throw new Error(`Could not read older saved groups for ${name}: ${await response.text()}`);
    const page = await response.json();
    rows.push(...page.filter(row => {
      const key = String(row.identity_key || '').trim();
      if (!key || key === currentKey || key === '__legacy__' || !aliases.has(key.toLowerCase())) return false;
      return !row.identity_type || !identity.type || isPageIdentityType(row.identity_type) === isPageIdentityType(identity.type);
    }));
    if (page.length < pageSize) return rows;
  }
}

async function getPreviousCompleteGroupSnapshot(session, identityKey) {
  const url = `${SB_URL}/rest/v1/jsw_post_jobs?user_id=eq.${encodeURIComponent(session.userId)}&message=eq.__import_groups__&status=eq.done&select=id,result,completed_at&order=completed_at.desc&limit=50`;
  const response = await fetch(url, { headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}` } });
  if (!response.ok) throw new Error('Could not read prior group scans: ' + await response.text());
  const jobs = await response.json();
  for (const job of jobs) {
    const item = (job.result?.identities || []).find(entry =>
      String(entry.identity_key) === String(identityKey)
      && entry.status === 'scanned'
      && entry.scan_complete === true
      && Array.isArray(entry.group_urls)
      && entry.group_scan_guard_version === GROUP_SCAN_GUARD_VERSION
    );
    if (item) return { job_id: job.id, urls: item.group_urls };
  }
  return null;
}

function groupSnapshotsAgree(previousUrls, currentUrls) {
  const previous = new Set(previousUrls || []);
  const current = new Set(currentUrls || []);
  if (!previous.size && !current.size) return true;
  const overlap = [...current].filter(url => previous.has(url)).length;
  return overlap / Math.max(previous.size, current.size) >= 0.8;
}

async function persistCompleteGroupScan(session, identity, scan, priorSnapshot) {
  if (scan?.scan_complete !== true || scan?.active_identity_verified !== true || !Array.isArray(scan.groups)) {
    throw new Error('Incomplete or unverified group scan cannot change saved groups');
  }
  const identityKey = String(identity.key || '');
  if (!identityKey || identityKey === '__legacy__' || String(scan.identity_key) !== identityKey) {
    throw new Error('Group scan identity key does not match its save target');
  }
  const existing = await getGroupRowsForIdentity(session, identityKey);
  const before = new Set(existing.map(row => row.group_url));
  const seen = new Set(scan.groups.map(group => group?.url).filter(Boolean));
  if (seen.size !== scan.groups.length) throw new Error('Group scan has missing or duplicate URLs');
  const rows = scan.groups.map(group => ({
    user_id: session.userId,
    identity_key: identityKey,
    identity_name: identity.name,
    identity_type: identity.type || null,
    group_url: group.url,
    group_name: group.name || null,
    group_avatar_url: group.group_avatar_url || group.avatar_url || null
  }));
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50);
    const write = async (withAvatar) => {
      const body = withAvatar ? chunk : chunk.map(({ group_avatar_url, ...row }) => row);
      return fetch(`${SB_URL}/rest/v1/jsw_groups?on_conflict=user_id,identity_key,group_url`, {
        method: 'POST',
        headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(body)
      });
    };
    let response = await write(true);
    if (!response.ok) {
      const reason = await response.text();
      if (/group_avatar_url|schema cache|column/i.test(reason)) response = await write(false);
      else throw new Error('Group save failed: ' + reason);
    }
    if (!response.ok) throw new Error('Group save failed: ' + await response.text());
  }

  const missing = existing.filter(row => row.id && !seen.has(row.group_url));
  const canReconcile = priorSnapshot && groupSnapshotsAgree(priorSnapshot.urls, [...seen]);
  let removedCount = 0;
  if (canReconcile) {
    for (let i = 0; i < missing.length; i += 50) {
      const ids = missing.slice(i, i + 50).map(row => row.id);
      const url = `${SB_URL}/rest/v1/jsw_groups?user_id=eq.${encodeURIComponent(session.userId)}&identity_key=eq.${encodeURIComponent(identityKey)}&id=in.(${ids.join(',')})`;
      const response = await fetch(url, {
        method: 'DELETE',
        headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}`, 'Prefer': 'return=minimal' }
      });
      if (!response.ok) throw new Error('Group reconciliation failed after removing ' + removedCount + ' rows: ' + await response.text());
      removedCount += ids.length;
    }
    // Older imports used a Page's name or URL as the owner key. After two
    // complete, consistent scans of its current stable key, the canonical rows
    // above contain the full membership, so those name-keyed copies can go.
    const oldRows = await getOldNameKeyedGroupRows(session, identity);
    const byKey = new Map();
    oldRows.forEach(row => {
      const key = String(row.identity_key || '');
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(row);
    });
    for (const [oldKey, rowsForKey] of byKey) {
      for (let i = 0; i < rowsForKey.length; i += 50) {
        const ids = rowsForKey.slice(i, i + 50).map(row => row.id);
        const url = `${SB_URL}/rest/v1/jsw_groups?user_id=eq.${encodeURIComponent(session.userId)}&identity_key=eq.${encodeURIComponent(oldKey)}&id=in.(${ids.join(',')})`;
        const response = await fetch(url, {
          method: 'DELETE',
          headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}`, 'Prefer': 'return=minimal' }
        });
        if (!response.ok) throw new Error('Old group-key reconciliation failed: ' + await response.text());
        removedCount += ids.length;
      }
    }
  }
  return {
    new_count: [...seen].filter(url => !before.has(url)).length,
    removed_count: removedCount,
    removed_groups: canReconcile ? missing.map(row => ({ group_url: row.group_url, group_name: row.group_name || null })) : [],
    retained_count: [...seen].filter(url => before.has(url)).length,
    reconciliation: !priorSnapshot ? 'baseline_recorded' : canReconcile ? 'complete' : 'awaiting_consistent_scan',
    previous_scan_job_id: priorSnapshot?.job_id || null,
    pending_removal_count: canReconcile ? 0 : missing.length
  };
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

function currentProfileGroupOverlap(pageGroups = [], profileGroups = []) {
  const pageUrls = new Set(pageGroups.map(group => group?.url || group?.group_url).filter(Boolean));
  const profileUrls = new Set(profileGroups.map(group => group?.url || group?.group_url).filter(Boolean));
  const overlap = [...pageUrls].filter(url => profileUrls.has(url)).length;
  return { overlap, page_count: pageUrls.size, high_overlap: overlap >= 5 && overlap / pageUrls.size >= 0.8 };
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

// A cookie or an already-open Facebook tab is not proof of a usable session:
// expired sessions can retain c_user and the login wall itself is a Facebook tab.
// Classify a no-post DOM probe fail-closed before scanning or switching actors.
function classifyFacebookSessionProbe(probe = {}) {
  const url = String(probe.url || '');
  const text = `${probe.title || ''} ${probe.text || ''}`;
  const onFacebook = /^https:\/\/(?:www\.|m\.)?facebook\.com\//i.test(url);
  const loginWall = /join or log into facebook|forgot account\?|create new account|log into facebook/i.test(text);
  if (!onFacebook || loginWall || !probe.hasCUser) {
    return { available: false, code: 'facebook_login_required' };
  }
  return { available: true, code: null };
}

async function requireFacebookSessionForGroupScan() {
  let createdTabId = null;
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.facebook.com/*' });
    // Discarded/unloaded tabs can reject executeScript even when the extension has the
    // correct host permission. Prefer a currently loaded first-party surface; do not
    // reload or close an existing tab merely to run this no-post session probe.
    let tab = tabs.find(t => t.status === 'complete' && /^https:\/\/(?:www\.|m\.)?facebook\.com\//i.test(String(t.url || '')));
    if (!tab?.id) {
      tab = await chrome.tabs.create({ url: 'https://www.facebook.com/', active: false });
      createdTabId = tab.id;
      await sleep(2000);
    }
    const [probeResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        url: location.href,
        title: document.title || '',
        text: (document.body?.innerText || '').slice(0, 6000)
      })
    });
    const cookies = await chrome.cookies.getAll({ domain: '.facebook.com' });
    const state = classifyFacebookSessionProbe({ ...probeResult?.result, hasCUser: cookies.some(c => c.name === 'c_user') });
    if (!state.available) {
      // Keep the Facebook tab visible so the operator can sign in to the exact
      // Chrome profile used by Reachr. A failed probe must never close it.
      createdTabId = null;
      try {
        await chrome.tabs.update(tab.id, { active: true });
        if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true });
      } catch (_) {}
      throw Object.assign(new Error('Facebook login required in this Reachr Chrome window. Sign in there, then retry Update profiles or Import groups.'), { code: state.code });
    }
    return state;
  } catch (error) {
    if (error?.code === 'facebook_login_required') throw error;
    throw Object.assign(new Error('Facebook session could not be verified; Reachr will not scan or switch identities.'), { code: 'facebook_login_required' });
  } finally {
    if (createdTabId != null) { try { await chrome.tabs.remove(createdTabId); } catch (_) {} }
  }
}

async function runImportGroupsJob(job, session) {
  await requireFacebookSessionForGroupScan();
  const targets = await getImportTargetsForJob(job, session);
  if (!targets.length) throw new Error('No synced Facebook profiles/pages found. Sync profiles first.');
  const perIdentity = [];
  const scanCandidates = [];
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
    await sbUpdateJob(job.id, { result: { group_scan_guard_version: GROUP_SCAN_GUARD_VERSION, text: `Scanning ${label} (${i + 1}/${targets.length})...`, current_identity: label, target_index: i + 1, target_count: targets.length } });
    try {
      const result = await importFacebookGroupsForJob(job.id, mergedTarget, { finalizeJob: false, progressPrefix: `${label}: ` });
      const resultSignature = groupUrlSignature(result?.groups || []);
      const isPageTarget = isPageIdentityType(mergedTarget.type);
      if (!isPageTarget && resultSignature) accountLevelGroupSignature = accountLevelGroupSignature || resultSignature;
      // A verified Page avatar on /groups/joins proves the actor, but the
      // generic list may still contain account-level memberships. Only the
      // Page's own Groups tab is independent Page-specific list evidence.
      const pageSourceProof = isPageTarget && hasPageSpecificScanProof(result?.page_scan_strategy, result?.scan_source_url);
      if (isPageTarget && !pageSourceProof && resultSignature && (knownAccountLevelGroupSignatures.has(resultSignature) || (accountLevelGroupSignature && resultSignature === accountLevelGroupSignature))) {
        throw new Error(`same account-level groups returned for ${mergedTarget.name}`);
      }
      const overlapAssessment = await assessAccountLevelGroupOverlap(session, mergedTarget.name, mergedTarget.type, result?.groups || []);
      const warnings = [];
      if (overlapAssessment?.high_overlap) {
        warnings.push({
          ...overlapAssessment,
          severity: pageSourceProof ? 'warning' : 'blocked',
          message: pageSourceProof
            ? 'The active Page was verified on the joined-groups route, but its URL set overlaps the account profile list; review before posting.'
            : 'Blocked because the scrape did not have Page-specific source proof and overlapped the account-level profile list.'
        });
        if (!pageSourceProof) {
          throw new Error(`same account-level groups returned for ${mergedTarget.name}`);
        }
      }
      scanSignatures.push({ identity_key: mergedTarget.key, identity_name: mergedTarget.name, identity_type: mergedTarget.type, signature: resultSignature, page_source_proof: pageSourceProof });
      const candidateIndex = perIdentity.length;
      scanCandidates.push({ identity: mergedTarget, result, index: candidateIndex });
      perIdentity.push({
        identity_name: mergedTarget.name || null,
        group_scan_guard_version: result?.group_scan_guard_version || null,
        identity_key: mergedTarget.key,
        identity_type: mergedTarget.type || null,
        status: 'scanned',
        count: result?.count || 0,
        avatar_count: result?.avatar_count || 0,
        scan_complete: result?.scan_complete === true,
        active_identity_verified: result?.active_identity_verified === true,
        group_urls: (result?.groups || []).map(group => group.url),
        scan_source_url: result?.scan_source_url || null,
        page_scan_strategy: result?.page_scan_strategy || null,
        debug: result?.debug || null,
        warnings,
        new_count: 0,
        removed_count: 0
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
  const quarantineReasons = new Map();
  const profileCandidates = scanCandidates.filter(item => !isPageIdentityType(item.identity.type));
  for (const page of scanCandidates.filter(item => isPageIdentityType(item.identity.type))) {
    for (const profile of profileCandidates) {
      const comparison = currentProfileGroupOverlap(page.result?.groups || [], profile.result?.groups || []);
      if (!comparison.high_overlap) continue;
      const key = String(page.identity.key);
      const reason = `Facebook returned ${comparison.overlap} of ${comparison.page_count} Page groups in ${profile.identity.name}'s current profile scan; Page membership is unverified.`;
      quarantinedKeys.add(key);
      quarantineReasons.set(key, reason);
      errors.push({ identity_name: page.identity.name, identity_key: key, status: 'not_scanned', reason, raw_error: 'current profile group overlap' });
      break;
    }
  }
  for (const item of scanSignatures) {
    const key = String(item.identity_key);
    if (!item.signature || signatureCounts.get(item.signature) < 2 || !isPageIdentityType(item.identity_type) || quarantinedKeys.has(key)) continue;
    quarantinedKeys.add(key);
    const reason = 'Facebook returned the same group list as another identity, so this Page scan was quarantined.';
    quarantineReasons.set(key, reason);
    errors.push({
      identity_name: item.identity_name || null,
      identity_key: item.identity_key || null,
      status: 'not_scanned',
      reason,
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
        reason: quarantineReasons.get(String(perIdentity[i].identity_key)) || 'Page group scan was quarantined.'
      };
    }
  }

  // All cross-identity checks finish before any scan writes Supabase.
  for (const candidate of scanCandidates) {
    if (quarantinedKeys.has(String(candidate.identity.key))) continue;
    const entry = perIdentity[candidate.index];
    if (entry?.status !== 'scanned') continue;
    try {
      const previous = await getPreviousCompleteGroupSnapshot(session, candidate.identity.key);
      const change = await persistCompleteGroupScan(session, candidate.identity, candidate.result, previous);
      Object.assign(entry, change);
      entry.text = `Scanned ${entry.count} groups; ${change.new_count} new, ${change.removed_count} removed`;
    } catch (e) {
      const reason = e.message || 'Group reconciliation failed';
      errors.push({ identity_name: candidate.identity.name, identity_key: candidate.identity.key, status: 'not_scanned', reason, raw_error: reason });
      perIdentity[candidate.index] = { identity_name: candidate.identity.name, identity_key: candidate.identity.key, identity_type: candidate.identity.type || null, count: 0, new_count: 0, removed_count: 0, status: 'not_scanned', reason };
    }
  }

  const totalGroups = perIdentity.reduce((sum, item) => sum + (item.count || 0), 0);
  const totalNew = perIdentity.reduce((sum, item) => sum + (item.new_count || 0), 0);
  const totalRemoved = perIdentity.reduce((sum, item) => sum + (item.removed_count || 0), 0);
  const notScanned = perIdentity.filter(item => item.status === 'not_scanned').length;
  const scanned = perIdentity.length - notScanned;
  const status = scanned > 0 ? 'done' : 'failed';
  const isDailyScan = !!(job.daily_scan || job.result?.daily_scan);
  const label = isDailyScan ? 'Daily group scan' : 'Group scan';
  const scanText = status === 'done'
    ? `${label} ${notScanned ? 'partial' : 'complete'}: ${scanned}/${targets.length} profiles/pages scanned · ${totalGroups} groups · ${totalNew} new · ${totalRemoved} removed${notScanned ? ` · ${notScanned} not scanned` : ''}`
    : `${label} could not scan any synced profiles/pages`;
  await sbUpdateJob(job.id, {
    status,
    result: {
      group_scan_guard_version: GROUP_SCAN_GUARD_VERSION,
      text: scanText,
      daily_scan: isDailyScan,
      target_count: targets.length,
      scanned_count: scanned,
      not_scanned_count: notScanned,
      total_groups: totalGroups,
      total_new_groups: totalNew,
      total_removed_groups: totalRemoved,
      worker_install_id: await getWorkerInstallId(),
      extension_version: EXT_VERSION,
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
  // Dashboard-created probe jobs may keep actor metadata on the job instead of
  // duplicating it on every group. Preserve that explicit actor; otherwise a
  // safe probe would degrade to null/unknown before reaching the composer.
  const identityName = job.identity_name || job.identityName || identity.identity_name || identity.identityName || job.ai_prompt || null;
  const identityUrl = job.identity_url || job.identityUrl || identity.identity_url || identity.identityUrl || null;
  const identityType = job.identity_type || job.identityType || job.type || identity.identity_type || identity.identityType || identity.type || null;
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
        const response = await sendTabMessageWithRetry(tab.id, { type: 'PROBE_GROUP_COMPOSER_IDENTITY', identityName, identityUrl, identityType, skipSwitch: directVerified, diagnosticNoPersist: true });
        results.push({ group_name: target.name || target.group_name || null, group_url: url, success: !!response?.success, reset_response: target._reset_response || null, reset_error: target._reset_error || null, switch_success: directVerified, switch_response: switchResponse, active_before_group: activeResponse?.activeIdentity || null, ...response });
      } else {
        tab = await chrome.tabs.create({ url, active: true });
        await sleep(7000);
        const response = await sendTabMessageWithRetry(tab.id, { type: 'PROBE_GROUP_COMPOSER_IDENTITY', identityName, identityUrl, identityType, diagnosticNoPersist: true });
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
  const probeResult = {
    text: `Composer probe complete: ${allowed.length}/${results.length} groups allow ${identityName}`,
    identity_name: identityName,
    tested_count: results.length,
    allowed_count: allowed.length,
    results
  };
  await sbUpdateJob(job.id, {
    status: 'done',
    result: probeResult,
    completed_at: new Date().toISOString()
  });
  // Returning the same result makes controlled diagnostics observable without
  // changing the persisted job contract used by the dashboard.
  return probeResult;
}

async function runJoinGroupsJob(job, session) {
  await requireFacebookSessionForGroupScan();
  let items = Array.isArray(job.groups) ? job.groups : [];
  if (typeof job.groups === 'string') {
    try { items = JSON.parse(job.groups); } catch (_) { items = []; }
  }
  if (!Array.isArray(items) || !items.length) throw new Error('No groups/search targets provided for join job');

  const resolvedItems = [];
  for (const item of items) {
    resolvedItems.push(typeof item === 'string' ? { group_url: item, url: item } : await enrichFacebookIdentityTarget(item || {}));
  }
  const identity = resolvedItems.find(g => g && (g.identity_name || g.identityName)) || {};
  const identityName = identity.identity_name || identity.identityName || job.ai_prompt || null;
  const identityUrl = identity.identity_url || identity.identityUrl || null;
  const identityKey = identity.identity_key || identity.identityKey || identity.key || identityName;
  const identityType = identity.identity_type || identity.identityType || identity.type || null;
  if (!identityName || !identityKey) throw new Error('Join refused: missing Facebook profile/page owner. Sync/select an identity first.');

  const targets = resolvedItems.slice(0, 10).map(t => ({
    ...t,
    group_url: t.group_url || t.url || null,
    group_name: t.group_name || t.name || t.title || t.query || null,
    search_url: t.search_url || t.facebook_search_url || null
  }));
  const results = [];
  let tab = null;
  const saveJoinedGroup = async (target, joinResult) => {
    const groupUrl = joinResult?.group_url || target.group_url || null;
    if (!groupUrl) return;
    const groupName = joinResult?.group_name || target.group_name || groupUrl;
    const row = {
      user_id: session.userId,
      group_url: groupUrl,
      group_name: groupName,
      group_avatar_url: joinResult?.group_avatar_url || target.group_avatar_url || target.avatar_url || null,
      identity_name: identityName,
      identity_key: identityKey,
      identity_type: identityType || null
    };
    const postRows = async (bodyRow) => fetch(`${SB_URL}/rest/v1/jsw_groups?on_conflict=user_id,identity_key,group_url`, {
      method: 'POST',
      headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(bodyRow)
    });
    let saveRes = await postRows(row);
    if (saveRes.ok) return;
    let text = await saveRes.text();
    if (/group_avatar_url|schema cache|column/i.test(text)) {
      const { group_avatar_url, ...rowWithoutAvatar } = row;
      saveRes = await postRows(rowWithoutAvatar);
      if (saveRes.ok) return;
      text = await saveRes.text();
    }
    throw new Error('Joined group save failed: ' + text);
  };

  try {
    tab = await chrome.tabs.create({ url: identityUrl || 'https://www.facebook.com/', active: true });
    await sleep(identityUrl ? 8000 : 5000);
    let switchResponse = null;
    try {
      switchResponse = await sendTabMessageWithRetry(tab.id, { type: 'SWITCH_FACEBOOK_IDENTITY', identityName, identityUrl });
    } catch (e) {
      switchResponse = { success: false, error: e.message };
    }
    if (!switchResponse?.success && isPageIdentityType(identityType)) {
      await sbUpdateJob(job.id, { result: { text: `Trying Pages Manager switch for ${identityName}...`, identity_name: identityName } });
      await chrome.tabs.update(tab.id, { url: 'https://www.facebook.com/pages/?category=your_pages', active: true });
      await sleep(8000);
      try {
        const fallback = await sendTabMessageWithRetry(tab.id, { type: 'SWITCH_FACEBOOK_MANAGED_PAGE', identityName, identityUrl });
        switchResponse = { ...fallback, fallback_path: 'pages_manager_join_groups' };
      } catch (e) {
        switchResponse = { success: false, error: e.message, fallback_path: 'pages_manager_join_groups' };
      }
    }
    if (!switchResponse?.success) throw new Error(switchResponse?.error || `Could not switch to ${identityName} before joining groups`);

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      await sbUpdateJob(job.id, { result: { text: `Joining/checking ${identityName} group ${i + 1}/${targets.length}...`, identity_name: identityName, current_group: target.group_name || target.group_url || target.search_url } });
      const openUrl = target.group_url || target.search_url;
      if (!openUrl) {
        results.push({ success: false, status: 'skipped', error: 'missing group_url/search_url', group_name: target.group_name || null });
        continue;
      }
      try {
        await chrome.tabs.update(tab.id, { url: openUrl, active: true });
        await sleep(/\/search\/groups/i.test(openUrl) ? 8000 : 7000);
        const [joinState] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          args: [target.group_name || target.query || target.title || null],
          func: async (expectedName) => {
            const sleep = ms => new Promise(r => setTimeout(r, ms));
            const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
            const visible = el => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
            const lowerExpected = norm(expectedName).toLowerCase();
            const controls = () => [...document.querySelectorAll('div[role="button"], button, a[role="button"], a[href]')].filter(visible);
            const textOf = el => norm([el.innerText, el.textContent, el.getAttribute('aria-label')].filter(Boolean).join(' '));
            const groupFromPage = () => {
              const href = location.href;
              const m = href.match(/facebook\.com\/groups\/([^/?#]+)/i);
              if (!m || /^(joins|feed|discover|search|create)$/i.test(m[1])) return null;
              return { group_url: `https://www.facebook.com/groups/${encodeURIComponent(decodeURIComponent(m[1]))}/`, group_name: norm(document.querySelector('h1')?.innerText || document.title.replace(/\s*\|\s*Facebook.*$/i, '')) || expectedName || null };
            };
            const readState = () => {
              const joined = controls().find(el => /^joined$/i.test(textOf(el)) || /\bjoined\b/i.test(el.getAttribute('aria-label') || ''));
              const pending = controls().find(el => /pending|cancel request|request pending|answer questions/i.test(textOf(el)));
              const composer = controls().find(el => /write something|what's on your mind|comment as|post as/i.test(textOf(el)));
              return { joined: !!joined, pending: !!pending, composerVisible: !!composer, joinedText: joined ? textOf(joined) : null, pendingText: pending ? textOf(pending) : null };
            };
            const groupInfoNear = (el) => {
              const roots = [];
              let cur = el;
              for (let i = 0; i < 7 && cur; i++, cur = cur.parentElement) roots.push(cur);
              for (const root of roots) {
                const link = [...root.querySelectorAll?.('a[href*="/groups/"]') || []].find(a => /facebook\.com\/groups\/([^/?#]+)/i.test(a.href || '') && !/\/groups\/(joins|feed|discover|search|create)/i.test(a.href || ''));
                if (link) {
                  const m = link.href.match(/facebook\.com\/groups\/([^/?#]+)/i);
                  const name = norm(link.innerText || link.textContent || link.getAttribute('aria-label') || expectedName || '');
                  return { group_url: `https://www.facebook.com/groups/${encodeURIComponent(decodeURIComponent(m[1]))}/`, group_name: name || expectedName || null };
                }
              }
              return null;
            };
            let picked = null;
            let pickedGroupInfo = null;
            if (/facebook\.com\/search\/groups/i.test(location.href)) {
              const joinButtons = controls().filter(el => /\bjoin group\b/i.test(textOf(el)));
              picked = joinButtons.find(el => {
                const t = textOf(el).toLowerCase();
                return lowerExpected ? t.includes(lowerExpected) : true;
              }) || joinButtons[0] || null;
              if (picked) pickedGroupInfo = groupInfoNear(picked);
            } else {
              picked = controls().find(el => {
                const t = textOf(el);
                if (/\b(joined|member)\b/i.test(t)) return false;
                return /^(join|join group|request to join)$/i.test(t) || /\bjoin group\b/i.test(t);
              });
              if (picked) pickedGroupInfo = groupFromPage();
            }
            if (!picked) {
              const state = readState();
              return { success: state.joined || state.composerVisible, status: state.joined ? 'already_joined' : state.composerVisible ? 'composer_available' : state.pending ? 'pending' : 'not_joinable', clicked: false, ...state, ...groupFromPage(), page_url: location.href, title: document.title };
            }
            const before = textOf(picked);
            try { picked.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
            picked.click();
            await sleep(7000);
            const state = readState();
            const groupInfo = groupFromPage();
            const body = norm((document.querySelector('[role="main"]')?.innerText || document.body?.innerText || '').slice(0, 3000));
            const visitNow = /\bvisit\b/i.test(body) && /\bjoin group\b/i.test(before);
            return { success: state.joined || state.composerVisible || visitNow, status: state.pending ? 'pending' : (state.joined || state.composerVisible || visitNow) ? 'joined' : 'clicked_unverified', clicked: true, clicked_text: before, ...state, ...(groupInfo || pickedGroupInfo || {}), page_url: location.href, title: document.title, body_sample: body.slice(0, 1200) };
          }
        });
        const result = { group_name: target.group_name || null, group_url: target.group_url || null, search_url: target.search_url || null, ...(joinState?.result || {}) };
        if (result.success || result.status === 'pending') {
          await saveJoinedGroup(target, result);
        }
        results.push(result);
      } catch (e) {
        results.push({ group_name: target.group_name || null, group_url: target.group_url || null, search_url: target.search_url || null, success: false, status: 'failed', error: e.message });
      }
      await sleep(1500);
    }
  } finally {
    if (tab?.id) { try { await chrome.tabs.remove(tab.id); } catch (_) {} }
  }

  const joinedCount = results.filter(r => r.success && ['joined','already_joined','composer_available'].includes(String(r.status || ''))).length;
  const pendingCount = results.filter(r => r.status === 'pending').length;
  await sbUpdateJob(job.id, {
    status: joinedCount || pendingCount ? 'done' : 'failed',
    result: {
      text: `Group join complete for ${identityName}: ${joinedCount} joined/available · ${pendingCount} pending · ${results.length - joinedCount - pendingCount} failed`,
      identity_name: identityName,
      identity_key: identityKey,
      identity_type: identityType || null,
      joined_count: joinedCount,
      pending_count: pendingCount,
      results,
      extension_version: EXT_VERSION
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
        const isManagedPage = /^page|facebook page$/i.test(String(identity.type || '')) || (!!identity.url && /^https:\/\/(www\.)?facebook\.com\/profile\.php\?id=\d+/i.test(String(identity.url)));
        const preSwitch = await ensureFacebookIdentityActive(identity.name, identity.url || null, identity.type || null);
        switchResponse = preSwitch?.switch_response || preSwitch || null;
        ok = !!preSwitch?.success;
        verifyHome = { activeIdentity: preSwitch?.active_identity || null, pageUrl: preSwitch?.page_url || null };
        if (!ok) error = preSwitch?.error || `Home active identity verified as ${verifyHome?.activeIdentity || 'unknown'}, not ${identity.name}`;
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

function closeOwnedPostingTab(tab, postingTabIds) {
  const tabId = tab?.id;
  if (!Number.isInteger(tabId) || !postingTabIds.includes(tabId)) return false;

  // Remove ownership before invoking Chrome so no later cleanup can issue a
  // duplicate removal. Only IDs recorded after this worker's own tabs.create
  // call are eligible; existing user tabs are never touched.
  postingTabIds.splice(postingTabIds.indexOf(tabId), 1);
  try {
    Promise.resolve(chrome.tabs.remove(tabId)).catch(error => {
      extLog('warn', 'Posting tab cleanup failed: ' + String(error?.message || error));
    });
  } catch (error) {
    extLog('warn', 'Posting tab cleanup failed: ' + String(error?.message || error));
  }
  return true;
}

// Claim a job (set status=processing) then run it
// Alarm, realtime, and local fallback polling share one Facebook cookie/actor.
// Acquire synchronously, before the first await, including for identity/import jobs.
let activeDashJobId = null;
async function executeDashJob(job) {
  // Fail closed for stale/imported local copies, before claim or actor side effects.
  if (job?.occurrence_id != null && (job.local_fallback || String(job.id).startsWith('local_'))) {
    extLog('error', `Rejected local execution of durable occurrence ${job.occurrence_id}`);
    return false;
  }
  if (activeDashJobId !== null) return false;
  activeDashJobId = job.id;
  try {
  dashSession = await getStoredSession();
  // Local fallback uses a non-secret account identifier only to scope the
  // existing duplicate ledger; it never treats this as remote authorization.
  if (job?.local_fallback && (!dashSession || !dashSession.userId)) {
    const localAccountId = job.user_id || await getStoredDashboardIdentity() || 'local-fallback';
    dashSession = { userId: localAccountId, ai_provider: 'ollama', ai_model: 'qwen3:8b', local_fallback: true };
  }
  if (!dashSession) return false;
  // Special job: import groups from Facebook
  if (job.message === '__sync_identities__') {
    const claimed = await sbUpdateJob(job.id, {
      status: 'processing',
      started_at: new Date().toISOString(),
      result: { text: 'Opening Facebook identity switcher...' }
    });
    if (!claimed) return false;
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
    if (!claimed) return false;
    extLog('info', 'Running import_groups job ' + job.id);
    try {
      await runImportGroupsJob(job, dashSession);
    } catch (e) {
      const loginRequired = e?.code === 'facebook_login_required';
      await sbUpdateJob(job.id, {
        status: loginRequired ? 'paused' : 'failed',
        result: { error: e.message, error_code: e?.code || null, requires_facebook_login: loginRequired },
        completed_at: new Date().toISOString()
      });
    }
    return;
  }

  if (job.message === '__join_groups__') {
    const claimed = await sbUpdateJob(job.id, {
      status: 'processing',
      started_at: new Date().toISOString(),
      result: { text: 'Starting actor-first Facebook group join...' }
    });
    if (!claimed) return false;
    extLog('info', 'Running join_groups job ' + job.id);
    try {
      await runJoinGroupsJob(job, dashSession);
    } catch (e) {
      const loginRequired = e?.code === 'facebook_login_required';
      await sbUpdateJob(job.id, {
        status: loginRequired ? 'paused' : 'failed',
        result: { error: e.message, error_code: e?.code || null, requires_facebook_login: loginRequired },
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
    if (!claimed) return false;
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
    if (!claimed) return false;
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

  // An old first batch must not start hours after its schedule. Later batches
  // wait for the previous one, so two workers cannot change the same Facebook
  // actor for different batches of one campaign at the same time.
  if (!(await admitScheduledCampaignBatch(job, dashSession))) return false;

  // Installation-local campaign exclusion, under the existing synchronous actor
  // lock. No queue producer (including a raw storage append) can bypass this
  // execution boundary. This is NOT an account-wide/cross-installation lease.
  // A missing campaign ID matches existing holds conservatively at admission,
  // but does not turn an ordinary untagged job into a new wildcard campaign.
  // Ordinary jobs retain their attempt cooldown/cap accounting. Explicit but
  // invalid/conflicting campaign metadata creates a wildcard hold, not a guess.
  // Only the documented reachrctl ID envelope is decoded, for known legacy IDs.
  const legacyCampaigns = ['wildrose-rose-all-saved-daily', 'emptyslot-budget-alerts-daily'];
  const embeddedCampaign = legacyCampaigns.find(id => new RegExp(`^local_reachr_${id}_[0-9]+$`).test(String(job.id)));
  const explicitCampaigns = [job.campaign_id, job.result?.campaign_id, embeddedCampaign].filter(v => v != null);
  const validCampaign = v => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(v);
  const campaignId = explicitCampaigns.length && explicitCampaigns.every(validCampaign)
    && new Set(explicitCampaigns).size === 1 ? explicitCampaigns[0] : '*';
  const accountId = dashSession.userId;
  const holdStorageKey = `amplr_campaign_uncertainty_v1:${encodeURIComponent(accountId)}`;
  const actorKeyFor = target => {
    const key = target?.identity_key || job.identity_key;
    const name = target?.identity_name || job.identity_name;
    // A stable Facebook key and its display name are normally different.
    // Compare each field with its job-level value instead of comparing key to name.
    if (target?.identity_key && job.identity_key && String(target.identity_key).trim().toLowerCase() !== String(job.identity_key).trim().toLowerCase()) return null;
    if (target?.identity_name && job.identity_name && String(target.identity_name).trim().toLowerCase() !== String(job.identity_name).trim().toLowerCase()) return null;
    return typeof (key || name) === 'string' ? (key || name).trim().toLowerCase() || null : null;
  };
  let holdTargets = job.groups || [];
  try { if (!Array.isArray(holdTargets)) holdTargets = JSON.parse(holdTargets); } catch (_) { return false; }
  if (!Array.isArray(holdTargets)) return false;
  const holdActors = holdTargets.map(actorKeyFor);
  const holdActorAliases = new Set([...holdActors, ...holdTargets.map(t => String(t?.identity_name || job.identity_name || '').trim().toLowerCase()).filter(Boolean)]);
  if (!accountId || (!job.local_fallback && accountId === 'local-fallback') || (job.user_id && job.user_id !== accountId)
      || !holdActors.length || holdActors.some(a => !a) || executeDashJob.campaignPersistenceFailed) return false;
  let campaignLedger;
  try {
    campaignLedger = (await chrome.storage.local.get(holdStorageKey))[holdStorageKey];
    // Dashboard re-authentication must never erase or bypass an existing local
    // uncertainty hold. If the account identity is unavailable, inspect every
    // local ledger read-only and merge only validated historical holds. This
    // makes local fallback more conservative, never more permissive.
    if (job.local_fallback) {
      const allStorage = await chrome.storage.local.get(null);
      const historicalHolds = Object.entries(allStorage)
        .filter(([key]) => key.startsWith('amplr_campaign_uncertainty_v1:'))
        .flatMap(([, ledger]) => Array.isArray(ledger?.holds) ? ledger.holds : []);
      if (historicalHolds.length) {
        campaignLedger = campaignLedger || { version: 1, holds: [] };
        const known = new Set(campaignLedger.holds.map(h => `${h.actor}\u0000${h.campaign}\u0000${h.job_id}`));
        for (const hold of historicalHolds) {
          const key = `${hold?.actor}\u0000${hold?.campaign}\u0000${hold?.job_id}`;
          if (!known.has(key)) { campaignLedger.holds.push(hold); known.add(key); }
        }
      }
    }
    if (campaignLedger === undefined) campaignLedger = { version: 1, holds: [] };
    if (campaignLedger?.version !== 1 || !Array.isArray(campaignLedger.holds)
        || campaignLedger.holds.some(h => !h || typeof h.actor !== 'string' || !h.actor || typeof h.campaign !== 'string'
          || !['held', 'reserved'].includes(h.state) || typeof h.job_id !== 'string')) return false;
  } catch (_) { return false; }
  // A user-confirmed pending submission may narrow an OLD campaign hold, but
  // only with an unambiguous, account-owned single-target source row. Never
  // infer approval from a missing permalink or clear a reservation/other job.
  // Lookup failure leaves the original campaign-wide exclusion untouched.
  for (const hold of [...campaignLedger.holds]) {
    if (hold.state !== 'held' || !holdActorAliases.has(hold.actor)
        || !(campaignId === '*' || hold.campaign === '*' || hold.campaign === campaignId)) continue;
    let row;
    try {
      if (job.local_fallback) {
        const data = await chrome.storage.local.get('amplr_local_fallback_jobs');
        row = data.amplr_local_fallback_jobs?.find(r => String(r.id) === hold.job_id);
      } else {
        const res = await fetch(`${SB_URL}/rest/v1/jsw_post_jobs?id=eq.${encodeURIComponent(hold.job_id)}&user_id=eq.${encodeURIComponent(accountId)}&select=id,user_id,status,groups,result`, {
          headers: { apikey: SB_ANON_KEY, Authorization: `Bearer ${dashSession.accessToken}` }
        });
        if (!res.ok) continue;
        const rows = await res.json();
        if (Array.isArray(rows) && rows.length === 1) row = rows[0];
      }
      if (!row || String(row.id) !== hold.job_id || row.user_id !== accountId || row.status !== 'paused'
          || row.result?.manual_reconciliation?.status !== 'pending_approval') continue;
      const targets = typeof row.groups === 'string' ? JSON.parse(row.groups) : row.groups;
      const results = row.result.results;
      if (!Array.isArray(targets) || targets.length !== 1 || !Array.isArray(results) || results.length !== 1) continue;
      const actor = value => {
        const key = value?.identity_key || row.identity_key;
        const name = value?.identity_name || row.identity_name;
        if (value?.identity_key && row.identity_key && String(value.identity_key).trim().toLowerCase() !== String(row.identity_key).trim().toLowerCase()) return [];
        if (value?.identity_name && row.identity_name && String(value.identity_name).trim().toLowerCase() !== String(row.identity_name).trim().toLowerCase()) return [];
        return [key, name].filter(Boolean).map(item => String(item).trim().toLowerCase());
      };
      const groupKey = value => {
        try {
          const url = new URL(value);
          return url.protocol === 'https:' && /^(www\.|m\.)?facebook\.com$/.test(url.hostname)
            && !url.username && !url.password && !url.port
            ? url.pathname.match(/^\/groups\/([^/]+)\/?$/)?.[1]?.toLowerCase() : null;
        } catch (_) { return null; }
      };
      const group = groupKey(targets[0].url);
      const reconciliationGroup = row.result.manual_reconciliation.group_url;
      if (!group || !actor(targets[0]).includes(hold.actor) || !actor(results[0]).includes(hold.actor)
          || !['submitted_unconfirmed', 'pending_approval'].includes(results[0].status) || groupKey(results[0].group_url) !== group
          || groupKey(hold.evidence?.group_url) !== group
          || (reconciliationGroup != null && groupKey(reconciliationGroup) !== group)) continue;
      // Durable target exclusion first. If either write fails, stop admission;
      // a restart sees at least the old campaign hold or the new group hold.
      const key = `reachr_group_hold:${encodeURIComponent(hold.actor)}:${group}`;
      await chrome.storage.local.set({ [key]: { reason: 'pending_approval', job_id: hold.job_id,
        auto_retry_allowed: false, recorded_at: new Date().toISOString(), evidence: row.result.manual_reconciliation } });
      const narrowed = { ...campaignLedger, holds: campaignLedger.holds.filter(h => h !== hold) };
      await chrome.storage.local.set({ [holdStorageKey]: narrowed });
      campaignLedger = narrowed;
    } catch (_) { return false; }
  }
  const _blockingHolds = campaignLedger.holds.filter(h => holdActorAliases.has(h.actor)
      && (campaignId === '*' || h.campaign === '*' || h.campaign === campaignId));
  const _jobTargetGroups = new Set(holdTargets.map(t => {
    try { return new URL(t.url || t.group_url || '').pathname.match(/^\/groups\/([^/]+)\/?$/)?.[1]?.toLowerCase() || null; }
    catch (_) { return null; }
  }).filter(Boolean));
  // Database rows have no dedicated continuation column. Durable jobs may carry
  // this explicit, audited one-time authorization in their result envelope.
  const explicitBoundedContinuation = job.explicit_bounded_continuation === true
    || job.result?.explicit_bounded_continuation === true;
  const _continuationSafe = explicitBoundedContinuation && _blockingHolds.length > 0
    && _blockingHolds.every(h => {
      if (!h.evidence?.group_url) return false;
      try { const g = new URL(h.evidence.group_url).pathname.match(/^\/groups\/([^/]+)\/?$/)?.[1]?.toLowerCase();
        return g != null && !_jobTargetGroups.has(g); } catch (_) { return false; }
    });
  if (_blockingHolds.length > 0 && !_continuationSafe) {
    // A local row would otherwise be selected every poll and spin forever on a
    // known-unresolved campaign. Pause it before any Facebook action; it can be
    // reconciled explicitly but never silently replayed.
    if (job.local_fallback) {
      await sbUpdateJob(job.id, {
        status: 'paused',
        execution_phase: 'manual_review',
        execution_updated_at: new Date().toISOString(),
        error: 'Campaign has an unconfirmed publication attempt. Manual reconciliation required; this queued post will not be replayed.',
        result: { ...(job.result || {}), campaign_hold: true, auto_retry_allowed: false }
      });
    } else {
      await pauseDashboardPendingJob(job,
        'Campaign has an unconfirmed publication attempt. Manual reconciliation required; this queued post will not be replayed.',
        { campaign_hold: true });
    }
    extLog('warn', 'Campaign uncertainty hold: pending job retained for reconciliation');
    return false;
  }
  let campaignPersistenceFailed = false;
  async function persistTargetHold(key, reason, evidence) {
    try {
      await chrome.storage.local.set({ [key]: { reason, job_id: String(job.id),
        recorded_at: new Date().toISOString(), auto_retry_allowed: false, evidence } });
    } catch (_) {
      campaignPersistenceFailed = true;
      executeDashJob.campaignPersistenceFailed = true;
      throw new Error('Group hold persistence failed; reconciliation required');
    }
  }
  // Reserve BEFORE delivering a mutation. A worker crash or failed promotion
  // leaves durable exclusion, rather than relying on a best-effort post-click
  // write. Only this invocation may finish its other targets; even the same job
  // ID is blocked after a worker restart. Held entries are never auto-released.
  async function persistCampaignHold(target, evidence, state = 'held') {
    if (!explicitCampaigns.length) return;
    const actor = actorKeyFor(target);
    const existing = campaignLedger.holds.find(h => h.actor === actor && h.campaign === campaignId);
    if (existing?.state === 'held') return;
    campaignLedger.holds = campaignLedger.holds.filter(h => h !== existing);
    if (state !== 'release') campaignLedger.holds.push({ actor, campaign: campaignId, state, job_id: String(job.id),
      reason: state === 'reserved' ? 'submission_in_flight' : 'publication_unconfirmed',
      recorded_at: new Date().toISOString(), evidence: evidence || null });
    try { await chrome.storage.local.set({ [holdStorageKey]: campaignLedger }); }
    catch (_) {
      campaignPersistenceFailed = true;
      executeDashJob.campaignPersistenceFailed = true;
      throw new Error('Campaign uncertainty persistence failed; reconciliation required');
    }
  }

  // Claim with an owner-bound durable lease before any Facebook work. Cloud
  // rows retain their existing atomic pending-only claim; outage execution uses
  // the local lifecycle because its evidence remains writable without auth.
  const localExecutionLease = job.local_fallback ? await claimLocalExecutionLifecycle(job) : null;
  const dashboardExecutionLease = job.local_fallback ? null : await claimDashboardExecutionLifecycle(job);
  const claimed = job.local_fallback ? !!localExecutionLease : !!dashboardExecutionLease;
  if (!claimed) {
    extLog('warn', 'Job already claimed, paused, or unavailable: ' + job.id);
    return false;
  }
  const executionLease = localExecutionLease || dashboardExecutionLease;
  try {
    await requireFacebookSessionForGroupScan();
    const checkpointed = localExecutionLease
      ? await checkpointLocalExecutionLifecycle(job, localExecutionLease, 'session_verified', {
        result: { text: 'Facebook session verified; command has not been dispatched.' }
      })
      : await checkpointDashboardExecutionLifecycle(job, dashboardExecutionLease, 'session_verified', {
        result: { text: 'Facebook session verified; command has not been dispatched.' }
      });
    if (!checkpointed) return false;
  } catch (e) {
    const pausePatch = {
      status: 'paused', execution_phase: 'manual_review', execution_updated_at: new Date().toISOString(),
      error: `Facebook session preflight failed: ${e.message}. Manual review required; no command dispatched.`,
      result: { pre_submit_failure: true, auto_retry_allowed: false, error: e.message }
    };
    if (localExecutionLease) await updateLocalFallbackJob(job.id, pausePatch, { status: 'processing', execution_owner: localExecutionLease.owner });
    else await completeDashboardExecutionLifecycle(job, dashboardExecutionLease, pausePatch);
    return false;
  }

  extLog('info', 'Executing job ' + job.id);
  broadcastDashStatus('Processing job...', '#eab308');

  let groups = job.groups || [];
  if (!Array.isArray(groups)) {
    try { groups = JSON.parse(groups); } catch (e) { groups = []; }
  }
  const controls = await fetchDashboardRunnerControls(dashSession);
  const groupTargets = groups.map(g => typeof g === 'string' ? { url:g } : { ...g, url: g.url || g.group_url }).filter(g => g && g.url);

  // Never silently drop overflow targets. A prior implementation posted only
  // the first maxGroupsPerJob targets and marked the rest skipped, which made
  // a completed job look exhaustive when it was not. Stop before dispatch so
  // an operator or queue builder can create separate, bounded child jobs.
  if (groupTargets.length > controls.maxGroupsPerJob) {
    const stoppedAt = new Date().toISOString();
    const pausePatch = {
      status: 'paused',
      execution_phase: 'manual_review',
      execution_updated_at: stoppedAt,
      execution_lease_expires_at: null,
      error: `Job has ${groupTargets.length} targets, exceeding the ${controls.maxGroupsPerJob}-group runner limit. Split it into bounded jobs before dispatch; no group was posted.`,
      result: {
        ...(job.result || {}),
        batch_split_required: true,
        auto_retry_allowed: false,
        total_target_count: groupTargets.length,
        max_groups_per_job: controls.maxGroupsPerJob,
        stopped_at: stoppedAt
      }
    };
    const saved = localExecutionLease
      ? await updateLocalFallbackJob(job.id, pausePatch, { status: 'processing', execution_owner: localExecutionLease.owner })
      : await completeDashboardExecutionLifecycle(job, dashboardExecutionLease, pausePatch);
    if (saved) {
      extLog('warn', `Job ${job.id} paused before dispatch: ${groupTargets.length} targets exceed max ${controls.maxGroupsPerJob}.`);
      broadcastDashStatus(`Paused — split ${groupTargets.length} targets into batches of ${controls.maxGroupsPerJob} or fewer`, '#eab308');
      notify(`Dashboard job paused before dispatch — ${groupTargets.length} targets exceed the ${controls.maxGroupsPerJob}-group limit. No post was attempted.`);
    }
    return false;
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
  const postingTabIds = [];
  const perGroupResults = [];

  const cooldownDays = controls.cooldownDays;

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  let recentPostedCount = await countRecentPostedResults(dashSession, since24h);
  // Unknown cloud history cannot be replaced by this browser's partial ledger.
  // Persist proven non-dispatch separately from publication uncertainty.
  if (!Number.isSafeInteger(recentPostedCount) || recentPostedCount < 0) {
    const stoppedAt = new Date().toISOString();
    const pausePatch = {
      status: 'paused', execution_phase: 'manual_review', execution_updated_at: stoppedAt,
      execution_lease_expires_at: null,
      error: 'Daily post count unavailable; no command dispatched. Restore count access before retrying.',
      result: {
        classification: 'failed_before_submission', pre_submit_failure: true,
        error_code: 'daily_post_count_unavailable', success_count: 0,
        submitted_unconfirmed_count: 0, auto_retry_allowed: false, auto_repeat_allowed: false
      }
    };
    if (localExecutionLease) await updateLocalFallbackJob(job.id, pausePatch, { status: 'processing', execution_owner: localExecutionLease.owner });
    else await completeDashboardExecutionLifecycle(job, dashboardExecutionLease, pausePatch);
    return { autoRepeatAllowed: false };
  }
  // Keep uncertain attempts out of the publication table without dropping
  // conservative local cooldown / 24h attempt accounting on the next job.
  // Actor serialization already protects this worker's read/modify/write.
  const attemptStorageKey = `amplr_unconfirmed_attempts:${dashSession.userId}`;
  const storedAttempts = (await chrome.storage.local.get(attemptStorageKey))[attemptStorageKey];
  const attemptCutoff = Date.now() - Math.max(1, cooldownDays) * 86400000;
  const recentAttempts = (Array.isArray(storedAttempts) ? storedAttempts : []).filter(a => new Date(a.submitted_at).getTime() >= attemptCutoff);
  const recentUnconfirmedCount = recentAttempts.filter(a => a.submitted_at >= since24h).length;
  recentPostedCount += recentUnconfirmedCount;

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

  for (const attempt of recentAttempts) {
    const key = `${attempt.identity_key}::${attempt.group_url}`;
    const previous = groupCooldownMap[key] || {};
    if (!previous.last_posted_at || previous.last_posted_at < attempt.submitted_at) {
      groupCooldownMap[key] = { ...previous, last_posted_at: attempt.submitted_at };
    }
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

    // BEGIN GROUP HOLD ADMISSION
    const groupSlug = groupUrl.match(/facebook\.com\/groups\/([^/?#]+)/i)?.[1];
    const groupHoldKey = `reachr_group_hold:${encodeURIComponent(identityName.trim().toLowerCase())}:${String(groupSlug).toLowerCase()}`;
    const groupHold = (await chrome.storage.local.get(groupHoldKey))[groupHoldKey];
    if (groupHold) {
      perGroupResults.push(skippedResult(target, 'group_restricted', {
        type: 'group_restricted', message: `Manual review required: ${groupHold.reason}`
      }));
      continue;
    }
    // END GROUP HOLD ADMISSION

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
      if (recentPostedCount !== null && recentPostedCount >= controls.dailyPostCap) {
        cooldownWarning = {
          type: 'daily_post_cap',
          daily_user_post_cap: controls.dailyPostCap,
          recent_posted_count: recentPostedCount,
          message: `Skipped because dashboard runner controls hit the ${controls.dailyPostCap}/24h posting cap.`
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

    const trackingResult = addTrackingParamsToMessage(finalText, { job, target, groupUrl, finalText });
    finalText = trackingResult.message;
    if (trackingResult.tracked_url_count) {
      extLog('info', `Tracking added for ${groupUrl}: ${trackingResult.tracking.campaign}/${trackingResult.tracking.creative}/${trackingResult.tracking.group}`);
    }

    let tab = null;
    try {
      // Prove the selected actor afresh for every destination. A previous group
      // cannot authorize movement on a later target after an account switch.
      const preflight = await ensureFacebookIdentityActive(identityName, identityUrl, identityType);
      if (!preflight?.success) {
          lastError = preflight?.error || `Could not verify Facebook identity ${identityName}`;
          perGroupResults.push({
            group_url: groupUrl,
            group_name: target.name || target.group_name || null,
            identity_name: identityName,
            identity_key: identityKey || null,
            identity_used: preflight?.active_identity || null,
            active_identity: preflight?.active_identity || null,
            composer_identity: null,
            composer_identity_verified: false,
            status: 'failed',
            error: lastError,
            error_code: 'identity_preflight_failed',
            failed_at: new Date().toISOString(),
            final_message: finalText,
            tracking: trackingResult.tracking,
            tracked_url_count: trackingResult.tracked_url_count,
            warnings: cooldownWarning ? [cooldownWarning] : []
          });
          broadcastDashStatus(`Identity verify failed ${i + 1}/${groupUrls.length}`, '#ef4444');
          break;
          }

          tab = await chrome.tabs.create({ url: groupUrl, active: true });
      postingTabIds.push(tab.id);
      await sleep(5000);

      // Final proof is tied to this exact group composer. The content script
      // opens and closes it without typing or submitting. Switching is disabled
      // here because the independent home-surface proof above is the only
      // permitted actor-change stage.
      const composerPreflight = await sendTabMessageWithRetry(tab.id, {
        type: 'PROBE_GROUP_COMPOSER_IDENTITY',
        identityName,
        identityUrl,
        identityType,
        skipSwitch: true
      }, 4);
      if (!composerPreflight?.success || composerPreflight?.composerIdentityVerified !== true) {
        const error = composerPreflight?.error || `Composer identity is not confirmed as ${identityName}`;
        perGroupResults.push({
          group_url: groupUrl,
          group_name: target.name || target.group_name || null,
          identity_name: identityName,
          identity_key: identityKey || null,
          identity_used: composerPreflight?.composerIdentity || composerPreflight?.activeIdentity || null,
          active_identity: composerPreflight?.activeIdentity || null,
          composer_identity: composerPreflight?.composerIdentity || null,
          composer_identity_verified: false,
          status: 'failed',
          error,
          error_code: composerPreflight?.error_code || 'identity_not_verified',
          failed_at: new Date().toISOString(),
          final_message: finalText,
          tracking: trackingResult.tracking,
          tracked_url_count: trackingResult.tracked_url_count,
          warnings: cooldownWarning ? [cooldownWarning] : []
        });
        broadcastDashStatus(`Composer identity not verified ${i + 1}/${groupUrls.length}`, '#ef4444');
        continue;
      }

      await persistCampaignHold(target, { group_url: groupUrl }, 'reserved');
      // This checkpoint is intentionally immediately before the only mutable
      // Facebook command. If the worker dies after it, reconciliation pauses
      // the job instead of ever replaying an ambiguous submission.
      const commandCheckpointed = localExecutionLease
        ? await checkpointLocalExecutionLifecycle(job, localExecutionLease, 'command_dispatched', {
          result: { text: 'Facebook post command dispatching; do not replay without manual reconciliation.', group_url: groupUrl }
        })
        : await checkpointDashboardExecutionLifecycle(job, dashboardExecutionLease, 'command_dispatched', {
          result: { text: 'Facebook post command dispatching; do not replay without manual reconciliation.', group_url: groupUrl }
        });
      if (!commandCheckpointed) {
        throw new Error('Lost execution lease before Facebook command dispatch');
      }
      let response;
      try {
        response = await sendTabMessageWithRetry(tab.id, {
          type: 'POST_TO_PAGE',
          intendedGroupUrl: groupUrl,
          message: finalText,
          imageUrl: job.image_url || '',
          identityName,
          identityUrl,
          identityType
        }, 4);
      } catch (error) {
        // Missing receivers prove non-delivery; other lost mutation replies do
        // not prove failure. Preserve uncertainty without asserting a click.
        if (/Receiving end does not exist|Could not establish connection/i.test(String(error?.message || error))) {
          await persistCampaignHold(target, null, 'release');
          throw error;
        }
        // A thrown defense error is not proof that the mutation was never
        // delivered. Keep the reservation and the existing defense stop.
        if (isFacebookDefenseError(error?.message || error)) throw error;
        response = { success: false, submissionDeliveryUnknown: true, publicationVerified: false,
          evidenceStatus: 'submission_delivery_unknown', evidenceReason: String(error?.message || error) };
      }
      if (!response) response = { success: false, submissionDeliveryUnknown: true, publicationVerified: false,
        evidenceStatus: 'submission_delivery_unknown', evidenceReason: 'empty_submission_response' };

      // Security signals outrank a contradictory group-local refusal code.
      if (isFacebookDefenseError(response.error)) response = { ...response, error_code: 'facebook_defense' };
      let destinationQuarantined = false;
      const attemptReported = response.success === true || response.submitted === true || response.submissionDeliveryUnknown === true;
      const provenPreSubmitRefusal = !attemptReported && response.error_code !== 'facebook_defense'
        && !isFacebookDefenseError(response.error) && ['not_group_member', 'group_restricted', 'identity_required',
        'identity_not_verified', 'intended_destination_not_verified', 'composer_submit_not_ready', 'composer_text_entry_failed'].includes(response.error_code);
      if (provenPreSubmitRefusal) {
        if (['not_group_member', 'group_restricted'].includes(response.error_code)) {
          await persistTargetHold(groupHoldKey, response.error_code, { group_url: groupUrl, error: response.error || null });
        }
        await persistCampaignHold(target, null, 'release');
      }
      else if (response.error_code === 'facebook_defense' || isFacebookDefenseError(response.error)) {
        // A security/checkpoint signal may affect every following destination,
        // so retain the campaign-wide stop for this class only.
        await persistCampaignHold(target, { group_url: groupUrl, response });
      }
      else if (!attemptReported) {
        // The command result is ambiguous, but its destination is exact. Keep
        // that target non-replayable and continue the caller's untouched work.
        await persistTargetHold(groupHoldKey, 'submission_delivery_unknown', { group_url: groupUrl, response });
        await persistCampaignHold(target, null, 'release');
        destinationQuarantined = true;
      }

      if ((response?.success === true || response?.submitted === true || response?.submissionDeliveryUnknown === true) && response?.error_code !== 'facebook_defense' && !isFacebookDefenseError(response?.error)) {
        const outcome = submissionEvidenceOutcome(response, groupUrl);
        if (outcome.publication_verified) successCount++;
        const postedAt = new Date().toISOString();
        const postUrl = outcome.post_url;
        const evidenceFound = !!response?.evidenceFound;
        extLog('info', `${outcome.publication_verified ? 'Verified publication' : 'Submitted, publication unconfirmed'} ${i + 1}/${groupUrls.length} → ${groupUrl}`);
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
          ...outcome,
          evidence_found: evidenceFound,
          matched_text: response?.matchedText || null,
          page_url: response?.pageUrl || null,
          final_message: finalText,
          tracking: trackingResult.tracking,
          tracked_url_count: trackingResult.tracked_url_count,
          warnings: cooldownWarning ? [cooldownWarning] : [],
          ...(outcome.publication_verified ? { posted_at: postedAt } : {
            submitted_at: postedAt,
            auto_retry_allowed: false,
            destination_quarantined: true
          })
        });
        broadcastDashStatus(`${outcome.publication_verified ? 'Posted' : 'Submission unconfirmed'} ${i + 1}/${groupUrls.length}`, outcome.publication_verified ? '#4ecca3' : '#eab308');
        const cooldownKey = `${identityKey}::${groupUrl}`;
        groupCooldownMap[cooldownKey] = { ...groupCooldownMap[cooldownKey], last_posted_at: postedAt };
        if (!outcome.publication_verified) {
          // The destination is known even when Facebook does not return enough
          // evidence to prove publication. Quarantine that exact actor+group
          // BEFORE releasing the campaign reservation. This prevents a replay
          // of the ambiguous target while allowing untouched destinations in
          // the same requested campaign to continue.
          await persistTargetHold(groupHoldKey,
            outcome.pending_approval === true ? 'pending_approval' : 'publication_unconfirmed',
            perGroupResults[perGroupResults.length - 1]);
          await persistCampaignHold(target, null, 'release');
          recentAttempts.push({ job_id: job.id, identity_key: identityKey, group_url: groupUrl, submitted_at: postedAt });
          await chrome.storage.local.set({ [attemptStorageKey]: recentAttempts });
        } else {
          await persistCampaignHold(target, null, 'release');
        }
        // Existing cooldown field tracks attempts conservatively, not publication proof.
        fetch(`${SB_URL}/rest/v1/jsw_groups?user_id=eq.${dashSession.userId}&identity_key=eq.${encodeURIComponent(identityKey || '__legacy__')}&group_url=eq.${encodeURIComponent(groupUrl)}`, {
          method: 'PATCH',
          headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${dashSession.accessToken}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ last_posted_at: postedAt })
        }).catch(e => extLog('warn', 'last_posted_at update error: ' + e.message));

        if (recentPostedCount !== null) recentPostedCount++;

        // This legacy table feeds publication counts and ban detection. Do not
        // insert uncertain attempts as publications; evidence lives in job.result.
        if (outcome.publication_verified) fetch(`${SB_URL}/rest/v1/jsw_post_results`, {
          method: 'POST',
          headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${dashSession.accessToken}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ user_id: dashSession.userId, group_url: groupUrl, post_url: postUrl, job_id: job.id, posted_at: postedAt })
        }).catch(e => extLog('warn', 'jsw_post_results insert error: ' + e.message));

        // First comment automation
        if (job.first_comment && outcome.publication_verified && postUrl) {
          await sleep(4000); // let FB process the post
          try {
            await postFirstComment(tab.id, job.first_comment);
            extLog('info', 'First comment posted on ' + groupUrl);
          } catch(e) {
            extLog('warn', 'First comment failed: ' + e.message);
          }
        }

        // Ambiguous publication is terminal for this actor+group, not for the
        // whole campaign. The durable group quarantine above makes continuing
        // safe and guarantees this destination is not replayed.
      } else if (response?.error_code === 'group_restricted') {
        const warning = { type: 'group_restricted', message: response.error || 'Group restricted; manual review required' };
        perGroupResults.push(skippedResult(target, 'group_restricted', warning));
        jobWarnings.push(warning);
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
          // Diagnostics are evidence only: never promote them to readiness or
          // publication proof and never infer a group restriction from them.
          reason: typeof response?.reason === 'string' ? response.reason.slice(0, 500) : null,
          readiness: response?.readiness && typeof response.readiness === 'object' ? response.readiness : null,
          status: 'failed',
          error: lastError,
          ...(destinationQuarantined ? { auto_retry_allowed: false, destination_quarantined: true } : {}),
          warnings: cooldownWarning ? [cooldownWarning] : [],
          final_message: finalText,
          tracking: trackingResult.tracking,
          tracked_url_count: trackingResult.tracked_url_count,
          failed_at: new Date().toISOString()
        });
        extLog('error', `Failed ${i + 1}/${groupUrls.length} → ${groupUrl}: ${lastError}`);
        broadcastDashStatus(`Failed ${i + 1}/${groupUrls.length}`, '#e94560');
        if (defenseTriggered) {
          jobWarnings.push({ type: 'facebook_defense_stop', message: `Stopped batch after Facebook defense signal: ${lastError}` });
          lastError = `Stopped after Facebook defense signal: ${lastError}`;
          break;
        }
        if ((!provenPreSubmitRefusal && !destinationQuarantined)
            || ['identity_required', 'identity_not_verified', 'identity_switch_failed', 'intended_destination_not_verified'].includes(response?.error_code)) break;
      }

    } catch (e) {
      lastError = e.message;
      if (campaignPersistenceFailed) {
        // Do not append a contradictory failed attempt over evidence already
        // recorded, or continue to another group after losing durable safety.
        jobWarnings.push({ type: 'campaign_hold_persistence_failed', message: lastError });
        break;
      }
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
        tracking: trackingResult.tracking,
        tracked_url_count: trackingResult.tracked_url_count,
        failed_at: new Date().toISOString()
      });
      extLog('error', `Error on group ${i + 1} (${groupUrl}): ${e.message}`);
      broadcastDashStatus(`Error on group ${i + 1}`, '#e94560');
      if (defenseTriggered) {
        jobWarnings.push({ type: 'facebook_defense_stop', message: `Stopped batch after Facebook defense signal: ${lastError}` });
        lastError = `Stopped after Facebook defense signal: ${lastError}`;
        break;
      }
    } finally {
      // Start cleanup as soon as this destination's attempt has settled. Do not
      // await browser housekeeping: a stuck tabs.remove must never block result
      // persistence or the remaining campaign. Ownership validation inside the
      // helper prevents any pre-existing/user-created tab from being removed.
      closeOwnedPostingTab(tab, postingTabIds);
    }

    if (i < groupUrls.length - 1) {
      const waitSeconds = randomAntiBotDelaySeconds(job.delay || 0);
      broadcastDashStatus(`Anti-bot wait ${waitSeconds}s...`, '#6a6a8a');
      await sleepWithWorkerKeepalive(waitSeconds * 1000);
    }
  }

  // Mark done or failed
  const success = successCount > 0;
  const failedCount = perGroupResults.filter(r => r.status === 'failed').length;
  const skippedCount = perGroupResults.filter(r => r.status === 'skipped').length;
  const unconfirmedCount = perGroupResults.filter(r => r.status === 'submitted_unconfirmed').length;
  const quarantinedCount = perGroupResults.filter(r => r.destination_quarantined === true).length;
  // Paused is an existing job state, retained locally and blocking durable
  // occurrence admission. Group attempts themselves are terminal, not retryable.
  const needsReview = campaignPersistenceFailed || campaignLedger.holds.length > 0
    && campaignLedger.holds.some(h => h.job_id === String(job.id));
  const completedWithoutHardFailure = success || unconfirmedCount > 0 || (skippedCount > 0 && failedCount === 0);
  const autoRepeatAllowed = !needsReview && quarantinedCount === 0;
  const completedAt = new Date().toISOString();
  const completionPatch = {
    status: needsReview ? 'paused' : completedWithoutHardFailure ? 'done' : 'failed',
    ...(executionLease ? { execution_phase: needsReview ? 'manual_review' : 'completed', execution_updated_at: completedAt, execution_lease_expires_at: null } : {}),
    error: needsReview ? 'Publication unconfirmed; manual reconciliation required before any replay.' : completedWithoutHardFailure ? null : (lastError || 'All groups failed'),
    result: {
      // Keep the campaign/reconciliation envelope durable across completion.
      ...(job.result || {}),
      success_count: successCount,
      submitted_unconfirmed_count: unconfirmedCount,
      quarantined_count: quarantinedCount,
      auto_repeat_allowed: autoRepeatAllowed,
      total_groups: groupUrls.length,
      failed_count: failedCount,
      skipped_count: skippedCount,
      warnings: jobWarnings,
      results: perGroupResults,
      completed_at: completedAt
    },
    completed_at: completedAt
  };
  const completionSaved = localExecutionLease
    ? await updateLocalFallbackJob(job.id, completionPatch, { status: 'processing', execution_owner: localExecutionLease.owner })
    : await completeDashboardExecutionLifecycle(job, dashboardExecutionLease, completionPatch);

  extLog(needsReview ? 'warn' : completedWithoutHardFailure ? 'info' : 'error', `Job ${job.id} ${needsReview ? 'PAUSED FOR REVIEW' : completedWithoutHardFailure ? 'DONE' : 'FAILED'} — ${successCount}/${groupUrls.length} posted, ${quarantinedCount} quarantined, ${skippedCount} skipped`);

  broadcastDashStatus(
    needsReview ? `Paused for review — ${unconfirmedCount} unconfirmed, ${successCount} verified publications` : completedWithoutHardFailure ? `Done — ${successCount}/${groupUrls.length} posted${quarantinedCount ? `, ${quarantinedCount} quarantined` : ''}${skippedCount ? `, ${skippedCount} skipped` : ''}` : 'Job failed',
    needsReview ? '#eab308' : completedWithoutHardFailure ? '#4ecca3' : '#e94560'
  );

  notify(needsReview ? `Dashboard job paused — ${unconfirmedCount} submissions unconfirmed. Do not replay without reconciliation.` : completedWithoutHardFailure
    ? `Dashboard job complete — ${successCount}/${groupUrls.length} groups posted${quarantinedCount ? `, ${quarantinedCount} quarantined (not replayable)` : ''}${skippedCount ? `, ${skippedCount} skipped` : ''}.`
    : `Dashboard job failed: ${lastError}`
  );

  // ── Webhook delivery (fire-and-forget, best-effort) ──
  if (job.webhook_url) {
    fireWebhook(job, completedWithoutHardFailure, successCount, groupUrls.length, lastError, unconfirmedCount, quarantinedCount, autoRepeatAllowed);
  }
  return { autoRepeatAllowed: autoRepeatAllowed && completionSaved === true };
  } finally {
    activeDashJobId = null;
  }
}

// Fire a webhook to the caller's endpoint with job completion details
async function fireWebhook(job, success, successCount, totalGroups, lastError, unconfirmedCount = 0, quarantinedCount = unconfirmedCount, autoRepeatAllowed = quarantinedCount === 0) {
  const payload = {
    event:       quarantinedCount && success ? 'job.completed_with_quarantine' : success ? 'job.completed' : 'job.failed',
    job_id:      job.id,
    status:      success ? 'done' : 'failed',
    success_count: successCount,
    submitted_unconfirmed_count: unconfirmedCount,
    quarantined_count: quarantinedCount,
    auto_repeat_allowed: autoRepeatAllowed,
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

// Update a job row via Supabase REST PATCH, or chrome.storage when this is a local fallback job
async function sbUpdateJob(jobId, patch) {
  try {
    if (String(jobId || '').startsWith('local_')) {
      const ok = await updateLocalFallbackJob(jobId, patch);
      if (ok && (patch.status === 'done' || patch.status === 'failed' || (patch.status === 'paused' && patch.result?.submitted_unconfirmed_count > 0))) await appendLocalFallbackResult(jobId, patch.result || patch);
      return ok;
    }
    const session = await getStoredSession();
    if (!session) return false;
    // A successful HTTP PATCH can update zero rows. Claims must atomically
    // transition pending -> processing and prove that this caller won.
    const claiming = patch.status === 'processing';
    const res = await fetch(`${SB_URL}/rest/v1/jsw_post_jobs?id=eq.${encodeURIComponent(jobId)}${claiming ? '&status=eq.pending' : ''}`, {
      method: 'PATCH',
      headers: {
        'apikey': SB_ANON_KEY,
        'Authorization': `Bearer ${session.accessToken}`,
        'Content-Type': 'application/json',
        'Prefer': claiming ? 'return=representation' : 'return=minimal'
      },
      body: JSON.stringify(patch)
    });
    if (!res.ok) return false;
    if (!claiming) return true;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length === 1 && String(rows[0].id) === String(jobId);
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
  if (/^(quick switch profiles?|see all profiles?|see all pages?|settings(?:\s*(?:&|and)?\s*privacy)?|help(?:\s*(?:&|and)?\s*support)?|report a problem(?:\s*⌘\s*B)?|give feedback|meta verified|meta business suite|display & accessibility|privacy|terms|privacy policy|advertising|ad choices|cookies|more|active|edit|manage|create(?: page)?|back to previous(?: page)?|select an option|available voices?,?\s*switch|unread chats?|chatsallhas new content.*|log out)$/i.test(cleaned)) return true;
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

function isFacebookMessageChannelReloadError(error) {
  const msg = String(error?.message || error || '');
  return /Receiving end does not exist|Could not establish connection|message (?:channel|port) closed|asynchronous response.*channel closed|Extension context invalidated|Frame with ID \d+ was removed|frame was removed|document was unloaded/i.test(msg);
}

const TAB_MESSAGE_RESPONSE_TIMEOUT_MS = 90_000;

async function sendTabMessageWithRetry(tabId, message, attempts = 5) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      // A content script can keep a message channel open indefinitely if Facebook
      // replaces its frame mid-flow. A post command has already been checkpointed
      // before this point, so a bounded timeout must surface as delivery-unknown
      // and pause/manual-review rather than wedging the whole local runner.
      return await Promise.race([
        chrome.tabs.sendMessage(tabId, message),
        new Promise((_, reject) => setTimeout(() => {
          reject(new Error(`Content-script response timed out after ${TAB_MESSAGE_RESPONSE_TIMEOUT_MS}ms`));
        }, TAB_MESSAGE_RESPONSE_TIMEOUT_MS))
      ]);
    } catch (e) {
      lastError = e;
      // An accepted mutation may have completed before navigation lost its reply.
      // Never blindly replay a post or identity switch. Only missing receivers
      // prove delivery did not happen; callers can verify identity after reload.
      const missingReceiver = /Receiving end does not exist|Could not establish connection/i.test(String(e?.message || e));
      const mutation = /^(POST_TO_PAGE|PROBE_GROUP_COMPOSER_TYPING|SWITCH_FACEBOOK_)/.test(String(message?.type || ''));
      if (mutation && !missingReceiver) throw e;
      if (isFacebookMessageChannelReloadError(e)) {
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

async function ensureFacebookIdentityActive(identityName, identityUrl = null, identityType = null) {
  if (!identityName || isForbiddenPostingIdentityName(identityName)) {
    return { success: false, error: 'Missing valid Facebook identity name' };
  }
  const isManagedPage = /^page|facebook page$/i.test(String(identityType || ''))
    || (!!identityUrl && /^https:\/\/(www\.)?facebook\.com\/profile\.php\?id=\d+/i.test(String(identityUrl)));
  let tab = null;
  let switchResponse = null;
  let switchError = null;
  try {
    tab = await chrome.tabs.create({ url: identityUrl || 'https://www.facebook.com/pages/?category=your_pages', active: true });
    await sleep(identityUrl ? 8000 : 6500);

    const trySwitchMessage = async (message) => {
      try {
        return await sendTabMessageWithRetry(tab.id, message, 2);
      } catch (e) {
        if (isFacebookMessageChannelReloadError(e)) {
          // Expected when Facebook reloads after clicking "Switch Now". Do not
          // trust it as success; verify on facebook.com after navigation settles.
          switchError = e;
          await sleep(7000);
          return { success: false, channel_closed_during_switch: true, error: String(e.message || e) };
        }
        throw e;
      }
    };

    if (identityUrl) {
      switchResponse = await trySwitchMessage({ type: 'SWITCH_FACEBOOK_IDENTITY', identityName, identityUrl });
      if (!switchResponse?.success && switchResponse?.channel_closed_during_switch) {
        await sleep(7000);
        try {
          const interimVerify = await sendTabMessageWithRetry(tab.id, { type: 'GET_FACEBOOK_ACTIVE_IDENTITY', expectedIdentity: identityName }, 4);
          if (facebookIdentityNameMatches(interimVerify?.activeIdentity, identityName)) {
            switchResponse = {
              ...switchResponse,
              success: true,
              active_identity: interimVerify.activeIdentity,
              page_url: interimVerify.pageUrl || null,
              verified_after_channel_close: true
            };
          }
        } catch (verifyErr) {
          extLog('warn', `Identity interim verify after channel close failed for ${identityName}: ${verifyErr.message}`);
        }
      }
    }
    // Facebook's visible Page-profile Switch control is a separate interaction
    // from the content-script menu path. Use the native DevTools click on the
    // exact Page URL before falling back to Pages Manager; then independently
    // prove the actor below. This is the route that handles Page shells whose
    // synthetic/isolated-world click acknowledges but does not switch identity.
    if (!switchResponse?.success && isManagedPage && identityUrl) {
      await chrome.tabs.update(tab.id, { url: identityUrl, active: true });
      await sleep(7000);
      // The Page shell's visible Switch card is often covered by its navigation
      // layer, so mouse coordinates land on navigation rather than the card.
      // Keyboard activation through CDP focus is trusted by Facebook and exposes
      // the required confirmation dialog; only then do we fall back to mouse.
      let nativeFallback = await confirmFacebookPageProfileSwitchByKeyboard(tab.id, identityName);
      if (!nativeFallback?.success) {
        nativeFallback = await clickFacebookPageProfileSwitchButton(tab.id, identityName);
      }
      switchResponse = {
        ...nativeFallback,
        content_switch: switchResponse || null,
        native_page_profile_fallback: nativeFallback,
        fallback_path: 'native_page_profile_switch'
      };
    }
    if (!switchResponse?.success && isManagedPage) {
      await chrome.tabs.update(tab.id, { url: 'https://www.facebook.com/pages/?category=your_pages', active: true });
      await sleep(8000);
      const fallback = await trySwitchMessage({ type: 'SWITCH_FACEBOOK_MANAGED_PAGE', identityName, identityUrl: identityUrl || null });
      switchResponse = { ...fallback, direct_page_probe: switchResponse || null, fallback_path: fallback?.fallback_path || 'background_pages_manager_pre_switch' };
    }

    await sleep(5000);
    let verifyPageContext = null;
    if (isManagedPage && identityUrl) {
      // Facebook Page mode currently renders its global account button as generic
      // “Your profile”. Before falling back to that ambiguous surface, require
      // two native controls in the exact managed-Page document: management chrome
      // and the Page-bound comment actor. The group composer remains the final
      // destination-specific actor proof.
      await chrome.tabs.update(tab.id, { url: identityUrl, active: true });
      await sleep(7000);
      verifyPageContext = await sendTabMessageWithRetry(tab.id, {
        type: 'GET_FACEBOOK_PAGE_CONTEXT_IDENTITY', identityName, identityUrl, expectedIdentity: identityName
      }, 4);
    }
    const verifiedByPageContext = isManagedPage
      && verifyPageContext?.success === true
      && verifyPageContext?.verified === true
      && verifyPageContext?.identitySource === 'native_managed_page_context'
      && facebookIdentityNameMatches(verifyPageContext?.activeIdentity, identityName);

    let verifyHome = null;
    if (!verifiedByPageContext) {
      await chrome.tabs.update(tab.id, { url: 'https://www.facebook.com/', active: true });
      await sleep(7000);
      verifyHome = await sendTabMessageWithRetry(tab.id, { type: 'GET_FACEBOOK_ACTIVE_IDENTITY', expectedIdentity: identityName }, 4);
    }
    // Switching is navigation telemetry, never actor proof. An exact native
    // managed-Page proof is accepted only for a managed Page; all other actors
    // still require the independent home/account-control proof.
    const verifiedByHome = verifyHome?.success === true && facebookIdentityNameMatches(verifyHome?.activeIdentity, identityName);
    const composerVerificationRequired = false;
    const ok = verifiedByPageContext || verifiedByHome;
    const proof = verifiedByPageContext ? verifyPageContext : verifyHome;
    const proofSource = verifiedByPageContext ? 'native_managed_page_context' : 'native_home_account_control';
    return {
      success: ok,
      active_identity: proof?.activeIdentity || null,
      page_url: proof?.pageUrl || null,
      switch_response: switchResponse || null,
      home_verify_identity: verifyHome?.activeIdentity || null,
      home_verify_url: verifyHome?.pageUrl || null,
      page_context_verify_identity: verifyPageContext?.activeIdentity || null,
      page_context_verify_url: verifyPageContext?.pageUrl || null,
      identity_proof_source: ok ? proofSource : null,
      composer_verification_required: composerVerificationRequired,
      recovered_after_channel_close: !!switchError,
      error: ok ? null : (`Home/Page active identity verified as ${verifyHome?.activeIdentity || verifyPageContext?.activeIdentity || 'unknown'}, not ${identityName}`)
    };
  } catch (e) {
    return { success: false, error: String(e?.message || e), switch_response: switchResponse || null };
  } finally {
    if (tab?.id) { try { await chrome.tabs.remove(tab.id); } catch (_) {} }
  }
}

async function openFullFacebookProfileSelectorNative(tabId) {
  const locate = await sendTabMessageWithRetry(tabId, { type: 'LOCATE_FACEBOOK_SEE_ALL_PROFILES' });
  if (!locate?.success || !Number.isFinite(locate.x) || !Number.isFinite(locate.y)) {
    throw new Error(locate?.error || 'Could not locate See all profiles button');
  }
  const target = { tabId };
  await chrome.tabs.update(tabId, { active: true });
  await chrome.debugger.attach(target, '1.3');
  try {
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: locate.x, y: locate.y, button: 'none' });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: locate.x, y: locate.y, button: 'left', clickCount: 1 });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: locate.x, y: locate.y, button: 'left', clickCount: 1 });
  } finally {
    try { await chrome.debugger.detach(target); } catch (_) {}
  }
  let selector;
  for (let attempt = 0; attempt < 15; attempt++) {
    await sleep(1000);
    selector = await sendTabMessageWithRetry(tabId, { type: 'SYNC_FACEBOOK_IDENTITIES' });
    if (selector?.success || !/full Select profile list is not open/i.test(selector?.error || '')) break;
  }
  if (!selector?.success) throw new Error(selector?.error || 'Facebook full profile selector did not open');
  return { locate, selector };
}

async function syncFacebookIdentitiesForJob(jobId) {
  const session = await getStoredSession();
  if (!session || !session.userId) {
    await sbUpdateJob(jobId, { status: 'failed', result: { error: 'Not signed in' }, completed_at: new Date().toISOString() });
    return;
  }

  let tab;
  const workerInstallId = await getWorkerInstallId();
  try {
    await sbUpdateJob(jobId, { result: { text: 'Opening Facebook...', extension_version: EXT_VERSION, worker_install_id: workerInstallId } });
    await requireFacebookSessionForGroupScan();
    tab = await chrome.tabs.create({ url: 'https://www.facebook.com/', active: true });
    try { if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
    await sleep(5000);

    await sbUpdateJob(jobId, { result: { text: 'Opening Facebook profile list...', extension_version: EXT_VERSION, worker_install_id: workerInstallId } });
    await sbUpdateJob(jobId, { result: { text: 'Reading full Facebook Select profile list...', extension_version: EXT_VERSION, worker_install_id: workerInstallId } });
    const { locate, selector: switcherResponse } = await openFullFacebookProfileSelectorNative(tab.id);

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
      active_identity: switcherResponse.active_identity || locate.active_identity || identities.find(i => i.is_active)?.name || null,
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
        active_identity: switcherResponse.active_identity || locate.active_identity || null,
        switcher_count: (switcherResponse.identities || []).length,
        managed_pages_count: (pagesResponse?.pages || []).length,
        avatar_count: avatarCount,
        extension_version: EXT_VERSION,
        worker_install_id: workerInstallId,
        text: `Synced ${identities.length} posting identities · ${avatarCount} profile pictures`
      },
      completed_at: new Date().toISOString()
    });
    extLog('info', `Synced ${identities.length} posting identities`);
  } catch (e) {
    // Leave Facebook visible for account-menu inspection after a failed sync.
    if (tab) {
      try {
        await chrome.tabs.update(tab.id, { active: true });
        if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true });
      } catch (_) {}
    }
    extLog('error', 'syncFacebookIdentitiesForJob error: ' + e.message);
    await sbUpdateJob(jobId, { status: 'failed', result: { error: e.message, error_code: e.code || null, extension_version: EXT_VERSION, worker_install_id: workerInstallId }, completed_at: new Date().toISOString() });
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
  return !!a && !!e && a === e;
}

async function assertFacebookActiveIdentity(tabId, expectedName, context = 'group import') {
  if (!expectedName) throw new Error(`Cannot verify active Facebook identity for ${context}`);
  let response = null;
  try {
    response = await sendTabMessageWithRetry(tabId, { type: 'GET_FACEBOOK_ACTIVE_IDENTITY', expectedIdentity: expectedName });
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

function isPageGroupsTabStrategy(strategy) {
  return /^page_groups_tab/i.test(String(strategy || ''));
}

function hasPageSpecificScanProof(strategy, scanSourceUrl) {
  return isPageGroupsTabStrategy(strategy) && scanSourceUrl && !isGenericJoinedGroupsUrl(scanSourceUrl);
}

const buildPageGroupsUrl = facebookPageGroupsUrl;

function assertPageGroupScanSource(identityName, identityType, scanSourceUrl, options = {}) {
  if (!isPageIdentityType(identityType)) return;
  if (isGenericJoinedGroupsUrl(scanSourceUrl) && !options.allowGenericJoinedGroupsForVerifiedPageSwitch) {
    throw new Error(`Refusing to save Page groups for ${identityName}: scanner landed on the generic account /groups/joins page instead of the Page's own Groups tab.`);
  }
}

async function switchFacebookIdentityNative(tabId, identityName, options = {}) {
  const current = await sendTabMessageWithRetry(tabId, { type: 'GET_FACEBOOK_ACTIVE_IDENTITY', expectedIdentity: identityName });
  if (current?.success && facebookIdentityNameMatches(current.activeIdentity, identityName)) {
    return { success: true, switched: false, already_active: true, active_identity: current.activeIdentity };
  }
  await openFullFacebookProfileSelectorNative(tabId);
  const locate = await sendTabMessageWithRetry(tabId, { type: 'LOCATE_FACEBOOK_IDENTITY_SWITCH_TARGET', identityName, force: options.force === true });
  if (locate?.already_active) return { success: true, switched: false, already_active: true, active_identity: locate.active_identity || identityName, debug: locate };
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
    const activeRes = await sendTabMessageWithRetry(tabId, { type: 'GET_FACEBOOK_ACTIVE_IDENTITY', expectedIdentity: identityName });
    active = activeRes?.activeIdentity || null;
  } catch (_) {}
  if (!facebookIdentityNameMatches(active, identityName)) {
    throw new Error(`Clicked ${identityName} in Select profile, but Facebook shows ${active || 'unknown'} as active`);
  }
  return { success: true, switched: true, active_identity: active, debug: locate };
}

async function confirmFacebookPageProfileSwitchByKeyboard(tabId, identityName) {
  const target = { tabId };
  const pressEnter = async () => {
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
    });
  };
  try {
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (expected) => {
        const pageText = String(document.body?.innerText || '').replace(/\s+/g, ' ');
        const control = [...document.querySelectorAll('[aria-label="Switch"]')]
          .find(el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
        return {
          ready: !!control && new RegExp(`Switch into ${String(expected).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(pageText),
          pageUrl: location.href
        };
      },
      args: [identityName]
    });
    if (!probe?.result?.ready) return { clicked: false, success: false, reason: 'page switch card unavailable' };

    await chrome.tabs.update(tabId, { active: true });
    await chrome.debugger.attach(target, '1.3');
    try {
      const first = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression: `document.querySelector('[aria-label="Switch"]')`
      });
      if (!first?.result?.objectId) return { clicked: false, success: false, reason: 'page switch control disappeared' };
      await chrome.debugger.sendCommand(target, 'DOM.focus', { objectId: first.result.objectId });
      await pressEnter();
      await sleep(900);

      const confirmation = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression: `(() => { const d = [...document.querySelectorAll('[role="dialog"]')].find(x => (x.innerText || '').toLowerCase().includes(${JSON.stringify(String(identityName).toLowerCase())})); return d?.querySelector('[aria-label="Switch"]') || null; })()`
      });
      if (!confirmation?.result?.objectId) {
        return { clicked: true, success: false, reason: 'page switch confirmation missing' };
      }
      await chrome.debugger.sendCommand(target, 'DOM.focus', { objectId: confirmation.result.objectId });
      await pressEnter();
    } finally {
      try { await chrome.debugger.detach(target); } catch (_) {}
    }
    // This only records that Facebook accepted both trusted UI activations. The
    // caller still performs independent Page/composer actor verification.
    await sleep(8000);
    return { clicked: true, success: true, switch_confirmed_by_dialog: true, active_identity: identityName };
  } catch (e) {
    try { await chrome.debugger.detach(target); } catch (_) {}
    return { clicked: false, success: false, error: e.message };
  }
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
async function scrollFacebookJoinedGroupsNative(tabId) {
  const [viewport] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({ width: window.innerWidth, height: window.innerHeight })
  });
  const width = Number(viewport?.result?.width) || 1200;
  const height = Number(viewport?.result?.height) || 800;
  // A browser wheel event over the group cards triggers Facebook's lazy list.
  // window.scrollBy moves the viewport but does not load the next card batch.
  const x = Math.max(320, Math.min(width - 60, Math.round(width * 0.42)));
  const y = Math.max(180, Math.min(height - 60, Math.round(height * 0.7)));
  const target = { tabId };
  await chrome.tabs.update(tabId, { active: true });
  await chrome.debugger.attach(target, '1.3');
  try {
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27
    });
    for (let step = 0; step < 2; step++) {
      await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel', x, y, deltaX: 0,
        deltaY: Math.max(400, Math.round(height * 0.8)), pointerType: 'mouse'
      });
      await sleep(180);
    }
  } finally {
    try { await chrome.debugger.detach(target); } catch (_) {}
  }
}

async function importFacebookGroupsForJob(jobId, identityMeta = null, options = {}) {
  const groupScanGuardVersion = GROUP_SCAN_GUARD_VERSION;
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
    const joinedGroupsUrl = 'https://www.facebook.com/groups/joins/?nav_source=tab&ordering=viewer_added';
    let pageScanStrategy = null;
    let allowGenericJoinedGroupsForVerifiedPageSwitch = false;
    let pageSwitchDebug = null;
    if (isManagedPageUrl) {
      // Actor-first Page import: switch to the selected Page/profile first,
      // then open the generic joined-groups surface and verify Facebook still
      // shows the intended actor there. This avoids saving account-level groups
      // unless the joined-groups route has explicit active-identity proof.
      await updateProgress(`Switching to ${identityName}...`);
      tab = await chrome.tabs.create({ url: 'https://www.facebook.com/', active: true });
      await sleep(5000);
      let managerSwitch = null;
      try {
        managerSwitch = await switchFacebookIdentityNative(tab.id, identityName);
        pageSwitchDebug = { ...managerSwitch, strategy: 'verified_profile_switch_then_joined_groups' };
      } catch (switchError) {
        pageSwitchDebug = { success: false, error: switchError.message, strategy: 'verified_profile_switch_then_joined_groups' };
        extLog('warn', `Verified profile/Page switch failed for ${identityName}: ${switchError.message}`);
        // Facebook may navigate immediately after a valid switch and close the
        // message channel before it can answer. Verify the actor independently.
        try {
          await sleep(4000);
          const active = await assertFacebookActiveIdentity(tab.id, identityName, 'Page switch recovery');
          managerSwitch = { success: true, recovered_after_navigation: true, active_identity: active };
          pageSwitchDebug = { ...pageSwitchDebug, recovery: managerSwitch };
        } catch (_) {}
      }

      if (!managerSwitch?.success) {
        await updateProgress(`Trying ${identityName} from Pages Manager...`);
        await chrome.tabs.update(tab.id, { url: 'https://www.facebook.com/pages/?category=your_pages', active: true });
        await sleep(8000);
        try {
          managerSwitch = await sendTabMessageWithRetry(tab.id, { type: 'SWITCH_FACEBOOK_MANAGED_PAGE', identityName, identityUrl });
          pageSwitchDebug = { ...managerSwitch, strategy: 'pages_manager_switch_then_joined_groups', fallback_from: pageSwitchDebug };
        } catch (switchError) {
          pageSwitchDebug = { success: false, error: switchError.message, strategy: 'pages_manager_switch_then_joined_groups', fallback_from: pageSwitchDebug };
          extLog('warn', `Pages Manager switch failed for ${identityName}: ${switchError.message}`);
          try {
            await sleep(4000);
            const active = await assertFacebookActiveIdentity(tab.id, identityName, 'Pages Manager switch recovery');
            managerSwitch = { success: true, recovered_after_navigation: true, active_identity: active, fallback_from: pageSwitchDebug.fallback_from };
            pageSwitchDebug = { ...pageSwitchDebug, recovery: managerSwitch };
          } catch (_) {}
        }
      }

      if (!managerSwitch?.success) {
        const firstError = pageSwitchDebug?.fallback_from?.error || null;
        const fallbackError = pageSwitchDebug?.error || managerSwitch?.error || 'Facebook did not confirm the switch';
        throw new Error(`Could not switch to ${identityName}: ${fallbackError}${firstError ? `; profile selector: ${firstError}` : ''}`);
      }
      await updateProgress(`Opening ${identityName} joined groups...`);
      await chrome.tabs.update(tab.id, { url: joinedGroupsUrl });
      await sleep(8000);
      const verifiedActor = await assertFacebookActiveIdentity(tab.id, identityName, 'joined groups import');
      const identityAssert = { verified: true, active_identity: verifiedActor };
      allowGenericJoinedGroupsForVerifiedPageSwitch = true;
      pageScanStrategy = managerSwitch?.fallback_from ? 'pages_manager_switch_then_joined_groups' : 'verified_profile_switch_then_joined_groups';
      pageSwitchDebug = { ...(pageSwitchDebug || {}), joined_groups_identity_assert: identityAssert };
    } else {
      tab = await chrome.tabs.create({ url: joinedGroupsUrl, active: true });
      await sleep(5000);
      if (identityName) {
        await updateProgress(`Switching to ${identityName}...`);
        const switchRes = await switchFacebookIdentityNative(tab.id, identityName);
        if (!switchRes?.success) throw new Error(switchRes?.error || `Could not switch to ${identityName}`);
        await sleep(4000);
        await chrome.tabs.update(tab.id, { url: joinedGroupsUrl });
        await sleep(5000);
      }
    }

    let groups = [];
    let scanSourceUrl = null;
    let prevCount = -1;
    let prevScrollHeight = -1;
    let expectedJoinedCount = null;
    let stableBottomPasses = 0;
    let passes = 0;
    let lastDebug = null;
    const MAX_PASSES = 100;
    const MIN_PASSES = 5;
    while (passes < MAX_PASSES) {
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

          const main = document.querySelector('[role="main"], main');
          if (!main) throw new Error('Joined-groups main region was not available');
          const joinedHeadings = [...main.querySelectorAll('h1, h2, h3, [role="heading"], div, span')]
            .map(el => ({ el, text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() }))
            .filter(item => /^All groups you(?:’|')ve joined\s*\(\d+\)$/i.test(item.text));
          const joinedHeading = joinedHeadings.sort((a, b) => a.text.length - b.text.length)[0] || null;
          if (!joinedHeading) throw new Error('Joined-groups count heading was not available');
          const expectedJoinedCount = Number(joinedHeading.text.match(/\((\d+)\)$/)?.[1]);
          main.querySelectorAll('a[href*="/groups/"]').forEach(a => {
            if (!(joinedHeading.el.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)) return;
            const card = a.closest('[role="listitem"], [role="article"]') || a.parentElement;
            const cardText = (card?.innerText || card?.textContent || '').replace(/\s+/g, ' ');
            if (/\bJoin group\b/i.test(cardText) && !/\bJoined\b/i.test(cardText)) return;
            if (/Requested to join|Answer questions|Pending group requests/i.test(cardText)) return;
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
          return {
            pageUrl, groups: [...found.values()], expectedJoinedCount, debug,
            atBottom: window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 80,
            scrollHeight: document.documentElement.scrollHeight
          };
        }
      });

      if (result?.result?.debug) lastDebug = result.result.debug;
      if (Number.isInteger(result?.result?.expectedJoinedCount)) expectedJoinedCount = result.result.expectedJoinedCount;
      if (result?.result?.pageUrl) {
        scanSourceUrl = result.result.pageUrl;
        if (!isGenericJoinedGroupsUrl(scanSourceUrl)) throw new Error('Joined-groups scan navigated away from Facebook’s joined-groups page');
        assertPageGroupScanSource(identityName, identityType, scanSourceUrl, { allowGenericJoinedGroupsForVerifiedPageSwitch });
      }
      const scrapedGroups = Array.isArray(result?.result) ? result.result : (result?.result?.groups || []);
      if (scrapedGroups.length) {
        const existingSlugs = new Set(groups.map(g => g.url));
        groups = [...groups, ...scrapedGroups.filter(g => !existingSlugs.has(g.url))];
      }

      const height = Number(result?.result?.scrollHeight) || 0;
      const stable = passes >= MIN_PASSES && result?.result?.atBottom === true
        && groups.length === prevCount && height === prevScrollHeight;
      stableBottomPasses = stable ? stableBottomPasses + 1 : 0;
      prevCount = groups.length;
      prevScrollHeight = height;
      if (stableBottomPasses >= 2 && Number.isInteger(expectedJoinedCount) && groups.length === expectedJoinedCount) break;
      if (passes >= 6 && expectedJoinedCount == null && groups.length === 0) {
        throw new Error(`Joined-groups count heading was not available for ${identityName}; saved groups were left unchanged`);
      }
      await updateProgress(`Found ${groups.length} groups, scrolling...`);
      await scrollFacebookJoinedGroupsNative(tab.id);
      await sleep(1500);
    }

    if (stableBottomPasses < 2 || !scanSourceUrl || !Number.isInteger(expectedJoinedCount) || groups.length !== expectedJoinedCount) {
      throw new Error(`Joined-groups scan incomplete for ${identityName}: found ${groups.length} of ${expectedJoinedCount ?? 'unknown'} joined groups after ${passes} passes; saved groups were left unchanged`);
    }
    await assertFacebookActiveIdentity(tab.id, identityName, 'completed joined groups import');
    await chrome.tabs.remove(tab.id);
    tab = null;

    const groupScanWarnings = [];
    if (isPageIdentityType(identityType)) {
      const overlap = await assessAccountLevelGroupOverlap(session, identityName, identityType, groups);
      if (overlap?.high_overlap) {
        groupScanWarnings.push({
          ...overlap,
          severity: 'warning',
          message: 'The Page group list overlaps the account profile list; confirm this identity before posting.'
        });
      }
    }

    const groupAvatarCount = groups.filter(g => !!(g.group_avatar_url || g.avatar_url || g.image_url)).length;
    const importResult = {
      group_scan_guard_version: groupScanGuardVersion,
      count: groups.length,
      avatar_count: groupAvatarCount,
      identity_name: identityName,
      identity_key: identityKey,
      identity_type: identityType || null,
      scan_complete: true,
      active_identity_verified: true,
      scan_passes: passes,
      scan_source_url: scanSourceUrl,
      page_scan_strategy: pageScanStrategy || null,
      joined_groups_identity_verified: !!allowGenericJoinedGroupsForVerifiedPageSwitch,
      warnings: groupScanWarnings,
      debug: { ...(lastDebug || {}), pageSwitchDebug },
      groups,
      text: `Scanned ${groups.length} groups for ${identityName}`
    };
    if (finalizeJob) {
      throw new Error('Standalone group scans must use the identity-scoped reconciliation job');
    }
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
  if (activeDashJobId !== null) {
    chrome.runtime.sendMessage({ type: 'IMPORT_GROUPS_ERROR', error: 'Facebook runner busy — retry after the current operation finishes.' });
    return false;
  }
  activeDashJobId = 'popup-import';
  try {
    return await importFacebookGroupsUnlocked(identityMeta);
  } finally {
    activeDashJobId = null;
  }
}

async function importFacebookGroupsUnlocked(identityMeta = null) {
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
      chrome.runtime.sendMessage({ type: 'IMPORT_GROUPS_PROGRESS', text: `Switching to ${identityName} before group sync...` });
      tab = await chrome.tabs.create({ url: 'https://www.facebook.com/', active: false });
      await sleep(5000);
      let switchRes = null;
      try {
        switchRes = await chrome.tabs.sendMessage(tab.id, { type: 'SWITCH_FACEBOOK_IDENTITY', identityName, identityUrl });
      } catch (switchError) {
        extLog('warn', `${identityName} legacy Page switch failed before Page Groups tab scan: ${switchError.message}`);
      }
      if (!switchRes?.success) {
        extLog('warn', switchRes?.error || `Could not verify switch to ${identityName}; scanning Page-specific Groups tab only`);
      }
      await sleep(switchRes?.success ? 4000 : 2000);
      chrome.runtime.sendMessage({ type: 'IMPORT_GROUPS_PROGRESS', text: `Opening ${identityName} page groups tab...` });
      await chrome.tabs.update(tab.id, { url: identityUrl });
      await sleep(switchRes?.success ? 5000 : 8000);
      await chrome.tabs.update(tab.id, { url: pageGroupsUrl });
      await sleep(8000);
      pageScanStrategy = switchRes?.success ? 'page_groups_tab_after_identity_switch' : 'page_groups_tab_without_verified_switch';
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
