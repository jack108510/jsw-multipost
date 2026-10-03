const assert=require('node:assert/strict');
const { isCredibleProspect, isLikelyPromotion }=require('../prospect-content.js');
assert.equal(isLikelyPromotion('We offer roofing services and free estimates. Call us to book your repair today.'),true);
assert.equal(isCredibleProspect({businessName:'Unlabeled visible post',businessUrl:'',postUrl:'',observedText:'Hi Madison, is this still available? Message sent by You'}),false);
assert.equal(isCredibleProspect({businessName:'Maple One',businessUrl:'https://www.facebook.com/groups/123/user/234',postUrl:'',observedText:'Our transport service takes passengers to nearby towns and healthcare appointments.'}),true);
assert.equal(isCredibleProspect({businessName:'Local Roofing',businessUrl:'',postUrl:'https://www.facebook.com/groups/123/posts/456',observedText:'We are available for roof repair and free estimates. Call today.'}),true);
assert.equal(isCredibleProspect({businessName:'Business',businessUrl:'',postUrl:'',observedText:'We offer services and free quotes.'}),false);
console.log('prospect evidence filter passed');
