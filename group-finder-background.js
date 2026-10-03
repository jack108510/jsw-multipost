// Dashboard-initiated, read-only scan of posts currently rendered in open group feeds.
const GROUP_PROSPECT_KEY = 'reachr_prospecting_visible_observations';
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!acceptDashboardRequest(sender?.url, msg?.type)) return;
  (async () => {
    if (typeof activeDashJobId !== 'undefined' && activeDashJobId !== null) return { ok: false, error: 'Reachr is busy with a Facebook job. Try again after it finishes.' };
    const groupUrls = normalizeGroupFeedUrls(msg.groupUrls);
    if (Array.isArray(msg.groupUrls) && msg.groupUrls.length && !groupUrls.length) return { ok: false, error: 'Use a Facebook group feed URL, not a post, search page, or another site.' };
    let results, tabCount;
    if (groupUrls.length) {
      const keepalive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 15000);
      try {
        results = await scanGroupFeeds(groupUrls, {
          open: url => chrome.tabs.create({ url, active: false }),
          read: tab => Promise.race([
            chrome.tabs.sendMessage(tab.id, { type: 'SCAN_VISIBLE_GROUP_PROMOTIONS' }).catch(() => ({ ok: false, transient: true, error: 'Feed is still loading' })),
            new Promise(resolve => setTimeout(() => resolve({ ok: false, transient: true, error: 'Feed timed out' }), 5000))
          ]),
          scroll: tab => chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.scrollBy(0, Math.max(window.innerHeight * 2, 1000)) }),
          close: tab => chrome.tabs.remove(tab.id),
          pause: ms => new Promise(resolve => setTimeout(resolve, ms))
        });
      } finally { clearInterval(keepalive); }
      tabCount = groupUrls.length;
    } else {
      const tabs = (await chrome.tabs.query({ url: ['https://*.facebook.com/groups/*', 'https://facebook.com/groups/*'] }))
        .filter(tab => tab.id && /^https:\/\/(?:[^/]+\.)?facebook\.com\/groups\/[^/]+/i.test(tab.url || '') && !/\/search\//i.test(tab.url || ''));
      if (!tabs.length) return { ok: false, error: 'Open a Facebook group feed tab first. No scan ran.' };
      results = await Promise.all(tabs.slice(0, 20).map(tab => Promise.race([
        chrome.tabs.sendMessage(tab.id, { type: 'SCAN_VISIBLE_GROUP_PROMOTIONS' }).catch(() => ({ ok: false })),
        new Promise(resolve => setTimeout(() => resolve({ ok: false }), 5000))
      ])));
      tabCount = tabs.length;
    }
    const existing = (await chrome.storage.local.get(GROUP_PROSPECT_KEY))[GROUP_PROSPECT_KEY] || [];
    const summary = buildScanSummary(existing, results, tabCount);
    if (!summary.scanned) return { ok: false, error: `Could not read any of ${tabCount} group feeds. Check Facebook login and retry.` };
    await chrome.storage.local.set({ [GROUP_PROSPECT_KEY]: summary.rows });
    return { ok: true, scanned: summary.scanned, tabCount: summary.tabCount, found: summary.found, failed: results.filter(r => !r?.ok).length,
      rows: summary.rows.slice(0, 100).map(row => ({ businessName: row.businessName, businessUrl: row.businessUrl,
        sourceGroupName: row.sourceGroupName, postUrl: row.postUrl, observedText: row.observedText,
        status: row.status, observedAt: row.observedAt })) };
  })().then(respond).catch(error => respond({ ok: false, error: error.message || 'Prospect scan failed.' }));
  return true;
});
