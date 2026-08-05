// ============ JSW Multi-Post Content Script v4 ============
// Based on verified FB DOM research.
// Key insight: clicking the composer opens a [role="dialog"] modal.
// All textbox + Post button searches are scoped INSIDE that dialog.

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

  // ============ MAIN ============
  async function postToGroup(message, imageUrl) {
    log('=== START POST ===');

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

    // 10. Wait for dialog to close (post submitted)
    await sleep(5000);
    log('=== POST DONE ===');
    return true;
  }

  // ============ MESSAGE LISTENER ============
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type !== 'POST_TO_PAGE') return;

    log('Received post command');
    (async () => {
      try {
        await postToGroup(msg.message, msg.imageUrl);
        sendResponse({ success: true });
      } catch (error) {
        log('ERROR:', error.message);
        sendResponse({ success: false, error: error.message });
      }
    })();

    return true; // keep channel open
  });

  log('Content script v4 loaded');
})();
