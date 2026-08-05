// ============ Amplr — Pairing Only ============

const $ = (id) => document.getElementById(id);

// Guard: chrome APIs only exist inside extension context
if (!window.chrome) window.chrome = {};
if (!chrome.storage) {
  chrome.storage = { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() } };
}
if (!chrome.runtime) {
  chrome.runtime = { sendMessage: () => {}, onMessage: { addListener: () => {} } };
}

const SUPABASE_URL = 'https://xacehhtgvubcqdoltazg.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_1TNu5hqotJ7GGQXfjliivQ_ttK51EAA';

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
}

function showDashStatus(text, type = '') {
  const s = $('dashStatus');
  if (!s) return;
  s.textContent = text;
  s.className = 'status' + (type ? ' ' + type : '');
}

// ---- Connect: validate pairing code against Supabase ----
$('pairConnectBtn').addEventListener('click', async () => {
  const code = $('pairingCodeInput').value.trim().toUpperCase();
  if (code.length !== 6) {
    showDashStatus('Enter the 6-character code', 'error');
    return;
  }

  showDashStatus('Validating...');
  $('pairConnectBtn').disabled = true;

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/jsw_settings?pairing_code=eq.${encodeURIComponent(code)}&select=user_id,api_key,ai_model,ai_provider,default_delay`,
      {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        }
      }
    );

    if (!res.ok) throw new Error(`Lookup failed (${res.status})`);

    const rows = await res.json();
    if (!rows.length) {
      showDashStatus('Invalid or expired code', 'error');
      $('pairConnectBtn').disabled = false;
      return;
    }

    const row = rows[0];
    const pairing = {
      connected: true,
      userId: row.user_id,
      email: 'Dashboard account',
      code: code,
      connectedAt: Date.now(),
      ai_provider: row.ai_provider,
      ai_model: row.ai_model,
      api_key: row.api_key,
      default_delay: row.default_delay
    };

    await new Promise(resolve => {
      chrome.storage.local.set({ jsw_pairing: pairing }, resolve);
    });

    showConnectedState(pairing);
    showDashStatus('');

    // Tell background to start polling
    chrome.runtime.sendMessage({ type: 'PAIRING_CONNECTED', pairing });
  } catch (e) {
    showDashStatus('Error: ' + e.message, 'error');
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
  showDashStatus('');
});

// ---- Listen for job status updates from background ----
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'DASH_JOB_STATUS') {
    const el = $('dashJobStatus');
    if (el) el.textContent = msg.text;
  }
});
