const assert=require('node:assert/strict');
const fs=require('node:fs');
const html=fs.readFileSync('dashboard.html','utf8');
assert.match(html,/id="prospectGroupUrls"/);
assert.match(html,/Scan Saved Groups/);
assert.match(html,/groupsForSelectedIdentity\(\)\.map\(g=>g\.group_url\)/);
assert.match(html,/groupUrls:groupUrls/);
console.log('dashboard offers saved and explicit group-feed scan targets');
