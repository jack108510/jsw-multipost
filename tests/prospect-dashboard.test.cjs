const assert = require('node:assert/strict');
const fs = require('node:fs');
const html = fs.readFileSync('dashboard.html', 'utf8');
assert.match(html, /id="prospectScanBtn"/);
assert.match(html, /function scanVisibleProspects/);
assert.match(html, /REACHR_SCAN_PROSPECTS/);
assert.match(html, /id="prospectResults"/);
console.log('prospect dashboard wiring passed');
