// ============ Amplr Content Script v6 ============
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

  function visibleText(el) {
    return normalizeText([el?.innerText, el?.textContent, el?.getAttribute?.('aria-label')].filter(Boolean).join(' '));
  }

  function findVisibleComposerTriggerNow() {
    const selectors = [
      "div[role='button'][aria-label^=\"What's on your mind\"]",
      "div[role='button'][aria-label*=\"What's on your mind\"]",
      'div[role="button"][aria-label*="Write something"]',
      'div[role="button"][aria-label*="Write a post"]',
      'a[href*="/composer/?"]'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (visible(el)) return el;
    }
    const main = document.querySelector('[role="main"]') || document.body;
    return [...main.querySelectorAll('div[role="button"]')].find(b =>
      visible(b) && /what's on your mind|write (a post|something)/i.test(b.textContent || '')
    ) || null;
  }

  function detectGroupMembershipBlock() {
    if (!/facebook\.com\/groups\//i.test(location.href)) return null;
    const main = document.querySelector('[role="main"]') || document.body;
    const controls = [...main.querySelectorAll('div[role="button"], button, a[role="button"], a[href]')].filter(visible);
    const joinControl = controls.find(el => {
      const t = visibleText(el).toLowerCase();
      if (/\b(joined|member)\b/i.test(t)) return false;
      return /^(join|join group|request to join|answer questions|pending|cancel request)$/i.test(t)
        || /\b(join group|request to join|answer questions|membership pending|request pending)\b/i.test(t);
    });
    if (joinControl) return { reason: visibleText(joinControl) || 'join_required' };
    const pageText = normalizeText(main.innerText || main.textContent || '').toLowerCase();
    if (/you(?:'re| are) not a member|join this group to|only members can|request to join|membership pending/.test(pageText)) {
      return { reason: 'membership_required' };
    }
    return null;
  }

  function assertAcceptedGroupBeforePosting() {
    const block = detectGroupMembershipBlock();
    if (block && !findVisibleComposerTriggerNow()) {
      const err = new Error(`Skipped because this profile/Page is not accepted into the group yet (${block.reason}).`);
      err.code = 'not_group_member';
      err.group_url = location.href;
      throw err;
    }
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
      .replace(/^Search\s+/i, '')
      .replace(/\s*['’]\s*s\s+(Timeline|profile|page)$/i, '')
      .replace(/['’]\s*s$/i, '')
      .replace(/\s+(facebook identity|profile|page)$/i, '')
      .trim();
  }

  function isBadIdentityEvidence(value) {
    const raw = normalizeText(value || '');
    const cleaned = cleanIdentityName(raw);
    if (!raw || !cleaned) return true;
    if (/^\s*Search\s+/i.test(raw)) return true;
    if (/^(close composer dialog|close|composer|create post|create a public post)$/i.test(cleaned)) return true;
    return isForbiddenIdentityName(cleaned);
  }

  function visible(el) {
    return !!(el && el.offsetParent !== null);
  }

  function imageUrlFromBackground(backgroundImage) {
    const match = String(backgroundImage || '').match(/url\(["']?([^"')]+)["']?\)/i);
    return match?.[1] || null;
  }

  function bestSrcFromSet(srcset='') {
    const entries = String(srcset || '').split(',')
      .map(part => part.trim().split(/\s+/))
      .filter(parts => parts[0])
      .map(parts => ({ url: parts[0], score: parseFloat(parts[1]) || 1 }));
    entries.sort((a,b) => b.score - a.score);
    return entries[0]?.url || null;
  }

  function avatarUrlAllowed(url) {
    if (!url) return false;
    const value = String(url).trim();
    if (!value || /^(about:blank|chrome-extension:)/i.test(value)) return false;
    if (/static\.xx\.fbcdn\.net\/rsrc/i.test(value)) return false;
    if (/\/emoji\.php|\/images\/emoji|\/assets\/emoji/i.test(value)) return false;
    return /^(https?:|data:image\/)/i.test(value);
  }

  function nearbyAvatarRoots(el) {
    const roots = [];
    const add = node => { if (node && !roots.includes(node)) roots.push(node); };
    add(el);
    add(el?.closest?.('a[href], [role="button"], [role="listitem"], [role="article"]'));
    let cur = el;
    for (let i = 0; cur && i < 5; i++, cur = cur.parentElement) add(cur);
    for (const root of [...roots]) {
      add(root.previousElementSibling);
      add(root.nextElementSibling);
    }
    return roots.filter(Boolean);
  }

  function extractAvatarUrl(el) {
    const roots = nearbyAvatarRoots(el);
    const tryUrl = value => {
      if (!value) return null;
      try { value = new URL(value, location.href).href; } catch (_) {}
      return avatarUrlAllowed(value) ? value : null;
    };

    for (const root of roots) {
      const imgs = [root.matches?.('img') ? root : null, ...root.querySelectorAll?.('img') || []].filter(Boolean);
      const imageCandidates = imgs
        .map(img => {
          const alt = normalizeText(img.getAttribute?.('alt') || '');
          const cls = String(img.className || '');
          const box = img.getBoundingClientRect?.();
          const width = box?.width || img.naturalWidth || 0;
          const height = box?.height || img.naturalHeight || 0;
          const usableSize = !box || (width >= 24 && height >= 24);
          const url = tryUrl(img.currentSrc || bestSrcFromSet(img.getAttribute?.('srcset')) || img.src || img.getAttribute?.('src'));
          const iconPenalty = /emoji|icon|logo|verified|chevron|caret|sprite/i.test(`${alt} ${cls}`) ? 100000 : 0;
          const shapeBonus = Math.abs(width - height) <= Math.max(8, Math.min(width, height) * 0.35) ? 5000 : 0;
          return { url, score: (width * height) + shapeBonus - iconPenalty };
        })
        .filter(c => c.url && c.score > 0)
        .sort((a,b) => b.score - a.score)
        .map(c => c.url);
      if (imageCandidates.length) return imageCandidates[0];

      // SVG <image> elements can hold profile photos, but CSS namespace-style
      // selectors such as image[xlink\:href] throw in Chrome. Query the element
      // type only, then read href/xlink:href manually.
      const svgImages = [root.matches?.('image') ? root : null, ...root.querySelectorAll?.('image') || []].filter(Boolean);
      for (const svgImage of svgImages) {
        const href = tryUrl(svgImage?.href?.baseVal || svgImage?.getAttribute?.('href') || svgImage?.getAttribute?.('xlink:href'));
        if (href) return href;
      }

      const bgNodes = [root, ...root.querySelectorAll?.('[style*="background"], [class]') || []];
      for (const node of bgNodes) {
        const box = node.getBoundingClientRect?.();
        if (box && (box.width < 20 || box.height < 20)) continue;
        const inlineBg = tryUrl(imageUrlFromBackground(node.style?.backgroundImage || node.style?.background || ''));
        if (inlineBg) return inlineBg;
        const computedBg = tryUrl(imageUrlFromBackground(window.getComputedStyle?.(node)?.backgroundImage || ''));
        if (computedBg) return computedBg;
      }
    }
    return null;
  }

  function currentIdentityName() {
    const candidates = [];
    const push = (value) => {
      if (isBadIdentityEvidence(value)) return;
      const name = cleanIdentityName(value || '');
      if (!name || /^(profile picture|photo|your profile|active)$/i.test(name)) return;
      if (isForbiddenIdentityName(name) || /^(see your profile|view your profile|facebook identity)$/i.test(name)) return;
      candidates.push(name);
    };

    const banner = document.querySelector('[role="banner"]') || document.body;
    [
      '[aria-label="Your profile"]',
      '[aria-label*="Your profile"]',
      '[aria-label="Account Controls and Settings"]',
      '[aria-label*="Account Controls"]',
      '[aria-label="Account"]',
      '[aria-label*="Account"]'
    ].forEach(sel => {
      banner.querySelectorAll(sel).forEach(el => {
        push(el.querySelector?.('img[alt]')?.getAttribute('alt'));
        const label = el.getAttribute?.('aria-label') || '';
        if (!/Your profile|Account Controls|Account/i.test(label)) push(label);
      });
    });

    document.querySelectorAll('[role="dialog"], [role="menu"], [aria-label*="Account"]')
      .forEach(root => {
        [...root.querySelectorAll('[role="button"], a[href], div')]
          .filter(visible)
          .forEach(el => {
            const rawText = el.innerText || el.textContent || '';
            const text = normalizeText(rawText);
            if (!/See your profile|View your profile/i.test(text)) return;
            const lines = rawText.split('\n').map(cleanIdentityName).filter(Boolean);
            const name = lines.find(line => !/^(see your profile|view your profile|facebook identity)$/i.test(line));
            push(name);
            push(el.querySelector?.('img[alt]')?.getAttribute('alt'));
          });
      });

    return candidates[0] || null;
  }

  async function openIdentityMenu() {
    const banner = document.querySelector('[role="banner"]') || document.body;
    const menuLooksOpen = () => {
      const text = normalizeText(identityMenuRoot()?.innerText || identityMenuRoot()?.textContent || '');
      return /Quick switch profiles|See all profiles|See all pages|Select profile|Pages you manage|Settings & privacy|Log out/i.test(text);
    };
    const topRightVisible = (el) => {
      if (!visible(el)) return false;
      const box = el.getBoundingClientRect?.();
      return !!box && box.top < 140 && box.left > window.innerWidth * 0.45;
    };

    // Most reliable on Facebook: click the top-right account/avatar button by position.
    // Selector labels change between personal profiles and Pages, but the account
    // switcher always opens from the right side of the top nav.
    const y = 50;
    for (const offset of [24, 64, 104, 144, 184, 224]) {
      const el = document.elementFromPoint(window.innerWidth - offset, y)?.closest?.('[role="button"], a[href], button');
      if (!el || !visible(el)) continue;
      const label = normalizeText(el.getAttribute?.('aria-label') || el.innerText || el.textContent || '');
      if (/Messenger|Notifications|Facebook menu|Search|Home|Pages|Professional dashboard|Ad Center|Reels/i.test(label)) continue;
      clickLikeUser(el);
      await sleep(1200);
      if (menuLooksOpen()) return true;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(250);
    }

    const selectors = [
      '[aria-label="Account Controls and Settings"]',
      '[aria-label*="Account Controls"]',
      '[aria-label="Account"]',
      '[aria-label*="Account"]',
      '[aria-label="Your profile"]',
      '[aria-label*="Your profile"]'
    ];
    for (const sel of selectors) {
      const matches = [...banner.querySelectorAll(sel)];
      const el = matches.find(topRightVisible)
        || (/Your profile/i.test(sel) ? null : matches.find(visible));
      if (el) { clickLikeUser(el); await sleep(1200); return true; }
    }
    const imgBtn = [...banner.querySelectorAll('div[role="button"], a[role="link"], a, button')]
      .filter(topRightVisible)
      .find(el => el.querySelector('img[alt]'));
    if (imgBtn) { clickLikeUser(imgBtn); await sleep(1200); return true; }
    return false;
  }

  function isForbiddenIdentityName(name) {
    const cleaned = cleanIdentityName(name || '');
    if (!cleaned) return true;
    if (/^(quick switch profiles?|see all profiles?|see all pages?|settings(?: & privacy)?|help(?: & support)?|report a problem|give feedback|meta verified|meta business suite|display & accessibility|privacy|terms|privacy policy|advertising|ad choices|cookies|more|active|edit|manage|back to previous(?: page)?|select an option|available voices?,?\s*switch|unread chats?|chatsallhas new content.*|log out)$/i.test(cleaned)) return true;
    if (/^(?:[A-Z]\s*){1,3}$/i.test(cleaned.replace(/\./g, ''))) return true; // menu initials like "B B"
    if (/^\d+$/.test(cleaned)) return true;
    if (/^(facebook|meta|pages?|profiles?|home|watch|marketplace|groups?|notifications?|menu)$/i.test(cleaned)) return true;
    if (/\b(number of unread notifications|new notification|notifications?|unread chats?|chat history is missing|available voices)\b/i.test(cleaned)) return true;
    return false;
  }

  function identityUrlAllowed(url) {
    if (!url) return true;
    try {
      const u = new URL(url, location.href);
      if (!/facebook\.com$/i.test(u.hostname.replace(/^www\./, ''))) return false;
      return !/(\/settings|\/help|\/privacy|\/policies|\/business|\/ads|\/ad_|\/groups\/|\/marketplace|\/events)/i.test(u.pathname);
    } catch (_) { return true; }
  }

  function extractIdentityName(el, label='') {
    const rawLabel = normalizeText(label || '');
    const switchMatch = rawLabel.match(/^(?:Switch to|Continue as|Use Facebook as)\s+(.+?)(?:\s+(?:profile|page))?$/i);
    if (switchMatch) return switchMatch[1];

    const imgAlt = el.querySelector?.('img[alt]')?.getAttribute('alt') || el.closest?.('div')?.querySelector?.('img[alt]')?.getAttribute('alt') || '';
    const cleanAlt = cleanIdentityName(imgAlt);
    if (cleanAlt && !isForbiddenIdentityName(cleanAlt) && !/^(profile picture|photo)$/i.test(cleanAlt)) return cleanAlt;

    const lines = (el.innerText || el.textContent || '')
      .split('\n')
      .map(cleanIdentityName)
      .filter(Boolean)
      .filter(line => !/^facebook identity$/i.test(line))
      .filter(line => !/^https?:\/\//i.test(line))
      .filter(line => !isForbiddenIdentityName(line));
    return lines[0] || cleanIdentityName(rawLabel);
  }

  function activeIdentityFromMenu(root=document, expectedName=null) {
    root = root === document ? identityMenuRoot() : root;
    const rootText = root?.innerText || root?.textContent || '';
    if (/Quick switch profiles|See all profiles|Meta Business Suite|Settings & privacy|Log out/i.test(rootText)) {
      const expected = cleanIdentityName(expectedName || '');
      const lines = rootText.split('\n')
        .map(cleanIdentityName)
        .filter(Boolean)
        .filter(line => !/^facebook identity$/i.test(line))
        .filter(line => !/^switch to\b/i.test(line))
        .filter(line => !isForbiddenIdentityName(line));
      if (expected) {
        const firstLine = lines.find(line => !/^(quick switch profiles?|see all profiles?|meta business suite|settings|privacy|help|log out)$/i.test(line));
        if (identityMatches(firstLine, expected)) return expected;
        const compactRoot = cleanIdentityName(rootText).replace(/\s+/g, '').toLowerCase();
        const compactExpected = expected.replace(/\s+/g, '').toLowerCase();
        if (compactRoot.startsWith(compactExpected) || compactRoot.startsWith('facebook'+compactExpected) || compactRoot.startsWith('yourprofile'+compactExpected)) return expected;
      }
      const first = lines.find(line => !/^(quick switch profiles?|see all profiles?|meta business suite|settings|privacy|help|log out)$/i.test(line));
      if (first) return first;
    }

    const rows = [...root.querySelectorAll('[role="button"], a[href], div')].filter(visible);
    for (const el of rows) {
      const rawText = el.innerText || el.textContent || '';
      const text = normalizeText(rawText);
      const isProfileRow = /See your profile|View your profile/i.test(text);
      const isActiveRow = /(?:^|\s)Active(?:\s|$)/i.test(text);
      if (!isProfileRow && !isActiveRow) continue;
      const lines = rawText.split('\n')
        .map(cleanIdentityName)
        .filter(Boolean)
        .filter(line => !/^facebook identity$/i.test(line))
        .filter(line => !/^(see your profile|view your profile)$/i.test(line))
        .filter(line => !isForbiddenIdentityName(line));
      const name = lines.find(line => !/active/i.test(line)) || cleanIdentityName(el.querySelector?.('img[alt]')?.getAttribute('alt') || '');
      if (name && !isForbiddenIdentityName(name)) return name;
    }
    return null;
  }

  function identityMenuRoot() {
    const menuTextRe = /Switch to|Continue as|See all profiles|See all pages|Pages you manage|Select profile|Your Pages|See your profile|View your profile|Quick switch profiles|Meta Business Suite|Settings & privacy|Log out/i;
    const textOf = el => normalizeText(el?.innerText || el?.textContent || el?.getAttribute?.('aria-label') || '');
    const goodBox = el => {
      const b = el?.getBoundingClientRect?.();
      return !!b && b.width >= 240 && b.width <= 620 && b.height >= 80 && b.height <= Math.max(950, window.innerHeight);
    };

    // Facebook's account switcher is often a plain floating div, not a dialog/menu.
    // Find the text node/row for Quick switch / See all, then climb to the smallest
    // visible ancestor that contains the account-menu footer/settings rows.
    const anchors = [...document.querySelectorAll('[role="button"], [aria-label], div, span')]
      .filter(visible)
      .filter(el => /Quick switch profiles|See all profiles|See all pages|Pages you manage|Select profile|Settings & privacy|Log out/i.test(textOf(el)));
    for (const anchor of anchors) {
      let node = anchor;
      let best = null;
      for (let i = 0; node && i < 10; i++, node = node.parentElement) {
        const text = textOf(node);
        if (menuTextRe.test(text) && /Settings & privacy|Log out|Meta Business Suite|Select profile|Pages you manage|See all pages/i.test(text) && goodBox(node)) best = node;
      }
      if (best) return best;
    }

    const roots = [...document.querySelectorAll('[role="dialog"], [role="menu"], [aria-label*="Account"]')].filter(visible);
    return roots.find(r => menuTextRe.test(textOf(r))) || document.body;
  }

  function clickLikeUser(el) {
    const target = el?.closest?.('[role="button"], a[href], button') || el;
    if (!target) return false;
    try { target.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
    try { target.focus?.(); } catch (_) {}
    try { HTMLElement.prototype.click.call(target); } catch (_) { try { target.click?.(); } catch (__) {} }
    ['pointerdown','mousedown','mouseup','click'].forEach(type => {
      const Ctor = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
      target.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window, pointerType: 'mouse', button: 0 }));
    });
    ['Enter', ' '].forEach(key => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, code: key === ' ' ? 'Space' : 'Enter', bubbles: true, cancelable: true }));
      target.dispatchEvent(new KeyboardEvent('keyup', { key, code: key === ' ' ? 'Space' : 'Enter', bubbles: true, cancelable: true }));
    });
    return true;
  }

  function findSeeAllIdentitiesButton(root=identityMenuRoot(), kind='any') {
    const wantsProfiles = kind === 'profiles';
    const wantsPages = kind === 'pages';
    return [...root.querySelectorAll('[role="button"], a[href], [aria-label]')]
      .filter(visible)
      .find(el => {
        const label = el.getAttribute('aria-label') || '';
        const text = normalizeText(el.innerText || el.textContent || '');
        const cleanedLabel = cleanIdentityName(label);
        const cleanedText = cleanIdentityName(text);
        if (wantsProfiles) return /^See all profiles\b/i.test(cleanedLabel) || /^See all profiles\b/i.test(cleanedText);
        if (wantsPages) return /^See all pages\b/i.test(cleanedLabel) || /^See all pages\b/i.test(cleanedText);
        return /^(See all profiles|See all pages)\b/i.test(cleanedLabel) || /^(See all profiles|See all pages)\b/i.test(cleanedText);
      }) || null;
  }

  async function expandAllIdentitiesIfPresent(maxClicks=2) {
    let clicked = false;
    for (let i = 0; i < maxClicks; i++) {
      const button = findSeeAllIdentitiesButton();
      if (!button) break;
      log('Expanding identity switcher:', normalizeText(button.innerText || button.textContent || button.getAttribute('aria-label') || 'see all'));
      clickLikeUser(button);
      clicked = true;
      await sleep(2200);
    }
    return clicked;
  }

  async function clickSeeAllButton(kind) {
    const button = findSeeAllIdentitiesButton(identityMenuRoot(), kind);
    if (!button) return false;
    log('Clicking Facebook identity switcher button:', normalizeText(button.innerText || button.textContent || button.getAttribute('aria-label') || kind));
    clickLikeUser(button);
    await sleep(kind === 'pages' ? 3000 : 1800);
    return true;
  }

  function mergeIdentityLists(...lists) {
    const merged = new Map();
    for (const list of lists) {
      for (const identity of (Array.isArray(list) ? list : [])) {
        const name = cleanIdentityName(identity?.name || '');
        if (!name || isForbiddenIdentityName(name)) continue;
        const key = name.toLowerCase();
        const prev = merged.get(key) || {};
        merged.set(key, {
          ...prev,
          ...identity,
          id: prev.id || identity.id || key,
          name,
          url: identity.url || prev.url || null,
          avatar_url: identity.avatar_url || identity.picture_url || identity.profile_picture_url || identity.photo_url || identity.image_url || prev.avatar_url || prev.picture_url || prev.profile_picture_url || prev.photo_url || prev.image_url || null,
          is_active: !!(prev.is_active || identity.is_active)
        });
      }
    }
    return [...merged.values()];
  }

  function findIdentityTarget(expectedName) {
    const expected = cleanIdentityName(expectedName || '').toLowerCase();
    const root = identityMenuRoot();
    const rows = [];
    const seen = new Set();
    [...root.querySelectorAll('[role="button"], a[href], button, [aria-label]')]
      .filter(visible)
      .forEach(el => {
        const row = el.closest?.('[role="button"], a[href]') || el;
        if (!row || seen.has(row)) return;
        seen.add(row);
        rows.push(row);
      });
    return rows.find(row => {
      const label = cleanIdentityName(row.getAttribute?.('aria-label') || '');
      const rawText = row.innerText || row.textContent || '';
      const text = normalizeText(rawText);
      if (!text && !label) return false;
      if (/^\s*Search\s+/i.test(text) || /^\s*Search\s+/i.test(row.getAttribute?.('aria-label') || '')) return false;
      if (text.length > 240 || /Meta Business Suite|Settings & privacy|Help & support|Report a problem|Display & accessibility|Log out/i.test(text)) return false;
      const lines = rawText.split('\n').map(cleanIdentityName).filter(Boolean).filter(line => !isForbiddenIdentityName(line));
      const names = [label, ...lines].filter(Boolean);
      return names.some(name => {
        const n = cleanIdentityName(name).toLowerCase();
        return n === expected || n === `${expected}'s` || n === `${expected} 's` || /^Switch to /i.test(name) && identityMatches(name, expectedName);
      });
    }) || null;
  }

  function identitySwitcherDebugSummary() {
    const root = identityMenuRoot();
    const rowEls = [...root.querySelectorAll('[role="button"], a[href], [aria-label]')]
      .filter(visible);
    const rows = rowEls
      .map(el => normalizeText(el.getAttribute('aria-label') || el.innerText || el.textContent || ''))
      .filter(Boolean)
      .filter(text => !/^\s*$/.test(text))
      .slice(0, 30);
    const scraped = scrapeIdentityMenu().map(i => i.name).filter(Boolean).slice(0, 20);
    const seeAllEls = rowEls.filter(el => /see all|pages?|profiles?/i.test(normalizeText(el.getAttribute('aria-label') || el.innerText || el.textContent || ''))).slice(0, 10);
    const seeAll = seeAllEls.map(el => {
      const clickable = el.closest?.('[role="button"], a[href], button') || el;
      const text = normalizeText(el.getAttribute('aria-label') || el.innerText || el.textContent || '');
      const role = clickable.getAttribute?.('role') || clickable.tagName;
      const href = clickable.href || clickable.getAttribute?.('href') || '';
      const aria = clickable.getAttribute?.('aria-label') || '';
      const rect = clickable.getBoundingClientRect?.();
      return `${text} [${role}${href ? ' href=' + href : ''}${aria ? ' aria=' + aria : ''}${rect ? ' rect=' + Math.round(rect.width) + 'x' + Math.round(rect.height) : ''}]`;
    });
    return `Switcher visible rows: ${rows.join(' | ') || 'none'}; scraped identities: ${scraped.join(', ') || 'none'}; see-all/page rows: ${seeAll.join(' | ') || 'none'}`;
  }

  function scrapeIdentityMenu() {
    const found = new Map();
    const add = (name, extra={}) => {
      name = cleanIdentityName(name);
      if (!name || name.length < 2 || isForbiddenIdentityName(name)) return;
      if (/https?:\/\//i.test(name)) return;
      if (!identityUrlAllowed(extra.url)) return;
      const key = name.toLowerCase();
      if (!found.has(key)) found.set(key, {
        id: key,
        name,
        type: extra.type || (/page|business/i.test(extra.label || '') ? 'page' : 'facebook identity'),
        url: extra.url || null,
        avatar_url: extra.avatar_url || null,
        is_active: !!extra.is_active
      });
    };

    const root = identityMenuRoot();
    const candidates = [...root.querySelectorAll('[role="button"], a[href], [aria-label], div')].filter(visible);

    for (const el of candidates) {
      const label = el.getAttribute('aria-label') || '';
      const rawText = el.innerText || el.textContent || '';
      const text = normalizeText(rawText);
      const combined = normalizeText(`${label} ${text}`);
      if (/^See all profiles$/i.test(cleanIdentityName(combined))) continue;
      if (isForbiddenIdentityName(combined) || /quick switch profiles/i.test(combined)) continue;

      const name = extractIdentityName(el, label || rawText);
      if (!name || isForbiddenIdentityName(name)) continue;
      const hasSwitcherVerb = /Switch to|Continue as|Use Facebook as/i.test(combined);
      const avatarUrl = extractAvatarUrl(el);
      const hasAvatar = !!avatarUrl;
      const hasIdentityText = /facebook identity|profile|page|active|switch to|continue as|use facebook as/i.test(combined);
      const looksLikeIdentityRow = hasSwitcherVerb || hasIdentityText || (hasAvatar && /profile\.php\?id=\d+|\/pages\//i.test(el.href || el.closest?.('a[href]')?.href || ''));
      if (!looksLikeIdentityRow) continue;

      const url = el.href || el.closest?.('a[href]')?.href || null;
      add(name, { label: combined, url, avatar_url: avatarUrl, type: /page|business/i.test(combined) ? 'page' : undefined });
    }

    const active = activeIdentityFromMenu(root) || currentIdentityName();
    if (active) add(active, { is_active: true, label: 'active profile' });
    return [...found.values()].map(i => ({ ...i, is_active: i.name === active || i.is_active }));
  }


  function scrapeManagedPages(root=document) {
    const found = new Map();
    const pageUrl = location.href;
    const add = (name, extra={}) => {
      name = cleanIdentityName(name);
      name = name.replace(/^Profile picture for\s+/i, '').trim();
      if (!name || name.length < 2 || isForbiddenIdentityName(name)) return;
      if (/^(pages?|your pages?|followed pages?|discover|inbox|insights|notifications?|messages?|switch now|meta business suite|edit notification settings|click to expand)$/i.test(name)) return;
      if (/^\d+\s+notifications?$/i.test(name)) return;
      if (/^Pages\s+.+\s+manages$/i.test(name)) return;
      if (/https?:\/\//i.test(name)) return;
      const key = name.toLowerCase();
      const prev = found.get(key) || {};
      found.set(key, {
        ...prev,
        id: prev.id || extra.id || key,
        name,
        type: 'page',
        url: extra.url || prev.url || null,
        avatar_url: extra.avatar_url || prev.avatar_url || null,
        is_active: !!(prev.is_active || extra.is_active),
        source: 'pages_manager'
      });
    };

    const title = normalizeText(root.querySelector?.('[role="main"]')?.textContent || root.body?.textContent || '');
    const looksLikePagesManager = /Pages .* manages|Your Pages|category=your_pages|Switch Now/i.test(`${title} ${pageUrl}`);
    if (!looksLikePagesManager) return [];

    const main = root.querySelector?.('[role="main"]') || root.body || root;

    // Primary path: the main list cards read like:
    // Page Name \n N Notifications \n Messages \n Switch Now
    for (const card of [...main.querySelectorAll('[role="article"], [role="listitem"], div')].filter(visible)) {
      const raw = card.innerText || card.textContent || '';
      const text = normalizeText(raw);
      const switchCount = (text.match(/\bSwitch Now\b/gi) || []).length;
      if (switchCount !== 1) continue;
      if (!/\b(Messages|Notifications?|Switch Now)\b/i.test(text)) continue;
      const lines = raw.split('\n').map(cleanIdentityName).filter(Boolean)
        .filter(line => !/^(messages?|notifications?|switch now|edit notification settings|click to expand)$/i.test(line))
        .filter(line => !/^\d+\s+notifications?$/i.test(line))
        .filter(line => !/^Pages\s+.+\s+manages$/i.test(line))
        .filter(line => !/^Profile picture for\s+/i.test(line))
        .filter(line => !isForbiddenIdentityName(line));
      const name = lines[0];
      if (!name) continue;
      const url = card.querySelector?.('a[href*="/profile.php"], a[href*="facebook.com/profile.php"]')?.href || null;
      add(name, { url, avatar_url: extractAvatarUrl(card) });
    }

    // Secondary path: real Page links from the Pages manager. Avoid buttons,
    // notifications, headings, and image alt text as identities.
    for (const a of [...root.querySelectorAll('a[href*="/profile.php"], a[href*="facebook.com/profile.php"]')].filter(visible)) {
      const href = a.href || '';
      if (!/profile\.php\?id=\d+/i.test(href)) continue;
      const raw = a.innerText || a.textContent || '';
      const imgAlt = a.querySelector?.('img[alt]')?.getAttribute('alt') || '';
      const label = a.getAttribute('aria-label') || '';
      const candidates = [raw, label, imgAlt.replace(/^Profile picture for\s+/i, '')]
        .flatMap(v => String(v || '').split('\n'))
        .map(cleanIdentityName)
        .filter(Boolean)
        .filter(line => !/^(messages?|notifications?|switch now|edit notification settings|click to expand)$/i.test(line))
        .filter(line => !/^\d+\s+notifications?$/i.test(line))
        .filter(line => !/^Pages\s+.+\s+manages$/i.test(line))
        .filter(line => !/^Profile picture for\s+/i.test(line))
        .filter(line => !isForbiddenIdentityName(line));
      const name = candidates[0];
      if (!name) continue;
      add(name, { url: href, avatar_url: extractAvatarUrl(a) });
    }

    return [...found.values()];
  }

  async function switchManagedPageFromPagesManager(expectedName) {
    if (!expectedName) throw new Error('Managed Page name is required');
    const bodySample = () => normalizeText(document.body?.innerText || document.body?.textContent || '').slice(0, 1600);
    const findCard = () => {
      const main = document.querySelector('[role="main"]') || document.body || document;
      const cards = [...main.querySelectorAll('[role="article"], [role="listitem"], div')].filter(visible);
      for (const card of cards) {
        const text = normalizeText(card.innerText || card.textContent || '');
        if (!/\bSwitch Now\b/i.test(text)) continue;
        const lines = (card.innerText || card.textContent || '').split('\n').map(cleanIdentityName).filter(Boolean);
        const hasPageName = lines.some(line => identityMatches(line, expectedName)) || identityMatches(text, expectedName);
        if (!hasPageName) continue;
        const switchButton = [...card.querySelectorAll('[role="button"], button, a[href], [aria-label]')]
          .filter(visible)
          .find(el => /^Switch Now$/i.test(cleanIdentityName(el.innerText || el.textContent || el.getAttribute('aria-label') || '')))
          || [...card.querySelectorAll('[role="button"], button, a[href], [aria-label]')]
            .filter(visible)
            .find(el => /\bSwitch Now\b/i.test(normalizeText(el.innerText || el.textContent || el.getAttribute('aria-label') || '')));
        if (switchButton) return { card, switchButton, text: text.slice(0, 500) };
      }
      return null;
    };

    for (let pass = 0; pass < 5; pass++) {
      const hit = findCard();
      if (hit) {
        clickLikeUser(hit.switchButton);
        await sleep(9000);
        let active = currentIdentityName();
        if (!identityMatches(active, expectedName)) {
          const opened = await openIdentityMenu();
          if (opened) {
            await sleep(1000);
            active = activeIdentityFromMenu(document, expectedName) || active;
          }
        }
        if (!identityMatches(active, expectedName)) {
          throw new Error(`Clicked Switch Now for ${expectedName}, but active identity did not verify. Active: ${active || 'unknown'}.`);
        }
        return {
          switched: true,
          active_identity: active || expectedName,
          page_url: location.href,
          matched_card_text: hit.text,
          body_sample: bodySample()
        };
      }
      window.scrollBy(0, window.innerHeight * 1.5);
      await sleep(1200);
    }
    throw new Error(`Could not find Switch Now card for ${expectedName} on Pages manager. ${bodySample()}`);
  }

  async function switchViaVerifiedFacebookIdentityPath(expectedName) {
    // Verified manual Facebook path:
    // profile/avatar menu -> See all profiles -> Select profile -> target OR See all Pages -> Pages you manage -> target.
    if (!expectedName) throw new Error('Facebook identity name is required');

    const clickAndVerifyTarget = async (target, source) => {
      if (!target) return null;
      const before = currentIdentityName();
      const text = normalizeText(target.innerText || target.textContent || target.getAttribute?.('aria-label') || '').slice(0, 500);
      log(`Selecting Facebook identity from ${source}:`, text || expectedName);
      clickLikeUser(target);
      await sleep(8000);
      let active = currentIdentityName();
      if (!identityMatches(active, expectedName)) {
        const reopened = await openIdentityMenu();
        if (reopened) {
          await sleep(1000);
          active = activeIdentityFromMenu(document, expectedName) || active;
        }
      }
      if (!identityMatches(active, expectedName)) {
        throw new Error(`Clicked ${expectedName} from ${source}, but active identity did not verify. Before: ${before || 'unknown'}; active: ${active || 'unknown'}.`);
      }
      return { switched: true, active_identity: active || expectedName, switched_via_verified_profile_path: source };
    };

    const opened = await openIdentityMenu();
    if (!opened) throw new Error('Could not open Facebook profile/avatar menu');
    await sleep(900);

    // Step 1: open Select profile.
    await clickSeeAllButton('profiles');
    await sleep(500);

    // Step 2: if the target is directly visible in Select profile, select it.
    let target = findIdentityTarget(expectedName);
    if (target) return await clickAndVerifyTarget(target, 'select_profile');

    // Step 3: otherwise open See all Pages and select from Pages you manage.
    const openedPages = await clickSeeAllButton('pages');
    if (!openedPages) {
      throw new Error(`Could not find ${expectedName}; Select profile did not expose the target or a See all Pages button. ${identitySwitcherDebugSummary()}`);
    }
    await sleep(1200);

    target = findIdentityTarget(expectedName);
    if (target) return await clickAndVerifyTarget(target, 'pages_you_manage');

    // Some Pages manager layouts expose cards with an explicit Switch Now button.
    try {
      const managed = await switchManagedPageFromPagesManager(expectedName);
      return { ...managed, switched_via_verified_profile_path: 'pages_you_manage_switch_now' };
    } catch (managedError) {
      throw new Error(`Could not find Facebook Page "${expectedName}" after See all Pages. ${managedError.message}`);
    }
  }

  async function syncFacebookIdentities() {
    log('Syncing Facebook identities...');
    const activeBefore = currentIdentityName();
    const opened = await openIdentityMenu();
    if (!opened) throw new Error('Could not open Facebook profile switcher');
    await sleep(1000);
    const activeAfterOpen = activeIdentityFromMenu() || currentIdentityName() || activeBefore;
    const quickIdentities = scrapeIdentityMenu();
    const expanded = await expandAllIdentitiesIfPresent();
    if (expanded) await sleep(800);
    let identities = mergeIdentityLists(quickIdentities, expanded ? scrapeIdentityMenu() : []);
    if (activeAfterOpen && !identities.some(i => identityMatches(i.name, activeAfterOpen))) identities.unshift({ id: activeAfterOpen.toLowerCase(), name: activeAfterOpen, type: 'facebook identity', is_active: true });
    if (!identities.length && activeAfterOpen) identities = [{ id: activeAfterOpen.toLowerCase(), name: activeAfterOpen, type: 'facebook identity', is_active: true }];
    if (!identities.length) throw new Error('No Facebook identities found in switcher');
    return { identities, active_identity: identities.find(i => i.is_active)?.name || activeAfterOpen || activeBefore || null, expanded_profiles: expanded, pageUrl: location.href };
  }

  function detectFacebookDefenseSignal() {
    const text = normalizeText(document.body?.innerText || document.body?.textContent || '').toLowerCase();
    const patterns = [
      'temporarily blocked',
      'action blocked',
      'try again later',
      'we limit how often',
      'confirm your identity',
      'checkpoint',
      'security check',
      'unusual activity',
      'account restricted'
    ];
    const hit = patterns.find(p => text.includes(p));
    if (!hit) return null;
    const err = new Error(`Facebook defense signal detected: ${hit}`);
    err.code = 'facebook_defense';
    return err;
  }

  function assertNoFacebookDefenseSignal() {
    const err = detectFacebookDefenseSignal();
    if (err) throw err;
  }

  function identityMatches(actual, expected) {
    if (!expected) return true;
    actual = cleanIdentityName(actual || '').toLowerCase();
    expected = cleanIdentityName(expected || '').toLowerCase();
    if (!actual || !expected) return false;
    if (actual === expected) return true;
    const strip = value => value
      .replace(/\s*['’]\s*s\s+(Timeline|profile|page)$/i, '')
      .replace(/\s+(facebook identity|profile|page)$/i, '')
      .replace(/['’]s$/i, '')
      .trim();
    return strip(actual) === strip(expected);
  }

  async function locateIdentitySwitchTarget(expectedName, force=false) {
    if (!expectedName) return { found: false, active_identity: currentIdentityName(), error: 'missing expected identity' };
    let active = currentIdentityName();
    if (!force && identityMatches(active, expectedName)) return { found: true, already_active: true, active_identity: active, pageUrl: location.href };
    const opened = await openIdentityMenu();
    if (!opened) return { found: false, active_identity: active || null, error: 'Could not open Facebook profile switcher', pageUrl: location.href };
    await sleep(1000);
    let target = findIdentityTarget(expectedName);
    if (!target) {
      const expanded = await expandAllIdentitiesIfPresent();
      if (expanded) {
        await sleep(800);
        target = findIdentityTarget(expectedName);
      }
    }
    if (!target) return { found: false, active_identity: activeIdentityFromMenu() || active || null, error: `Could not find Facebook identity ${expectedName}`, debug: identitySwitcherDebugSummary(), pageUrl: location.href };
    const clickable = target.closest?.('[role="button"], a[href], button') || target;
    try { clickable.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
    const box = clickable.getBoundingClientRect();
    return { found: true, already_active: false, active_identity: activeIdentityFromMenu() || active || null, text: normalizeText(clickable.innerText || clickable.textContent || clickable.getAttribute('aria-label') || target.innerText || target.textContent || '').slice(0, 500), x: box.left + box.width / 2, y: box.top + box.height / 2, pageUrl: location.href };
  }

  async function switchToIdentity(expectedName, identityUrl=null) {
    if (!expectedName) return { switched: false, active_identity: currentIdentityName() };
    let active = currentIdentityName();
    if (identityMatches(active, expectedName)) return { switched: false, active_identity: active };

    const tryDirectPageUrl = async (reason='') => {
      if (!identityUrl || !/^https:\/\/(www\.)?facebook\.com\/profile\.php\?id=\d+/i.test(identityUrl)) return null;
      const targetId = String(identityUrl).match(/profile\.php\?id=(\d+)/i)?.[1] || null;
      const currentId = String(location.href).match(/profile\.php\?id=(\d+)/i)?.[1] || null;
      if (!targetId || currentId !== targetId) {
        log('Direct Page URL requires background navigation first:', identityUrl, reason);
        return null;
      }
      log('Trying direct Facebook Page profile switch button on current URL:', identityUrl, reason);
      await sleep(1500);
      const clickPageSwitchButton = async () => {
        const expected = cleanIdentityName(expectedName || '').toLowerCase();
        const candidates = [...document.querySelectorAll('[role="button"], a[href], button')]
          .filter(visible)
          .map(el => {
            let root = el;
            for (let i = 0; root?.parentElement && i < 5; i++) root = root.parentElement;
            return { el, text: normalizeText(el.innerText || el.textContent || el.getAttribute('aria-label') || ''), context: normalizeText(root?.innerText || root?.textContent || '') };
          })
          .filter(item => /\bSwitch\b/i.test(item.text));
        const target = candidates.find(item => {
          const text = item.text.toLowerCase();
          return text.includes(expected) && /switch into|switch to|continue as|use facebook as/i.test(item.text);
        }) || candidates.find(item => /^(switch|switch now)$/i.test(item.text) && item.context.toLowerCase().includes(expected) && /switch into|switch to|continue as|use facebook as/i.test(item.context)) || null;
        if (!target) return false;
        log('Clicking Page profile switch button:', target.text);
        clickLikeUser(target.el);
        await sleep(7000);
        return true;
      };
      active = currentIdentityName();
      if (!identityMatches(active, expectedName) && /Switch into .*Page to take more actions|Switch/i.test(document.body?.innerText || '')) {
        const clicked = await clickPageSwitchButton();
        active = currentIdentityName();
        if (clicked && !identityMatches(active, expectedName)) {
          log('Page profile switch button clicked, but active identity did not verify:', active || 'unknown');
        }
      }
      if (identityMatches(active, expectedName)) {
        return { switched: true, active_identity: active || expectedName, direct_url_fallback: false, switched_via_page_profile_button: true, page_url: location.href };
      }
      return null;
    };

    const opened = await openIdentityMenu();
    if (!opened) throw new Error('Could not open Facebook profile switcher to change identity');
    await sleep(1000);

    let target = findIdentityTarget(expectedName);
    if (!target) {
      const expanded = await expandAllIdentitiesIfPresent();
      if (expanded) {
        await sleep(800);
        target = findIdentityTarget(expectedName);
      }
    }
    if (!target) {
      const direct = await tryDirectPageUrl('switcher target not found');
      if (direct) return direct;
      try {
        return await switchViaVerifiedFacebookIdentityPath(expectedName);
      } catch (pathError) {
        throw new Error(`Could not find Facebook identity "${expectedName}" in switcher or verified See all profiles/pages path. ${pathError.message}. ${identitySwitcherDebugSummary()}`);
      }
    }
    clickLikeUser(target);
    await sleep(6000);
    active = currentIdentityName();
    if (!identityMatches(active, expectedName)) {
      const reopened = await openIdentityMenu();
      if (reopened) {
        await sleep(1000);
        active = activeIdentityFromMenu() || active;
      }
    }
    if (!identityMatches(active, expectedName)) {
      const direct = await tryDirectPageUrl('switcher click did not verify active identity');
      if (direct) return direct;
      throw new Error(`Facebook identity switch did not verify as "${expectedName}". Active identity: ${active || 'unknown'}. ${identitySwitcherDebugSummary()}`);
    }
    return { switched: true, active_identity: active || expectedName };
  }

  function extractComposerIdentity(dialog) {
    if (!dialog) return null;
    const values = [];
    const push = (value) => {
      if (isBadIdentityEvidence(value)) return;
      const cleaned = cleanIdentityName(value || '');
      if (!cleaned || isForbiddenIdentityName(cleaned)) return;
      if (/\b(post|publish|create a public post|write something|what's on your mind|add to your post|audience|public|group|more options)\b/i.test(cleaned)) return;
      values.push(cleaned);
    };

    // Facebook group composer usually exposes the active identity near the top of the modal
    // as text plus avatar alt/ARIA labels. Read only the dialog, never the wider feed.
    [...dialog.querySelectorAll('[aria-label], img[alt], span[dir="auto"], strong, h2, h3')]
      .filter(visible)
      .slice(0, 80)
      .forEach(el => {
        push(el.getAttribute?.('aria-label'));
        push(el.getAttribute?.('alt'));
        push(el.innerText || el.textContent);
      });

    const raw = dialog.innerText || dialog.textContent || '';
    raw.split('\n').map(cleanIdentityName).filter(Boolean).slice(0, 20).forEach(push);
    return values[0] || null;
  }

  function verifyComposerIdentity(dialog, expectedName) {
    const active = currentIdentityName();
    const composerIdentity = extractComposerIdentity(dialog);
    if (!expectedName) {
      const err = new Error('Posting identity is required; refusing to post from the current Facebook account by default.');
      err.code = 'identity_required';
      err.identity_active = active || null;
      err.composer_identity = composerIdentity || null;
      throw err;
    }

    // Hard safety gate: require a direct composer-level identity value to match.
    // Do NOT pass just because the expected company name appears somewhere in
    // dialog text; group rules, previews, or pasted content can contain that name.
    const verified = identityMatches(composerIdentity, expectedName);

    if (!verified) {
      const err = new Error(`Composer identity is not confirmed as ${expectedName}. Active: ${active || 'unknown'}; composer: ${composerIdentity || 'unknown'}`);
      err.code = 'identity_not_verified';
      err.identity_expected = expectedName;
      err.identity_active = active || null;
      err.composer_identity = composerIdentity || null;
      throw err;
    }

    return {
      active_identity: active || composerIdentity || expectedName,
      composer_identity: composerIdentity,
      verified: true
    };
  }

  function composerIdentitySwitcherCandidates(dialog) {
    if (!dialog) return [];
    const top = dialog.getBoundingClientRect?.();
    const rows = [...dialog.querySelectorAll('[role="button"], button, a[href], [aria-haspopup], [aria-label]')]
      .filter(visible)
      .map(el => {
        const box = el.getBoundingClientRect?.();
        const text = normalizeText(el.innerText || el.textContent || el.getAttribute?.('aria-label') || '');
        const topBias = top && box ? Math.max(0, 260 - Math.abs(box.top - top.top)) : 0;
        const hasIdentity = !isBadIdentityEvidence(text) && !/post|publish|add to your post|audience|public|group|more options/i.test(text);
        const hasAvatar = !!el.querySelector?.('img[alt]');
        const looksDropdown = /switch|profile|page|identity|posting as|act as|use facebook as/i.test(text)
          || el.getAttribute?.('aria-haspopup')
          || hasAvatar;
        return { el, text, score: (looksDropdown ? 1000 : 0) + (hasIdentity ? 500 : 0) + (hasAvatar ? 250 : 0) + topBias };
      })
      .filter(item => item.score >= 900)
      .sort((a,b) => b.score - a.score);
    const seen = new Set();
    return rows.map(item => item.el.closest?.('[role="button"], button, a[href]') || item.el).filter(el => {
      if (!el || seen.has(el)) return false;
      seen.add(el);
      return true;
    }).slice(0, 8);
  }

  function findComposerIdentityOption(expectedName) {
    const roots = [
      ...document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"], [aria-label*="profile" i], [aria-label*="Page" i]')
    ].filter(visible);
    roots.push(document.body);
    const seen = new Set();
    for (const root of roots) {
      const candidates = [...root.querySelectorAll('[role="option"], [role="menuitem"], [role="button"], button, a[href], [aria-label]')]
        .filter(visible);
      for (const el of candidates) {
        const row = el.closest?.('[role="option"], [role="menuitem"], [role="button"], a[href], button') || el;
        if (!row || seen.has(row)) continue;
        seen.add(row);
        const raw = normalizeText(row.innerText || row.textContent || row.getAttribute?.('aria-label') || '');
        if (!raw || raw.length > 500) continue;
        const lines = raw.split(/\n| {2,}/).map(cleanIdentityName).filter(Boolean);
        const names = [cleanIdentityName(row.getAttribute?.('aria-label') || ''), ...lines]
          .filter(Boolean)
          .filter(name => !isForbiddenIdentityName(name));
        if (names.some(name => identityMatches(name, expectedName)) || identityMatches(raw, expectedName)) return row;
      }
    }
    return null;
  }

  async function switchComposerIdentityInDialog(dialog, expectedName) {
    if (!dialog || !expectedName) return false;
    const before = extractComposerIdentity(dialog);
    if (identityMatches(before, expectedName)) return true;

    for (const candidate of composerIdentitySwitcherCandidates(dialog)) {
      const label = normalizeText(candidate.innerText || candidate.textContent || candidate.getAttribute?.('aria-label') || '');
      log('Trying composer actor switcher:', label.slice(0, 120));
      clickLikeUser(candidate);
      await sleep(1200);
      const option = findComposerIdentityOption(expectedName);
      if (!option) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(350);
        continue;
      }
      log('Selecting composer actor option:', normalizeText(option.innerText || option.textContent || option.getAttribute?.('aria-label') || '').slice(0, 160));
      clickLikeUser(option);
      await sleep(2200);
      if (identityMatches(extractComposerIdentity(dialog), expectedName)) return true;
    }
    return false;
  }

  // ============ MAIN ============
  function isManagedPageIdentityUrl(identityUrl) {
    return /^https:\/\/(www\.)?facebook\.com\/profile\.php\?id=\d+/i.test(String(identityUrl || ''));
  }

  function closeComposerDialog(dialog) {
    if (!dialog) return;
    const closeBtn = [...dialog.querySelectorAll('[aria-label], [role="button"], button')]
      .find(el => /^(close|discard)$/i.test(cleanIdentityName(el.getAttribute?.('aria-label') || el.innerText || el.textContent || '')));
    try {
      if (closeBtn) closeBtn.click();
      else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    } catch (_) {}
  }

  async function openVerifiedComposerDialog(identityName) {
    assertNoFacebookDefenseSignal();
    assertAcceptedGroupBeforePosting();
    const trigger = await findTrigger();
    log('Clicking trigger...');
    trigger.click();
    const dialog = await findDialog();
    await sleep(500);
    let identityCheck = null;
    try {
      identityCheck = verifyComposerIdentity(dialog, identityName);
    } catch (e) {
      if (e.code !== 'identity_not_verified') throw e;
      log('Composer opened under wrong actor; trying composer identity picker:', e.message);
      const switchedInComposer = await switchComposerIdentityInDialog(dialog, identityName);
      if (!switchedInComposer) throw e;
      identityCheck = verifyComposerIdentity(dialog, identityName);
    }
    return { dialog, identityCheck };
  }

  async function postToGroup(message, imageUrl, identityName, identityUrl=null) {
    log('=== START POST ===');
    const groupPageUrl = location.href;
    assertNoFacebookDefenseSignal();

    let identitySwitch = { switched: false, active_identity: currentIdentityName(), page_first: false };
    let dialog = null;
    let identityCheck = null;

    // Page identities are group-specific on Facebook: the global/Page-manager
    // switch can visually land on the Page but still leave the group composer as
    // another actor. First verify the actual group composer. If this group was
    // joined by the requested Page, this succeeds without a fragile global switch.
    if (isManagedPageIdentityUrl(identityUrl)) {
      try {
        const opened = await openVerifiedComposerDialog(identityName);
        dialog = opened.dialog;
        identityCheck = opened.identityCheck;
        identitySwitch = { switched: false, active_identity: identityCheck?.active_identity, page_first: true };
        log('Managed Page composer verified directly:', identityName);
      } catch (firstError) {
        closeComposerDialog(document.querySelector('[role="dialog"]'));
        await sleep(700);
        log('Managed Page direct composer check failed; trying switch path:', firstError.message);
      }
    }

    // Fallback/normal path: switch identity before opening the group composer.
    if (!dialog) {
      identitySwitch = await switchToIdentity(identityName, identityUrl);
      if (identitySwitch?.direct_url_fallback && groupPageUrl && location.href !== groupPageUrl) {
        log('Returning to group after direct identity URL fallback:', groupPageUrl);
        location.href = groupPageUrl;
        await sleep(7000);
      }
      const opened = await openVerifiedComposerDialog(identityName);
      dialog = opened.dialog;
      identityCheck = opened.identityCheck;
    }

    // 5. Find textbox inside dialog
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
    assertNoFacebookDefenseSignal();
    const evidence = findSubmittedPostEvidence(message);
    log('=== POST DONE ===', evidence);
    return {
      submitted: true,
      postUrl: evidence.postUrl || null,
      evidenceFound: !!evidence.found,
      matchedText: evidence.matchedText || null,
      pageUrl: location.href,
      identityName: identityName || null,
      activeIdentity: identityCheck?.active_identity || identitySwitch?.active_identity || null,
      identityUsed: identityCheck?.composer_identity || identityCheck?.active_identity || identitySwitch?.active_identity || null,
      composerIdentity: identityCheck?.composer_identity || null,
      composerIdentityVerified: !!identityCheck?.verified,
      identitySwitched: !!identitySwitch?.switched
    };
  }

  async function probeGroupComposerIdentity(identityName, identityUrl=null, skipSwitch=false) {
    const groupPageUrl = location.href;
    let identitySwitch = { switched: false, active_identity: currentIdentityName(), skipped: !!skipSwitch };
    let dialog = null;
    let identityCheck = null;

    if (skipSwitch || isManagedPageIdentityUrl(identityUrl)) {
      try {
        const opened = await openVerifiedComposerDialog(identityName);
        dialog = opened.dialog;
        identityCheck = opened.identityCheck;
      } catch (firstError) {
        closeComposerDialog(document.querySelector('[role="dialog"]'));
        await sleep(500);
        if (skipSwitch) throw firstError;
      }
    }

    if (!dialog) {
      identitySwitch = await switchToIdentity(identityName, identityUrl);
      if (identitySwitch?.direct_url_fallback && groupPageUrl && location.href !== groupPageUrl) {
        location.href = groupPageUrl;
        await sleep(7000);
      }
      const opened = await openVerifiedComposerDialog(identityName);
      dialog = opened.dialog;
      identityCheck = opened.identityCheck;
    }

    closeComposerDialog(dialog);
    await sleep(500);
    return {
      allowed: true,
      pageUrl: location.href,
      identityName: identityName || null,
      activeIdentity: identityCheck?.active_identity || identitySwitch?.active_identity || null,
      composerIdentity: identityCheck?.composer_identity || null,
      composerIdentityVerified: !!identityCheck?.verified,
      identitySwitched: !!identitySwitch?.switched
    };
  }

  // ============ MESSAGE LISTENER ============
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!['POST_TO_PAGE','PROBE_GROUP_COMPOSER_IDENTITY','SYNC_FACEBOOK_IDENTITIES','SWITCH_FACEBOOK_IDENTITY','LOCATE_FACEBOOK_IDENTITY_SWITCH_TARGET','SCRAPE_FACEBOOK_MANAGED_PAGES','SWITCH_FACEBOOK_MANAGED_PAGE','GET_FACEBOOK_ACTIVE_IDENTITY'].includes(msg.type)) return;

    if (msg.type === 'GET_FACEBOOK_ACTIVE_IDENTITY') {
      (async () => {
        try {
          const expected = msg.expectedIdentity || msg.identityName || msg.identity_name || null;
          let active = currentIdentityName();
          if (expected ? !identityMatches(active, expected) : !active) {
            const opened = await openIdentityMenu();
            if (opened) {
              await sleep(1000);
              active = activeIdentityFromMenu(document, expected) || currentIdentityName();
            }
          }
          sendResponse({ success: true, activeIdentity: active || null, expectedIdentity: expected, matchesExpected: identityMatches(active, expected), pageUrl: location.href });
        } catch (e) {
          sendResponse({ success: false, error: e.message, activeIdentity: currentIdentityName() || null, pageUrl: location.href });
        }
      })();
      return true;
    }

    if (msg.type === 'LOCATE_FACEBOOK_IDENTITY_SWITCH_TARGET') {
      log('Received identity switch target locate command');
      (async () => {
        try {
          const result = await locateIdentitySwitchTarget(msg.identityName || msg.identity_name, msg.force === true);
          sendResponse({ success: true, ...result });
        } catch (error) {
          sendResponse({ success: false, error: error.message, activeIdentity: currentIdentityName() || null, pageUrl: location.href });
        }
      })();
      return true;
    }

    if (msg.type === 'SWITCH_FACEBOOK_IDENTITY') {
      log('Received identity switch command');
      (async () => {
        try {
          const result = await switchToIdentity(msg.identityName || msg.identity_name, msg.identityUrl || msg.identity_url || null);
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

    if (msg.type === 'SCRAPE_FACEBOOK_MANAGED_PAGES') {
      log('Received managed Pages scrape command');
      (async () => {
        try {
          const pages = scrapeManagedPages();
          sendResponse({ success: true, pages, pageUrl: location.href });
        } catch (error) {
          log('MANAGED PAGES SCRAPE ERROR:', error.message);
          sendResponse({ success: false, error: error.message });
        }
      })();
      return true;
    }

    if (msg.type === 'SWITCH_FACEBOOK_MANAGED_PAGE') {
      log('Received managed Page switch command');
      (async () => {
        try {
          const result = await switchManagedPageFromPagesManager(msg.identityName || msg.identity_name);
          sendResponse({ success: true, ...result });
        } catch (error) {
          log('MANAGED PAGE SWITCH ERROR:', error.message);
          sendResponse({ success: false, error: error.message, pageUrl: location.href });
        }
      })();
      return true;
    }

    if (msg.type === 'PROBE_GROUP_COMPOSER_IDENTITY') {
      log('Received composer identity probe command');
      (async () => {
        try {
          const result = await probeGroupComposerIdentity(msg.identityName || msg.identity_name || null, msg.identityUrl || msg.identity_url || null, msg.skipSwitch === true);
          sendResponse({ success: true, ...result });
        } catch (error) {
          log('COMPOSER PROBE ERROR:', error.message);
          sendResponse({
            success: false,
            error: error.message,
            error_code: error.code || null,
            identity_expected: error.identity_expected || msg.identityName || msg.identity_name || null,
            identity_active: error.identity_active || null,
            composer_identity: error.composer_identity || null,
            composer_identity_verified: false,
            pageUrl: location.href
          });
        }
      })();
      return true;
    }

    log('Received post command');
    (async () => {
      try {
        const result = await postToGroup(msg.message, msg.imageUrl, msg.identityName || msg.identity_name || null, msg.identityUrl || msg.identity_url || null);
        sendResponse({ success: true, ...result });
      } catch (error) {
        log('ERROR:', error.message);
        sendResponse({
          success: false,
          error: error.message,
          error_code: error.code || null,
          identity_expected: error.identity_expected || msg.identityName || msg.identity_name || null,
          identity_active: error.identity_active || null,
          composer_identity: error.composer_identity || null,
          composer_identity_verified: false
        });
      }
    })();

    return true; // keep channel open
  });

  log('Content script v8 loaded');
})();
