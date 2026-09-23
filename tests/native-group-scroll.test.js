// Run with macOS JavaScriptCore: jsc tests/native-group-scroll.test.js
const source = readFile('../background.js');
const start = source.indexOf('async function withGroupScanTimeout(');
const end = source.indexOf('async function importFacebookGroupsForJob(', start);
if (start < 0 || end < 0) throw new Error('Native joined-groups scroll missing');
const events = [];
const setTimeout = () => 1;
const clearTimeout = () => {};
const chrome = {
  scripting: { executeScript: async () => [{ result: { width: 1200, height: 800, targetX: 810 } }] },
  tabs: { update: async () => ({}) },
  debugger: {
    attach: async () => events.push('attach'),
    detach: async () => events.push('detach'),
    sendCommand: async (_, command, params) => events.push({ command, params })
  }
};
const sleep = async () => {};
eval(source.slice(start, end));

scrollFacebookJoinedGroupsNative(1).then(() => {
  const wheels = events.filter(event => event.command === 'Input.dispatchMouseEvent' && event.params.type === 'mouseWheel');
  if (wheels.length !== 2 || wheels.some(event => event.params.deltaY <= 0 || event.params.x !== 810)) {
    throw new Error('Joined-groups scroll did not send wheel events over the main list');
  }
  if (events[0] !== 'attach' || events.at(-1) !== 'detach') throw new Error('Debugger was not detached');
  print('native group scroll test OK');
});
