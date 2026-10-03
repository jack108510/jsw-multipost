const assert=require('node:assert/strict');
const { mergePostContainers }=require('../prospect-content.js');
const real={id:1},overlay={id:2};
assert.deepEqual(mergePostContainers([overlay],[{node:real,businessName:'Maple One'},{node:overlay,businessName:'Chat'}]),[
 {node:overlay},{node:real,businessName:'Maple One'}
]);
console.log('feed fallback remains available when overlay articles exist');
