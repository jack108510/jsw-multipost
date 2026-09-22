'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../content.js'), 'utf8');
const start = source.indexOf('  function findManagedPageProfileSwitchControl(');
const end = source.indexOf('\n  }', start);

function find({url='https://www.facebook.com/profile.php?id=61572103491433', target='Wildrose Automations', page='Wildrose Automations', switchAria='Switch', context=true}={}) {
  assert.ok(start >= 0 && end > start, 'Page-profile switch locator must exist');
  const button = {getAttribute: key => key === 'aria-label' ? switchAria : null};
  const card = {innerText: `Switch into ${page}'s Page to take more actions Switch`, contains: el => el === button};
  const doc = {body:{innerText:card.innerText}, querySelectorAll: sel => sel === '[aria-label="Switch"]' ? [button] : sel === 'div, [role="article"], [role="listitem"]' && context ? [card] : []};
  const ctx = {document:doc,location:{href:url},visible:()=>true,normalizeText:s=>String(s||'').replace(/\s+/g,' ').trim(),facebookProfileIdFromUrl:s=>new URL(s).searchParams.get('id')};
  vm.createContext(ctx);
  vm.runInContext(source.slice(start,end+4)+';globalThis.locate=findManagedPageProfileSwitchControl',ctx);
  return ctx.locate(target,'https://www.facebook.com/profile.php?id=61572103491433');
}
test('finds exact Page-shell Switch control for Wildrose when Pages manager Switch Now is absent',()=>{
  assert.equal(find()?.getAttribute('aria-label'),'Switch');
});
test('refuses wrong Page URL, wrong card name, and unbound Switch control',()=>{
  assert.equal(find({url:'https://www.facebook.com/profile.php?id=61591900434164'}),null);
  assert.equal(find({page:'Empty Slot'}),null);
  assert.equal(find({context:false}),null);
});
test('Page-shell switch confirms the dialog but fails closed when actor is not verified', async () => {
  const begin = source.indexOf('  async function switchManagedPageFromPagesManager(');
  const finish = source.indexOf('\n  async function switchViaVerifiedFacebookIdentityPath(',begin);
  assert.ok(begin >= 0 && finish > begin);
  const cardButton = {kind:'card'};
  const confirmButton = {kind:'confirm', getAttribute: key => key === 'aria-label' ? 'Switch' : null};
  const dialog = {innerText:'Switch into Wildrose Automations’s Page?',querySelectorAll:()=>[confirmButton]};
  const clicks = [];
  const ctx = {
    document:{body:{innerText:"Switch into Wildrose Automations's Page to take more actions Switch",querySelectorAll:()=>[]},
      querySelector:()=>null,querySelectorAll:sel=>sel === '[role="dialog"]' ? [dialog] : []},
    location:{href:'https://www.facebook.com/profile.php?id=61572103491433',pathname:'/profile.php'},
    normalizeText:s=>String(s||'').replace(/\s+/g,' ').trim(),
    visible:()=>true,identityMatches:(a,b)=>a===b,currentIdentityName:()=> 'Other Page',
    findManagedPageProfileSwitchControl:()=>cardButton,clickLikeUser:el=>clicks.push(el.kind),
    sleep:async()=>{},window:{scrollBy:()=>{},innerHeight:800}
  };
  vm.createContext(ctx);
  vm.runInContext(source.slice(begin,finish)+';globalThis.run=switchManagedPageFromPagesManager',ctx);
  await assert.rejects(ctx.run('Wildrose Automations','https://www.facebook.com/profile.php?id=61572103491433'),/active actor did not verify/);
  assert.deepEqual(clicks,['card','confirm']);
});
