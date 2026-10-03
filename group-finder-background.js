// Dashboard-initiated, read-only scan of posts currently rendered in open group feeds.
const GROUP_PROSPECT_KEY = 'reachr_prospecting_visible_observations';
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!acceptDashboardRequest(sender?.url, msg?.type)) return;
  (async () => {
    const tabs = (await chrome.tabs.query({ url: ['https://*.facebook.com/groups/*', 'https://facebook.com/groups/*'] }))
      .filter(tab => tab.id && /^https:\/\/(?:[^/]+\.)?facebook\.com\/groups\/[^/]+/i.test(tab.url || '') && !/\/search\//i.test(tab.url || ''));
    if (!tabs.length) return { ok: false, error: 'Open a Facebook group feed tab first. No scan ran.' };
    const results = await Promise.all(tabs.slice(0, 20).map(tab => Promise.race([
      chrome.tabs.sendMessage(tab.id, { type: 'SCAN_VISIBLE_GROUP_PROMOTIONS' }).catch(() => ({ ok: false })),
      new Promise(resolve => setTimeout(() => resolve({ ok: false }), 5000))
    ])));
    const existing = (await chrome.storage.local.get(GROUP_PROSPECT_KEY))[GROUP_PROSPECT_KEY] || [];
    const summary = buildScanSummary(existing, results, tabs.length);
    if (!summary.scanned) return { ok: false, error: 'Could not read any open group feeds. Check Facebook login, then refresh the feeds.' };
    await chrome.storage.local.set({ [GROUP_PROSPECT_KEY]: summary.rows });
    return { ok: true, scanned: summary.scanned, tabCount: summary.tabCount, found: summary.found,
      rows: summary.rows.slice(0, 100).map(row => ({ businessName: row.businessName, businessUrl: row.businessUrl,
        sourceGroupName: row.sourceGroupName, postUrl: row.postUrl, observedText: row.observedText,
        status: row.status, observedAt: row.observedAt })) };
  })().then(respond).catch(error => respond({ ok: false, error: error.message || 'Prospect scan failed.' }));
  return true;
});
