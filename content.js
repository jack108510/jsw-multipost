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
      // Group variants may expose the entry point as a native button, an
      // accessible div, or a link. Treat those as equivalent discovery inputs;
      // later stages still require a verified modal, requested actor, exact
      // draft and enabled scoped submit control before any mutation.
      const selectors = [
        'div[role="button"][aria-label^="What\'s on your mind"]',
        'button[aria-label^="What\'s on your mind"]',
        'div[role="button"][aria-label*="What\'s on your mind"]',
        'button[aria-label*="What\'s on your mind"]',
        'div[role="button"][aria-label*="Write something"]',
        'button[aria-label*="Write something"]',
        'div[role="button"][aria-label*="Write a post"]',
        'button[aria-label*="Write a post"]',
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
      const btn = [...main.querySelectorAll('div[role="button"], button')].find(b =>
        /what's on your mind|write (a post|something)/i.test(visibleText(b))
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
      "button[aria-label^=\"What's on your mind\"]",
      "div[role='button'][aria-label*=\"What's on your mind\"]",
      "button[aria-label*=\"What's on your mind\"]",
      'div[role="button"][aria-label*="Write something"]',
      'button[aria-label*="Write something"]',
      'div[role="button"][aria-label*="Write a post"]',
      'button[aria-label*="Write a post"]',
      'a[href*="/composer/?"]'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (visible(el)) return el;
    }
    const main = document.querySelector('[role="main"]') || document.body;
    return [...main.querySelectorAll('div[role="button"], button')].find(b =>
      visible(b) && /what's on your mind|write (a post|something)/i.test(visibleText(b))
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
      // Facebook can leave an old, hidden contenteditable mounted while the
      // visible composer is replaced. Never type into that stale node.
      const candidates = dialog.querySelectorAll ? [...dialog.querySelectorAll(sel)] : [];
      const isEditable = candidate => candidate?.isContentEditable === true || candidate?.getAttribute?.('contenteditable') === 'true';
      const isVisible = candidate => typeof visible !== 'function' || visible(candidate);
      const hasEditableCandidate = candidates.some(isEditable);
      const el = candidates.find(candidate => isEditable(candidate) && isVisible(candidate)) ||
        (!hasEditableCandidate ? dialog.querySelector?.(sel) || null : null);
      if (el) {
        log('Found textbox:', el.getAttribute('aria-label') || el.getAttribute('role'));
        return el;
      }
    }
    return null;
  }

  // ============ TYPE INTO COMPOSER ============
  async function typeMessage(textbox, text, assertCurrent = () => {}) {
    log('Typing message...');
    const hasExactDraft = () => normalizeText(textbox.innerText || textbox.textContent || '') === normalizeText(text);
    const ownsFocus = () => textbox.isConnected && textbox.ownerDocument === document
      && (document.activeElement === textbox || textbox.contains(document.activeElement));
    const ownsSelection = () => {
      const selection = document.getSelection();
      return ownsFocus() && selection?.rangeCount === 1
        && textbox.contains(selection.anchorNode) && textbox.contains(selection.focusNode);
    };
    assertCurrent();
    textbox.focus();
    if (!ownsFocus()) return false;
    // Bind replacement to this editor before yielding. Never select the document
    // or silently repair focus/selection drift after an asynchronous wait.
    const replacement = document.createRange();
    replacement.selectNodeContents(textbox);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(replacement);
    await sleep(200);
    assertCurrent();
    if (!ownsSelection()) return false;

    // Method 1: execCommand insertText (works with FB's React contenteditable)
    await sleep(50);
    assertCurrent();
    if (!ownsSelection()) return false;
    const ok = document.execCommand('insertText', false, text);
    await sleep(300);
    assertCurrent();
    if (!ownsSelection()) return false;

    if (ok && hasExactDraft()) {
      log('Typed via execCommand OK');
      return true;
    }

    // Method 2: beforeinput + input events
    log('execCommand failed, trying synthetic events...');
    textbox.focus();
    for (const type of ['beforeinput', 'input']) {
      assertCurrent();
      if (!ownsSelection()) return false;
      textbox.dispatchEvent(new InputEvent(type, {
        inputType: 'insertText',
        data: text,
        bubbles: true,
        cancelable: true,
        composed: true,
      }));
    }
    await sleep(300);
    assertCurrent();
    if (!ownsSelection()) return false;

    if (hasExactDraft()) {
      log('Typed via InputEvent OK');
      return true;
    }

    // Facebook's controlled composer can reject isolated-world InputEvents.
    // Fall back only through the background's native DevTools transport, bound
    // to this exact document URL and this exact verified editor. The background
    // rechecks those bindings and focus immediately before Input.insertText;
    // we recheck context and exact draft immediately after it returns.
    const newToken = () => {
      if (globalThis.crypto?.getRandomValues) {
        const bytes = new Uint32Array(4);
        globalThis.crypto.getRandomValues(bytes);
        return [...bytes].map(value => value.toString(36)).join('_');
      }
      return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    };
    const editorToken = newToken();
    const documentToken = newToken();
    const root = document.documentElement;
    try {
      assertCurrent();
      textbox.focus();
      // A failed synthetic write may have left a collapsed caret after a partial
      // draft. Rebind the native transport to the complete, verified editor
      // contents; never append to a partial draft or select outside this box.
      const nativeReplacement = document.createRange();
      nativeReplacement.selectNodeContents(textbox);
      selection.removeAllRanges();
      selection.addRange(nativeReplacement);
      if (!ownsSelection() || !root?.isConnected) return false;
      textbox.setAttribute('data-reachr-native-editor', editorToken);
      root.setAttribute('data-reachr-native-document', documentToken);
      let timeoutId;
      const native = await Promise.race([
        chrome.runtime.sendMessage({
          type: 'NATIVE_TYPE_FACEBOOK_DRAFT',
          text,
          editorToken,
          documentToken,
          documentUrl: location.href
        }),
        new Promise(resolve => { timeoutId = setTimeout(() => resolve({ ok: false, error: 'native_type_timeout' }), 8000); })
      ]);
      if (timeoutId) clearTimeout(timeoutId);
      assertCurrent();
      if (!ownsSelection() || native?.ok !== true) return false;
      if (hasExactDraft()) {
        log('Typed via bound native input OK');
        return true;
      }
    } catch (error) {
      // The caller records only the safe, generic text-entry failure. Do not
      // surface debugger transport detail to queue telemetry.
      log('Bound native draft input unavailable:', error?.message || 'unknown');
    } finally {
      if (textbox.getAttribute('data-reachr-native-editor') === editorToken) {
        textbox.removeAttribute('data-reachr-native-editor');
      }
      if (root?.getAttribute('data-reachr-native-document') === documentToken) {
        root.removeAttribute('data-reachr-native-document');
      }
    }
    log('Draft entry was not confirmed');
    return false;
  }

  // ============ FIND POST BUTTON INSIDE DIALOG ============
  function findPostButtonInDialog(dialog, diagnostics = {}) {
    Object.assign(diagnostics, { found: false, enabled: false, naming_source: null, candidates: 0 });
    if (!dialog?.isConnected) return null;
    const isVisible = btn => {
      if (!btn?.isConnected) return false;
      const rect = btn.getBoundingClientRect();
      const style = getComputedStyle(btn);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse';
    };
    const accessibleName = btn => {
      const ids = (btn.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean);
      const labels = ids.map(id => (btn.ownerDocument || document).getElementById(id)).filter(Boolean);
      // IDREF order matters; a resolved labelledby overrides aria-label/text,
      // even when the resulting name is empty. Never emit label/DOM text.
      if (labels.length) return { name: labels.map(el => el.textContent || '').join(' ').replace(/\s+/g, ' ').trim(), source: 'aria-labelledby' };
      const label = btn.getAttribute('aria-label');
      if (label?.trim()) return { name: label.trim(), source: 'aria-label' };
      return { name: (btn.textContent || '').trim(), source: 'text' };
    };
    const candidates = [...dialog.querySelectorAll('[role="button"], button')];
    const fallbacks = [...dialog.querySelectorAll('[data-testid="react-composer-post-button"], [data-testid="composer-post-button"]')];
    diagnostics.candidates = new Set([...candidates, ...fallbacks]).size;
    const matches = btn => /^(post|publish)$/i.test(accessibleName(btn).name) && isVisible(btn);
    // Only controls inside this dialog are considered. A known test ID cannot
    // override a contradictory accessible name (especially Next).
    const named = candidates.find(matches);
    const selected = named || fallbacks.find(btn => {
      const label = accessibleName(btn);
      return isVisible(btn) && (/^(post|publish)$/i.test(label.name) || (!label.name && label.source === 'text'));
    }) || null;
    if (selected) Object.assign(diagnostics, {
      found: true,
      enabled: selected.getAttribute('aria-disabled') !== 'true' && selected.disabled !== true,
      naming_source: named ? accessibleName(selected).source : 'test-id'
    });
    return selected;
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

  // Only canonical, explicitly group-scoped URLs are attributable here. Unknown
  // formats and group aliases fail closed rather than borrowing a feed link.
  function submittedPostPermalink(href, expectedGroupUrl) {
    try {
      const expected = new URL(expectedGroupUrl);
      const url = new URL(href, expected);
      const isFacebook = u => u.protocol === 'https:' && /^(www\.|m\.|mbasic\.)?facebook\.com$/.test(u.hostname) && !u.port && !u.username && !u.password;
      const group = expected.pathname.match(/^\/groups\/([^/]+)(?:\/|$)/)?.[1];
      if (!group || !isFacebook(expected) || !isFacebook(url)) return null;
      const post = url.pathname.match(/^\/groups\/([^/]+)\/(?:posts|permalink)\/(\d+)\/?$/);
      if (!post || post[1] !== group) return null;
      return `https://www.facebook.com/groups/${group}/posts/${post[2]}/`;
    } catch (_) {
      return null;
    }
  }

  function captureSubmittedPostBaseline(expectedGroupUrl) {
    const baseline = new Set();
    for (const link of document.querySelectorAll('a[href]')) {
      const postUrl = submittedPostPermalink(link.href, expectedGroupUrl);
      if (postUrl) baseline.add(postUrl);
    }
    return baseline;
  }

  // Observation only: never re-click or infer publication from composer closure.
  // Wait budget is scheduled sleep time, not a claim about wall-clock duration.
  async function observeSubmittedPostEvidence(message, options) {
    let observationScans = 0;
    let observationWaitMs = 0;
    try {
      for (let scan = 0; scan <= 16; scan++) {
        observationScans++;
        const evidence = findSubmittedPostEvidence(message, options);
        if (evidence.found) return { ...evidence, evidenceStatus: 'matched_new_permalink', evidenceReason: null, observationScans, observationWaitMs };
        // Only a NEW, visible, submission-specific platform notification on the
        // intended group is admin-review evidence. Generic group rules, old
        // pending posts and mere absence of a permalink remain unknown.
        if (options?.pendingBaseline instanceof Set
            && new URL(location.href).pathname.replace(/\/$/, '') === new URL(options.expectedGroupUrl).pathname.replace(/\/$/, '')) {
          for (const notice of document.querySelectorAll('[role="alert"], [role="status"]')) {
            const text = normalizeText(notice.innerText || notice.textContent || '').toLowerCase();
            if (options.pendingBaseline.has(text)
                || !/^your post (?:is (?:pending|awaiting) (?:admin |administrator )?approval|has been submitted (?:to (?:the )?admins? )?for approval)[.!]?$/.test(text)) continue;
            const rect = notice.getBoundingClientRect();
            const style = getComputedStyle(notice);
            if (rect.width > 0 && rect.height > 0 && style.display !== 'none'
                && style.visibility !== 'hidden' && style.visibility !== 'collapse') {
              return { found: false, postUrl: null, matchedText: null, evidenceStatus: 'pending_approval',
                evidenceReason: 'new_visible_submission_approval_notice', observationScans, observationWaitMs };
            }
          }
        }
        if (scan < 16) {
          await sleep(500);
          observationWaitMs += 500;
        }
      }
    } catch (_) {
      return { found: false, postUrl: null, matchedText: null, evidenceStatus: 'submitted_unconfirmed', evidenceReason: 'observation_error', observationScans, observationWaitMs };
    }
    return { found: false, postUrl: null, matchedText: null, evidenceStatus: 'submitted_unconfirmed', evidenceReason: 'no_new_matching_permalink', observationScans, observationWaitMs };
  }

  function findSubmittedPostEvidence(message, { expectedGroupUrl = null, baseline = null } = {}) {
    // Attribution is intentionally strict: one visible article must contain the
    // complete submitted body and expose exactly one *new*, canonical permalink
    // for this exact group. This is stronger than a composer closing or a toast,
    // yet lets real completed publications leave the uncertainty circuit breaker.
    try {
      const body = normalizeText(message);
      if (!body || !expectedGroupUrl) return { found: false, postUrl: null, matchedText: null };
      const expectedPath = new URL(expectedGroupUrl).pathname.replace(/\/$/, '');
      if (location.pathname.replace(/\/$/, '') !== expectedPath) return { found: false, postUrl: null, matchedText: null };
      const matchingArticles = [...document.querySelectorAll('[role="article"]')].filter(article => {
        const rect = article.getBoundingClientRect?.();
        const style = getComputedStyle(article);
        return rect && rect.width > 0 && rect.height > 0 && style.display !== 'none'
          && style.visibility !== 'hidden' && style.visibility !== 'collapse'
          && normalizeText(article.textContent).includes(body);
      });
      if (matchingArticles.length !== 1) return { found: false, postUrl: null, matchedText: null };
      const permalinks = new Set();
      for (const link of matchingArticles[0].querySelectorAll('a[href]')) {
        const permalink = submittedPostPermalink(link.href, expectedGroupUrl);
        if (permalink) permalinks.add(permalink);
      }
      if (permalinks.size !== 1) return { found: false, postUrl: null, matchedText: null };
      const [postUrl] = permalinks;
      const known = baseline instanceof Set ? baseline : new Set(Array.isArray(baseline) ? baseline : []);
      if (known.has(postUrl)) return { found: false, postUrl: null, matchedText: null };
      return { found: true, postUrl, matchedText: body };
    } catch (_) {
      return { found: false, postUrl: null, matchedText: null };
    }
  }

  // Observation-only metadata. The prior submitted_unconfirmed/pending_approval
  // state is echoed, never upgraded: a candidate is not attribution, so found and
  // postUrl stay falsy and the permalink is exposed only as candidatePermalink.
  function submittedPostReconciliationResult(evidenceStatus, candidatePermalink = null, candidateReason = null) {
    return {
      observationOnly: true,
      submitted: false,
      found: false,
      postUrl: null,
      publicationVerified: false,
      attributed: false,
      evidenceStatus: evidenceStatus === 'pending_approval' ? 'pending_approval' : 'submitted_unconfirmed',
      candidateStatus: candidatePermalink ? 'candidate_permalink_unattributed' : 'no_candidate',
      candidatePermalink: candidatePermalink || null,
      candidateReason: candidatePermalink ? null : candidateReason
    };
  }

  // Read-only scan after an already-submitted attempt: exactly one visible group
  // article must contain the normalized full body (possibly alongside Facebook
  // UI text) and exactly one canonical
  // permalink for the expected group. Never clicks, waits, navigates or verifies.
  function reconcileSubmittedPostCandidate(message, { expectedGroupUrl = null, baseline = null, evidenceStatus = null } = {}) {
    const result = (candidatePermalink, reason) => submittedPostReconciliationResult(evidenceStatus, candidatePermalink, reason);
    try {
      const body = normalizeText(message);
      if (!body || !expectedGroupUrl) return result(null, 'missing_body_or_group');
      if (new URL(location.href).pathname.replace(/\/$/, '') !== new URL(expectedGroupUrl).pathname.replace(/\/$/, '')) {
        return result(null, 'not_on_expected_group');
      }
      const matches = [];
      for (const article of document.querySelectorAll('[role="article"]')) {
        const rect = article.getBoundingClientRect?.();
        const style = getComputedStyle(article);
        if (!rect || !(rect.width > 0 && rect.height > 0) || style.display === 'none'
            || style.visibility === 'hidden' || style.visibility === 'collapse') continue;
        if (normalizeText(article.textContent).includes(body)) matches.push(article);
      }
      if (matches.length !== 1) return result(null, matches.length ? 'ambiguous_matching_articles' : 'no_visible_matching_article');
      const permalinks = new Set();
      for (const link of matches[0].querySelectorAll('a[href]')) {
        const postUrl = submittedPostPermalink(link.href, expectedGroupUrl);
        if (postUrl) permalinks.add(postUrl);
      }
      if (permalinks.size !== 1) return result(null, permalinks.size ? 'ambiguous_permalinks' : 'no_canonical_permalink');
      const [permalink] = permalinks;
      const known = Array.isArray(baseline) || baseline instanceof Set ? [...baseline] : [];
      if (known.some(href => submittedPostPermalink(href, expectedGroupUrl) === permalink)) {
        return result(null, 'permalink_in_pre_submit_baseline');
      }
      return result(permalink, null);
    } catch (_) {
      return result(null, 'reconciliation_error');
    }
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
    if (/\/v\/t39\.30808-6\//i.test(value) && /(?:cstp=mx720|ctp=s720|dst-jpg_tt6)/i.test(value)) return false;
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

  function nativeAccountIdentityFromLabel(label) {
    // Facebook renders the active account button as e.g. “Your profile, Name”.
    // Treat only this native, account-control grammar as evidence; generic labels
    // and arbitrary names elsewhere in the banner are never actor proof.
    const match = normalizeText(label || '').match(/^(?:Your profile|Account Controls(?: and Settings)?|Account)\s*[,\:]\s*(.+)$/i);
    if (!match) return null;
    const name = cleanIdentityName(match[1]);
    return name && !isForbiddenIdentityName(name) ? name : null;
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

    const banner = document.querySelector('[role="banner"]');
    [
      '[aria-label="Your profile"]',
      '[aria-label*="Your profile"]',
      '[aria-label="Account Controls and Settings"]',
      '[aria-label*="Account Controls"]',
      '[aria-label="Account"]',
      '[aria-label*="Account"]'
    ].forEach(sel => {
      banner?.querySelectorAll(sel).forEach(el => {
        const label = el.getAttribute?.('aria-label') || '';
        push(nativeAccountIdentityFromLabel(label));
        push(el.querySelector?.('img[alt]')?.getAttribute('alt'));
        if (!/Your profile|Account Controls|Account/i.test(label)) push(label);
      });
    });

    push(activeIdentityFromMenu());
    const names = [...new Map(candidates.map(name => [name.toLowerCase(), name])).values()];
    return names.length === 1 ? names[0] : null;
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

  function isPlaceholderIdentityName(name) {
    return /^(unnamed(?: page| profile)?|unknown(?: page| profile)?|new page)$/i.test(cleanIdentityName(name || ''));
  }

  function facebookProfileIdFromUrl(url) {
    const match = String(url || '').match(/profile\.php\?id=(\d+)/i);
    return match?.[1] || null;
  }

  function nativeManagedPageContextIdentity(expectedName, expectedUrl) {
    // Page URL alone proves nothing: any viewer can visit it. Accept a managed
    // Page context only when Facebook simultaneously exposes its native Page
    // management chrome and the native comment actor for the same expected Page.
    // This is a Page-only alternative when Facebook renders the global account
    // button as generic “Your profile”.
    const expectedId = facebookProfileIdFromUrl(expectedUrl);
    const actualId = facebookProfileIdFromUrl(location.href);
    const expected = cleanIdentityName(expectedName || '');
    if (!expectedId || !actualId || expectedId !== actualId || !expected || isForbiddenIdentityName(expected)) return null;
    const pageNavigation = [...document.querySelectorAll('[role="navigation"][aria-label="Page navigation"]')]
      .map(el => normalizeText(el.innerText || el.textContent || ''))
      .filter(Boolean);
    const managementPrefix = `Manage Page ${expected}`.toLowerCase();
    const nativeManagement = pageNavigation.some(text => {
      const normalized = text.toLowerCase();
      return normalized === managementPrefix || normalized.startsWith(`${managementPrefix} `);
    });
    const nativeCommentActor = [...document.querySelectorAll('[role="textbox"]')]
      .some(el => normalizeText(el.getAttribute('aria-label') || '') === `Comment as ${expected}`);
    if (!nativeManagement || !nativeCommentActor) return null;
    return { activeIdentity: expected, identitySource: 'native_managed_page_context', verified: true };
  }

  function isForbiddenIdentityName(name) {
    const cleaned = cleanIdentityName(name || '');
    if (!cleaned || isPlaceholderIdentityName(cleaned)) return true;
    if (cleaned.length > 90) return true;
    if (/^(quick switch profiles?|see all profiles?|see all pages?|settings(?:\s*(?:&|and)?\s*privacy)?|help(?:\s*(?:&|and)?\s*support)?|report a problem|give feedback|meta verified|meta business suite|display & accessibility|privacy|terms|privacy policy|advertising|ad choices|cookies|more|active|edit|manage|back to previous(?: page)?|select an option|available voices?,?\s*switch|unread chats?|chatsallhas new content.*|log out)$/i.test(cleaned)) return true;
    if (/^(?:[A-Z]\s*){1,3}$/i.test(cleaned.replace(/\./g, ''))) return true; // menu initials like "B B"
    if (/^\d+\+?$/.test(cleaned)) return true;
    if (/^\d+\s*(?:m|h|d|w|mo|y)$/i.test(cleaned)) return true;
    if (/^(facebook|facebook menu|meta|pages?|profiles?|home|watch|marketplace|groups?|notifications?|menu|account controls(?: and settings)?|account|your|your feed|feed)$/i.test(cleaned)) return true;
    if (/\b(number of unread notifications|new notification|notifications?|unread chats?|chat history is missing|available voices|privacy shortcuts|professional dashboard|ad center|create post|composer|search facebook|view all|sponsored|contacts|meta ai|profile photo|profile picture|online status indicator)\b/i.test(cleaned)) return true;
    return false;
  }

  function identityUrlAllowed(url) {
    if (!url) return true;
    try {
      const u = new URL(url, location.href);
      if (!/facebook\.com$/i.test(u.hostname.replace(/^www\./, ''))) return false;
      return !/(\/settings|\/help|\/privacy|\/policies|\/business|\/ads|\/ad_|\/groups\/|\/marketplace|\/events|\/friends|\/messages|\/notifications|\/stories\/)/i.test(u.pathname);
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
    // Available actors and menu ordering are never current-account evidence.
    if (!root || root === document.body || !root.isConnected || root.ownerDocument !== document) return null;
    const names = new Map();
    const selector = '[role="button"], button, a[href], [role="menuitem"], [role="menuitemradio"], [role="option"]';
    for (const el of [...root.querySelectorAll(selector)].filter(visible)) {
      if (el.querySelector(selector)) continue; // Do not aggregate multiple actor rows.
      const lines = (el.innerText || el.textContent || '').split('\n').map(normalizeText).filter(Boolean);
      const marked = lines.some(line => /^(See your profile|View your profile|Active)$/i.test(line))
        || el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true';
      if (!marked || lines.some(line => /^Switch to\b/i.test(line))) continue;
      const values = lines.filter(line => !/^(See your profile|View your profile|Active)$/i.test(line) && !isForbiddenIdentityName(line));
      const alt = cleanIdentityName(el.querySelector('img[alt]')?.getAttribute('alt') || '');
      if (alt && !isForbiddenIdentityName(alt)) values.push(alt);
      for (const name of values) names.set(name.toLowerCase(), name);
    }
    return names.size === 1 ? [...names.values()][0] : null;
  }

  function identityMenuRoot() {
    const menuTextRe = /Switch to|Continue as|See all profiles|See all pages|Pages you manage|Select profile|Your Pages|See your profile|View your profile|Quick switch profiles|Meta Business Suite|Settings & privacy|Log out/i;
    const textOf = el => normalizeText(el?.innerText || el?.textContent || el?.getAttribute?.('aria-label') || '');
    const goodBox = el => {
      const b = el?.getBoundingClientRect?.();
      return !!b && b.width >= 240 && b.width <= 620 && b.height >= 80 && b.height <= Math.max(950, window.innerHeight);
    };

    const semanticRoots = [...document.querySelectorAll('[role="menu"], [role="dialog"]')].filter(visible)
      .filter(el => menuTextRe.test(textOf(el)));
    if (semanticRoots.length) return semanticRoots.length === 1 ? semanticRoots[0] : null;
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
        if (node === document.body || node === document.documentElement) break;
        if (menuTextRe.test(text) && /Settings & privacy|Log out|Meta Business Suite|Select profile|Pages you manage|See all pages/i.test(text) && goodBox(node)) { best = node; break; }
      }
      if (best) return best;
    }

    const roots = [...document.querySelectorAll('[role="dialog"], [role="menu"], [aria-label*="Account"]')].filter(visible);
    return roots.find(r => menuTextRe.test(textOf(r))) || null;
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
    if (!root) return null;
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

  async function openPagesManagerFromVisibleChrome(expectedName='') {
    // Some Facebook layouts no longer expose "See all profiles" from group pages,
    // but still expose the canonical Pages manager link in the left/nav chrome.
    // This keeps the safe path actor-first: go to Pages manager, then only click
    // a verified Switch Now card/link for the requested Page.
    const links = [...document.querySelectorAll('a[href]')].filter(visible);
    const target = links.find(a => {
      const href = a.href || a.getAttribute('href') || '';
      return /facebook\.com\/pages\/\?category=your_pages/i.test(href)
        || /\/pages\/\?category=your_pages/i.test(href);
    }) || links.find(a => {
      const href = a.href || a.getAttribute('href') || '';
      const text = cleanIdentityName(a.innerText || a.textContent || a.getAttribute('aria-label') || '');
      return /^Pages$/i.test(text) && /facebook\.com\/pages/i.test(href);
    }) || null;
    if (!target) return false;
    log('Opening Facebook Pages manager fallback for identity switch:', expectedName || 'page');
    clickLikeUser(target);
    await sleep(6000);
    return /\/pages\//i.test(location.pathname) || /category=your_pages/i.test(location.href)
      || /Pages .* manages|Your Pages|Switch Now/i.test(normalizeText(document.body?.innerText || document.body?.textContent || ''));
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
                  id: facebookProfileIdFromUrl(identity.url) || identity.id || facebookProfileIdFromUrl(prev.url) || prev.id || key,
        name,
        type: identity.type || prev.type || (facebookProfileIdFromUrl(identity.url || prev.url) ? 'page' : 'facebook identity'),
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
    if (!root) return null;
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
    if (!root) return 'Switcher visible rows: none; scraped identities: none; see-all/page rows: none';
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
    if (!root) return [];
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
      const url = el.href || el.closest?.('a[href]')?.href || null;
      const hasActorUrl = /profile\.php\?id=\d+|\/pages\/|\/people\//i.test(url || '');
      const isCurrentAccountRow = /See your profile|View your profile|Active/i.test(combined);
      const looksLikeIdentityRow = hasSwitcherVerb || isCurrentAccountRow || hasActorUrl || (hasAvatar && hasActorUrl);
      if (!looksLikeIdentityRow) continue;

      add(name, { label: combined, url, avatar_url: avatarUrl, type: /page|business/i.test(combined) ? 'page' : undefined, source: 'account_switcher' });
    }

    const active = activeIdentityFromMenu(root) || currentIdentityName();
    if (active) add(active, { is_active: true, label: 'active profile', source: 'active_account' });
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
      const stablePageId = facebookProfileIdFromUrl(extra.url) || facebookProfileIdFromUrl(prev.url) || extra.id || prev.id || key;
      found.set(key, {
        ...prev,
        id: stablePageId,
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

  function findManagedPageProfileSwitchControl(expectedName, expectedUrl) {
    // A bare "Switch" is safe only on the exact requested Page URL and in its
    // own "Switch into <name>'s Page" card, never another Page's card.
    const expectedId = facebookProfileIdFromUrl(expectedUrl);
    if (!expectedId || facebookProfileIdFromUrl(location.href) !== expectedId) return null;
    const phrase = `switch into ${normalizeText(expectedName).toLowerCase()}'s page`;
    const cards = [...document.querySelectorAll('div, [role="article"], [role="listitem"]')]
      .filter(visible)
      .filter(card => {
        const text = normalizeText(card.innerText || card.textContent || '').toLowerCase().replace(/’/g, "'");
        return text.length < 300 && text.includes(phrase);
      });
    return [...document.querySelectorAll('[aria-label="Switch"]')]
      .filter(visible)
      .find(button => cards.some(card => card.contains(button))) || null;
  }

  async function switchManagedPageFromPagesManager(expectedName, expectedUrl = null) {
    if (!expectedName) throw new Error('Managed Page name is required');
    const expectedId = String(expectedUrl || '').match(/profile\.php\?id=(\d+)/i)?.[1] || null;
    const bodySample = () => normalizeText(document.body?.innerText || document.body?.textContent || '').slice(0, 1600);
    const pageOwnerVerified = () => {
      const body = normalizeText(document.body?.innerText || document.body?.textContent || '');
      const onPagesManagerList = /\/pages\//i.test(location.pathname) && /category=your_pages/i.test(location.href);
      // The Pages Manager list can contain every Page name plus "Switch Now" buttons.
      // Seeing the target name there is not proof that Facebook is acting as that Page.
      if (onPagesManagerList && /\bSwitch Now\b/i.test(body)) return false;
      const expected = normalizeText(expectedName).toLowerCase();
      const hasTargetManagementChrome = body.toLowerCase().includes(`manage page ${expected}`)
        || body.toLowerCase().includes(`switch into ${expected}'s page`)
        || body.toLowerCase().includes(`switch into ${expected}’s page`);
      // A Page being visible in its own management shell is not enough: the
      // current posting actor may still be another Page. Require Facebook's
      // native Page-bound comment control to name this exact actor.
      const hasTargetCommentActor = [...document.querySelectorAll('[role="textbox"]')]
        .some(el => normalizeText(el.getAttribute('aria-label') || '').toLowerCase() === `comment as ${expected}`);
      return hasTargetManagementChrome && hasTargetCommentActor;
    };
    const findPageLink = () => {
      if (!expectedId) return null;
      return [...document.querySelectorAll('a[href*="/profile.php"], a[href*="facebook.com/profile.php"]')]
        .filter(visible)
        .find(a => (a.href || '').includes(expectedId)) || null;
    };
    const findCard = () => {
      const main = document.querySelector('[role="main"]') || document.body || document;
      const cards = [...main.querySelectorAll('[role="article"], [role="listitem"], div')].filter(visible);
      for (const card of cards) {
        const text = normalizeText(card.innerText || card.textContent || '');
        // Ancestor containers include every Page and the first sibling's switch.
        // Only a single-Page card may bind a target name/ID to Switch Now.
        if ((text.match(/\bSwitch Now\b/gi) || []).length !== 1) continue;
        const href = card.querySelector?.('a[href*="/profile.php"], a[href*="facebook.com/profile.php"]')?.href || '';
        const lines = (card.innerText || card.textContent || '').split('\n').map(cleanIdentityName).filter(Boolean);
        const hasPageName = lines.some(line => identityMatches(line, expectedName)) || identityMatches(text, expectedName);
        const hasPageId = expectedId && href.includes(expectedId);
        if (!hasPageName && !hasPageId) continue;
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

    if (pageOwnerVerified()) {
      return { switched: true, already_active: true, active_identity: expectedName, page_url: location.href, body_sample: bodySample() };
    }

    for (let pass = 0; pass < 5; pass++) {
      if (pageOwnerVerified()) {
        return { switched: true, already_active: true, active_identity: expectedName, page_url: location.href, body_sample: bodySample() };
      }
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
        if (!identityMatches(active, expectedName) && pageOwnerVerified()) active = expectedName;
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
      const profileSwitch = findManagedPageProfileSwitchControl(expectedName, expectedUrl);
      if (profileSwitch) {
        clickLikeUser(profileSwitch);
        await sleep(1500);
        const confirmation = [...document.querySelectorAll('[role="dialog"]')].filter(visible)
          .find(dialog => normalizeText(dialog.innerText || dialog.textContent || '').toLowerCase()
            .replace(/’/g, "'").includes(normalizeText(expectedName).toLowerCase()));
        if (confirmation) {
          const confirmButton = [...confirmation.querySelectorAll('[aria-label="Switch"], [role="button"], button')]
            .filter(visible)
            .find(el => /^Switch$/i.test(normalizeText(el.getAttribute('aria-label') || el.innerText || el.textContent || '')));
          if (!confirmButton) throw new Error(`Page switch confirmation for ${expectedName} has no Switch control`);
          clickLikeUser(confirmButton);
        }
        await sleep(8000);
        // A successful click is not actor proof. Require independent native
        // actor evidence before returning; the background also rechecks it.
        let active = currentIdentityName();
        if (!identityMatches(active, expectedName) && pageOwnerVerified()) active = expectedName;
        if (!identityMatches(active, expectedName)) {
          throw new Error(`Page profile Switch for ${expectedName} clicked, but active actor did not verify. Active: ${active || 'unknown'}.`);
        }
        return { switched: true, active_identity: active, page_url: location.href, switched_via_page_profile_card: true, body_sample: bodySample() };
      }
      const link = findPageLink();
      if (link) {
        clickLikeUser(link);
        await sleep(6000);
        if (pageOwnerVerified()) {
          return { switched: true, active_identity: expectedName, page_url: location.href, opened_page_link: true, body_sample: bodySample() };
        }
      }
      window.scrollBy(0, window.innerHeight * 1.5);
      await sleep(1200);
    }
    throw new Error(`Could not find Switch Now card for ${expectedName} on Pages manager. ${bodySample()}`);
  }

  async function switchViaVerifiedFacebookIdentityPath(expectedName, expectedUrl = null) {
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

    // Step 1: open Select profile via Facebook's full identity switcher.
    // This is a hard safety gate: never select a Page/profile from the stale
    // quick-switcher rows. The operator requirement is profile/avatar menu
    // -> See all profiles -> select target (or See all Pages -> target).
    const openedProfiles = await clickSeeAllButton('profiles');
    if (!openedProfiles) {
      const openedPagesManager = await openPagesManagerFromVisibleChrome(expectedName);
      if (openedPagesManager) {
        try {
          const managed = await switchManagedPageFromPagesManager(expectedName, expectedUrl);
          return { ...managed, switched_via_verified_profile_path: 'pages_manager_visible_chrome_fallback' };
        } catch (managedError) {
          throw new Error(`Could not open See all profiles before switching to ${expectedName}; Pages manager fallback opened but did not verify target. ${managedError.message}`);
        }
      }
      throw new Error(`Could not open See all profiles before switching to ${expectedName}. Refusing stale quick-switcher path. ${identitySwitcherDebugSummary()}`);
    }
    await sleep(500);

    // Step 2: only after See all profiles is open, select a directly visible target.
    let target = findIdentityTarget(expectedName);
    if (target) return await clickAndVerifyTarget(target, 'see_all_profiles_select_profile');

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
      const managed = await switchManagedPageFromPagesManager(expectedName, expectedUrl);
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
    if (!identities.length) throw new Error(`No Facebook identities found in switcher at ${location.pathname}. ${identitySwitcherDebugSummary().slice(0, 600)}`);
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
    if (!expected) return false;
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

    // Always open the full Facebook profile/Page selector before locating the
    // actor. The compact quick-switcher can show stale or partial identities;
    // the full "See all profiles" path is the stable source of truth.
    await clickSeeAllButton('profiles');
    await sleep(800);

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
          .filter(item => /\b(switch|continue|use facebook as|act as)\b/i.test(`${item.text} ${item.context}`));
        const target = candidates.find(item => {
          const actionText = `${item.text} ${item.context}`.toLowerCase();
          return actionText.includes(expected) && /switch into|switch to|continue as|use facebook as|act as/i.test(actionText);
        }) || candidates.find(item => /^(switch|switch now|continue)$/i.test(item.text) && item.context.toLowerCase().includes(expected) && /switch into|switch to|continue as|use facebook as|act as/i.test(item.context)) || null;
        if (!target) return false;
        log('Clicking Page profile switch button:', target.text);
        clickLikeUser(target.el);
        await sleep(7000);
        return true;
      };
      active = currentIdentityName();
      if (!identityMatches(active, expectedName) && /Switch into .*Page to take more actions|Switch/i.test(document.body?.innerText || '')) {
        // The Page's own "Switch into <Page>'s Page" card is stronger evidence
        // than a broad ancestor-text match, which can click the wrong control.
        const specificControl = findManagedPageProfileSwitchControl(expectedName, identityUrl);
        let clicked = false;
        if (specificControl) {
          clickLikeUser(specificControl);
          await sleep(1500);
          const confirmation = [...document.querySelectorAll('[role="dialog"]')].filter(visible)
            .find(dialog => normalizeText(dialog.innerText || dialog.textContent || '').toLowerCase()
              .replace(/’/g, "'").includes(normalizeText(expectedName).toLowerCase()));
          if (confirmation) {
            const confirmButton = [...confirmation.querySelectorAll('[aria-label="Switch"], [role="button"], button')]
              .filter(visible)
              .find(el => /^Switch$/i.test(normalizeText(el.getAttribute('aria-label') || el.innerText || el.textContent || '')));
            if (!confirmButton) throw new Error(`Page switch confirmation for ${expectedName} has no Switch control`);
            clickLikeUser(confirmButton);
          }
          await sleep(8000);
          clicked = true;
        } else {
          // Never fall back to a broad descendant/ancestor text match on a
          // Page shell: it may belong to a different Page or navigation item.
          log('Exact Page switch control not found; trying verified profile selector');
        }
        active = currentIdentityName();
        if (clicked && !identityMatches(active, expectedName)) {
          throw new Error(`Page profile switch clicked, but active actor did not verify as ${expectedName}; refusing another switch or a post.`);
        }
      }
      if (identityMatches(active, expectedName)) {
        return { switched: true, active_identity: active || expectedName, direct_url_fallback: false, switched_via_page_profile_button: true, page_url: location.href };
      }
      return null;
    };

    // When the background worker opened a stable Page URL, try its local Page
    // action before relying on Facebook's account menu. This is more resilient
    // than text-only menu discovery and preserves a useful Page-specific context.
    const directAtCurrentPage = await tryDirectPageUrl('initial Page URL');
    if (directAtCurrentPage) return directAtCurrentPage;

    // Always use the verified path first: avatar menu -> See all profiles ->
    // target, then See all Pages/Pages manager if needed. The quick-switcher is
    // intentionally skipped because Facebook can leave it on an old/stale list.
    try {
      return await switchViaVerifiedFacebookIdentityPath(expectedName, identityUrl);
    } catch (pathError) {
      const direct = await tryDirectPageUrl('verified See all profiles path failed');
      if (direct) return direct;
      throw new Error(`Could not find Facebook identity "${expectedName}" via verified See all profiles/pages path. ${pathError.message}. ${identitySwitcherDebugSummary()}`);
    }
  }

  function extractComposerIdentity(dialog) {
    if (!dialog?.isConnected || dialog.ownerDocument !== document) return null;
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
        const label = el.getAttribute?.('aria-label') || '';
        const postingAs = label.match(/^(?:Posting|Post|Commenting) as\s+(.+)$/i);
        if (postingAs) push(postingAs[1]);
        // Current Facebook group composers can render the selected Page as a
        // native header/button label such as “Wildrose Automations 's Timeline”.
        // This is accepted only from an aria-label inside this exact composer
        // dialog; plain dialog text or a group title is never actor evidence.
        const timelineOwner = label.match(/^(.+?)\s*(?:'|’)\s*s\s+Timeline$/i);
        if (timelineOwner) push(timelineOwner[1]);
      });

    // Unstructured dialog text includes drafts, group rules and previews. None
    // of it is actor evidence; only native actor controls may identify a poster.
    const unique = [...new Set(values.map(value => value.toLowerCase()))];
    return unique.length === 1 ? values[0] : null;
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

  function findComposerIdentityOption(expectedName, dialog, control) {
    if (!dialog?.isConnected || dialog.ownerDocument !== document || !control?.isConnected || !dialog.contains(control)) return null;
    const ids = (control.getAttribute('aria-controls') || control.getAttribute('aria-owns') || '').split(/\s+/).filter(Boolean);
    const roots = ids.map(id => document.getElementById(id)).filter(root => root?.isConnected && root.ownerDocument === document && visible(root) && root.matches('[role="menu"], [role="listbox"], [role="dialog"]'));
    // Portalled pickers need an explicit ownership relation. Never search body,
    // unrelated dialogs, or the global account switcher as composer recovery.
    if (!ids.length) roots.push(...control.querySelectorAll('[role="menu"], [role="listbox"]'));
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
    const ownerDocument = document;
    const documentRoot = document.documentElement;
    const documentUrl = location.href;
    const isCurrent = control => document === ownerDocument && document.documentElement === documentRoot
      && location.href === documentUrl && dialog.isConnected && dialog.ownerDocument === document && visible(dialog)
      && (!control || (control.isConnected && control.ownerDocument === document && dialog.contains(control) && visible(control)));
    if (!isCurrent()) return false;
    const before = extractComposerIdentity(dialog);
    if (identityMatches(before, expectedName)) return true;

    for (const candidate of composerIdentitySwitcherCandidates(dialog)) {
      if (!isCurrent(candidate)) return false;
      const label = normalizeText(candidate.innerText || candidate.textContent || candidate.getAttribute?.('aria-label') || '');
      log('Trying composer actor switcher:', label.slice(0, 120));
      clickLikeUser(candidate);
      await sleep(1200);
      if (!isCurrent(candidate)) return false;
      const option = findComposerIdentityOption(expectedName, dialog, candidate);
      if (!option) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(350);
        if (!isCurrent(candidate)) return false;
        continue;
      }
      log('Selecting composer actor option:', normalizeText(option.innerText || option.textContent || option.getAttribute?.('aria-label') || '').slice(0, 160));
      clickLikeUser(option);
      await sleep(2200);
      if (!isCurrent(candidate)) return false;
      if (identityMatches(extractComposerIdentity(dialog), expectedName)) return true;
    }
    return false;
  }

  // ============ MAIN ============
  function isManagedPageIdentity(identityUrl, identityType=null) {
    return /page/i.test(String(identityType || '')) || /^https:\/\/(www\.)?facebook\.com\/profile\.php\?id=\d+/i.test(String(identityUrl || ''));
  }

  function isManagedPageIdentityUrl(identityUrl) {
    return isManagedPageIdentity(identityUrl, null);
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

  // BEGIN GROUP RESTRICTION QUARANTINE
  function groupRestrictionKey(identityName) {
    const group = location.href.match(/facebook\.com\/groups\/([^/?#]+)/i)?.[1];
    if (!group || !identityName) throw new Error('Group and actor required for restriction check');
    return `reachr_group_hold:${encodeURIComponent(identityName.trim().toLowerCase())}:${group.toLowerCase()}`;
  }

  async function quarantineGroup(identityName, reason, { diagnosticNoPersist = false } = {}) {
    const key = groupRestrictionKey(identityName);
    const hold = { reason, group_url: location.href, actor: identityName, held_at: new Date().toISOString(), requires_manual_review: true };
    if (!diagnosticNoPersist) await chrome.storage.local.set({ [key]: hold });
    return hold;
  }

  async function assertGroupRestriction(identityName, restrictionOptions = {}) {
    const key = groupRestrictionKey(identityName);
    let hold = (await chrome.storage.local.get(key))[key];
    const text = document.body?.innerText || '';
    if (!hold && /(?:reached|hit).*pending.content.limit|pending.content.limit.*(?:reached|hit)|too many pending posts/i.test(text)) {
      hold = await quarantineGroup(identityName, 'pending_content_limit', restrictionOptions);
    }
    if (hold) {
      const error = new Error(`Group restricted (${hold.reason}); manual review required`);
      error.code = 'group_restricted';
      error.reason = hold.reason;
      throw error;
    }
  }
  // END GROUP RESTRICTION QUARANTINE

  async function openVerifiedComposerDialog(identityName, restrictionOptions = {}) {
    assertNoFacebookDefenseSignal();
    await assertGroupRestriction(identityName, restrictionOptions);
    assertAcceptedGroupBeforePosting();
    let trigger;
    try {
      trigger = await findTrigger();
    } catch (cause) {
      assertNoFacebookDefenseSignal();
      await assertGroupRestriction(identityName, restrictionOptions);
      await quarantineGroup(identityName, 'composer_unavailable', restrictionOptions);
      const error = new Error(`Group composer unavailable; manual review required: ${cause.message}`);
      error.code = 'group_restricted';
      error.stage = 'trigger';
      error.cause = cause;
      throw error;
    }
    log('Clicking trigger...');
    trigger.click();
    let dialog;
    try {
      dialog = await findDialog();
    } catch (cause) {
      cause.stage = 'dialog';
      throw cause;
    }
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

  function intendedGroupKey(value) {
    if (typeof value !== 'string' || !value || value !== value.trim()) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || !['facebook.com', 'www.facebook.com', 'm.facebook.com', 'mbasic.facebook.com'].includes(url.hostname) ||
          url.username || url.password || url.port) return null;
      const match = url.pathname.match(/^\/groups\/([a-zA-Z0-9._-]+)\/?$/);
      if (!match || ['feed', 'joins', 'discover', 'create'].includes(match[1].toLowerCase())) return null;
      return match[1].toLowerCase();
    } catch (_) { return null; }
  }

  function assertIntendedGroupContext(intendedGroupUrl, context=null, dialog=null, button=null) {
    const expected = intendedGroupKey(intendedGroupUrl);
    const refuse = () => { throw Object.assign(new Error('Intended group destination not verified; refusing to click'), { code: 'intended_destination_not_verified' }); };
    if (!expected || intendedGroupKey(location.href) !== expected) refuse();
    if (context && (document !== context.document || document.documentElement !== context.root ||
        !context.root || (dialog && dialog.ownerDocument !== document) || (button && button.ownerDocument !== document))) refuse();
    if (!dialog) return;
    // Prefer explicit destination metadata; any group link in the composer is
    // also a conservative constraint, never a source of the expected target.
    const destinations = [dialog.getAttribute?.('data-group-url')];
    const groupId = dialog.getAttribute?.('data-group-id');
    if (groupId && String(groupId).toLowerCase() !== expected) refuse();
    for (const node of dialog.querySelectorAll('[data-group-url], [data-group-id], a[href]')) {
      const id = node.getAttribute?.('data-group-id');
      if (id && String(id).toLowerCase() !== expected) refuse();
      destinations.push(node.getAttribute?.('data-group-url'));
      const href = node.getAttribute?.('href');
      if (href && /\/groups\//i.test(href)) destinations.push(href);
    }
    for (const value of destinations.filter(value => value !== null && value !== undefined)) {
      let resolved;
      try { resolved = new URL(value, intendedGroupUrl).href; } catch (_) { refuse(); }
      if (intendedGroupKey(resolved) !== expected) refuse();
    }
    // Last reads at the synchronous boundary, after inspecting composer nodes.
    if (intendedGroupKey(location.href) !== expected || (context &&
        (document !== context.document || document.documentElement !== context.root))) refuse();
  }

  async function postToGroup(message, imageUrl, identityName, identityUrl=null, identityType=null, intendedGroupUrl=null, noSubmit=false) {
    log('=== START POST ===');
    // Only the explicit no-submit typing diagnostic opts out of persistence.
    // Existing holds are still read/refused; production discovery keeps writes.
    const restrictionOptions = { diagnosticNoPersist: noSubmit === true };
    const groupPageUrl = intendedGroupUrl;
    const groupContext = { document, root: document.documentElement };
    assertIntendedGroupContext(intendedGroupUrl, groupContext);
    assertNoFacebookDefenseSignal();

    let identitySwitch = { switched: false, active_identity: currentIdentityName(), page_first: false };
    let dialog = null;
    let identityCheck = null;

    // Page identities are group-specific on Facebook: the global/Page-manager
    // switch can visually land on the Page but still leave the group composer as
    // another actor. First verify the actual group composer. If this group was
    // joined by the requested Page, this succeeds without a fragile global switch.
    if (isManagedPageIdentity(identityUrl, identityType)) {
      try {
        const opened = await openVerifiedComposerDialog(identityName, restrictionOptions);
        dialog = opened.dialog;
        identityCheck = opened.identityCheck;
        identitySwitch = { switched: false, active_identity: identityCheck?.active_identity, page_first: true };
        log('Managed Page composer verified directly:', identityName);
      } catch (firstError) {
        if (firstError.code === 'group_restricted') throw firstError;
        closeComposerDialog(document.querySelector('[role="dialog"]'));
        await sleep(700);
        log('Managed Page direct composer check failed; trying switch path:', firstError.message);
      }
    }

    // A Page-level switch can navigate the document and permanently lose this
    // async content-script response. The background already performs and verifies
    // Page switching before it creates this group tab. If the group composer cannot
    // prove the Page (or change actor within its own dialog), fail closed here;
    // never navigate away from the intended group from a mutable post command.
    if (!dialog && isManagedPageIdentity(identityUrl, identityType)) {
      const error = new Error(`Composer identity is not confirmed as ${identityName}; no group-side Page navigation attempted.`);
      error.code = 'identity_not_verified';
      error.identity_expected = identityName;
      error.identity_active = currentIdentityName() || null;
      throw error;
    }

    // Stage 1: all actors arrive from background preflight. This command never
    // owns a navigation-capable account switch, including personal profiles.
    if (!dialog) {
      const opened = await openVerifiedComposerDialog(identityName, restrictionOptions);
      dialog = opened.dialog;
      identityCheck = opened.identityCheck;
    }

    // 5. Find textbox inside dialog
    const textbox = findTextboxInDialog(dialog);
    if (!textbox) throw new Error('No textbox found in composer dialog');

    // 5. Focus and type
    textbox.click();
    await sleep(300);
    // Stage 2: no stored verification result crosses a text-entry await. Bind
    // each local mutation to this document and re-read the native actor control.
    const draftDeadline = Date.now() + 15000;
    const assertDraftContext = () => {
      if (Date.now() >= draftDeadline) {
        throw Object.assign(new Error('Composer text-entry stage expired; no further mutation allowed.'), { code: 'composer_stage_expired' });
      }
      assertIntendedGroupContext(intendedGroupUrl, groupContext, dialog);
      verifyComposerIdentity(dialog, identityName);
      if (!textbox.isConnected || textbox.ownerDocument !== document || findTextboxInDialog(dialog) !== textbox) {
        throw Object.assign(new Error('Composer textbox changed; fresh verification required.'), { code: 'identity_not_verified' });
      }
    };
    const typed = await typeMessage(textbox, message, assertDraftContext);
    if (!typed) {
      const error = new Error('Composer text entry was not confirmed; no post attempted.');
      error.code = 'composer_text_entry_failed';
      error.typing = { draft_confirmed: false, native_fallback_attempted: true, native_fallback_disabled: false };
      throw error;
    }

    if (noSubmit === true) {
      return {
        probe: true,
        submitted: false,
        draft_confirmed: true,
        identity: identityCheck?.active_identity || identitySwitch?.active_identity || null,
        target: location.href
      };
    }

    // 6. Attach image
    if (imageUrl) {
      await attachImage(imageUrl, dialog);
    }

    // Facebook may replace the dialog or submit button after typing/uploading.
    // Poll live nodes, never a detached reference. A replacement must contain
    // this exact draft and prove the requested actor; never search feed buttons.
    let postBtn;
    const readiness = { reason: 'not_observed', connected_dialogs: 0, visible_dialogs: 0, matching_dialogs: 0, button: {}, last_actor_error: null };
    const matchingComposers = () => {
      // Re-discover even if the old node is connected: React can retain stale
      // or hidden modals. Ambiguous exact drafts fail closed, not first-match.
      const connected = [...document.querySelectorAll('[role="dialog"]')].filter(d => d.isConnected);
      const visibleDialogs = connected.filter(d => {
        const rect = d.getBoundingClientRect();
        const style = getComputedStyle(d);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse';
      });
      const matching = visibleDialogs.filter(d => {
        const box = findTextboxInDialog(d);
        return box && normalizeText(box.innerText || box.textContent || '') === normalizeText(message);
      });
      Object.assign(readiness, { connected_dialogs: connected.length, visible_dialogs: visibleDialogs.length, matching_dialogs: matching.length });
      return matching;
    };
    try {
      postBtn = await waitFor(() => {
        readiness.reason = 'observation_failed';
        readiness.button = { found: false, enabled: false, naming_source: null, candidates: 0 };
        const matching = matchingComposers();
        if (matching.length !== 1) {
          readiness.reason = matching.length > 1 ? 'ambiguous_draft' : 'draft_mismatch';
          return null;
        }
        dialog = matching[0];
        const button = findPostButtonInDialog(dialog, readiness.button);
        if (!button || !button.isConnected) { readiness.reason = 'button_missing'; return null; }
        if (button.getAttribute('aria-disabled') === 'true' || button.disabled === true) { readiness.reason = 'button_disabled'; return null; }
        try {
          identityCheck = verifyComposerIdentity(dialog, identityName);
          if (identityCheck?.verified !== true) throw Object.assign(new Error('Actor unverified'), { code: 'identity_not_verified' });
        } catch (actorError) {
          readiness.reason = 'actor_unverified';
          // Preserve the last actor failure across subsequent polls, but never
          // copy its message, stack, names or DOM-derived metadata into telemetry.
          readiness.last_actor_error = {
            code: ['identity_required', 'identity_not_verified'].includes(actorError?.code) ? actorError.code : 'actor_verification_error',
            expected_present: !!identityName,
            composer_present: !!actorError?.composer_identity,
            active_present: !!actorError?.identity_active
          };
          return null;
        }
        readiness.reason = 'ready';
        return button;
      }, 15000);
    } catch (cause) {
      const error = new Error(`Composer submit not ready: ${cause.message}. Post button missing/disabled, draft changed, or actor unverified.`);
      error.code = 'composer_submit_not_ready';
      error.reason = readiness.reason;
      error.readiness = readiness;
      throw error;
    }

    // Explicit diagnostic only: execute the same live readiness contract as a
    // real submission, but stop before baseline capture and the final click.
    // This proves the exact button, actor and draft are concurrently ready.
    if (noSubmit === 'readiness') {
      return {
        probe: true,
        submitted: false,
        publicationVerified: false,
        draft_confirmed: true,
        identity: identityCheck?.active_identity || identitySwitch?.active_identity || null,
        composerIdentity: identityCheck?.composer_identity || null,
        composerIdentityVerified: !!identityCheck?.verified,
        readiness,
        target: location.href
      };
    }

    // Capture pre-submit links synchronously, before the final safety boundary.
    // This is a visible-DOM baseline, not proof of server-side freshness.
    const evidenceBaseline = captureSubmittedPostBaseline(groupPageUrl);
    const pendingBaseline = new Set([...document.querySelectorAll('[role="alert"], [role="status"]')]
      .map(node => normalizeText(node.innerText || node.textContent || '').toLowerCase()));

    // Recheck actor, unique exact draft, scoped button and enabled state
    // synchronously at the final click boundary. No await before the click.
    assertNoFacebookDefenseSignal();
    identityCheck = verifyComposerIdentity(dialog, identityName);
    const finalMatching = matchingComposers();
    if (identityCheck?.verified !== true || finalMatching.length !== 1 || finalMatching[0] !== dialog ||
        !dialog.isConnected || findPostButtonInDialog(dialog) !== postBtn || !postBtn.isConnected ||
        postBtn.getAttribute('aria-disabled') === 'true' || postBtn.disabled === true) {
      throw new Error('Composer changed before submission; refusing to click');
    }
    log('Clicking Post...');
    assertIntendedGroupContext(intendedGroupUrl, groupContext, dialog, postBtn);
    postBtn.click();

    // A click is a submission attempt, not confirmation of publication. Observe
    // boundedly without another click; no evidence must never provoke a retry.
    const evidence = await observeSubmittedPostEvidence(message, { expectedGroupUrl: groupPageUrl, baseline: evidenceBaseline, pendingBaseline });
    // When the bounded, attempt-aware observer cannot prove publication, make one
    // synchronous DOM-only pass for a manual-review candidate. It cannot upgrade
    // the state, retry, or authorize dependent work.
    const reconciliation = evidence.found || typeof reconcileSubmittedPostCandidate !== 'function' ? null : reconcileSubmittedPostCandidate(message, {
      expectedGroupUrl: groupPageUrl,
      baseline: evidenceBaseline,
      evidenceStatus: evidence.evidenceStatus
    });
    assertNoFacebookDefenseSignal();
    log('=== POST DONE ===', evidence);
    return {
      submitted: true,
      postUrl: evidence.postUrl || null,
      evidenceFound: !!evidence.found,
      evidenceStatus: evidence.evidenceStatus,
      evidenceReason: evidence.evidenceReason,
      candidatePermalink: reconciliation?.candidatePermalink || null,
      candidateStatus: reconciliation?.candidateStatus || null,
      // A single new canonical Facebook permalink attached to the exact submitted
      // draft is publication evidence. Persist it so the dashboard can link to it.
      publicationVerified: evidence.found === true && evidence.evidenceStatus === 'matched_new_permalink' && !!evidence.postUrl,
      evidenceBaselineCount: evidenceBaseline.size,
      evidenceObservationScans: evidence.observationScans,
      evidenceObservationWaitMs: evidence.observationWaitMs,
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

  // No-post probe opener. With diagnosticNoPersist a trigger/dialog timeout is
  // inconclusive evidence: it must not write a group hold, and it must not claim
  // the group is restricted or the actor has (or lacks) access.
  async function openProbeComposerDialog(identityName, diagnosticNoPersist) {
    if (!diagnosticNoPersist) return openVerifiedComposerDialog(identityName);
    try {
      return await openVerifiedComposerDialog(identityName, { diagnosticNoPersist: true });
    } catch (cause) {
      if (cause.stage !== 'trigger' && cause.stage !== 'dialog') throw cause;
      const error = new Error(`Composer ${cause.stage} not observed before timeout; diagnostic inconclusive, no hold written and no access conclusion drawn: ${(cause.cause || cause).message}`);
      error.code = `composer_${cause.stage}_timeout`;
      error.stage = cause.stage;
      throw error;
    }
  }

  async function probeGroupComposerIdentity(identityName, identityUrl=null, skipSwitch=false, identityType=null, diagnosticNoPersist=false) {
    const groupPageUrl = location.href;
    let identitySwitch = { switched: false, active_identity: currentIdentityName(), skipped: !!skipSwitch };
    let dialog = null;
    let identityCheck = null;

    if (skipSwitch || isManagedPageIdentity(identityUrl, identityType)) {
      try {
        const opened = await openProbeComposerDialog(identityName, diagnosticNoPersist);
        dialog = opened.dialog;
        identityCheck = opened.identityCheck;
      } catch (firstError) {
        closeComposerDialog(document.querySelector('[role="dialog"]'));
        await sleep(500);
        // Page/group access is group-specific. If the group page itself says Join/Pending,
        // do not fall back to the global account switcher and mislabel the problem as a
        // profile-switch failure. A Page can be globally switchable while still not being
        // accepted into a particular group.
        if (skipSwitch || firstError.code === 'group_restricted' || firstError.code === 'not_group_member' || firstError.code === 'composer_trigger_timeout') throw firstError;
      }
    }

    if (!dialog) {
      identitySwitch = await switchToIdentity(identityName, identityUrl);
      if (identitySwitch?.direct_url_fallback && groupPageUrl && location.href !== groupPageUrl) {
        location.href = groupPageUrl;
        await sleep(7000);
      }
      const opened = await openProbeComposerDialog(identityName, diagnosticNoPersist);
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

  function sanitizePostReadiness(error) {
    const knownReason = value => ['not_observed', 'observation_failed', 'ambiguous_draft', 'draft_mismatch',
      'button_missing', 'button_disabled', 'actor_unverified', 'ready'].includes(value) ? value : null;
    const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
    if (error?.code !== 'composer_submit_not_ready') return { reason: null, readiness: null };
    const raw = error.readiness;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { reason: knownReason(error.reason), readiness: null };
    const actor = raw.last_actor_error;
    return { reason: knownReason(error.reason), readiness: {
      reason: knownReason(raw.reason),
      connected_dialogs: count(raw.connected_dialogs), visible_dialogs: count(raw.visible_dialogs), matching_dialogs: count(raw.matching_dialogs),
      button: {
        found: raw.button?.found === true, enabled: raw.button?.enabled === true,
        naming_source: ['aria-labelledby', 'aria-label', 'text', 'test-id'].includes(raw.button?.naming_source) ? raw.button.naming_source : null,
        candidates: count(raw.button?.candidates)
      },
      last_actor_error: actor && typeof actor === 'object' ? {
        code: ['identity_required', 'identity_not_verified', 'actor_verification_error'].includes(actor.code) ? actor.code : null,
        expected_present: actor.expected_present === true, composer_present: actor.composer_present === true, active_present: actor.active_present === true
      } : null
    } };
  }

  // A diagnostic must always return a terminal result. The individual DOM and
  // native-input stages are bounded, but a page/extension edge case must not
  // retain the outer tab message channel until the background's 90s guard.
  const NO_SUBMIT_TYPING_RESPONSE_TIMEOUT_MS = 45_000;
  function respondNoSubmitTypingWithDeadline(operation, sendResponse) {
    let settled = false;
    let timer = null;
    const respond = result => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      sendResponse(result);
    };
    timer = setTimeout(() => respond({
      success: false,
      submitted: false,
      publicationVerified: false,
      error: 'Composer typing probe timed out; no post attempted.',
      error_code: 'composer_typing_probe_timeout',
      typing: { draft_confirmed: false, native_fallback_attempted: true, native_fallback_disabled: false }
    }), NO_SUBMIT_TYPING_RESPONSE_TIMEOUT_MS);
    Promise.resolve().then(operation).then(
      result => respond({ success: true, ...result }),
      error => respond({
        success: false,
        submitted: false,
        publicationVerified: false,
        error: error.message,
        error_code: error.code || null,
        ...(error.code === 'composer_text_entry_failed' ? { typing: { draft_confirmed: false, native_fallback_attempted: true, native_fallback_disabled: false } } : {})
      })
    );
  }

  // ============ MESSAGE LISTENER ============
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!['POST_TO_PAGE','RECONCILE_SUBMITTED_POST_CANDIDATE','PROBE_GROUP_COMPOSER_TYPING','PROBE_GROUP_COMPOSER_SUBMIT_READINESS','PROBE_GROUP_COMPOSER_IDENTITY','SYNC_FACEBOOK_IDENTITIES','SWITCH_FACEBOOK_IDENTITY','LOCATE_FACEBOOK_IDENTITY_SWITCH_TARGET','SCRAPE_FACEBOOK_MANAGED_PAGES','SWITCH_FACEBOOK_MANAGED_PAGE','GET_FACEBOOK_ACTIVE_IDENTITY','GET_FACEBOOK_PAGE_CONTEXT_IDENTITY'].includes(msg.type)) return;

    if (msg.type === 'RECONCILE_SUBMITTED_POST_CANDIDATE') {
      // Observation-only: no composer, click, wait, storage or post path. The
      // response is an unattributed candidate at most, never publication proof.
      try {
        sendResponse({ success: true, ...reconcileSubmittedPostCandidate(msg.message, {
          expectedGroupUrl: msg.expectedGroupUrl || msg.intendedGroupUrl || null,
          baseline: msg.baselineUrls,
          evidenceStatus: msg.evidenceStatus
        }) });
      } catch (e) {
        sendResponse({ success: false, error: e.message, ...submittedPostReconciliationResult(msg.evidenceStatus, null, 'reconciliation_error') });
      }
      return true;
    }

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

    if (msg.type === 'GET_FACEBOOK_PAGE_CONTEXT_IDENTITY') {
      // Read-only Page-local proof. It never opens a composer or changes actor.
      try {
        const expected = msg.expectedIdentity || msg.identityName || msg.identity_name || null;
        const proof = nativeManagedPageContextIdentity(expected, msg.identityUrl || msg.identity_url || null);
        sendResponse({
          success: true,
          activeIdentity: proof?.activeIdentity || null,
          identitySource: proof?.identitySource || null,
          verified: proof?.verified === true,
          expectedIdentity: expected,
          matchesExpected: identityMatches(proof?.activeIdentity || null, expected),
          pageUrl: location.href
        });
      } catch (e) {
        sendResponse({ success: false, error: e.message, activeIdentity: null, identitySource: null, verified: false, pageUrl: location.href });
      }
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
          const result = await switchManagedPageFromPagesManager(msg.identityName || msg.identity_name, msg.identityUrl || msg.identity_url || null);
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
          const result = await probeGroupComposerIdentity(msg.identityName || msg.identity_name || null, msg.identityUrl || msg.identity_url || null, msg.skipSwitch === true, msg.identityType || msg.identity_type || null, msg.diagnosticNoPersist === true);
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
            failed_stage: error.stage || null,
            pageUrl: location.href
          });
        }
      })();
      return true;
    }

    if (msg.type === 'PROBE_GROUP_COMPOSER_TYPING') {
      // Explicit no-submit diagnostic route. It shares the production identity,
      // composer, and text-entry path but returns immediately after the exact
      // draft is confirmed; no media or submit control is touched.
      log('Received no-submit composer typing probe command');
      respondNoSubmitTypingWithDeadline(() => postToGroup(
        msg.message,
        null,
        msg.identityName || msg.identity_name || null,
        msg.identityUrl || msg.identity_url || null,
        msg.identityType || msg.identity_type || null,
        msg.intendedGroupUrl || null,
        true
      ), sendResponse);
      return true;
    }

    if (msg.type === 'PROBE_GROUP_COMPOSER_SUBMIT_READINESS') {
      // Uses the production draft/readiness predicate, but never captures
      // evidence or clicks Facebook's final Post control.
      log('Received no-submit composer readiness probe command');
      (async () => {
        try {
          const result = await postToGroup(
            msg.message,
            null,
            msg.identityName || msg.identity_name || null,
            msg.identityUrl || msg.identity_url || null,
            msg.identityType || msg.identity_type || null,
            msg.intendedGroupUrl || null,
            'readiness'
          );
          sendResponse({ success: true, ...result });
        } catch (error) {
          const readinessFailure = error.code === 'composer_submit_not_ready';
          sendResponse({
            success: false,
            submitted: false,
            publicationVerified: false,
            error: readinessFailure ? 'Composer submit not ready; no post attempted.' : error.message,
            error_code: error.code || null,
            ...sanitizePostReadiness(error)
          });
        }
      })();
      return true;
    }

    log('Received post command');
    (async () => {
      try {
        const result = await postToGroup(msg.message, msg.imageUrl, msg.identityName || msg.identity_name || null, msg.identityUrl || msg.identity_url || null, msg.identityType || msg.identity_type || null, msg.intendedGroupUrl || null);
        sendResponse({ success: true, ...result });
      } catch (error) {
        const readinessFailure = error.code === 'composer_submit_not_ready';
        const safeMessage = readinessFailure ? 'Composer submit not ready; no post attempted.' : error.message;
        log('ERROR:', safeMessage);
        sendResponse({
          success: false,
          publicationVerified: false,
          error: safeMessage,
          error_code: error.code || null,
          ...(error.code === 'composer_text_entry_failed' ? { typing: { draft_confirmed: false, native_fallback_attempted: true, native_fallback_disabled: false } } : {}),
          ...sanitizePostReadiness(error),
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
