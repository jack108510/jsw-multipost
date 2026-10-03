const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const html=fs.readFileSync(require('node:path').join(__dirname,'../dashboard.html'),'utf8');
const start=html.indexOf('function opsDailyCounts(');
const end=html.indexOf('\nfunction campaignNameForJob(',start);
assert.ok(start>=0 && end>start);
const context=vm.createContext({
  resultItems:j=>j.result?.results||[],
  isSameLocalDay:value=>String(value||'').startsWith('2026-10-03')
});
vm.runInContext(html.slice(start,end),context);

test('daily counts distinguish submissions, verified posts, skipped, failed, and unreported',()=>{
  const rows=[{id:'job-1',groups:['a','b','c','d','e','f'].map(url=>({url})),result:{results:[
    {group_url:'a',status:'submitted_unconfirmed',submitted_at:'2026-10-03T12:00:00Z'},
    {group_url:'b',status:'submitted_unconfirmed',submitted_at:'2026-10-03T12:00:00Z'},
    {group_url:'c',status:'skipped'},
    {group_url:'d',status:'failed'},
    {group_url:'f',status:'submitted_unconfirmed',submitted_at:'2026-10-02T12:00:00Z'}
  ]}}];
  const monitors=[{source_job_id:'job-1',group_url:'a',status:'published'},
    {source_job_id:'job-1',group_url:'b',status:'pending_approval'}];
  const counts=context.opsDailyCounts(rows,monitors);
  assert.deepEqual(JSON.parse(JSON.stringify(counts)),{targets:6,submitted:2,verified:1,failed:1,skipped:1,unreported:2});
});
