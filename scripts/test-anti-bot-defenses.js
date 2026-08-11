#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const dashboard = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

function assert(condition, message) {
  if (!condition) {
    console.error(`anti-bot defense test failed: ${message}`);
    process.exit(1);
  }
}

assert(/const ANTI_BOT = \{[\s\S]*maxGroupsPerJob:\s*8/.test(background), 'worker max-groups cap missing');
assert(/hardCooldownDays:\s*2/.test(background), 'worker hard cooldown missing');
assert(/minDelaySeconds:\s*90/.test(background), 'worker minimum randomized delay missing');
assert(/maxDelaySeconds:\s*210/.test(background), 'worker maximum randomized delay missing');
assert(/scheduleJitterMinutes:\s*75/.test(background), 'recurring schedule jitter missing');
assert(/dailyUserPostCap:\s*24/.test(background), 'daily user post cap missing');
assert(/cooldown_skip/.test(background), 'cooldown skip result missing');
assert(/ban_risk_skip/.test(background), 'ban-risk skip missing');
assert(/facebook_defense_stop/.test(background), 'batch stop on Facebook defense missing');
assert(/Anti-bot wait \$\{waitSeconds\}s/.test(background), 'randomized wait status missing');
assert(/detectFacebookDefenseSignal/.test(content), 'content-script defense detector missing');
assert(/temporarily blocked/.test(content) && /confirm your identity/.test(content), 'Facebook block/checkpoint terms missing');
assert(/ANTI_BOT_RULES/.test(dashboard), 'dashboard anti-bot rules missing');
assert(/Anti-bot defense active/.test(dashboard), 'dashboard anti-bot UI copy missing');
assert(manifest.version === '2.2.9', `manifest version expected 2.2.9, got ${manifest.version}`);

console.log('anti-bot defense tests passed');
