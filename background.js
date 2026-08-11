// ============ Amplr Background Worker v2.1.3 ============
// Orchestrates posting queue, AI refinement, and scheduled posts via chrome.alarms.

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const EXT_VERSION = chrome.runtime.getManifest?.().version || 'unknown';
const CONNECTION_STATUS_KEY = 'extension_status';

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

// ============ HANDLE MESSAGES FROM POPUP ============
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_POSTING') {
    runPostingQueue(msg, sender);
  } else if (msg.type === 'IMPORT_GROUPS') {
    importFacebookGroups(msg.identity || msg.identityMeta || null);
  }
});

// ============ POSTING QUEUE ============
async function runPostingQueue({ message, imageUrl, groups, delay, settings }, sender) {
  let successCount = 0;

  for (let i = 0; i < groups.length; i++) {
    const groupUrl = groups[i];

    // Determine final post text
    let finalText = message;

    if (settings?.aiEnabled && settings?.apiKey) {
      sendProgress({
        text: `AI refining for ${groupUrl.split('/').pop()}... (${i + 1}/${groups.length})`,
        progress: ((i / groups.length) * 100).toFixed(0),
        done: false
      }, sender);

      try {
        finalText = await callAI(message, settings, settings.aiVariations ? i : 0);
      } catch (e) {
        sendProgress({
          text: `AI failed for ${groupUrl.split('/').pop()}, using original — ${e.message}`,
          progress: ((i / groups.length) * 100).toFixed(0),
          done: false
        }, sender);
        // Fall back to original message
      }
    }

    sendProgress({
      text: `Posting to ${groupUrl.split('/').pop()}... (${i + 1}/${groups.length})`,
      progress: ((i / groups.length) * 100).toFixed(0),
      done: false
    }, sender);

    try {
      const tab = await chrome.tabs.create({ url: groupUrl, active: true });
      await sleep(5000);

      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'POST_TO_PAGE',
        message: finalText,
        imageUrl
      });

      if (response?.success) {
        successCount++;
        sendProgress({
          text: `✓ Posted to ${groupUrl.split('/').pop()}`,
          progress: (((i + 1) / groups.length) * 100).toFixed(0),
          done: false
        }, sender);
      } else {
        sendProgress({
          text: `✗ Failed: ${groupUrl.split('/').pop()} — ${response?.error || 'unknown'}`,
          progress: (((i + 1) / groups.length) * 100).toFixed(0),
          done: false
        }, sender);
      }

      await sleep(1000);
      await chrome.tabs.remove(tab.id);

    } catch (error) {
      sendProgress({
        text: `✗ Error: ${groupUrl.split('/').pop()} — ${error.message}`,
        progress: (((i + 1) / groups.length) * 100).toFixed(0),
        done: false
      }, sender);
    }

    if (i < groups.length - 1) {
      sendProgress({
        text: `Waiting ${delay}s before next...`,
        progress: (((i + 1) / groups.length) * 100).toFixed(0),
        done: false
      }, sender);
      await sleep(delay * 1000);
    }
  }

  sendProgress({
    text: `Complete — ${successCount}/${groups.length} posted`,
    progress: '100',
    done: true,
    success: true,
    successCount
  }, sender);

  notify(`Done — ${successCount}/${groups.length} groups posted successfully.`);
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

  // Write first so the dashboard flips online immediately after reload/sign-in.
  try { await writeHeartbeat(); } catch (e) { console.warn('[JSW] heartbeat write failed during startup:', e.message); }

  // Poll immediately, then via alarms (MV3 service workers can sleep between events).
  pollPendingJobs();
  pollGroupLookups();
  await chrome.alarms.create('poll-jobs', { periodInMinutes: 0.5 }); // every 30s
  await chrome.alarms.create('amplr_heartbeat', { periodInMinutes: 0.5 }); // every 30s
  await chrome.alarms.create('check-post-results', { periodInMinutes: 360 }); // every 6h
}

async function stopDashPolling() {
  await chrome.alarms.clear('poll-jobs');
  await chrome.alarms.clear('amplr_heartbeat');
  await chrome.alarms.clear('check-post-results');
}

// Heartbeat and poll-jobs alarm handler
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'amplr_heartbeat') writeHeartbeat();
  else if (alarm.name === 'poll-jobs') { pollPendingJobs(); pollGroupLookups(); }
  else if (alarm.name === 'check-post-results') { checkPostResults(); }
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
    const res = await fetch(`${SB_URL}/rest/v1/amplr_data?user_id=eq.${session.userId}&key=eq.posting_identities&select=value`, {
      headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}` }
    });
    if (!res.ok) return null;
    const rows = await res.json();
    const value = rows?.[0]?.value;
    const identities = Array.isArray(value) ? value : (value?.identities || []);
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
      const identityMeta = Array.isArray(job.groups) ? job.groups[0] : null;
      const identityName = job.ai_prompt || identityMeta?.identity_name || null;
      const identityKey = identityMeta?.identity_key || null;
      const storedIdentity = await getPostingIdentityByNameOrKey(identityName, identityKey);
      await importFacebookGroupsForJob(job.id, {
        name: identityName,
        key: identityKey,
        type: identityMeta?.identity_type || storedIdentity?.type || null,
        url: identityMeta?.identity_url || storedIdentity?.url || null
      });
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
        identityUrl
      });

      if (response?.success) {
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
      const waitSeconds = randInt(Math.max(job.delay || 30, ANTI_BOT.minDelaySeconds), Math.max(job.delay || 30, ANTI_BOT.maxDelaySeconds));
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


function isForbiddenPostingIdentityName(name) {
  const cleaned = String(name || '').trim().replace(/\s+/g, ' ');
  if (!cleaned) return true;
  if (/^(quick switch profiles?|see all profiles?|see all pages?|settings(?: & privacy)?|help(?: & support)?|report a problem|give feedback|meta verified|meta business suite|display & accessibility|privacy|terms|privacy policy|advertising|ad choices|cookies|more|active|log out)$/i.test(cleaned)) return true;
  if (/^(?:[A-Z]\s*){1,3}$/i.test(cleaned.replace(/\./g, ''))) return true;
  if (/^(facebook|meta|pages?|profiles?|home|watch|marketplace|groups?|notifications?|menu)$/i.test(cleaned)) return true;
  if (/^https?:\/\//i.test(cleaned)) return true;
  return false;
}

function postingIdentityUrlAllowed(url) {
  if (!url) return true;
  try {
    const u = new URL(url, 'https://www.facebook.com');
    if (!/facebook\.com$/i.test(u.hostname.replace(/^www\./, ''))) return false;
    return !/(\/settings|\/help|\/privacy|\/policies|\/business|\/ads|\/ad_|\/groups\/|\/marketplace|\/events)/i.test(u.pathname);
  } catch (_) { return true; }
}

function isValidPostingIdentityRecord(item) {
  return !!item && !isForbiddenPostingIdentityName(item.name) && postingIdentityUrlAllowed(item.url || '');
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
        id: prev.id || item.id || item.url || key,
        name,
        type: item.type || prev.type || 'facebook identity',
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
      await sleep(1000);
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

    // Do not preserve stale junk identities from older scraper versions. Merge
    // only valid existing rows, and require current scrape evidence for a row to
    // survive unless it has a strong Facebook URL/avatar signal.
    const existingStored = await getPostingIdentityByNameOrKey(null, '__load_all__');
    const existingIdentities = (Array.isArray(existingStored?.__all) ? existingStored.__all : []).filter(isValidPostingIdentityRecord);
    const scrapedIdentities = [...(switcherResponse.identities || []), ...(pagesResponse?.pages || [])].filter(isValidPostingIdentityRecord);
    const scrapedNames = new Set(scrapedIdentities.map(i => normalizeIdentityNameForMerge(i.name)));
    const keepExisting = existingIdentities.filter(i => {
      const key = normalizeIdentityNameForMerge(i.name);
      return scrapedNames.has(key) || (!!i.url && !!(i.avatar_url || i.picture_url || i.profile_picture_url || i.photo_url || i.image_url));
    });
    const combined = mergePostingIdentities(keepExisting, scrapedIdentities);
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
// Job-aware version: updates job progress and result in jsw_post_jobs
async function importFacebookGroupsForJob(jobId, identityMeta = null) {
  const identityName = typeof identityMeta === 'string' ? identityMeta : (identityMeta?.name || null);
  const identityKey = (typeof identityMeta === 'object' && identityMeta?.key) ? identityMeta.key : (identityName || '__legacy__');
  const identityType = (typeof identityMeta === 'object' && identityMeta?.type) ? identityMeta.type : null;
  const identityUrl = (typeof identityMeta === 'object' && identityMeta?.url) ? identityMeta.url : null;
  const session = await getStoredSession();
  if (!session || !session.userId) {
    await sbUpdateJob(jobId, { status: 'failed', result: { error: 'Not signed in' }, completed_at: new Date().toISOString() });
    return;
  }

  const updateProgress = async (text) => {
    await sbUpdateJob(jobId, { result: { text } });
    chrome.runtime.sendMessage({ type: 'IMPORT_GROUPS_PROGRESS', text }).catch(() => {});
  };

  let tab;
  try {
    await updateProgress('Opening your Facebook groups...');
    tab = await chrome.tabs.create({ url: 'https://www.facebook.com/groups/joins/', active: false });
    await sleep(5000);
    if (identityName) {
      await updateProgress(`Switching to ${identityName}...`);
      const switchRes = await chrome.tabs.sendMessage(tab.id, { type: 'SWITCH_FACEBOOK_IDENTITY', identityName, identityUrl });
      if (!switchRes?.success) throw new Error(switchRes?.error || `Could not switch to ${identityName}`);
      await sleep(4000);
      await chrome.tabs.update(tab.id, { url: 'https://www.facebook.com/groups/joins/' });
      await sleep(5000);
    }

    let groups = [];
    let prevCount = -1;
    let passes = 0;
    const MAX_PASSES = 30;

    while (passes < MAX_PASSES && groups.length !== prevCount) {
      prevCount = groups.length;
      passes++;

      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const found = new Map();
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
            if (/^(new|see all|join|joined|member|members|post|posts|comment|comments|notification|notifications)$/i.test(t)) return true;
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
          return [...found.values()];
        }
      });

      if (result?.result) {
        const existingSlugs = new Set(groups.map(g => g.url));
        groups = [...groups, ...result.result.filter(g => !existingSlugs.has(g.url))];
      }

      await updateProgress(`Found ${groups.length} groups, scrolling...`);
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.scrollBy(0, window.innerHeight * 3) });
      await sleep(2500);
    }

    await chrome.tabs.remove(tab.id);
    tab = null;

    if (groups.length === 0) {
      await sbUpdateJob(jobId, { status: 'failed', result: { error: 'No groups found — make sure you\'re logged into Facebook' }, completed_at: new Date().toISOString() });
      return;
    }

    await updateProgress(`Saving ${groups.length} groups...`);

    const rows = groups.map(g => ({
      user_id: session.userId,
      group_url: g.url,
      group_name: g.name || null,
      group_avatar_url: g.group_avatar_url || g.avatar_url || g.image_url || null,
      identity_name: identityName || null,
      identity_key: identityKey || '__legacy__',
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
    await sbUpdateJob(jobId, { status: 'done', result: { count: groups.length, avatar_count: groupAvatarCount, identity_name: identityName || null, identity_key: identityKey || '__legacy__', identity_type: identityType || null, text: `Imported ${groups.length} groups${identityName ? ' for ' + identityName : ''} · ${groupAvatarCount} photos` }, completed_at: new Date().toISOString() });
    chrome.runtime.sendMessage({ type: 'IMPORT_GROUPS_DONE', count: groups.length, groups }).catch(() => {});

  } catch (e) {
    extLog('error', 'importFacebookGroupsForJob error: ' + e.message);
    if (tab) { try { await chrome.tabs.remove(tab.id); } catch (_) {} }
    await sbUpdateJob(jobId, { status: 'failed', result: { error: e.message }, completed_at: new Date().toISOString() });
  }
}

async function importFacebookGroups(identityMeta = null) {
  const identityName = typeof identityMeta === 'string' ? identityMeta : (identityMeta?.name || identityMeta?.identity_name || null);
  const identityKey = (typeof identityMeta === 'object' && (identityMeta?.key || identityMeta?.identity_key)) ? (identityMeta.key || identityMeta.identity_key) : (identityName || '__legacy__');
  const identityType = (typeof identityMeta === 'object' && (identityMeta?.type || identityMeta?.identity_type)) ? (identityMeta.type || identityMeta.identity_type) : null;
  const identityUrl = (typeof identityMeta === 'object' && (identityMeta?.url || identityMeta?.identity_url)) ? (identityMeta.url || identityMeta.identity_url) : null;
  const session = await getStoredSession();
  if (!session || !session.userId) {
    chrome.runtime.sendMessage({ type: 'IMPORT_GROUPS_ERROR', error: 'Not signed in' });
    return;
  }

  let tab;
  try {
    chrome.runtime.sendMessage({ type: 'IMPORT_GROUPS_PROGRESS', text: 'Opening your Facebook groups...' });

    tab = await chrome.tabs.create({ url: 'https://www.facebook.com/groups/joins/', active: false });
    await sleep(5000);
    if (identityName) {
      chrome.runtime.sendMessage({ type: 'IMPORT_GROUPS_PROGRESS', text: `Switching to ${identityName}...` });
      const switchRes = await chrome.tabs.sendMessage(tab.id, { type: 'SWITCH_FACEBOOK_IDENTITY', identityName, identityUrl });
      if (!switchRes?.success) throw new Error(switchRes?.error || `Could not switch to ${identityName}`);
      await sleep(4000);
      await chrome.tabs.update(tab.id, { url: 'https://www.facebook.com/groups/joins/' });
      await sleep(5000);
    }

    // Scroll and collect — runs multiple passes until no new groups appear
    let groups = [];
    let prevCount = -1;
    let passes = 0;
    const MAX_PASSES = 30;

    while (passes < MAX_PASSES && groups.length !== prevCount) {
      prevCount = groups.length;
      passes++;

      // Scrape current DOM
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const found = new Map();
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
            if (/^(new|see all|join|joined|member|members|post|posts|comment|comments|notification|notifications)$/i.test(t)) return true;
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

          return [...found.values()];
        }
      });

      if (result?.result) {
        const fresh = result.result;
        const existingSlugs = new Set(groups.map(g => g.url));
        const newOnes = fresh.filter(g => !existingSlugs.has(g.url));
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

    // Save to Supabase — upsert by (user_id, identity_key, group_url)
    chrome.runtime.sendMessage({ type: 'IMPORT_GROUPS_PROGRESS', text: `Saving ${groups.length} groups...` });

    const rows = groups.map(g => ({
      user_id:    session.userId,
      group_url:  g.url,
      group_name: g.name || null,
      group_avatar_url: g.group_avatar_url || g.avatar_url || g.image_url || null,
      identity_name: identityName || null,
      identity_key: identityKey || '__legacy__',
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
    chrome.runtime.sendMessage({ type: 'IMPORT_GROUPS_DONE', count: groups.length, groups, identity_name: identityName || null, identity_key: identityKey || '__legacy__', identity_type: identityType || null });

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
