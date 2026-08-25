(() => {
  const SESSION_KEYS = ['jsw_session'];

  function normalizeSession(raw) {
    if (!raw) return null;
    let session = raw;
    if (typeof session === 'string') {
      try { session = JSON.parse(session); } catch (_) { return null; }
    }
    if (!session || typeof session !== 'object') return null;

    const candidates = [
      session,
      session.currentSession,
      session.session,
      session.currentSession?.session,
      session.value,
      session.value?.currentSession,
      session.value?.session,
    ].filter(Boolean);

    for (const cand of candidates) {
      const userId = cand.userId || cand.user_id || cand.user?.id;
      const accessToken = cand.accessToken || cand.access_token;
      const refreshToken = cand.refreshToken || cand.refresh_token;
      const expiresAt = cand.expiresAt || cand.expires_at;
      const email = cand.email || cand.user?.email || null;
      if (userId && accessToken && refreshToken) {
        return { userId, accessToken, refreshToken, expiresAt, email };
      }
    }
    return null;
  }

  function getDashboardSession() {
    for (const key of SESSION_KEYS) {
      const parsed = normalizeSession(localStorage.getItem(key));
      if (parsed) return parsed;
    }

    // Supabase-js can store sessions as sb-<project>-auth-token.
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !/^sb-.*-auth-token$/.test(key)) continue;
      const parsed = normalizeSession(localStorage.getItem(key));
      if (parsed) return parsed;
    }
    return null;
  }

  function syncSessionToExtension() {
    const session = getDashboardSession();
    if (!session) return;
    chrome.runtime.sendMessage({ type: 'DASHBOARD_SESSION_IMPORT', session }).catch(() => {});
  }

  function sendBridgeResponse(requestId, payload) {
    if (!requestId) return;
    window.postMessage({ source: 'amplr-dashboard-bridge', requestId, ...payload }, window.location.origin);
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const msg = event.data || {};
    if (msg.source !== 'amplr-dashboard-page') return;
    if (msg.type === 'QUEUE_LOCAL_FALLBACK_JOB' && msg.job) {
      chrome.runtime.sendMessage({ type: 'QUEUE_LOCAL_FALLBACK_JOB', job: msg.job })
        .then(response => sendBridgeResponse(msg.requestId, response || { ok: false, error: 'No extension response' }))
        .catch(error => sendBridgeResponse(msg.requestId, { ok: false, error: error.message }));
    } else if (msg.type === 'GET_LOCAL_FALLBACK_JOB' && msg.jobId) {
      chrome.runtime.sendMessage({ type: 'GET_LOCAL_FALLBACK_JOB', jobId: msg.jobId })
        .then(response => sendBridgeResponse(msg.requestId, response || { ok: false, error: 'No extension response' }))
        .catch(error => sendBridgeResponse(msg.requestId, { ok: false, error: error.message }));
    }
  });

  syncSessionToExtension();
  window.addEventListener('storage', syncSessionToExtension);
  setInterval(syncSessionToExtension, 30000);
})();
