// Run from this directory with macOS JavaScriptCore: jsc group-import-token-refresh.test.js
const source = readFile('../background.js');
const start = source.indexOf('async function ensureImportJobActive(');
const end = source.indexOf('async function runImportGroupsJob(', start);
if (start < 0 || end < 0) throw new Error('Import session checks missing');
const SB_URL = 'https://example.invalid';
const SB_ANON_KEY = 'public-test-key';
const oldSession = { userId: 'user-1', accessToken: 'expired-token' };
let currentSession = { userId: 'user-1', accessToken: 'refreshed-token' };
let authorization = '';
const getStoredSession = async () => currentSession;
const fetch = async (_, options) => {
  authorization = options.headers.Authorization;
  return { ok: true, json: async () => [{ status: 'processing' }] };
};
eval(source.slice(start, end));

Promise.resolve().then(async () => {
  await ensureImportJobActive('job-1', oldSession);
  if (authorization !== 'Bearer refreshed-token') throw new Error('Import reused the expired JWT');
  if ((await freshGroupImportSession('user-1')).accessToken !== 'refreshed-token') throw new Error('Fresh session was not returned');
  currentSession = { userId: 'user-2', accessToken: 'another-account' };
  let rejected = false;
  try { await freshGroupImportSession('user-1'); } catch (_) { rejected = true; }
  if (!rejected) throw new Error('Import accepted a different signed-in user');
  print('group import token refresh test OK');
});
