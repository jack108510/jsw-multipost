// Shared, read-only scan policy. No joining, messaging, or account switching.
const ALLOWED_ORIGIN = 'https://jack108510.github.io';
function acceptDashboardRequest(url, type) {
  try {
    const parsed = new URL(url);
    return parsed.origin === ALLOWED_ORIGIN && parsed.pathname === '/jsw-multipost/dashboard.html' && type === 'REACHR_SCAN_PROSPECTS';
  } catch { return false; }
}
function key(row) {
  const url = row?.postUrl || row?.businessUrl || '';
  if (url) { try { const parsed = new URL(url); return parsed.origin + parsed.pathname.replace(/\/$/, ''); } catch {} }
  return `${String(row?.businessName || '').toLowerCase()}|${String(row?.sourceGroupUrl || '').toLowerCase()}`;
}
function buildScanSummary(existing, results, tabCount) {
  const rows = new Map((Array.isArray(existing) ? existing : []).map(row => [key(row), row]));
  let scanned = 0, found = 0;
  for (const result of results) {
    if (!result?.ok) continue;
    scanned++;
    for (const row of result.candidates || []) {
      found++;
      const previous = rows.get(key(row));
      rows.set(key(row), { ...row, ...previous, lastSeenAt: new Date().toISOString() });
    }
  }
  return { scanned, tabCount, found, rows: [...rows.values()].slice(0, 1000) };
}
if (typeof module !== 'undefined') module.exports = { acceptDashboardRequest, buildScanSummary };
