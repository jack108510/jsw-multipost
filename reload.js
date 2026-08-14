setTimeout(() => {
  try {
    document.title = 'Amplr reload ' + chrome.runtime.getManifest().version;
    chrome.runtime.reload();
  } catch (e) {
    document.title = 'Amplr reload error ' + e.message;
  }
}, 500);
