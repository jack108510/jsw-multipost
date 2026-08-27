setTimeout(() => {
  try {
    document.title = 'Reachr reload ' + chrome.runtime.getManifest().version;
    chrome.runtime.reload();
  } catch (e) {
    document.title = 'Reachr reload error ' + e.message;
  }
}, 500);
