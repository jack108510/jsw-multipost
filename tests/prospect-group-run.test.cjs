const assert = require('node:assert/strict');
const { scanGroupFeeds } = require('../group-finder-scan.js');
(async()=>{
  const opened=[],closed=[],scans=[];
  const results=await scanGroupFeeds(['https://www.facebook.com/groups/one/','https://www.facebook.com/groups/two/'],{
    async open(url){opened.push(url);return {id:opened.length}},
    async read(tab){scans.push(tab.id);return tab.id===1 ? {ok:true,diagnostics:{containers:[1,3,2][scans.filter(x=>x===1).length-1]},candidates:[{postUrl:`https://facebook.com/posts/${scans.length}`,businessName:'Example'}]} : {ok:false,error:'login_required'}},
    async close(tab){closed.push(tab.id)},
    async pause(){}
  });
  assert.deepEqual(opened,['https://www.facebook.com/groups/one/','https://www.facebook.com/groups/two/']);
  assert.deepEqual(closed,[1,2]);
  assert.equal(results[0].candidates.length,3);
  assert.equal(results[0].diagnostics.containers,3);
  assert.equal(scans.filter(x=>x===1).length,3); // two bounded scroll/read passes
  assert.equal(results[1].ok,false);
  assert.equal(scans.filter(x=>x===2).length,1); // don't retry explicit refusal
  const cleanup=[];
  const failed=await scanGroupFeeds(['https://www.facebook.com/groups/one/'],{
    async open(){return {id:3}},async read(){throw Error('tab crashed')},async close(tab){cleanup.push(tab.id)},async pause(){}
  });
  assert.deepEqual(cleanup,[3]);assert.equal(failed[0].ok,false);
  console.log('bounded group-feed scan and cleanup passed');
})().catch(e=>{console.error(e);process.exitCode=1});
