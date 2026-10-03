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
function normalizeGroupFeedUrls(values) {
  const urls = [];
  for (const raw of Array.isArray(values) ? values : []) {
    try {
      const url = new URL(String(raw).trim());
      if (url.protocol !== 'https:' || !['facebook.com', 'www.facebook.com', 'm.facebook.com'].includes(url.hostname.toLowerCase())) continue;
      const match = url.pathname.match(/^\/groups\/([a-zA-Z0-9._-]+)\/?$/);
      if (!match || match[1] === 'feed') continue;
      const canonical = `https://www.facebook.com/groups/${match[1]}/`;
      if (!urls.includes(canonical)) urls.push(canonical);
      if (urls.length === 3) break;
    } catch {}
  }
  return urls;
}
async function scanGroupFeeds(urls, api) {
  const results = [];
  for (const url of normalizeGroupFeedUrls(urls)) {
    let tab;
    try {
      tab = await api.open(url);
      await api.pause(2500);
      let result;
      const candidates = new Map();
      for (let attempt = 0; attempt < 3; attempt++) {
        result = await api.read(tab);
        if (!result?.ok && !result?.transient) break;
        for (const row of result?.candidates || []) candidates.set(key(row), row);
        if (attempt < 2) {
          if (result?.ok && api.scroll) await api.scroll(tab).catch(() => {});
          await api.pause(2500);
        }
      }
      results.push(result?.ok ? { ...result, candidates: [...candidates.values()] } : candidates.size ? { ok: true, candidates: [...candidates.values()] } : result || { ok: false, error: 'No feed response' });
    } catch (error) { results.push({ ok: false, error: error.message || 'Group feed failed' }); }
    finally { if (tab?.id) await api.close(tab).catch(() => {}); }
  }
  return results;
}
if (typeof module !== 'undefined') module.exports = { acceptDashboardRequest, buildScanSummary, normalizeGroupFeedUrls, scanGroupFeeds };
