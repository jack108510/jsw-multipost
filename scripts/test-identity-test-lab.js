#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const background = read('background.js');
const popup = read('popup.js');
const popupHtml = read('popup.html');
const labHtml = read('test-lab.html');
const labJs = read('test-lab.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function functionBody(source, functionName) {
  const start = source.indexOf(`async function ${functionName}`);
  assert(start >= 0, `Missing ${functionName}() in background.js`);
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

const testBody = functionBody(background, 'runNonPostingIdentityTest');

assert(background.includes("'IDENTITY_TEST_LIST'"), 'Missing IDENTITY_TEST_LIST message handler');
assert(background.includes("'IDENTITY_TEST_RUN'"), 'Missing IDENTITY_TEST_RUN message handler');
assert(testBody.includes("'SWITCH_FACEBOOK_IDENTITY'"), 'Test does not exercise regular identity switching');
assert(testBody.includes("'SWITCH_FACEBOOK_MANAGED_PAGE'"), 'Test does not exercise managed Page switching');
assert(testBody.includes("'GET_FACEBOOK_ACTIVE_IDENTITY'"), 'Test does not verify the active Facebook identity');
assert(testBody.includes("'PROBE_GROUP_COMPOSER_IDENTITY'"), 'Test does not support composer verification');
assert(!/type\s*:\s*['\"]POST_TO_PAGE['\"]/.test(testBody), 'Non-posting test path references POST_TO_PAGE');
assert(!/jsw_post_jobs/.test(testBody), 'Non-posting test path references the posting queue');
assert(!/\.insert\s*\(/.test(testBody), 'Non-posting test path contains an insert operation');
assert(popupHtml.includes('openIdentityTestBtn'), 'Popup does not expose the Identity Test Lab');
assert(popup.includes("chrome.runtime.getURL('test-lab.html')"), 'Popup does not open the local Identity Test Lab');
assert(labHtml.includes('Non-posting test'), 'Test Lab does not disclose its non-posting behavior');
assert(labJs.includes("type: 'IDENTITY_TEST_RUN'"), 'Test Lab does not invoke the dedicated background test message');

console.log('PASS: Identity Test Lab is wired to switch/verify paths and contains no posting or queue operation.');
