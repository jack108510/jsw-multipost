const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

function makeChromeStub() {
  return new Proxy(function noop() {}, {
    get(_target, prop) {
      if (prop === 'getManifest') return () => ({ version: 'test' });
      if (prop === 'addListener') return () => {};
      if (prop === 'create') return () => {};
      if (prop === 'catch') return () => {};
      return makeChromeStub();
    },
    apply() {
      return makeChromeStub();
    }
  });
}

const context = {
  console,
  URL,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  fetch: async () => ({ ok: true, json: async () => [] }),
  chrome: makeChromeStub()
};

vm.createContext(context);
vm.runInContext(fs.readFileSync('background.js', 'utf8'), context);

const roseCopy = `Rose is an AI front desk for local businesses.\n\nTry the preview with your own URL:\nhttps://wildroseautomations.ca/#mockup`;
const tracked = context.addTrackingParamsToMessage(roseCopy, {
  job: {
    id: '78a5ef69-658b-4cc4-917f-13d56c0121a1',
    message: roseCopy,
    groups: [{ identity_name: 'Wildrose Automations' }]
  },
  target: { group_name: 'Alberta Friends Small Business Network' },
  groupUrl: 'https://facebook.com/groups/example'
});

assert.strictEqual(tracked.tracked_url_count, 1);
assert.match(tracked.message, /utm_source=facebook_group/);
assert.match(tracked.message, /utm_medium=organic/);
assert.match(tracked.message, /utm_campaign=wildrose-rose/);
assert.match(tracked.message, /utm_content=copy-[a-z0-9]+/);
assert.match(tracked.message, /amplr_group=alberta-friends-small-business-network/);
assert.match(tracked.message, /amplr_job=78a5ef69/);
assert.match(tracked.message, /#mockup$/);

const facebookOnly = context.addTrackingParamsToMessage('Join https://facebook.com/groups/example', {
  job: { message: 'Join https://facebook.com/groups/example' },
  target: { group_name: 'Test Group' }
});
assert.strictEqual(facebookOnly.tracked_url_count, 0);
assert.strictEqual(facebookOnly.message, 'Join https://facebook.com/groups/example');

console.log('PASS: tracked link parameters are added to outbound campaign URLs and Facebook URLs are skipped');
