// ============ JSW Multi-Post Background Worker v2.0 ============
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
    title: 'JSW Multi-Post',
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

  let systemContent = aiPrompt || 'Rewrite this into an engaging Facebook group post.';
  if (settings.aiVariations && variationIndex > 0) {
    systemContent += ` This is variation #${variationIndex + 1}. Write it differently — vary the hook, structure, and word choice while keeping the same message.`;
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
// DASHBOARD DIRECT MESSAGING — externally_connectable API
// Handles messages from the GitHub Pages dashboard directly.
// This is the primary, zero-latency pairing channel.
// ============================================================

const TRUSTED_ORIGINS = [
  'https://jack108510.github.io'
];

// --- Spintax utilities ---
function hasSpintax(text) {
  return /\{[^}]+\|[^}]+\}/.test(text);
}

function spinVariation(text) {
  return text.replace(/\{([^}]+)\}/g, (_, content) => {
    const options = content.split('|');
    return options[Math.floor(Math.random() * options.length)];
  });
}

function countVariations(text) {
  let count = 1;
  const regex = /\{([^}]+)\}/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    count *= m[1].split('|').length;
  }
  return count;
}

// --- Storage helpers ---
async function getStore(keys) {
  return chrome.storage.local.get(keys);
}

async function setStore(obj) {
  return chrome.storage.local.set(obj);
}

// --- Post to a single group via content script ---
async function postToGroup(tabId, message, imageUrl) {
  const response = await chrome.tabs.sendMessage(tabId, {
    type: 'POST_TO_PAGE',
    message,
    imageUrl
  });
  return response;
}

// --- Execute a multi-group posting job from dashboard ---
async function executeDashDirectPost(post) {
  const groups = post.groups || [];
  const settings = (await getStore(['jsw_settings'])).jsw_settings || {};
  const delay = settings.delay || 30;

  let successCount = 0;
  const results = [];

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const groupUrl = typeof g === 'string' ? g : g.url;
    const groupName = typeof g === 'string' ? groupUrl.split('/').pop() : (g.name || groupUrl.split('/').pop());

    // Resolve spintax per-group
    let finalText = post.text;
    if (hasSpintax(post.text)) {
      finalText = spinVariation(post.text);
    }

    // AI refinement if enabled
    if (settings.aiEnabled && settings.apiKey) {
      try {
        finalText = await callAI(finalText, settings, settings.aiVariations ? i : 0);
      } catch (e) {
        console.warn('[JSW] AI refine failed:', e.message);
      }
    }

    try {
      const tab = await chrome.tabs.create({ url: groupUrl, active: true });
      await sleep(5000);

      const resp = await postToGroup(tab.id, finalText, post.imageUrl || '');

      if (resp?.success) {
        successCount++;
        results.push({ group: groupName, success: true });
      } else {
        results.push({ group: groupName, success: false, error: resp?.error || 'unknown' });
      }

      await sleep(1000);
      await chrome.tabs.remove(tab.id);
    } catch (e) {
      results.push({ group: groupName, success: false, error: e.message });
    }

    if (i < groups.length - 1) {
      await sleep(delay * 1000);
    }
  }

  // Log the result
  const logs = (await getStore(['jsw_logs'])).jsw_logs || [];
  logs.unshift({
    id: Date.now().toString(),
    timestamp: new Date().toISOString(),
    postId: post.id,
    text: post.text,
    results
  });
  // Keep last 200 logs
  if (logs.length > 200) logs.length = 200;
  await setStore({ jsw_logs: logs });

  // Write to history posts table
  const history = (await getStore(['jsw_history'])).jsw_history || [];
  history.unshift({
    id: Date.now().toString(),
    text: post.text,
    groups: groups.length,
    success: successCount,
    failed: groups.length - successCount,
    timestamp: new Date().toISOString()
  });
  if (history.length > 200) history.length = 200;
  await setStore({ jsw_history: history });

  notify(`Post complete — ${successCount}/${groups.length} groups posted.`);

  return { success: successCount > 0, successCount, total: groups.length, results };
}

// --- Scheduled post checker (runs every minute) ---
async function checkScheduledPosts() {
  const data = await getStore(['jsw_posts']);
  const posts = data.jsw_posts || [];
  const now = new Date();
  const currentDay = now.getDay();
  const currentTime = now.toTimeString().substring(0, 5); // HH:MM
  const settings = (await getStore(['jsw_settings'])).jsw_settings || {};
  const delay = settings.delay || 30;
  const maxGroups = settings.maxGroups || 10;
  const jitter = settings.jitter || 5;

  for (const post of posts) {
    if (!post.enabled) continue;
    if (!post.schedule || !post.schedule.days || !post.schedule.time) continue;

    if (post.schedule.days.includes(currentDay) && post.schedule.time === currentTime) {
      // Check if already posted in the last 2 minutes for this post
      const logs = (await getStore(['jsw_logs'])).jsw_logs || [];
      const recentLog = logs.find(l =>
        l.postId === post.id &&
        Date.now() - new Date(l.timestamp).getTime() < 120000
      );
      if (recentLog) continue;

      console.log(`[JSW] Firing scheduled post: ${post.id}`);

      // Apply maxGroups limit and jitter delay
      const groupsToPost = post.groups.slice(0, maxGroups);
      const jitterDelay = delay + Math.floor(Math.random() * (jitter * 2 + 1)) - jitter;

      await executeDashDirectPost({
        id: post.id,
        text: post.text,
        imageUrl: post.imageUrl || '',
        groups: groupsToPost,
        schedule: { time: jitterDelay + 's' }
      });
    }
  }
}

// Run the scheduler every 60 seconds
setInterval(checkScheduledPosts, 60000);

// --- THE EXTERNAL MESSAGE HANDLER ---
// This is what the GitHub Pages dashboard talks to.
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  // Verify origin
  if (!TRUSTED_ORIGINS.some(origin => sender.origin?.startsWith(origin))) {
    console.warn('[JSW] Rejected external message from', sender.origin);
    return false;
  }

  const handler = async () => {
    try {
      switch (msg.type) {
        // --- Heartbeat ---
        case 'ping':
          return { ok: true, version: '2.1.0', name: 'JSW Multi-Post' };

        // --- Get all data ---
        case 'get-data': {
          const data = await getStore([
            'jsw_posts', 'jsw_logs', 'jsw_templates',
            'jsw_groups', 'jsw_settings', 'jsw_history'
          ]);
          return {
            posts: data.jsw_posts || [],
            logs: data.jsw_logs || [],
            templates: data.jsw_templates || [],
            groups: data.jsw_groups || [],
            settings: data.jsw_settings || {},
            history: data.jsw_history || []
          };
        }

        // --- Save a scheduled post ---
        case 'save-post': {
          const posts = (await getStore(['jsw_posts'])).jsw_posts || [];
          const idx = posts.findIndex(p => p.id === msg.post.id);
          if (idx >= 0) {
            posts[idx] = msg.post;
          } else {
            posts.push(msg.post);
          }
          await setStore({ jsw_posts: posts });
          return { ok: true };
        }

        // --- Post now (custom, not saved) ---
        case 'post-now-custom': {
          const result = await executeDashDirectPost(msg.post);
          return { ok: true, result };
        }

        // --- Fire a saved post now ---
        case 'post-now':
        case 'fire-post': {
          const posts = (await getStore(['jsw_posts'])).jsw_posts || [];
          const post = posts.find(p => p.id === msg.id);
          if (!post) return { ok: false, error: 'Post not found' };
          const result = await executeDashDirectPost(post);
          return { ok: true, result };
        }

        // --- Toggle post enabled/disabled ---
        case 'toggle-post': {
          const posts = (await getStore(['jsw_posts'])).jsw_posts || [];
          const idx = posts.findIndex(p => p.id === msg.id);
          if (idx >= 0) {
            posts[idx].enabled = !posts[idx].enabled;
            await setStore({ jsw_posts: posts });
            return { ok: true, enabled: posts[idx].enabled };
          }
          return { ok: false, error: 'Not found' };
        }

        // --- Delete a post ---
        case 'delete-post': {
          const posts = (await getStore(['jsw_posts'])).jsw_posts || [];
          const filtered = posts.filter(p => p.id !== msg.id);
          await setStore({ jsw_posts: filtered });
          return { ok: true };
        }

        // --- Delete all posts ---
        case 'delete-all-posts': {
          await setStore({ jsw_posts: [] });
          return { ok: true };
        }

        // --- Save templates ---
        case 'save-templates': {
          await setStore({ jsw_templates: msg.templates });
          return { ok: true };
        }

        // --- Save groups ---
        case 'save-groups': {
          await setStore({ jsw_groups: msg.groups });
          return { ok: true };
        }

        // --- Save settings ---
        case 'save-settings': {
          const existing = (await getStore(['jsw_settings'])).jsw_settings || {};
          const merged = { ...existing, ...msg.settings };
          await setStore({ jsw_settings: merged });
          return { ok: true };
        }

        // --- Factory reset ---
        case 'factory-reset': {
          await setStore({
            jsw_posts: [],
            jsw_logs: [],
            jsw_templates: [],
            jsw_groups: [],
            jsw_history: []
          });
          return { ok: true };
        }

        default:
          return { ok: false, error: 'Unknown message type: ' + msg.type };
      }
    } catch (e) {
      console.error('[JSW] External handler error:', e);
      return { ok: false, error: e.message };
    }
  };

  // Must return true to keep sendResponse channel open for async
  handler().then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
  return true;
});

console.log('[JSW Multi-Post] Background worker v2.1 ready — externally_connectable enabled');

// ============================================================
// DASHBOARD PAIRING — SUPABASE POLLING (v2.1, secondary channel)
// ============================================================
const SB_URL = 'https://xacehhtgvubcqdoltazg.supabase.co';
const SB_ANON_KEY = 'sb_publishable_1TNu5hqotJ7GGQXfjliivQ_ttK51EAA';
let dashPollTimer = null;
let dashPairing = null;

// Listen for pairing connect/disconnect from popup
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'PAIRING_CONNECTED') {
    dashPairing = msg.pairing;
    startDashPolling();
    console.log('[JSW] Dashboard pairing connected, polling started');
  } else if (msg.type === 'PAIRING_DISCONNECTED') {
    stopDashPolling();
    dashPairing = null;
    console.log('[JSW] Dashboard pairing disconnected');
  }
});

// On startup, resume polling if already paired
chrome.runtime.onStartup.addListener(loadPairingAndResume);
chrome.runtime.onInstalled.addListener(loadPairingAndResume);

async function loadPairingAndResume() {
  const data = await chrome.storage.local.get(['jsw_pairing']);
  if (data.jsw_pairing && data.jsw_pairing.connected) {
    dashPairing = data.jsw_pairing;
    startDashPolling();
    console.log('[JSW] Resumed dashboard polling for user', dashPairing.userId);
  }
}

function startDashPolling() {
  if (dashPollTimer) clearInterval(dashPollTimer);
  // Poll immediately, then every 10 seconds
  pollPendingJobs();
  dashPollTimer = setInterval(pollPendingJobs, 10000);
}

function stopDashPolling() {
  if (dashPollTimer) { clearInterval(dashPollTimer); dashPollTimer = null; }
}

function broadcastDashStatus(text, color) {
  chrome.runtime.sendMessage({ type: 'DASH_JOB_STATUS', text, color }).catch(() => {});
}

// Fetch pending jobs for this paired user via REST API
async function pollPendingJobs() {
  if (!dashPairing || !dashPairing.userId) return;

  try {
    const url = `${SB_URL}/rest/v1/jsw_post_jobs?user_id=eq.${encodeURIComponent(dashPairing.userId)}&status=eq.pending&order=created_at.asc&limit=1`;
    const res = await fetch(url, {
      headers: {
        'apikey': SB_ANON_KEY,
        'Authorization': `Bearer ${SB_ANON_KEY}`
      }
    });

    if (!res.ok) {
      console.warn('[JSW] Dash poll failed:', res.status);
      return;
    }

    const jobs = await res.json();
    if (jobs && jobs.length > 0) {
      const job = jobs[0];
      console.log('[JSW] Found pending dashboard job:', job.id);
      await executeDashJob(job);
    }
  } catch (e) {
    console.warn('[JSW] Dash poll error:', e.message);
  }
}

// Claim a job (set status=processing) then run it
async function executeDashJob(job) {
  // Try to claim it via PATCH
  const claimed = await sbUpdateJob(job.id, {
    status: 'processing',
    started_at: new Date().toISOString()
  });
  if (!claimed) {
    console.log('[JSW] Job already claimed by another worker, skipping');
    return;
  }

  broadcastDashStatus('Processing job...', '#eab308');

  const groups = job.groups || [];
  if (!Array.isArray(groups)) {
    try { groups = JSON.parse(groups); } catch (e) { groups = []; }
  }
  const groupUrls = groups.map(g => typeof g === 'string' ? g : g.url).filter(Boolean);

  let settings = {
    aiEnabled: job.ai_enabled,
    aiPrompt: job.ai_prompt,
    apiKey: dashPairing.api_key,
    aiProvider: dashPairing.ai_provider || 'openai',
    aiModel: dashPairing.ai_model || 'gpt-4o-mini',
    aiVariations: false,
    aiTemp: 0.7
  };

  let successCount = 0;
  let lastError = null;

  for (let i = 0; i < groupUrls.length; i++) {
    const groupUrl = groupUrls[i];
    let finalText = job.message;

    if (settings.aiEnabled && settings.apiKey) {
      try {
        finalText = await callAI(job.message, settings, 0);
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
        broadcastDashStatus(`Posted ${i + 1}/${groupUrls.length}`, '#4ecca3');
      } else {
        lastError = response?.error || 'Unknown error';
        broadcastDashStatus(`Failed ${i + 1}/${groupUrls.length}`, '#e94560');
      }

      await sleep(1000);
      await chrome.tabs.remove(tab.id);
    } catch (e) {
      lastError = e.message;
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

  broadcastDashStatus(
    success ? `Done — ${successCount}/${groupUrls.length} posted` : 'Job failed',
    success ? '#4ecca3' : '#e94560'
  );

  notify(success
    ? `Dashboard job complete — ${successCount}/${groupUrls.length} groups posted.`
    : `Dashboard job failed: ${lastError}`
  );
}

// Update a job row via Supabase REST PATCH
async function sbUpdateJob(jobId, patch) {
  try {
    const res = await fetch(`${SB_URL}/rest/v1/jsw_post_jobs?id=eq.${jobId}`, {
      method: 'PATCH',
      headers: {
        'apikey': SB_ANON_KEY,
        'Authorization': `Bearer ${SB_ANON_KEY}`,
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
