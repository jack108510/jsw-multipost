#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('dashboard.html', 'utf8');
const match = html.match(/const WILDROSE_FEATURE_POSTS = ([\s\S]*?);\n\ntry \{/);
assert(match, 'Wildrose feature post bank not found');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`posts = ${match[1]};`, sandbox);
const posts = sandbox.posts;

const expectedKeys = [
  'basic-site',
  'business-site',
  'ai-adoption-plan',
  'app-development',
  'automation-ai',
  'portals-dashboards',
  'booking-payments',
  'maintenance-hosting'
];

assert.strictEqual(JSON.stringify(posts.map(p => p.key)), JSON.stringify(expectedKeys), 'feature keys changed unexpectedly');
assert.strictEqual(posts.length, 8, 'Wildrose should have one post category per sold feature/offer');

for (const feature of posts) {
  assert(feature.label && feature.label.length > 8, `${feature.key} needs a useful label`);
  assert(Array.isArray(feature.posts), `${feature.key} posts must be an array`);
  assert(feature.posts.length >= 2, `${feature.key} needs at least two variations`);
  for (const post of feature.posts) {
    assert(post.length > 220, `${feature.key} post is too thin`);
    assert(!/\$29\/month|\$29\/mo/i.test(post), `${feature.key} still contains stale $29 pricing`);
    assert(!/emoji|hashtag/i.test(post), `${feature.key} contains meta-writing instead of post copy`);
  }
}

assert(html.includes('wildroseFeaturePostSelect'), 'dashboard picker missing');
assert(html.includes('loadWildroseFeaturePost()'), 'load function missing');
assert(html.includes('renderWildroseFeaturePostPicker();'), 'picker render hook missing');

console.log(`wildrose feature post tests passed (${posts.length} features, ${posts.reduce((n, f) => n + f.posts.length, 0)} posts)`);
