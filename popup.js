// ============ Amplr — Direct Login (REST, no Supabase lib) ============

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

// ---- Load session on popup open ----
chrome.storage.local.get(['jsw_session'], (data) => {
  const stored = data.jsw_session;
  if (stored && stored.userId) {
    showConnectedState(stored);
  } else {
    showDisconnectedState();
  }
});

function showDisconnectedState() {
  $('dashDisconnected').style.display = 'block';
  $('dashConnected').style.display = 'none';
}

function showConnectedState(sessionData) {
  $('dashDisconnected').style.display = 'none';
  $('dashConnected').style.display = 'block';
  if (sessionData.email && $('dashEmail')) {
    $('dashEmail').textContent = sessionData.email;
  }
}

function showDashStatus(text, type = '') {
  const s = $('dashStatus');
  if (!s) return;
  s.textContent = text;
  s.className = 'status' + (type ? ' ' + type : '');
}

// ---- Sign In via Supabase REST (no library needed) ----
$('loginBtn').addEventListener('click', async () => {
  const email = $('loginEmail').value.trim();
  const password = $('loginPassword').value;

  if (!email || !password) {
    showDashStatus('Enter email and password', 'error');
    return;
  }
  if (password.length < 6) {
    showDashStatus('Password must be 6+ characters', 'error');
    return;
  }

  showDashStatus('Signing in...');
  $('loginBtn').disabled = true;

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email, password })
    });

    const data = await res.json();

    if (!res.ok || !data.access_token || !data.user) {
      throw new Error(data.error_description || data.message || `Login failed (${res.status})`);
    }

    const sessionData = {
      userId: data.user.id,
      email: data.user.email,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_at,
      connectedAt: Date.now()
    };

    // Fetch AI settings for this user
    try {
      const setRes = await fetch(
        `${SUPABASE_URL}/rest/v1/jsw_settings?user_id=eq.${sessionData.userId}&select=api_key,ai_model,ai_provider,default_delay`,
        {
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${sessionData.accessToken}`
          }
        }
      );
      if (setRes.ok) {
        const rows = await setRes.json();
        if (rows.length > 0) {
          sessionData.api_key = rows[0].api_key || '';
          sessionData.ai_model = rows[0].ai_model || '';
          sessionData.ai_provider = rows[0].ai_provider || 'openai';
          sessionData.default_delay = rows[0].default_delay || 30;
        }
      }
    } catch (e) {
      console.warn('[JSW] Could not fetch AI settings:', e.message);
    }

    await new Promise(resolve => {
      chrome.storage.local.set({ jsw_session: sessionData }, resolve);
    });

    showConnectedState(sessionData);
    showDashStatus('');

    // Tell background to start polling
    chrome.runtime.sendMessage({ type: 'PAIRING_CONNECTED', pairing: sessionData });
  } catch (e) {
    showDashStatus(e.message || 'Login failed', 'error');
    $('loginBtn').disabled = false;
  }
});

// ---- Enter key submits ----
$('loginEmail').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('loginPassword').focus();
});
$('loginPassword').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('loginBtn').click();
});

// ---- Sign Out ----
$('pairDisconnectBtn').addEventListener('click', async () => {
  // Try to revoke the token server-side (best-effort)
  try {
    const data = await new Promise(resolve => {
      chrome.storage.local.get(['jsw_session'], resolve);
    });
    const token = data.jsw_session?.accessToken;
    if (token) {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${token}`
        }
      });
    }
  } catch (e) { /* ignore */ }

  await new Promise(resolve => {
    chrome.storage.local.remove(['jsw_session'], resolve);
  });
  chrome.runtime.sendMessage({ type: 'PAIRING_DISCONNECTED' });
  showDisconnectedState();
  showDashStatus('');

  // Clear fields
  $('loginEmail').value = '';
  $('loginPassword').value = '';
  $('loginBtn').disabled = false;
});

// ---- Listen for job status updates from background ----
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'DASH_JOB_STATUS') {
    const el = $('dashJobStatus');
    if (el) el.textContent = msg.text;
  }
});
