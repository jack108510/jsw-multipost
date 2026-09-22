const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../background.js'), 'utf8');
const auth = source.slice(source.indexOf('let dashSession = null;'), source.indexOf('// ─── Remote logging'));
const expired = () => ({ userId: 'a', accessToken: 'expired', refreshToken: 'saved-refresh', expiresAt: 1, durableSchedulerV1: true });
const success = () => ({ ok: true, status: 200, json: async () => ({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 }) });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
function harness({ session = expired(), fetch = async () => { throw new Error('Failed to fetch'); }, status = async () => {} } = {}) {
  const state = { jsw_session: structuredClone(session) };
  const timers = new Map(); let timerId = 0;
  const ctx = vm.createContext({ console: { warn() {} }, Date, AbortController,
    SB_URL: 'https://offline.invalid', SB_ANON_KEY: 'fixture', fetch,
    writeExtensionStatus: status,
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    chrome: { storage: { local: {
      get: async () => structuredClone(state),
      set: async value => Object.assign(state, structuredClone(value)),
      remove: async () => { delete state.jsw_session; },
    } } },
  });
  let listener;
  ctx.chrome.runtime = { onMessage: { addListener: fn => { listener = fn; } } };
  Object.assign(ctx, { startDashPolling: async () => {}, writeHeartbeat() {}, extLog() {}, EXT_VERSION: 'fixture' });
  vm.runInContext(auth, ctx);
  vm.runInContext(source.slice(source.indexOf('// Listen for login/logout from popup'), source.indexOf('// On startup, resume polling if already logged in')), ctx);
  return { state, ctx, timers, send: msg => listener(msg, {}, () => {}), get: () => ctx.getStoredSession(), dash: () => vm.runInContext('dashSession', ctx),
    expireTimers() { for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn(); } } };
}
test('hung refresh fetch has an abortable deadline and cannot later overwrite failure state', async () => {
  const pending = deferred(); let signal;
  const h = harness({ fetch: async (_, options) => { signal = options.signal; return pending.promise; } });
  let result = 'pending'; const request = h.get().then(value => { result = value; });
  await turn(); h.expireTimers(); await turn();
  assert.equal(result, null);
  assert.equal(signal.aborted, true);
  assert.equal(h.state.jsw_session.refreshPending, true);
  pending.resolve(success()); await request; await turn();
  assert.equal(h.state.jsw_session.accessToken, 'expired');
  assert.equal(h.timers.size, 0);
});
test('hung response body shares the refresh deadline', async () => {
  const h = harness({ fetch: async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }) });
  let result = 'pending'; h.get().then(value => { result = value; });
  await turn(); h.expireTimers(); await turn();
  assert.equal(result, null);
  assert.equal(h.state.jsw_session.refreshToken, 'saved-refresh');
});
test('hung status report cannot block persisted credentials or auth return', async () => {
  let called = false;
  const h = harness({ status: () => { called = true; return new Promise(() => {}); } });
  let result = 'pending'; h.get().then(value => { result = value; });
  await turn();
  assert.equal(called, true);
  assert.equal(h.state.jsw_session.refreshPending, true);
  h.expireTimers(); await turn();
  assert.equal(result, null);
});
test('concurrent callers share one rotating refresh and a later call can retry', async () => {
  const pending = deferred(); let calls = 0;
  const h = harness({ fetch: async () => { calls++; return pending.promise; } });
  const requests = [h.get(), h.get(), h.get()]; await turn();
  assert.equal(calls, 1);
  pending.resolve(success());
  const results = await Promise.all(requests);
  assert.ok(results.every(s => s.accessToken === 'fresh'));
  h.state.jsw_session.expiresAt = 1;
  await h.get(); assert.equal(calls, 2);
});
test('successful recovery clears refresh error metadata and preserves ownership', async () => {
  const h = harness({ session: { ...expired(), refreshPending: true, refreshError: 'old failure', lastRefreshAttempt: 123 }, fetch: async () => success() });
  const result = await h.get();
  assert.equal(result.refreshPending, false);
  assert.equal(result.refreshError, undefined);
  assert.equal(result.lastRefreshAttempt, undefined);
  assert.equal(result.durableSchedulerV1, true);
  assert.deepEqual(h.state.jsw_session, structuredClone(result));
});
test('HTML HTTP 503 is transient rather than a JSON/auth rejection', async () => {
  const h = harness({ fetch: async () => ({ ok: false, status: 503, json: async () => { throw new SyntaxError('Unexpected token <'); } }) });
  assert.equal(await h.get(), null);
  assert.equal(h.state.jsw_session.refreshPending, true);
  assert.match(h.state.jsw_session.refreshError, /503/);
});
for (const outcome of ['success', 'failure']) {
  for (const userId of ['a', 'b']) {
    test(`stale refresh ${outcome} cannot overwrite imported account ${userId}`, async () => {
      const pending = deferred(); const h = harness({ fetch: () => pending.promise });
      const request = h.get(); await turn();
      h.send({ type: 'DASHBOARD_SESSION_IMPORT', session: { userId, accessToken: 'imported', refreshToken: 'imported-r', expiresAt: 9999999999 } });
      await turn(); const imported = structuredClone(h.state.jsw_session);
      if (outcome === 'success') pending.resolve(success()); else pending.reject(new Error('Failed to fetch'));
      assert.equal(await request, null);
      assert.deepEqual(h.state.jsw_session, imported);
      assert.deepEqual(structuredClone(h.dash()), imported);
    });
  }
}
test('import arriving during the final storage check wins over a stale read snapshot', async () => {
  const h = harness({ fetch: async () => success() });
  const read = h.ctx.chrome.storage.local.get;
  const gate = deferred(); let reads = 0;
  h.ctx.chrome.storage.local.get = async () => {
    const value = await read();
    if (++reads === 2) { await gate.promise; }
    return value;
  };
  const request = h.get(); await turn();
  h.send({ type: 'DASHBOARD_SESSION_IMPORT', session: { userId: 'b', accessToken: 'imported', refreshToken: 'imported-r', expiresAt: 9999999999 } });
  await turn(); gate.resolve();
  assert.equal(await request, null); await turn();
  assert.equal(h.state.jsw_session.accessToken, 'imported');
  assert.equal(h.dash().accessToken, 'imported');
});
test('import waits out an already issued refresh storage write and remains the final session', async () => {
  const h = harness({ fetch: async () => success() });
  const write = h.ctx.chrome.storage.local.set; const gate = deferred();
  h.ctx.chrome.storage.local.set = async value => {
    if (value.jsw_session?.accessToken === 'fresh') await gate.promise;
    return write(value);
  };
  const request = h.get(); await turn();
  h.send({ type: 'DASHBOARD_SESSION_IMPORT', session: { userId: 'b', accessToken: 'imported', refreshToken: 'imported-r', expiresAt: 9999999999 } });
  await turn(); gate.resolve();
  assert.equal(await request, null); await turn();
  assert.equal(h.state.jsw_session.accessToken, 'imported');
  assert.equal(h.dash().accessToken, 'imported');
});
test('expired transient failure returns null while retaining refresh credentials', async () => {
  const h = harness();
  assert.equal(await h.get(), null);
  assert.equal(h.dash(), null);
  assert.equal(h.state.jsw_session.refreshToken, 'saved-refresh');
  assert.equal(h.state.jsw_session.refreshPending, true);
});
