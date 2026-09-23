// Run from this directory with macOS JavaScriptCore: jsc durable-campaign-batch.test.js
const source = readFile('../background.js');
const start = source.indexOf('async function admitScheduledCampaignBatch(');
const end = source.indexOf('// END DASHBOARD EXECUTION LIFECYCLE', start);
if (start < 0 || end < 0) throw new Error('Scheduled campaign batch guard missing');
const paused = [];
let previous = null;
const SB_URL = 'https://example.invalid';
const SB_ANON_KEY = 'public';
const pauseDashboardPendingJob = async (job, reason) => { paused.push({ job, reason }); return true; };
const fetch = async () => ({ ok: true, json: async () => previous ? [previous] : [] });
eval(source.slice(start, end));

const session = { userId: 'user-1', accessToken: 'test-only' };
const base = { result: { run_id: 'run-1', batch_index: 1 }, scheduled_for: new Date().toISOString() };
Promise.resolve()
  .then(async () => {
    if (!await admitScheduledCampaignBatch(base, session)) throw new Error('Fresh first batch was rejected');
    const stale = { ...base, scheduled_for: new Date(Date.now() - 60 * 60 * 1000).toISOString() };
    if (await admitScheduledCampaignBatch(stale, session)) throw new Error('Late first batch was admitted');
    if (paused.length !== 1) throw new Error('Late batch was not paused');
    previous = { status: 'processing' };
    if (await admitScheduledCampaignBatch({ ...base, result: { ...base.result, batch_index: 2 } }, session)) throw new Error('Overlapping batch was admitted');
    previous = { status: 'done' };
    if (!await admitScheduledCampaignBatch({ ...base, result: { ...base.result, batch_index: 2 } }, session)) throw new Error('Completed prior batch did not release next batch');
    print('durable campaign batch test OK');
  });
