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
      const name = cleanIdentityName(value || '');
      if (!name || /^(profile picture|photo|your profile|active)$/i.test(name)) return;
      if (isForbiddenIdentityName(name) || /^(see your profile|view your profile|facebook identity)$/i.test(name)) return;
      candidates.push(name);
    };

    [
      '[aria-label="Your profile"]',
      '[aria-label*="Your profile"]',
      '[aria-label$="profile"]',
      'a[aria-label*="profile"]',
      '[role="banner"] [aria-label*="profile"]'
    ].forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        push(el.querySelector?.('img[alt]')?.getAttribute('alt'));
        const label = el.getAttribute?.('aria-label') || '';
        if (!/Your profile/i.test(label)) push(label);
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

  function isForbiddenIdentityName(name) {
    const cleaned = cleanIdentityName(name || '');
    if (!cleaned) return true;
    if (/^(quick switch profiles?|see all profiles?|see all pages?|settings(?: & privacy)?|help(?: & support)?|report a problem|give feedback|meta verified|meta business suite|display & accessibility|privacy|terms|privacy policy|advertising|ad choices|cookies|more|active|log out)$/i.test(cleaned)) return true;
    if (/^(?:[A-Z]\s*){1,3}$/i.test(cleaned.replace(/\./g, ''))) return true; // menu initials like "B B"
    if (/^(facebook|meta|pages?|profiles?|home|watch|marketplace|groups?|notifications?|menu)$/i.test(cleaned)) return true;
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

  function activeIdentityFromMenu(root=document) {
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
    const roots = [...document.querySelectorAll('[role="dialog"], [role="menu"], [aria-label*="Account"], [aria-label*="profile"], [aria-label*="Page"]')].filter(visible);
    return roots.find(r => /Switch to|Continue as|See all profiles|See all pages|Your Pages|See your profile|View your profile|Quick switch profiles/i.test(r.textContent || '')) || document.body;
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

  function findSeeAllIdentitiesButton(root=identityMenuRoot()) {
    return [...root.querySelectorAll('[role="button"], a[href], [aria-label]')]
      .filter(visible)
      .find(el => {
        const label = el.getAttribute('aria-label') || '';
        const text = normalizeText(el.innerText || el.textContent || '');
        const cleanedLabel = cleanIdentityName(label);
        const cleanedText = cleanIdentityName(text);
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
    const candidates = [...document.querySelectorAll('[aria-label], [role="button"], a[href], span[dir="auto"]')].filter(visible);
    return candidates.find(el => {
      const label = el.getAttribute('aria-label') || '';
      const text = el.innerText || el.textContent || '';
      const name = extractIdentityName(el, label || text);
      const combined = cleanIdentityName(`${label} ${text}`);
      return (identityMatches(name, expectedName) || identityMatches(combined, expectedName)) && !isForbiddenIdentityName(name);
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
    return actual && expected && (actual === expected || actual.includes(expected) || expected.includes(actual));
  }

  async function switchToIdentity(expectedName, identityUrl=null) {
    if (!expectedName) return { switched: false, active_identity: currentIdentityName() };
    let active = currentIdentityName();
    if (identityMatches(active, expectedName)) return { switched: false, active_identity: active };

    const tryDirectPageUrl = async (reason='') => {
      if (!identityUrl || !/^https:\/\/(www\.)?facebook\.com\/profile\.php\?id=\d+/i.test(identityUrl)) return null;
      log('Trying direct Facebook Page profile URL fallback:', identityUrl, reason);
      location.href = identityUrl;
      await sleep(7000);
      active = currentIdentityName();
      if (identityMatches(active, expectedName) || /profile\.php\?id=\d+/i.test(location.href)) {
        return { switched: true, active_identity: active || expectedName, direct_url_fallback: true, page_url: location.href };
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
      throw new Error(`Could not find Facebook identity "${expectedName}" in switcher. ${identitySwitcherDebugSummary()}`);
    }
    clickLikeUser(target);
    await sleep(6000);
    active = currentIdentityName();
    if (!identityMatches(active, expectedName)) {
      // Facebook sometimes navigates after switch; reload detection from page text/menu can lag.
      log('Identity switch verification uncertain:', active, expectedName);
    }
    return { switched: true, active_identity: active || expectedName };
  }

  function extractComposerIdentity(dialog) {
    if (!dialog) return null;
    const values = [];
    const push = (value) => {
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

  // ============ MAIN ============
  async function postToGroup(message, imageUrl, identityName, identityUrl=null) {
    log('=== START POST ===');
    const groupPageUrl = location.href;
    assertNoFacebookDefenseSignal();

    // 0. Switch Facebook posting identity before opening the group composer.
    const identitySwitch = await switchToIdentity(identityName, identityUrl);
    if (identitySwitch?.direct_url_fallback && groupPageUrl && location.href !== groupPageUrl) {
      log('Returning to group after direct identity URL fallback:', groupPageUrl);
      location.href = groupPageUrl;
      await sleep(7000);
    }
    assertNoFacebookDefenseSignal();

    // 1. Find trigger
    const trigger = await findTrigger();

    // 2. Click it — opens dialog
    log('Clicking trigger...');
    trigger.click();

    // 3. Wait for dialog to appear
    const dialog = await findDialog();

    // 4. Verify the actual composer identity before typing/submitting.
    // This is the hard safety gate that prevents accidental cross-Page posts.
    await sleep(500);
    const identityCheck = verifyComposerIdentity(dialog, identityName);

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

  // ============ MESSAGE LISTENER ============
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!['POST_TO_PAGE','SYNC_FACEBOOK_IDENTITIES','SWITCH_FACEBOOK_IDENTITY','SCRAPE_FACEBOOK_MANAGED_PAGES'].includes(msg.type)) return;

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

  log('Content script v7 loaded');
})();
