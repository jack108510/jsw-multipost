// ============ Amplr Background Worker v2.1 ============
// Orchestrates posting queue, AI refinement, and scheduled posts via chrome.alarms.

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ============ HANDLE MESSAGES FROM POPUP ============
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_POSTING') {
    runPostingQueue(msg, sender);
  } else if (msg.type === 'ADD_SCHEDULE') {
    registerAlarm(msg.schedule);
  } else if (msg.type === 'REMOVE_SCHEDULE') {
    chrome.alarms.clear(msg.id);
  } else if (msg.type === 'IMPORT_GROUPS') {
    importFacebookGroups();
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

function sendProgress(data, sender) {
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

// ============ SCHEDULES (chrome.alarms) ============

function registerAlarm(schedule) {
  const now = new Date();
  const [hours, minutes] = schedule.time.split(':').map(Number);
  let next = new Date(now);
  next.setHours(hours, minutes, 0, 0);

  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  // For weekly, advance to correct day
  if (schedule.freq === 'weekly') {
    while (next.getDay() !== schedule.day) {
      next.setDate(next.getDate() + 1);
    }
  }

  let periodInMinutes = undefined;

  if (schedule.freq === 'hourly') {
    periodInMinutes = 60;
  } else if (schedule.freq === 'daily') {
    periodInMinutes = 1440; // 24h
  } else if (schedule.freq === 'weekly') {
    periodInMinutes = 10080; // 7 days
  }

  const alarmInfo = {};
  if (schedule.freq === 'once') {
    alarmInfo.when = next.getTime();
  } else {
    alarmInfo.when = next.getTime();
    alarmInfo.periodInMinutes = periodInMinutes;
  }

  chrome.alarms.create(schedule.id, alarmInfo);
  console.log(`[JSW] Alarm set: ${schedule.id} for ${schedule.freq} at ${schedule.time}`);
}

// ============ ALARM FIRES ============
chrome.alarms.onAlarm.addListener(async (alarm) => {
  // Check if this is a scheduled post alarm
  const data = await chrome.storage.local.get(['jsw_schedules', 'jsw_settings']);
  const schedules = data.jsw_schedules || [];
  const schedule = schedules.find(s => s.id === alarm.name);

  if (!schedule) return;

  console.log(`[JSW] Alarm fired: ${schedule.id}`);
  const settings = data.jsw_settings || {};

  // Run posting queue for this schedule
  await runPostingQueueScheduled(schedule, settings);
});

async function runPostingQueueScheduled(schedule, settings) {
  const { message, groups } = schedule;
  let successCount = 0;

  for (let i = 0; i < groups.length; i++) {
    const groupUrl = groups[i];
    let finalText = message;

    if (settings.aiEnabled && settings.apiKey) {
      try {
        finalText = await callAI(message, settings, settings.aiVariations ? i : 0);
      } catch (e) {
        console.warn('[JSW] AI failed:', e.message);
      }
    }

    try {
      const tab = await chrome.tabs.create({ url: groupUrl, active: true });
      await sleep(5000);

      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'POST_TO_PAGE',
        message: finalText,
        imageUrl: schedule.imageUrl || ''
      });

      if (response?.success) successCount++;

      await sleep(1000);
      await chrome.tabs.remove(tab.id);
    } catch (e) {
      console.warn(`[JSW] Failed for ${groupUrl}:`, e.message);
    }

    if (i < groups.length - 1) await sleep((schedule.delay || 30) * 1000);
  }

  notify(`Scheduled post complete — ${successCount}/${groups.length} groups.`);

  // If it was a one-time schedule, remove it
  if (schedule.freq === 'once') {
    const updated = schedules.filter(s => s.id !== schedule.id);
    // Need to re-fetch since schedules variable is from outer scope
    const fresh = await chrome.storage.local.get(['jsw_schedules']);
    const updatedSchedules = (fresh.jsw_schedules || []).filter(s => s.id !== schedule.id);
    await chrome.storage.local.set({ jsw_schedules: updatedSchedules });
  }
}

// ============ RESTORE ALARMS ON BROWSER RESTART ============
chrome.runtime.onStartup.addListener(async () => {
  console.log('[JSW] Browser started — restoring alarms');
  const data = await chrome.storage.local.get(['jsw_schedules']);
  const schedules = data.jsw_schedules || [];
  schedules.forEach(s => {
    if (s.freq !== 'once') registerAlarm(s);
  });
});

// Also restore on extension install/update
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[JSW] Extension installed/updated — restoring alarms');
  const data = await chrome.storage.local.get(['jsw_schedules']);
  const schedules = data.jsw_schedules || [];
  schedules.forEach(s => {
    if (s.freq !== 'once') registerAlarm(s);
  });
});

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
    'You rewrite Facebook group posts to make them unique and avoid spam detection. Keep the exact same message, offer, and call to action — vary the hook, sentence structure, and word choice. Sound natural and human. Output ONLY the rewritten post text, nothing else. No explanations, no preamble.';
  const user = `Rewrite this Facebook post (variation #${variationIndex + 1}). Change the opening, vary sentence length, use different synonyms. Keep the same core message and any links intact.\n\nOriginal:\n${userMessage}`;

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
    startDashPolling();
    extLog('info', 'Session connected, polling started for ' + dashSession.userId);
  } else if (msg.type === 'PAIRING_DISCONNECTED') {
    stopDashPolling();
    dashSession = null;
    extLog('info', 'Session disconnected');
  }
});

// On startup, resume polling if already logged in
chrome.runtime.onStartup.addListener(loadSessionAndResume);
chrome.runtime.onInstalled.addListener(loadSessionAndResume);
// MV3 service workers restart without firing onStartup/onInstalled — call on load too
loadSessionAndResume();

async function loadSessionAndResume() {
  const data = await chrome.storage.local.get(['jsw_session']);
  if (data.jsw_session && data.jsw_session.userId) {
    dashSession = data.jsw_session;
    startDashPolling();
    extLog('info', 'Resumed polling for user ' + dashSession.userId);
  }
}

function startDashPolling() {
  // Poll immediately, then via alarm (survives MV3 service worker sleep)
  pollPendingJobs();
  pollGroupLookups();
  chrome.alarms.create('poll-jobs', { periodInMinutes: 1 });
  writeHeartbeat();
  chrome.alarms.create('amplr_heartbeat', { periodInMinutes: 0.5 }); // every 30s
  chrome.alarms.create('check-post-results', { periodInMinutes: 360 }); // every 6h
}

function stopDashPolling() {
  chrome.alarms.clear('poll-jobs');
  chrome.alarms.clear('amplr_heartbeat');
  chrome.alarms.clear('check-post-results');
}

// Heartbeat and poll-jobs alarm handler
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'amplr_heartbeat') writeHeartbeat();
  else if (alarm.name === 'poll-jobs') { pollPendingJobs(); pollGroupLookups(); }
  else if (alarm.name === 'check-post-results') { checkPostResults(); }
});

// ─── Group name lookup ───
async function pollGroupLookups() {
  const data = await chrome.storage.local.get(['jsw_session']);
  const session = data.jsw_session;
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
    const res = await fetch(`${SB_URL}/rest/v1/jsw_group_lookups?id=eq.${lookupId}`, {
      method: 'PATCH',
      headers: {
        'apikey': SB_ANON_KEY,
        'Authorization': `Bearer ${dashSession.accessToken}`,
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
    // Read from storage every time — survives service worker restarts
    const data = await chrome.storage.local.get(['jsw_session']);
    const session = data.jsw_session;
    if (!session || !session.userId) return;

    await fetch(`${SB_URL}/rest/v1/jsw_settings?user_id=eq.${encodeURIComponent(session.userId)}`, {
      method: 'PATCH',
      headers: {
        'apikey': SB_ANON_KEY,
        'Authorization': `Bearer ${session.accessToken}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ ext_heartbeat: new Date().toISOString() })
    });
  } catch (e) {
    // Silent — heartbeat is best-effort
  }
}

function broadcastDashStatus(text, color) {
  chrome.runtime.sendMessage({ type: 'DASH_JOB_STATUS', text, color }).catch(() => {});
}

// Fetch pending jobs for this paired user via REST API
async function pollPendingJobs() {
  const data = await chrome.storage.local.get(['jsw_session']);
  const session = data.jsw_session;
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
    const [hours, minutes] = job.repeat_time.split(':').map(Number);
    const days = job.repeat_days; // e.g. [1, 3, 5] = Mon, Wed, Fri
    const now = new Date();
    let next = new Date(now);
    next.setSeconds(0, 0);
    next.setHours(hours, minutes);
    // Advance until we hit a future allowed day
    for (let i = 0; i < 8; i++) {
      next.setDate(next.getDate() + (i === 0 ? 1 : 1)); // always at least tomorrow
      if (days.includes(next.getDay())) break;
    }
    await fetch(`${SB_URL}/rest/v1/jsw_post_jobs`, {
      method: 'POST',
      headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        user_id: session.userId,
        message: job.message,
        image_url: job.image_url || null,
        groups: job.groups,
        delay: job.delay || 30,
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

// Claim a job (set status=processing) then run it
async function executeDashJob(job) {
  // Special job: import groups from Facebook
  if (job.message === '__import_groups__') {
    const claimed = await sbUpdateJob(job.id, {
      status: 'processing',
      started_at: new Date().toISOString()
    });
    if (!claimed) return;
    extLog('info', 'Running import_groups job ' + job.id);
    try {
      await importFacebookGroupsForJob(job.id);
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
  const groupUrls = groups.map(g => typeof g === 'string' ? g : g.url).filter(Boolean);

  extLog('info', 'Job ' + job.id + ' — ' + groupUrls.length + ' groups');

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

  // Load cooldown setting (default 2 days)
  const cooldownDays = dashSession?.cooldown_days || cachedData?.settings?.cooldown_days || 2;

  for (let i = 0; i < groupUrls.length; i++) {
    const groupUrl = groupUrls[i];
    let finalText = job.message;

    // ── Cooldown check ──
    try {
      const groupRes = await fetch(`${SB_URL}/rest/v1/jsw_groups?user_id=eq.${session.userId}&group_url=eq.${encodeURIComponent(groupUrl)}&select=last_posted_at,ban_risk`, {
        headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}` }
      });
      const groupData = await groupRes.json();
      const lastPosted = groupData?.[0]?.last_posted_at;
      if (lastPosted && cooldownDays > 0) {
        const daysSince = (Date.now() - new Date(lastPosted).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSince < cooldownDays) {
          extLog('info', `Skipping ${groupUrl} — cooldown (${daysSince.toFixed(1)} days since last post)`);
          chrome.runtime.sendMessage({ type: 'DASH_STATUS', text: `Skipping (cooldown): ${groupUrl.split('/').filter(Boolean).pop()}` }).catch(() => {});
          broadcastDashStatus(`Cooldown skip ${i + 1}/${groupUrls.length}`, '#6a6a8a');
          continue; // skip this group
        }
      }
    } catch (e) {
      extLog('warn', 'Cooldown check error: ' + e.message);
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

    try {
      const tab = await chrome.tabs.create({ url: groupUrl, active: true });
      await sleep(5000);

      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'POST_TO_PAGE',
        message: finalText,
        imageUrl: job.image_url || ''
      });

      if (response?.success) {
        successCount++;
        extLog('info', `Posted ${i + 1}/${groupUrls.length} → ${groupUrl}`);
        broadcastDashStatus(`Posted ${i + 1}/${groupUrls.length}`, '#4ecca3');

        // Update last_posted_at for cooldown tracking
        fetch(`${SB_URL}/rest/v1/jsw_groups?user_id=eq.${session.userId}&group_url=eq.${encodeURIComponent(groupUrl)}`, {
          method: 'PATCH',
          headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ last_posted_at: new Date().toISOString() })
        }).catch(e => extLog('warn', 'last_posted_at update error: ' + e.message));

        // Record post result for ban detection
        const postUrl = response?.postUrl || null;
        fetch(`${SB_URL}/rest/v1/jsw_post_results`, {
          method: 'POST',
          headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ user_id: session.userId, group_url: groupUrl, post_url: postUrl, job_id: job.id, posted_at: new Date().toISOString() })
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
        extLog('error', `Failed ${i + 1}/${groupUrls.length} → ${groupUrl}: ${lastError}`);
        broadcastDashStatus(`Failed ${i + 1}/${groupUrls.length}`, '#e94560');
      }

      await sleep(1000);
      await chrome.tabs.remove(tab.id);
    } catch (e) {
      lastError = e.message;
      extLog('error', `Error on group ${i + 1} (${groupUrl}): ${e.message}`);
      broadcastDashStatus(`Error on group ${i + 1}`, '#e94560');
    }

    if (i < groupUrls.length - 1) {
      broadcastDashStatus(`Waiting ${job.delay || 30}s...`, '#6a6a8a');
      await sleep((job.delay || 30) * 1000);
    }
  }

  // Mark done or failed
  const success = successCount > 0;
  await sbUpdateJob(job.id, {
    status: success ? 'done' : 'failed',
    error: success ? null : (lastError || 'All groups failed'),
    completed_at: new Date().toISOString()
  });

  extLog(success ? 'info' : 'error', `Job ${job.id} ${success ? 'DONE' : 'FAILED'} — ${successCount}/${groupUrls.length} posted`);

  broadcastDashStatus(
    success ? `Done — ${successCount}/${groupUrls.length} posted` : 'Job failed',
    success ? '#4ecca3' : '#e94560'
  );

  notify(success
    ? `Dashboard job complete — ${successCount}/${groupUrls.length} groups posted.`
    : `Dashboard job failed: ${lastError}`
  );

  // ── Webhook delivery (fire-and-forget, best-effort) ──
  if (job.webhook_url) {
    fireWebhook(job, success, successCount, groupUrls.length, lastError);
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
    const res = await fetch(`${SB_URL}/rest/v1/jsw_post_jobs?id=eq.${jobId}`, {
      method: 'PATCH',
      headers: {
        'apikey': SB_ANON_KEY,
        'Authorization': `Bearer ${dashSession.accessToken}`,
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
// IMPORT FACEBOOK GROUPS
// Opens facebook.com/groups/joins, scrolls to load all,
// scrapes name + URL, saves to jsw_groups via Supabase REST.
// ============================================================
// Job-aware version: updates job progress and result in jsw_post_jobs
async function importFacebookGroupsForJob(jobId) {
  const data = await chrome.storage.local.get(['jsw_session']);
  const session = data.jsw_session;
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
          document.querySelectorAll('a[href*="/groups/"]').forEach(a => {
            const href = a.href || '';
            const match = href.match(/facebook\.com\/groups\/([^/?#]+)/);
            if (!match) return;
            const slug = match[1];
            if (['discover', 'feed', 'joins', 'create', 'search', 'membership'].includes(slug)) return;
            if (found.has(slug)) return;
            let name = '';
            let el = a;
            for (let i = 0; i < 6; i++) {
              el = el.parentElement;
              if (!el) break;
              const spans = el.querySelectorAll('span');
              for (const span of spans) {
                const t = span.textContent.trim();
                if (t.length > 2 && t.length < 120 && !t.match(/^\d+$/) && !t.includes('Join') && !t.includes('See more')) {
                  name = t; break;
                }
              }
              if (name) break;
            }
            if (!name) name = a.textContent.trim();
            found.set(slug, { name: name || slug, url: `https://www.facebook.com/groups/${slug}/` });
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

    const rows = groups.map(g => ({ user_id: session.userId, group_url: g.url, group_name: g.name || null }));
    const CHUNK = 50;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await fetch(`${SB_URL}/rest/v1/jsw_groups`, {
        method: 'POST',
        headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(rows.slice(i, i + CHUNK))
      });
    }

    extLog('info', `Imported ${groups.length} groups via job ${jobId}`);
    await sbUpdateJob(jobId, { status: 'done', result: { count: groups.length, text: `Imported ${groups.length} groups` }, completed_at: new Date().toISOString() });
    chrome.runtime.sendMessage({ type: 'IMPORT_GROUPS_DONE', count: groups.length, groups }).catch(() => {});

  } catch (e) {
    extLog('error', 'importFacebookGroupsForJob error: ' + e.message);
    if (tab) { try { await chrome.tabs.remove(tab.id); } catch (_) {} }
    await sbUpdateJob(jobId, { status: 'failed', result: { error: e.message }, completed_at: new Date().toISOString() });
  }
}

async function importFacebookGroups() {
  const data = await chrome.storage.local.get(['jsw_session']);
  const session = data.jsw_session;
  if (!session || !session.userId) {
    chrome.runtime.sendMessage({ type: 'IMPORT_GROUPS_ERROR', error: 'Not signed in' });
    return;
  }

  let tab;
  try {
    chrome.runtime.sendMessage({ type: 'IMPORT_GROUPS_PROGRESS', text: 'Opening your Facebook groups...' });

    tab = await chrome.tabs.create({ url: 'https://www.facebook.com/groups/joins/', active: false });
    await sleep(5000);

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

          // Primary: anchors linking to /groups/<id>/
          document.querySelectorAll('a[href*="/groups/"]').forEach(a => {
            const href = a.href || '';
            const match = href.match(/facebook\.com\/groups\/([^/?#]+)/);
            if (!match) return;
            const slug = match[1];
            // Skip Facebook's own nav links and numeric-only group pages that are just "discover"
            if (['discover', 'feed', 'joins', 'create', 'search', 'membership'].includes(slug)) return;
            if (found.has(slug)) return;

            // Try to find the group name from nearby text
            let name = '';
            // Walk up to find a block with a meaningful text label
            let el = a;
            for (let i = 0; i < 6; i++) {
              el = el.parentElement;
              if (!el) break;
              const spans = el.querySelectorAll('span');
              for (const span of spans) {
                const t = span.textContent.trim();
                if (t.length > 2 && t.length < 120 && !t.match(/^\d+$/) && !t.includes('Join') && !t.includes('See more')) {
                  name = t;
                  break;
                }
              }
              if (name) break;
            }
            if (!name) {
              // Fallback: use the link's own text
              name = a.textContent.trim();
            }

            const cleanUrl = `https://www.facebook.com/groups/${slug}/`;
            found.set(slug, { name: name || slug, url: cleanUrl });
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

    // Save to Supabase — upsert by (user_id, group_url)
    chrome.runtime.sendMessage({ type: 'IMPORT_GROUPS_PROGRESS', text: `Saving ${groups.length} groups...` });

    const rows = groups.map(g => ({
      user_id:    session.userId,
      group_url:  g.url,
      group_name: g.name || null
    }));

    // Batch in chunks of 50
    const CHUNK = 50;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      await fetch(`${SB_URL}/rest/v1/jsw_groups`, {
        method: 'POST',
        headers: {
          'apikey': SB_ANON_KEY,
          'Authorization': `Bearer ${session.accessToken}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(chunk)
      });
    }

    extLog('info', `Imported ${groups.length} groups for user ${session.userId}`);
    chrome.runtime.sendMessage({ type: 'IMPORT_GROUPS_DONE', count: groups.length, groups });

  } catch (e) {
    extLog('error', 'importFacebookGroups error: ' + e.message);
    chrome.runtime.sendMessage({ type: 'IMPORT_GROUPS_ERROR', error: e.message });
    if (tab) {
      try { await chrome.tabs.remove(tab.id); } catch (_) {}
    }
  }
}
