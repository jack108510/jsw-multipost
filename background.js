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

console.log('[JSW Multi-Post] Background worker v2.0 ready');
