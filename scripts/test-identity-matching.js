const assert = require('assert');

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function cleanIdentityName(text) {
  return normalizeText(text)
    .replace(/^(Switch to|Continue as|Use Facebook as)\s+/i, '')
    .replace(/^Search\s+/i, '')
    .replace(/\s*['’]\s*s\s+(Timeline|profile|page)$/i, '')
    .replace(/['’]\s*s$/i, '')
    .replace(/\s+(facebook identity|profile|page)$/i, '')
    .trim();
}

function identityMatches(actual, expected) {
  if (!expected) return true;
  actual = cleanIdentityName(actual || '').toLowerCase();
  expected = cleanIdentityName(expected || '').toLowerCase();
  if (!actual || !expected) return false;
  if (actual === expected) return true;
  const strip = value => value
    .replace(/\s*['’]\s*s\s+(Timeline|profile|page)$/i, '')
    .replace(/\s+(facebook identity|profile|page)$/i, '')
    .replace(/['’]s$/i, '')
    .trim();
  return strip(actual) === strip(expected);
}

const positiveCases = [
  ["Vet Inc's Timeline", 'Vet Inc'],
  ["Jack Sereda's Timeline", 'Jack Sereda'],
  ["Wildrose Automations 's Timeline", 'Wildrose Automations'],
  ["Empty Slot’s Timeline", 'Empty Slot'],
  ['Vet Inc facebook identity', 'Vet Inc'],
  ['Search Empty Slot', 'Empty Slot']
];

for (const [actual, expected] of positiveCases) {
  assert.strictEqual(identityMatches(actual, expected), true, `${actual} should match ${expected}`);
}

const negativeCases = [
  ["Vet Inc's Timeline", 'Empty Slot'],
  ["Wildrose Automations's Timeline", 'Vet Inc'],
  ['Available Voices, switch', 'Vet Inc'],
  ['Edit', 'Vet Inc'],
  ['1 Unread Chats', 'Jack Sereda']
];

for (const [actual, expected] of negativeCases) {
  assert.strictEqual(identityMatches(actual, expected), false, `${actual} should not match ${expected}`);
}

console.log(`identity matching tests passed (${positiveCases.length + negativeCases.length})`);
