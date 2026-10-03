const assert=require('node:assert/strict');
const { isGroupFeedNode }=require('../prospect-content.js');
assert.equal(isGroupFeedNode({closest:selector=>selector.includes('main')?{}:null}),true);
assert.equal(isGroupFeedNode({closest:()=>null}),false);
console.log('scanner ignores non-feed overlays');
