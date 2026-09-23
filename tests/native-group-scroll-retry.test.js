// Run with macOS JavaScriptCore: jsc native-group-scroll-retry.test.js
const source = readFile('../background.js');
const start = source.indexOf('async function scrollFacebookJoinedGroupsWithRetry(');
const end = source.indexOf('async function importFacebookGroupsForJob(', start);
if (start < 0 || end < 0) throw new Error('Joined-groups retry helper missing');

let calls = 0;
let notices = 0;
let mode = 'once';
const sleep = async () => {};
const scrollFacebookJoinedGroupsNative = async () => {
  calls++;
  if (mode === 'other') throw new Error('Facebook switched accounts');
  if (mode === 'persistent' || calls === 1) throw new Error('Facebook joined-groups wheel event timed out after 20 seconds');
};
eval(source.slice(start, end));

Promise.resolve().then(async () => {
  await scrollFacebookJoinedGroupsWithRetry(1, () => { notices++; });
  if (calls !== 2 || notices !== 1) throw new Error('Wheel timeout was not retried once');
  mode = 'persistent';
  calls = 0;
  const error = await scrollFacebookJoinedGroupsWithRetry(1, null).then(() => null, e => e);
  if (!error || calls !== 2) throw new Error('Persistent wheel timeout was not stopped after one retry');
  mode = 'other';
  calls = 0;
  const other = await scrollFacebookJoinedGroupsWithRetry(1, null).then(() => null, e => e);
  if (!other || calls !== 1) throw new Error('A non-timeout failure was retried');
  print('native group scroll retry test OK');
});
