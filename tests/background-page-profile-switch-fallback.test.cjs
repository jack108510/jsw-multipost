const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'background.js'), 'utf8');
const start = source.indexOf('async function ensureFacebookIdentityActive(');
const end = source.indexOf('\nasync function syncFacebookIdentitiesForJob', start);
assert.ok(start >= 0 && end > start, 'ensureFacebookIdentityActive must exist');
const implementation = source.slice(start, end);

test('managed Page preflight uses native Page-profile Switch fallback before Pages Manager', async () => {
  const sent = [];
  let nativeCalls = 0;
  const context = {
    isForbiddenPostingIdentityName: () => false,
    isFacebookMessageChannelReloadError: () => false,
    facebookIdentityNameMatches: (actual, expected) => actual === expected,
    sendTabMessageWithRetry: async (_tabId, message) => {
      sent.push(message.type);
      if (message.type === 'SWITCH_FACEBOOK_IDENTITY') return { success: false, error: 'content click did not switch' };
      if (message.type === 'GET_FACEBOOK_PAGE_CONTEXT_IDENTITY') return { success: true, verified: true, identitySource: 'native_managed_page_context', activeIdentity: 'Wildrose Automations', pageUrl: 'https://www.facebook.com/profile.php?id=61572103491433' };
      throw new Error(`unexpected message ${message.type}`);
    },
    confirmFacebookPageProfileSwitchByKeyboard: async () => {
      nativeCalls++;
      return { clicked: true, success: true, active_identity: 'Wildrose Automations', switch_confirmed_by_dialog: true };
    },
    clickFacebookPageProfileSwitchButton: async () => { throw new Error('mouse fallback should not be called when keyboard switch succeeds'); },
    chrome: { tabs: {
      create: async () => ({ id: 7 }),
      update: async () => {},
      remove: async () => {}
    } },
    sleep: async () => {},
    extLog: () => {}
  };
  vm.createContext(context);
  vm.runInContext(`${implementation}; globalThis.ensureFacebookIdentityActive = ensureFacebookIdentityActive;`, context);

  const result = await context.ensureFacebookIdentityActive('Wildrose Automations', 'https://www.facebook.com/profile.php?id=61572103491433', 'page');

  assert.equal(nativeCalls, 1);
  assert.deepEqual(sent.slice(0, 1), ['SWITCH_FACEBOOK_IDENTITY']);
  assert.equal(sent.includes('SWITCH_FACEBOOK_MANAGED_PAGE'), false);
  assert.equal(result.success, true);
  assert.equal(result.active_identity, 'Wildrose Automations');
  assert.equal(result.switch_response.native_page_profile_fallback.success, true);
});
