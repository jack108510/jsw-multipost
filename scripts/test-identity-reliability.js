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
const globalProbe = functionBody(background, 'runGlobalIdentitySwitchProbeJob');
const switchIdentity = functionBody(content, 'switchToIdentity');

assert(manifest.version === '2.2.116', 'Manifest version was not bumped to the reliability release');
assert(content.includes('function isPlaceholderIdentityName'), 'Browser scraper is missing placeholder-identity detection');
assert(background.includes('function isPlaceholderPostingIdentityName'), 'Background worker is missing placeholder-identity detection');
assert(!/empty slot/i.test(content) && !/empty slot/i.test(background), 'Empty Slot must not be treated as a stale placeholder; it is a real posting identity');
assert(content.includes('function facebookProfileIdFromUrl'), 'Browser scraper does not extract stable Facebook Page IDs');
assert(background.includes('function facebookPageIdFromUrl'), 'Background worker does not extract stable Facebook Page IDs');
assert(background.includes('async function enrichFacebookIdentityTarget'), 'Background worker does not enrich saved group targets with synchronized metadata');
assert(background.includes('const genericUrl = target.url') && background.includes('profile\\.php\\?id'), 'Group URLs may still be misinterpreted as identity URLs');
assert(composerProbe.includes('await enrichFacebookIdentityTarget(item)'), 'Composer probes do not use enriched identity metadata');
assert(composerProbe.includes('skipSwitch: directVerified'), 'Composer probes do not conditionally use the verified direct Page switch');
assert(!/POST_TO_PAGE/.test(composerProbe), 'Composer probe path references the posting command');
assert(globalProbe.includes("url: identity.url, active: true"), 'Global probe does not prefer a stable Page URL');
assert(globalProbe.includes('ok = facebookIdentityNameMatches'), 'Global probe does not treat verified Facebook state as authoritative');
assert(globalProbe.includes('switch_control_confirmed'), 'Global probe does not preserve switch-control evidence separately');
assert(switchIdentity.includes("tryDirectPageUrl('initial Page URL')"), 'Identity switcher does not try the stable Page URL first');
assert(content.includes('switch|continue|use facebook as|act as'), 'Page switch button matcher is not broadened for Facebook UI variants');

console.log('PASS: Identity reliability release preserves stable Page metadata, rejects placeholders, and keeps composer probes non-posting.');
