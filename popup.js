// ============ JSW Multi-Post Popup Logic v2.0 ============

const $ = (id) => document.getElementById(id);
let groups = [];
let schedules = [];

// Guard: chrome APIs only exist inside extension context.
// Outside (e.g. loaded as webpage for testing), stub them.
if (!window.chrome) window.chrome = {};
if (!chrome.storage) {
  chrome.storage = { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() } };
}
if (!chrome.runtime) {
  chrome.runtime = { sendMessage: () => {}, onMessage: { addListener: () => {} } };
}

// ---- Load all saved state ----
chrome.storage.local.get([
  'jsw_groups', 'jsw_message', 'jsw_delay',
  'jsw_settings', 'jsw_schedules'
], (data) => {
  if (data.jsw_groups) groups = data.jsw_groups;
  if (data.jsw_message) $('message').value = data.jsw_message;
  if (data.jsw_delay) $('delay').value = data.jsw_delay;

  const s = data.jsw_settings || {};
  $('aiEnabled').checked = s.aiEnabled || false;
  $('aiPrompt').value = s.aiPrompt || '';
  $('aiVariations').checked = s.aiVariations || false;
  $('aiTemp').value = s.aiTemp ?? 0.7;
  $('aiProvider').value = s.aiProvider || 'openai';
  $('apiKey').value = s.apiKey || '';
  $('aiModel').value = s.aiModel || 'gpt-4o-mini';

  if (data.jsw_schedules) schedules = data.jsw_schedules;

  renderGroups();
  renderSchedules();
});

// ============ TAB SWITCHING ============
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    $('tab-' + tab.dataset.tab).classList.add('active');
  });
});

// ============ GROUPS ============
$('addGroup').addEventListener('click', addGroup);
$('groupUrl').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addGroup(); }
});

function addGroup() {
  let url = $('groupUrl').value.trim();
  if (!url) return;
  if (!url.startsWith('http')) url = 'https://facebook.com/groups/' + url;
  url = url.replace(/\/$/, '');
  if (groups.includes(url)) { showStatus('Already added', 'error'); return; }
  groups.push(url);
  $('groupUrl').value = '';
  saveGroups();
  renderGroups();
}

function removeGroup(url) {
  groups = groups.filter(g => g !== url);
  saveGroups();
  renderGroups();
}

function saveGroups() {
  chrome.storage.local.set({ jsw_groups: groups });
}

function renderGroups() {
  const list = $('groupList');
  if (groups.length === 0) { list.innerHTML = ''; return; }
  list.innerHTML = groups.map(url => {
    const name = url.split('/').pop() || url;
    return `<div class="group-item"><span class="url">${name}</span><button class="remove" data-url="${url}">✕</button></div>`;
  }).join('');
  list.querySelectorAll('.remove').forEach(btn => {
    btn.addEventListener('click', () => removeGroup(btn.dataset.url));
  });
}

$('message').addEventListener('input', () => chrome.storage.local.set({ jsw_message: $('message').value }));
$('delay').addEventListener('input', () => chrome.storage.local.set({ jsw_delay: $('delay').value }));

// ============ SETTINGS ============
$('saveSettingsBtn').addEventListener('click', () => {
  const settings = {
    aiEnabled: $('aiEnabled').checked,
    aiPrompt: $('aiPrompt').value,
    aiVariations: $('aiVariations').checked,
    aiTemp: parseFloat($('aiTemp').value) || 0.7,
    aiProvider: $('aiProvider').value,
    apiKey: $('apiKey').value,
    aiModel: $('aiModel').value
  };
  chrome.storage.local.set({ jsw_settings: settings }, () => {
    showSettingsStatus('✓ Settings saved', 'active');
    setTimeout(() => showSettingsStatus('', ''), 2000);
  });
});

function showSettingsStatus(text, type) {
  const s = $('settingsStatus');
  s.textContent = text;
  s.className = 'status' + (type ? ' ' + type : '');
}

// ============ AI TEST ============
$('aiTestBtn').addEventListener('click', async () => {
  const message = $('message').value.trim();
  if (!message) { showStatus('Write a message first', 'error'); return; }

  const settings = await getSettings();
  if (!settings.apiKey) { showStatus('Add API key in Settings tab', 'error'); return; }
  if (!settings.aiEnabled) { showStatus('Enable AI in AI Prompt tab first', 'error'); return; }

  showStatus('Generating AI preview...', '');
  $('aiTestBtn').disabled = true;

  try {
    const result = await callAI(message, settings, 0);
    $('aiPreview').classList.add('active');
    $('aiPreviewText').textContent = result;
    showStatus('AI preview ready', 'active');
  } catch (e) {
    showStatus('AI error: ' + e.message, 'error');
  } finally {
    $('aiTestBtn').disabled = false;
  }
});

// ============ POST ============
$('postBtn').addEventListener('click', async () => {
  const message = $('message').value.trim();
  if (!message) { showStatus('Write a message first', 'error'); return; }
  if (groups.length === 0) { showStatus('Add at least one group', 'error'); return; }

  const delay = parseInt($('delay').value) || 30;
  const imageUrl = $('imageUrl').value.trim();
  const settings = await getSettings();

  let confirmMsg = `Post to ${groups.length} group(s)?\n${delay}s delay between each.\nMake sure you're logged into Facebook.`;
  if (settings.aiEnabled && settings.apiKey) {
    confirmMsg += settings.aiVariations
      ? '\n\nAI will generate a unique variation for each group.'
      : '\n\nAI will refine your message before posting.';
  }
  if (!confirm(confirmMsg)) return;

  $('postBtn').disabled = true;
  $('postBtn').textContent = 'Posting...';
  $('progressBar').classList.add('active');

  chrome.runtime.sendMessage({
    type: 'START_POSTING',
    message,
    imageUrl,
    groups,
    delay,
    settings
  });
});

// Listen for progress
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'POST_PROGRESS') {
    showStatus(msg.text, msg.done ? 'active' : '');
    $('progressFill').style.width = msg.progress + '%';
    if (msg.done) {
      $('postBtn').disabled = false;
      $('postBtn').textContent = 'Post to All Groups';
      if (msg.success) showStatus(`✓ Done — ${msg.successCount}/${groups.length} posted`, 'active');
    }
  }
});

// ============ SCHEDULES ============
$('addScheduleBtn').addEventListener('click', () => {
  const message = $('schedMessage').value.trim();
  if (!message) { showStatus('Write a schedule message first', 'error'); return; }
  if (groups.length === 0) { showStatus('Add groups in Post tab first', 'error'); return; }

  const schedule = {
    id: 'sched_' + Date.now(),
    message,
    freq: $('schedFreq').value,
    time: $('schedTime').value || '09:00',
    day: parseInt($('schedDay').value),
    groups: [...groups],
    enabled: true,
    created: Date.now()
  };

  schedules.push(schedule);
  chrome.storage.local.set({ jsw_schedules: schedules });
  renderSchedules();

  chrome.runtime.sendMessage({ type: 'ADD_SCHEDULE', schedule });
  $('schedMessage').value = '';
  showStatus('Schedule added', 'active');
});

function renderSchedules() {
  const list = $('scheduleList');
  if (schedules.length === 0) {
    list.innerHTML = '<div style="color:#4a4a6a;font-size:11px;padding:8px;">No schedules yet</div>';
    return;
  }
  list.innerHTML = schedules.map(s => {
    const freqLabel = { once: 'Once', hourly: 'Hourly', daily: 'Daily', weekly: 'Weekly' }[s.freq];
    const dayLabel = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][s.day];
    const detail = s.freq === 'weekly' ? `${dayLabel} ${s.time}` : s.time;
    return `
      <div class="schedule-item">
        <div class="info">${freqLabel} · ${detail}<small>${s.message.substring(0, 50)}...</small></div>
        <button class="remove" data-id="${s.id}">✕</button>
      </div>
    `;
  }).join('');
  list.querySelectorAll('.remove').forEach(btn => {
    btn.addEventListener('click', () => removeSchedule(btn.dataset.id));
  });
}

function removeSchedule(id) {
  schedules = schedules.filter(s => s.id !== id);
  chrome.storage.local.set({ jsw_schedules: schedules });
  chrome.runtime.sendMessage({ type: 'REMOVE_SCHEDULE', id });
  renderSchedules();
}

// ============ HELPERS ============
function getSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get(['jsw_settings'], (data) => {
      resolve(data.jsw_settings || {});
    });
  });
}

function showStatus(text, type = '') {
  const s = $('status');
  s.textContent = text;
  s.className = 'status' + (type ? ' ' + type : '');
}

// ============ AI API CALL ============
async function callAI(userMessage, settings, variationIndex = 0) {
  const { aiProvider, apiKey, aiModel, aiPrompt, aiTemp } = settings;

  let systemContent = aiPrompt || 'Rewrite this into an engaging Facebook group post.';
  if (settings.aiVariations && variationIndex > 0) {
    systemContent += ` This is variation #${variationIndex + 1}. Write it differently from previous versions — vary the hook, structure, and word choice while keeping the same message.`;
  }

  const messages = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userMessage }
  ];

  if (aiProvider === 'anthropic') {
    return callAnthropic(apiKey, aiModel || 'claude-3-5-sonnet-20241022', messages, aiTemp);
  } else if (aiProvider === 'gemini') {
    return callGemini(apiKey, aiModel || 'gemini-1.5-flash', messages, aiTemp);
  } else if (aiProvider === 'openrouter') {
    return callOpenRouter(apiKey, aiModel || 'openai/gpt-4o-mini', messages, aiTemp);
  } else {
    return callOpenAI(apiKey, aiModel || 'gpt-4o-mini', messages, aiTemp);
  }
}

async function callOpenAI(key, model, messages, temp) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model, messages, temperature: temp, max_tokens: 500 })
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).substring(0, 100)}`);
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
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).substring(0, 100)}`);
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
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).substring(0, 100)}`);
  const data = await res.json();
  return data.candidates[0].content.parts[0].text.trim();
}

async function callOpenRouter(key, model, messages, temp) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model, messages, temperature: temp, max_tokens: 500 })
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).substring(0, 100)}`);
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

// ============ DASHBOARD PAIRING (v2.1) ============
const SUPABASE_URL = 'https://xacehhtgvubcqdoltazg.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_1TNu5hqotJ7GGQXfjliivQ_ttK51EAA';

function showDashStatus(text, type = '') {
  const s = $('dashStatus');
  s.textContent = text;
  s.className = 'status' + (type ? ' ' + type : '');
}

// ---- Load pairing state on popup open ----
chrome.storage.local.get(['jsw_pairing'], (data) => {
  const pairing = data.jsw_pairing;
  if (pairing && pairing.connected && pairing.userId) {
    showConnectedState(pairing);
  } else {
    showDisconnectedState();
  }
});

function showDisconnectedState() {
  $('dashDisconnected').style.display = 'block';
  $('dashConnected').style.display = 'none';
}

function showConnectedState(pairing) {
  $('dashDisconnected').style.display = 'none';
  $('dashConnected').style.display = 'block';
  $('dashEmail').textContent = pairing.email || 'Unknown email';
  $('dashUser').textContent = 'User: ' + (pairing.userId || '').substring(0, 8) + '...';
  $('dashJobStatus').textContent = 'Idle — watching for jobs';
}

// ---- Connect: validate pairing code against Supabase ----
$('pairConnectBtn').addEventListener('click', async () => {
  const code = $('pairingCodeInput').value.trim().toUpperCase();
  if (code.length !== 6) {
    showDashStatus('Enter the 6-character code', 'error');
    return;
  }

  showDashStatus('Validating code...', '');
  $('pairConnectBtn').disabled = true;

  try {
    // Look up the pairing code in jsw_settings to find the user_id + email
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/jsw_settings?pairing_code=eq.${encodeURIComponent(code)}&select=user_id,api_key,ai_model,ai_provider,default_delay`,
      {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        }
      }
    );

    if (!res.ok) {
      throw new Error(`Lookup failed (${res.status}). Run schema.sql first.`);
    }

    const rows = await res.json();
    if (!rows.length) {
      showDashStatus('Invalid or expired code', 'error');
      $('pairConnectBtn').disabled = false;
      return;
    }

    const row = rows[0];
    // Fetch the user's email from auth.users via the user_id (RLS-permitting)
    // Since auth.users isn't directly queryable, store the userId and let
    // the dashboard-driven session do the work. We store what we have.
    const pairing = {
      connected: true,
      userId: row.user_id,
      email: 'Dashboard account',  // email resolved lazily; user sees this in popup
      code: code,
      connectedAt: Date.now(),
      // Carry over AI settings so background worker can use them
      ai_provider: row.ai_provider,
      ai_model: row.ai_model,
      api_key: row.api_key,
      default_delay: row.default_delay
    };

    await new Promise(resolve => {
      chrome.storage.local.set({ jsw_pairing: pairing }, resolve);
    });

    showConnectedState(pairing);
    showDashStatus('Connected — polling for jobs', 'active');

    // Tell background to start polling
    chrome.runtime.sendMessage({ type: 'PAIRING_CONNECTED', pairing });
  } catch (e) {
    showDashStatus('Error: ' + e.message, 'error');
  } finally {
    $('pairConnectBtn').disabled = false;
  }
});

// ---- Disconnect ----
$('pairDisconnectBtn').addEventListener('click', async () => {
  await new Promise(resolve => {
    chrome.storage.local.remove(['jsw_pairing'], resolve);
  });
  chrome.runtime.sendMessage({ type: 'PAIRING_DISCONNECTED' });
  showDisconnectedState();
  showDashStatus('Disconnected', '');
});

// ---- Listen for job status updates from background ----
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'DASH_JOB_STATUS') {
    const el = $('dashJobStatus');
    if (el) {
      el.textContent = msg.text;
      el.style.color = msg.color || '#6a6a8a';
    }
  }
});
