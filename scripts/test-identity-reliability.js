#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function functionBody(source, functionName) {
  const marker = `async function ${functionName}`;
  const start = source.indexOf(marker);
  assert(start >= 0, `Missing ${functionName}() implementation`);
  const signatureEnd = source.indexOf('\n', start);
  const bodyStart = source.lastIndexOf('{', signatureEnd);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(bodyStart, i + 1);
    }
  }
  throw new Error(`Could not parse ${functionName}() body`);
}

const composerProbe = functionBody(background, 'runComposerProbeJob');
const joinGroups = functionBody(background, 'runJoinGroupsJob');
const globalProbe = functionBody(background, 'runGlobalIdentitySwitchProbeJob');
const switchIdentity = functionBody(content, 'switchToIdentity');

const versionParts = String(manifest.version || '').split('.').map(Number);
const minVersion = [2, 2, 120];
assert(versionParts.length === 3 && versionParts.every(Number.isFinite), `Manifest version must be semantic, got ${manifest.version}`);
assert(versionParts.some((part, idx) => part > minVersion[idx]) || versionParts.every((part, idx) => part === minVersion[idx]), 'Manifest version was not bumped to the actor-first group join release');
assert(background.includes('function hasPageSpecificScanProof'), 'Background worker is missing Page-specific scan proof helper');
assert(background.includes('verified_profile_switch_then_joined_groups'), 'Page identities must use verified actor switch before opening /groups/joins');
assert(content.includes('function isPlaceholderIdentityName'), 'Browser scraper is missing placeholder-identity detection');
assert(background.includes('function isPlaceholderPostingIdentityName'), 'Background worker is missing placeholder-identity detection');
assert(!/isPlaceholderIdentityName[\s\S]{0,200}empty slot/i.test(content) && !/isPlaceholderPostingIdentityName[\s\S]{0,200}empty slot/i.test(background), 'Empty Slot must not be treated as a stale placeholder; it is a real posting identity');
assert(content.includes('function facebookProfileIdFromUrl'), 'Browser scraper does not extract stable Facebook Page IDs');
assert(background.includes('function facebookPageIdFromUrl'), 'Background worker does not extract stable Facebook Page IDs');
assert(background.includes('async function enrichFacebookIdentityTarget'), 'Background worker does not enrich saved group targets with synchronized metadata');
assert(background.includes('const genericUrl = target.url') && background.includes('profile\\.php\\?id'), 'Group URLs may still be misinterpreted as identity URLs');
assert(composerProbe.includes('await enrichFacebookIdentityTarget(item)'), 'Composer probes do not use enriched identity metadata');
assert(composerProbe.includes('skipSwitch: directVerified'), 'Composer probes do not conditionally use the verified direct Page switch');
assert(!/POST_TO_PAGE/.test(composerProbe), 'Composer probe path references the posting command');
assert(globalProbe.includes('ensureFacebookIdentityActive(identity.name, identity.url'), 'Global probe does not use the verified Page URL and identity');
assert(globalProbe.includes('ok = !!preSwitch?.success'), 'Global probe does not treat verified Facebook state as authoritative');
assert(globalProbe.includes('switch_control_confirmed'), 'Global probe does not preserve switch-control evidence separately');
assert(background.includes("job.message === '__join_groups__'"), 'Dashboard/API jobs cannot queue actor-first group joins');
assert(joinGroups.includes('SWITCH_FACEBOOK_IDENTITY') && joinGroups.includes('SWITCH_FACEBOOK_MANAGED_PAGE'), 'Group join job does not switch into the intended actor first');
assert(joinGroups.includes('Join refused: missing Facebook profile/page owner'), 'Group join job does not fail closed without an identity owner');
assert(joinGroups.includes('jsw_groups?on_conflict=user_id,identity_key,group_url') && joinGroups.includes('identity_key: identityKey'), 'Group join job does not preserve joined groups under the selected identity');
assert(joinGroups.includes('search\\/groups') && joinGroups.includes('join group'), 'Group join job does not support Facebook search-result Join buttons');
assert(switchIdentity.includes("tryDirectPageUrl('initial Page URL')"), 'Identity switcher does not try the stable Page URL first');
assert(content.includes('switch|continue|use facebook as|act as'), 'Page switch button matcher is not broadened for Facebook UI variants');

// Group reconciliation must require two consistent, complete identity scans.
const agreeStart = background.indexOf('function groupSnapshotsAgree(');
const agreeEnd = background.indexOf('async function persistCompleteGroupScan(', agreeStart);
assert(agreeStart >= 0 && agreeEnd > agreeStart, 'Group snapshot comparison is missing');
const groupSnapshotsAgree = new Function(background.slice(agreeStart, agreeEnd) + '; return groupSnapshotsAgree;')();
assert(groupSnapshotsAgree(['a', 'b'], ['a', 'b']), 'Identical snapshots must agree');
assert(!groupSnapshotsAgree(['a', 'b'], ['x', 'y']), 'Disjoint snapshots must not agree');
const persistStart = background.indexOf('async function persistCompleteGroupScan(');
const persistEnd = background.indexOf('async function deleteGroupsForIdentity(', persistStart);
assert(persistStart >= 0 && persistEnd > persistStart, 'Identity-scoped persistence is missing');
const persistBody = background.slice(persistStart, persistEnd);
assert(persistBody.includes('scan?.scan_complete !== true') && persistBody.includes('scan?.active_identity_verified !== true'), 'An incomplete or unverified scan could change saved groups');
assert(persistBody.includes('identity_key=eq.') && persistBody.includes("method: 'DELETE'"), 'Missing groups are not reconciled within their identity');
const importBody = background.slice(background.indexOf('async function importFacebookGroupsForJob('), background.indexOf('\nasync function ', background.indexOf('async function importFacebookGroupsForJob(') + 10));
assert(!importBody.includes('jsw_groups?on_conflict='), 'Scanner writes groups before cross-identity validation');
assert(importBody.includes('stableBottomPasses < 2'), 'Scanner may reconcile after partial scrolling');

async function runReconciliationTests() {
  const buildPersist = new Function('getGroupRowsForIdentity', 'fetch', 'SB_URL', 'SB_ANON_KEY',
    background.slice(agreeStart, persistEnd) + '; return persistCompleteGroupScan;');
  const existing = [
    { id: '1', group_url: 'https://www.facebook.com/groups/old/', group_name: 'Old' },
    { id: '2', group_url: 'https://www.facebook.com/groups/keep/', group_name: 'Keep' }
  ];
  const writes = [];
  const fetchMock = async (url, options) => {
    writes.push({ url, method: options.method });
    return { ok: true, text: async () => '' };
  };
  const persist = buildPersist(async () => existing, fetchMock, 'https://example.supabase.co', 'anon');
  const session = { userId: 'user', accessToken: 'token' };
  const identity = { key: 'page-one', name: 'Page One', type: 'page' };
  const scan = {
    identity_key: 'page-one', scan_complete: true, active_identity_verified: true,
    groups: [
      { url: 'https://www.facebook.com/groups/keep/', name: 'Keep' },
      { url: 'https://www.facebook.com/groups/new/', name: 'New' }
    ]
  };
  const first = await persist(session, identity, scan, null);
  assert(first.reconciliation === 'baseline_recorded' && first.removed_count === 0, 'First scan must record a baseline without deletion');
  assert(!writes.some(write => write.method === 'DELETE'), 'First scan issued a delete');
  writes.length = 0;
  const second = await persist(session, identity, scan, { job_id: 'prior', urls: scan.groups.map(group => group.url) });
  assert(second.reconciliation === 'complete' && second.removed_count === 1, 'Matching second scan did not remove the missing row');
  assert(writes.some(write => write.method === 'DELETE' && write.url.includes('identity_key=eq.page-one')), 'Deletion was not scoped to the identity');
  writes.length = 0;
  let rejected = false;
  try { await persist(session, identity, { ...scan, scan_complete: false }, { job_id: 'prior', urls: [] }); }
  catch (_) { rejected = true; }
  assert(rejected && writes.length === 0, 'Incomplete scan changed saved rows');
}

runReconciliationTests().then(() => {
  console.log('PASS: Identity reliability and guarded group reconciliation.');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
