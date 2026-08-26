const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const schedulerPath = path.join(__dirname, '..', 'dashboard_group_campaign.js');
assert(fs.existsSync(schedulerPath), 'dashboard_group_campaign.js must exist');

const code = fs.readFileSync(schedulerPath, 'utf8');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: schedulerPath });

const api = sandbox.window.AmplrGroupJoinCampaign;
assert(api, 'AmplrGroupJoinCampaign API must be exposed on window');
assert.strictEqual(typeof api.buildGroupJoinCampaignJobs, 'function');
assert.strictEqual(typeof api.candidateToJoinTarget, 'function');

const identity = {
  name: 'Empty Slot',
  key: 'page-empty-slot',
  type: 'page',
  url: 'https://www.facebook.com/profile.php?id=1234567890'
};
const candidates = Array.from({ length: 25 }, (_, i) => ({
  id: `safe-${i}`,
  status: 'safe',
  group_name: `US Pet Group ${i + 1}`,
  group_url: `https://www.facebook.com/groups/us-pet-${i + 1}/`,
  score: 82
})).concat([
  { id: 'unsafe-1', status: 'unsafe', group_name: 'Lost Pets Finder', group_url: 'https://www.facebook.com/groups/lost/' },
  { id: 'joined-1', status: 'joined', group_name: 'Already Joined', group_url: 'https://www.facebook.com/groups/joined/' },
  { id: 'requested-1', status: 'requested', group_name: 'Already Requested', group_url: 'https://www.facebook.com/groups/requested/' },
  { id: 'missing-url', status: 'safe', group_name: 'Missing URL' }
]);

const start = new Date('2026-08-26T16:00:00.000Z');
const jobs = api.buildGroupJoinCampaignJobs({
  userId: 'user-123',
  identity,
  candidates,
  totalTarget: 22,
  batchSize: 12,
  jobsPerDay: 2,
  startAt: start,
  campaignName: 'Empty Slot US pet-owner groups',
  spacingHours: 4
});

assert.strictEqual(jobs.length, 3, '22 safe targets at capped batch size 10 should produce 3 jobs');
assert.deepStrictEqual(Array.from(jobs.map(j => j.groups.length)), [10, 10, 2], 'jobs should chunk into capped batches');
assert.deepStrictEqual(Array.from(jobs.map(j => j.scheduled_for)), [
  '2026-08-26T16:00:00.000Z',
  '2026-08-26T20:00:00.000Z',
  '2026-08-27T16:00:00.000Z'
], 'jobs should respect jobs/day pacing and spacing hours');

for (const job of jobs) {
  assert.strictEqual(job.user_id, 'user-123');
  assert.strictEqual(job.message, '__join_groups__');
  assert.strictEqual(job.status, 'pending');
  assert.strictEqual(job.ai_enabled, false);
  assert.strictEqual(job.delay, 0);
  assert.strictEqual(job.ai_prompt, 'Empty Slot');
  assert.strictEqual(job.result.join_campaign, true);
  assert.strictEqual(job.result.campaign_name, 'Empty Slot US pet-owner groups');
  assert(job.groups.every(g => g.identity_name === 'Empty Slot'), 'every group target must preserve actor name');
  assert(job.groups.every(g => g.identity_key === 'page-empty-slot'), 'every group target must preserve actor key');
  assert(job.groups.every(g => g.identity_url === identity.url), 'every group target must preserve actor URL');
  assert(job.groups.every(g => g.join_source === 'dashboard_group_join_campaign'), 'every target must mark campaign source');
}

const flatNames = jobs.flatMap(j => j.groups.map(g => g.group_name));
assert(!flatNames.includes('Lost Pets Finder'), 'unsafe groups must not be scheduled');
assert(!flatNames.includes('Already Joined'), 'joined groups must not be scheduled');
assert(!flatNames.includes('Already Requested'), 'requested groups must not be scheduled');
assert(!flatNames.includes('Missing URL'), 'candidates without group or search URL must not be scheduled');

assert.throws(() => api.buildGroupJoinCampaignJobs({ userId: 'u', identity: { name: 'Empty Slot' }, candidates }), /identity key/i, 'campaigns must fail closed without identity key');
assert.throws(() => api.buildGroupJoinCampaignJobs({ userId: 'u', identity, candidates, batchSize: 0 }), /batch size/i, 'invalid batch size should be rejected');
assert.throws(() => api.buildGroupJoinCampaignJobs({ userId: 'u', identity, candidates, totalTarget: 101 }), /100/i, 'campaign total target must be capped at 100');

console.log('PASS: group join campaign scheduler builds paced actor-first __join_groups__ jobs safely');
