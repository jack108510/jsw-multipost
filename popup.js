// ============ Amplr Popup — with Onboarding Flow ============

const $ = (id) => document.getElementById(id);

const SUPABASE_URL = 'https://xacehhtgvubcqdoltazg.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_1TNu5hqotJ7GGQXfjliivQ_ttK51EAA';

// ── Views ──
function showView(name) {
  ['loginView', 'onboardingView', 'connectedView'].forEach(v => {
    const el = $(v);
    if (el) el.style.display = v === name ? 'block' : 'none';
  });
}

// ── Session load ──
chrome.storage.local.get(['jsw_session', 'amplr_onboarding_done'], (data) => {
  const session = data.jsw_session;
  const onboardDone = data.amplr_onboarding_done;
  if (session?.userId) {
    if (!onboardDone) {
      showView('onboardingView');
      initOnboarding(session);
    } else {
      showConnectedView(session);
    }
  } else {
    showView('loginView');
  }
});

// ── Connected view ──
function showConnectedView(session) {
  showView('connectedView');
  if (session?.email && $('dashEmail')) {
    $('dashEmail').textContent = session.email;
  }
}

// ── Sign In ──
$('loginBtn').addEventListener('click', async () => {
  const email = $('loginEmail').value.trim();
  const password = $('loginPassword').value;
  const errEl = $('loginError');
  errEl.textContent = '';

  if (!email || !password) { errEl.textContent = 'Enter email and password'; return; }

  $('loginBtn').disabled = true;
  $('loginBtn').textContent = 'Signing in...';

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) throw new Error(data.error_description || 'Login failed');

    const session = {
      userId: data.user.id,
      email: data.user.email,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_at,
      connectedAt: Date.now()
    };

    // Fetch AI settings
    try {
      const setRes = await fetch(
        `${SUPABASE_URL}/rest/v1/jsw_settings?user_id=eq.${session.userId}&select=ai_key,ai_model,ai_provider,ai_prompt,default_delay`,
        { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${session.accessToken}` } }
      );
      if (setRes.ok) {
        const rows = await setRes.json();
        if (rows[0]) {
          session.ai_key = rows[0].ai_key || '';
          session.ai_model = rows[0].ai_model || '';
          session.ai_provider = rows[0].ai_provider || 'ollama';
          session.ai_prompt = rows[0].ai_prompt || '';
          session.default_delay = rows[0].default_delay || 30;
        }
      }
    } catch(e) { /* non-fatal */ }

    await chrome.storage.local.set({ jsw_session: session });
    chrome.runtime.sendMessage({ type: 'PAIRING_CONNECTED', pairing: session });

    // Check if onboarding already done
    const stored = await new Promise(r => chrome.storage.local.get('amplr_onboarding_done', r));
    if (stored.amplr_onboarding_done) {
      showConnectedView(session);
    } else {
      showView('onboardingView');
      initOnboarding(session);
    }
  } catch(e) {
    $('loginError').textContent = e.message;
    $('loginBtn').disabled = false;
    $('loginBtn').textContent = 'Sign In';
  }
});

$('loginEmail').addEventListener('keydown', e => { if (e.key === 'Enter') $('loginPassword').focus(); });
$('loginPassword').addEventListener('keydown', e => { if (e.key === 'Enter') $('loginBtn').click(); });

// ── Sign Out ──
function signOut() {
  chrome.storage.local.get(['jsw_session'], async (data) => {
    try {
      if (data.jsw_session?.accessToken) {
        await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
          method: 'POST',
          headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${data.jsw_session.accessToken}` }
        });
      }
    } catch(e) {}
    await chrome.storage.local.remove(['jsw_session', 'amplr_onboarding_done']);
    chrome.runtime.sendMessage({ type: 'PAIRING_DISCONNECTED' });
    $('loginEmail').value = '';
    $('loginPassword').value = '';
    $('loginBtn').disabled = false;
    $('loginBtn').textContent = 'Sign In';
    showView('loginView');
  });
}

// ══════════════════════════════════════
// ONBOARDING
// ══════════════════════════════════════

let onboardSession = null;
let onboardState = { step1: false, step2: false, step3: false };

function initOnboarding(session) {
  onboardSession = session;
  // Check if already logged into Facebook
  checkFacebookLogin();
}

function checkOnboardComplete() {
  const allDone = onboardState.step1 && onboardState.step2 && onboardState.step3;
  const btn = $('finishBtn');
  if (btn) btn.disabled = !allDone;
}

function markStep(step, label) {
  const el = $(step);
  const num = $(step + 'num');
  const btn = $(step + 'btn');
  const done = $(step + 'done');
  if (el) { el.classList.remove('active'); el.classList.add('done'); }
  if (num) num.textContent = '✓';
  if (btn) btn.style.display = 'none';
  if (done) { done.style.display = 'inline'; if (label) done.textContent = label; }
  onboardState[step] = true;
  checkOnboardComplete();
}

// Step 1: Background apps setting
function openBackgroundSetting() {
  chrome.tabs.create({ url: 'chrome://settings/system' });
  // Mark done after a short delay — user opened the page, assume they'll enable it
  setTimeout(() => {
    markStep('step1', '✓ Opened — enable "Continue running background apps"');
    $('onboardStatus').textContent = 'Flip the toggle in Chrome settings, then come back here.';
    setTimeout(() => { $('onboardStatus').textContent = ''; }, 4000);
  }, 1000);
}

// Step 2: Facebook login check
async function checkFacebookLogin() {
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.facebook.com/*' });
    if (tabs.length > 0) {
      markStep('step2', '✓ Logged in');
    } else {
      // Check cookies
      const cookies = await chrome.cookies.getAll({ domain: '.facebook.com' });
      const loggedIn = cookies.some(c => c.name === 'c_user');
      if (loggedIn) markStep('step2', '✓ Logged in');
    }
  } catch(e) {}
}

function openFacebook() {
  chrome.tabs.create({ url: 'https://www.facebook.com' });
  // Poll for login
  let attempts = 0;
  const poll = setInterval(async () => {
    attempts++;
    if (attempts > 30 || onboardState.step2) { clearInterval(poll); return; }
    try {
      const cookies = await chrome.cookies.getAll({ domain: '.facebook.com' });
      const loggedIn = cookies.some(c => c.name === 'c_user');
      if (loggedIn) {
        clearInterval(poll);
        markStep('step2', '✓ Logged in');
      }
    } catch(e) {}
  }, 3000);
}

// Step 3: Import groups
function runImportGroups() {
  const btn = $('step3btn') || $('importGroupsBtn');
  const statusEl = $('importStatus') || $('onboardStatus');
  if (btn) { btn.disabled = true; btn.textContent = 'Importing...'; }
  if (statusEl) statusEl.textContent = 'Opening your Facebook groups...';
  chrome.runtime.sendMessage({ type: 'IMPORT_GROUPS' });
}

function finishOnboarding() {
  chrome.storage.local.set({ amplr_onboarding_done: true }, () => {
    chrome.storage.local.get('jsw_session', (d) => showConnectedView(d.jsw_session || onboardSession));
  });
}

// ── Message listener ──
chrome.runtime.onMessage.addListener((msg) => {
  const statusEl = $('importStatus') || $('onboardStatus');

  if (msg.type === 'IMPORT_GROUPS_PROGRESS') {
    if (statusEl) statusEl.textContent = msg.text;
  }
  if (msg.type === 'IMPORT_GROUPS_DONE') {
    const label = `✓ ${msg.count} groups imported`;
    if (statusEl) statusEl.textContent = label;
    // Mark step 3 done (onboarding or connected view)
    const step3btn = $('step3btn');
    if (step3btn) markStep('step3', label);
    // Reset connected view button
    const importBtn = $('importGroupsBtn');
    if (importBtn) { importBtn.disabled = false; }
  }
  if (msg.type === 'IMPORT_GROUPS_ERROR') {
    if (statusEl) { statusEl.textContent = 'Failed: ' + msg.error; statusEl.style.color = 'var(--red)'; }
    const step3btn = $('step3btn');
    if (step3btn) { step3btn.disabled = false; step3btn.textContent = 'Try Again →'; }
    const importBtn = $('importGroupsBtn');
    if (importBtn) importBtn.disabled = false;
  }
  if (msg.type === 'DASH_JOB_STATUS') {
    const el = $('dashStatus');
    if (el) el.textContent = msg.text;
  }
});
