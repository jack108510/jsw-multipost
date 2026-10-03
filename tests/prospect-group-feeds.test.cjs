const assert = require('node:assert/strict');
const { normalizeGroupFeedUrls } = require('../group-finder-scan.js');
assert.deepEqual(normalizeGroupFeedUrls([
  'https://www.facebook.com/groups/torontovbnetwork/?sorting_setting=CHRONOLOGICAL',
  'https://facebook.com/groups/torontovbnetwork',
  'https://www.facebook.com/groups/123456789',
]), [
  'https://www.facebook.com/groups/torontovbnetwork/',
  'https://www.facebook.com/groups/123456789/',
]);
assert.deepEqual(normalizeGroupFeedUrls([
  'https://evil.com/groups/torontovbnetwork',
  'https://www.facebook.com/groups/abc/posts/123',
  'https://www.facebook.com/groups/abc/search/',
  'https://www.facebook.com/groups/abc/members/',
  'https://www.facebook.com/groups/',
  'javascript:alert(1)',
]), []);
assert.equal(normalizeGroupFeedUrls(Array.from({length:10},(_,i)=>`https://facebook.com/groups/group${i}`)).length,3);
console.log('read-only group scan URL policy passed');
