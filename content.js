// ============ Amplr Content Script v5 ============
// Based on verified FB DOM research.
// Key insight: clicking the composer opens a [role="dialog"] modal.
// All textbox + Post button searches are scoped INSIDE that dialog.
// v5 returns post-submit evidence instead of only a boolean click result.

(() => {
  if (window.__jsw_multipost_loaded) return;
  window.__jsw_multipost_loaded = true;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function log(...args) {
    console.log('[JSW]', ...args);
  }

  function waitFor(fn, timeout = 12000, interval = 200) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = async () => {
        try {
          const result = await fn();
          if (result) return resolve(result);
        } catch (e) {}
        if (Date.now() - start > timeout)
          return reject(new Error('Timeout waiting for element'));
        setTimeout(check, interval);
      };
      check();
    });
  }

  // ============ FIND COMPOSER TRIGGER ============
  // aria-label is "What's on your mind, <Name>?" — must use substring match
  async function findTrigger() {
    log('Finding composer trigger...');
    return waitFor(() => {
      const selectors = [
        'div[role="button"][aria-label^="What\'s on your mind"]',
        'div[role="button"][aria-label*="What\'s on your mind"]',
        'div[role="button"][aria-label*="Write something"]',
        'div[role="button"][aria-label*="Write a post"]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) {
          log('Found trigger:', el.getAttribute('aria-label'));
          return el;
        }
      }
      // Fallback: href-based (deep link to composer)
      const link = document.querySelector('a[href*="/composer/?"]');
      if (link) return link;

      // Last resort: text scan in main area
      const main = document.querySelector('[role="main"]') || document.body;
      const btn = [...main.querySelectorAll('div[role="button"]')].find(b =>
        /what's on your mind|write (a post|something)/i.test(b.textContent)
      );
      return (btn && btn.offsetParent !== null) ? btn : null;
    });
  }

  // ============ FIND THE DIALOG (opens after clicking trigger) ============
  async function findDialog() {
    log('Waiting for composer dialog to open...');
    return waitFor(() => {
      // The composer modal that contains a contenteditable
      const dialogs = document.querySelectorAll('div[role="dialog"]');
      for (const d of dialogs) {
        const editable = d.querySelector('[contenteditable="true"]');
        if (editable) {
          log('Found composer dialog');
          return d;
        }
      }
      return null;
    });
  }

  // ============ FIND TEXTBOX INSIDE DIALOG ============
  function findTextboxInDialog(dialog) {
    const selectors = [
      'div[role="textbox"][contenteditable="true"]',
      '[data-testid="status-attachment-mentionsinput"] [contenteditable="true"]',
      '[contenteditable="true"][aria-label*="What\'s on your mind"]',
      '[contenteditable="true"]',
    ];
    for (const sel of selectors) {
      const el = dialog.querySelector(sel);
      if (el) {
        log('Found textbox:', el.getAttribute('aria-label') || el.getAttribute('role'));
        return el;
      }
    }
    return null;
  }

  // ============ TYPE INTO COMPOSER ============
  async function typeMessage(textbox, text) {
    log('Typing message...');
    textbox.focus();
    await sleep(200);

    // Method 1: execCommand insertText (works with FB's React contenteditable)
    document.execCommand('selectAll', false, null);
    await sleep(50);
    const ok = document.execCommand('insertText', false, text);
    await sleep(300);

    if (ok && textbox.textContent.trim().length > 0) {
      log('Typed via execCommand OK');
      return true;
    }

    // Method 2: beforeinput + input events
    log('execCommand failed, trying synthetic events...');
    textbox.focus();
    for (const type of ['beforeinput', 'input']) {
      textbox.dispatchEvent(new InputEvent(type, {
        inputType: 'insertText',
        data: text,
        bubbles: true,
        cancelable: true,
        composed: true,
      }));
    }
    await sleep(300);

    if (textbox.textContent.trim().length > 0) {
      log('Typed via InputEvent OK');
      return true;
    }

    // Method 3: set innerText + fire input (last resort)
    log('Trying innerText + events...');
    textbox.focus();
    textbox.innerText = text;
    textbox.dispatchEvent(new InputEvent('input', {
      inputType: 'insertText',
      data: text,
      bubbles: true,
      cancelable: true,
    }));
    await sleep(300);

    log('Final textContent:', textbox.textContent?.substring(0, 40));
    return textbox.textContent.trim().length > 0;
  }

  // ============ FIND POST BUTTON INSIDE DIALOG ============
  function findPostButtonInDialog(dialog) {
    // data-testid approach
    const testidSelectors = [
      '[data-testid="react-composer-post-button"]',
      '[data-testid*="composer-post"]',
      '[data-testid*="post-button"]',
    ];
    for (const sel of testidSelectors) {
      const btn = dialog.querySelector(sel);
      if (btn && btn.offsetParent !== null) return btn;
    }

    // aria-label approach
    const ariaBtns = [
      'div[role="button"][aria-label="Post"]',
      'div[role="button"][aria-label="Publish"]',
      'button[aria-label="Post"]',
    ];
    for (const sel of ariaBtns) {
      const btn = dialog.querySelector(sel);
      if (btn && btn.offsetParent !== null) return btn;
    }

    // Exact text match (scoped to dialog = won't match comment buttons)
    const allBtns = dialog.querySelectorAll('div[role="button"], button');
    for (const btn of allBtns) {
      const t = (btn.textContent || '').trim().toLowerCase();
      if ((t === 'post' || t === 'publish') && btn.offsetParent !== null) {
        log('Found Post button via text match');
        return btn;
      }
    }

    return null;
  }

  // ============ IMAGE ATTACH ============
  async function attachImage(url, dialog) {
    try {
      log('Attaching image...');
      const res = await fetch(url);
      const blob = await res.blob();
      const filename = url.split('/').pop().split('?')[0] || 'image.jpg';
      const file = new File([blob], filename, { type: blob.type || 'image/jpeg' });

      const fileInput =
        dialog.querySelector('input[type="file"][accept*="image"]') ||
        dialog.querySelector('input[type="file"]') ||
        document.querySelector('input[type="file"][accept*="image"]');

      if (fileInput) {
        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        log('Image attached, waiting for upload...');
        await sleep(4000);
      }
    } catch (e) {
      log('Image attach failed:', e.message);
    }
  }

  // ============ POST EVIDENCE ============
  function normalizeText(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function findSubmittedPostEvidence(message) {
    const wanted = normalizeText(message).slice(0, 80).toLowerCase();
    const wantedWords = wanted.split(' ').filter(w => w.length > 3).slice(0, 6);
    const articles = [...document.querySelectorAll('[role="article"], div[data-pagelet*="FeedUnit"], div[data-ad-preview="message"]')];

    for (const article of articles) {
      const articleText = normalizeText(article.textContent).toLowerCase();
      if (!articleText) continue;
      const exactish = wanted && articleText.includes(wanted.slice(0, Math.min(45, wanted.length)));
      const wordHits = wantedWords.filter(w => articleText.includes(w)).length;
      if (!exactish && wordHits < Math.min(4, wantedWords.length)) continue;

      const link = [...article.querySelectorAll('a[href]')].find(a => {
        const href = a.href || '';
        return /\/posts\/|\/permalink\/|story_fbid=|multi_permalinks=/.test(href);
      });
      return {
        found: true,
        postUrl: link ? link.href : null,
        matchedText: normalizeText(article.textContent).slice(0, 240)
      };
    }

    const permalink = [...document.querySelectorAll('a[href]')].find(a => {
      const href = a.href || '';
      return /\/posts\/|\/permalink\/|story_fbid=|multi_permalinks=/.test(href);
    });
    return {
      found: false,
      postUrl: permalink ? permalink.href : null,
      matchedText: null
    };
  }


  // ============ FACEBOOK IDENTITY SYNC / VERIFY ============
  function cleanIdentityName(text) {
    return normalizeText(text)
      .replace(/^(Switch to|Continue as|Use Facebook as)\s+/i, '')
      .replace(/\s+(profile|page)$/i, '')
      .trim();
  }

  function visible(el) {
    return !!(el && el.offsetParent !== null);
  }

  function currentIdentityName() {
    const candidates = [
      document.querySelector('[aria-label$="profile"] img[alt]')?.getAttribute('alt'),
      document.querySelector('[aria-label*="Your profile"] img[alt]')?.getAttribute('alt'),
      document.querySelector('a[aria-label*="profile"] img[alt]')?.getAttribute('alt'),
      document.querySelector('[role="banner"] img[alt]')?.getAttribute('alt')
    ].filter(Boolean).map(cleanIdentityName).filter(Boolean);
    return candidates[0] || null;
  }

  async function openIdentityMenu() {
    const selectors = [
      '[aria-label="Your profile"]',
      '[aria-label*="Your profile"]',
      '[aria-label="Account"]',
      '[aria-label*="Account"]',
      '[aria-label*="profile"]'
    ];
    for (const sel of selectors) {
      const el = [...document.querySelectorAll(sel)].find(visible);
      if (el) { el.click(); await sleep(1200); return true; }
    }
    const banner = document.querySelector('[role="banner"]') || document.body;
    const imgBtn = [...banner.querySelectorAll('div[role="button"], a[role="link"], a')].find(el => visible(el) && el.querySelector('img[alt]'));
    if (imgBtn) { imgBtn.click(); await sleep(1200); return true; }
    return false;
  }

  function scrapeIdentityMenu() {
    const found = new Map();
    const add = (name, extra={}) => {
      name = cleanIdentityName(name);
      if (!name || name.length < 2 || /^(see all|settings|help|log out|give feedback|meta verified)$/i.test(name)) return;
      const key = (extra.url || name).toLowerCase();
      if (!found.has(key)) found.set(key, {
        id: key,
        name,
        type: extra.type || (/page/i.test(extra.label || '') ? 'page' : 'facebook identity'),
        url: extra.url || null,
        avatar_url: extra.avatar_url || null,
        is_active: !!extra.is_active
      });
    };

    const menuRoots = [...document.querySelectorAll('[role="dialog"], [role="menu"], [aria-label*="Account"], body')];
    const root = menuRoots.find(r => /Switch to|Continue as|See all profiles|Your profile|Vet Inc|Empty Slot/i.test(r.textContent || '')) || document.body;

    root.querySelectorAll('[aria-label], [role="button"], a[href], span[dir="auto"]').forEach(el => {
      const label = el.getAttribute('aria-label') || el.textContent || '';
      if (!/Switch to|Continue as|Use Facebook as/i.test(label) && el.tagName !== 'A' && el.getAttribute('role') !== 'button') return;
      let name = label;
      if (!/Switch to|Continue as|Use Facebook as/i.test(label)) {
        const imgAlt = el.querySelector?.('img[alt]')?.getAttribute('alt') || el.closest?.('div')?.querySelector?.('img[alt]')?.getAttribute('alt');
        const text = normalizeText(el.textContent || '');
        name = imgAlt || text;
      }
      const img = el.querySelector?.('img[src]') || el.closest?.('div')?.querySelector?.('img[src]');
      const url = el.href || el.closest?.('a[href]')?.href || null;
      add(name, { label, url, avatar_url: img?.src || null, type: /Page|business/i.test(label) ? 'page' : undefined });
    });

    const active = currentIdentityName();
    if (active) add(active, { is_active: true });
    return [...found.values()].map(i => ({ ...i, is_active: i.name === active || i.is_active }));
  }

  async function syncFacebookIdentities() {
    log('Syncing Facebook identities...');
    const activeBefore = currentIdentityName();
    const opened = await openIdentityMenu();
    if (!opened) throw new Error('Could not open Facebook profile switcher');
    await sleep(1000);
    let identities = scrapeIdentityMenu();
    if (!identities.length && activeBefore) identities = [{ id: activeBefore.toLowerCase(), name: activeBefore, type: 'facebook identity', is_active: true }];
    if (!identities.length) throw new Error('No Facebook identities found in switcher');
    return { identities, active_identity: identities.find(i => i.is_active)?.name || activeBefore || null, pageUrl: location.href };
  }

  function identityMatches(actual, expected) {
    if (!expected) return true;
    actual = cleanIdentityName(actual || '').toLowerCase();
    expected = cleanIdentityName(expected || '').toLowerCase();
    return actual && expected && (actual === expected || actual.includes(expected) || expected.includes(actual));
  }

  async function switchToIdentity(expectedName) {
    if (!expectedName) return { switched: false, active_identity: currentIdentityName() };
    let active = currentIdentityName();
    if (identityMatches(active, expectedName)) return { switched: false, active_identity: active };

    const opened = await openIdentityMenu();
    if (!opened) throw new Error('Could not open Facebook profile switcher to change identity');
    await sleep(1000);

    const candidates = [...document.querySelectorAll('[aria-label], [role="button"], a[href], span[dir="auto"]')].filter(visible);
    const target = candidates.find(el => {
      const label = cleanIdentityName(el.getAttribute('aria-label') || el.textContent || '');
      return identityMatches(label, expectedName) && /Switch to|Continue as|Use Facebook as|.+/i.test(label);
    });
    if (!target) throw new Error(`Could not find Facebook identity "${expectedName}" in switcher`);
    target.click();
    await sleep(6000);
    active = currentIdentityName();
    if (!identityMatches(active, expectedName)) {
      // Facebook sometimes navigates after switch; reload detection from page text/menu can lag.
      log('Identity switch verification uncertain:', active, expectedName);
    }
    return { switched: true, active_identity: active || expectedName };
  }

  async function verifyComposerIdentity(expectedName) {
    if (!expectedName) return { active_identity: currentIdentityName(), verified: true };
    const main = document.querySelector('[role="main"]') || document.body;
    const text = normalizeText(main.textContent || '').slice(0, 2000);
    const profileHint = [...main.querySelectorAll('[aria-label], img[alt]')]
      .map(el => el.getAttribute('aria-label') || el.getAttribute('alt') || '')
      .find(v => identityMatches(v, expectedName));
    const active = currentIdentityName();
    const verified = identityMatches(active, expectedName) || !!profileHint || text.toLowerCase().includes(expectedName.toLowerCase());
    if (!verified) throw new Error(`Active Facebook identity is not confirmed as ${expectedName}. Current: ${active || 'unknown'}`);
    return { active_identity: active || expectedName, verified };
  }

  // ============ MAIN ============
  async function postToGroup(message, imageUrl, identityName) {
    log('=== START POST ===');

    // 0. Verify/switch Facebook posting identity before opening composer
    const identitySwitch = await switchToIdentity(identityName);
    const identityCheck = await verifyComposerIdentity(identityName);

    // 1. Find trigger
    const trigger = await findTrigger();

    // 2. Click it — opens dialog
    log('Clicking trigger...');
    trigger.click();

    // 3. Wait for dialog to appear
    const dialog = await findDialog();

    // 4. Find textbox inside dialog
    await sleep(500);
    const textbox = findTextboxInDialog(dialog);
    if (!textbox) throw new Error('No textbox found in composer dialog');

    // 5. Focus and type
    textbox.click();
    await sleep(300);
    const typed = await typeMessage(textbox, message);
    if (!typed) throw new Error('Could not type into composer');

    // 6. Attach image
    if (imageUrl) {
      await attachImage(imageUrl, dialog);
    }

    // 7. Find Post button inside dialog
    await sleep(500);
    let postBtn = findPostButtonInDialog(dialog);

    if (!postBtn) {
      log('Post button not found immediately, waiting...');
      await sleep(2000);
      postBtn = findPostButtonInDialog(dialog);
    }

    if (!postBtn) throw new Error('Post button not found in dialog');

    // 8. Wait for button to enable (aria-disabled flips to false)
    log('Waiting for Post button to enable...');
    await waitFor(() => {
      const disabled =
        postBtn.getAttribute('aria-disabled') === 'true' ||
        postBtn.disabled === true;
      return !disabled;
    }, 15000);

    // 9. Click Post
    log('Clicking Post...');
    postBtn.click();

    // 10. Wait for dialog to close / feed to refresh, then collect evidence
    await sleep(8000);
    const evidence = findSubmittedPostEvidence(message);
    log('=== POST DONE ===', evidence);
    return {
      submitted: true,
      postUrl: evidence.postUrl || null,
      evidenceFound: !!evidence.found,
      matchedText: evidence.matchedText || null,
      pageUrl: location.href,
      identityName: identityName || null,
      activeIdentity: identityCheck?.active_identity || identitySwitch?.active_identity || null
    };
  }

  // ============ MESSAGE LISTENER ============
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!['POST_TO_PAGE','SYNC_FACEBOOK_IDENTITIES','SWITCH_FACEBOOK_IDENTITY'].includes(msg.type)) return;

    if (msg.type === 'SWITCH_FACEBOOK_IDENTITY') {
      log('Received identity switch command');
      (async () => {
        try {
          const result = await switchToIdentity(msg.identityName || msg.identity_name);
          sendResponse({ success: true, ...result });
        } catch (error) {
          log('IDENTITY SWITCH ERROR:', error.message);
          sendResponse({ success: false, error: error.message });
        }
      })();
      return true;
    }

    if (msg.type === 'SYNC_FACEBOOK_IDENTITIES') {
      log('Received identity sync command');
      (async () => {
        try {
          const result = await syncFacebookIdentities();
          sendResponse({ success: true, ...result });
        } catch (error) {
          log('IDENTITY SYNC ERROR:', error.message);
          sendResponse({ success: false, error: error.message });
        }
      })();
      return true;
    }

    log('Received post command');
    (async () => {
      try {
        const result = await postToGroup(msg.message, msg.imageUrl, msg.identityName || msg.identity_name || null);
        sendResponse({ success: true, ...result });
      } catch (error) {
        log('ERROR:', error.message);
        sendResponse({ success: false, error: error.message });
      }
    })();

    return true; // keep channel open
  });

  log('Content script v6 loaded');
})();
