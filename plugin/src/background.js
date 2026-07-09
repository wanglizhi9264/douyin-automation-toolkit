chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    chrome.tabs.create({ url: "https://www.douyin.com/" });
  }
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const error = chrome.runtime.lastError;
    if (error) return;

    const active = tabs[0];
    if (active?.url?.startsWith("https://www.douyin.com/")) {
      chrome.tabs.sendMessage(active.id, { type: "TOGGLE_SIDEBAR" }, () => {
        chrome.runtime.lastError;
      });
      return;
    }
    chrome.tabs.create({ url: "https://www.douyin.com/" });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "OPEN_FOLDER_PICKER_TAB") {
    chrome.tabs.create({ url: chrome.runtime.getURL("src/folder-picker/index.html") }, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) sendResponse({ ok: false, error: error.message });
      else sendResponse({ ok: true, tabId: tab?.id || null });
    });
    return true;
  }

  if (message?.type === "SET_DOWNLOAD_UI") {
    if (!chrome.downloads?.setUiOptions) {
      sendResponse({ ok: true, supported: false });
      return false;
    }
    chrome.downloads.setUiOptions({ enabled: Boolean(message.enabled) }, () => {
      const error = chrome.runtime.lastError;
      if (error) sendResponse({ ok: false, error: error.message });
      else sendResponse({ ok: true, supported: true });
    });
    return true;
  }

  if (message?.type !== "DOWNLOAD_URL") return false;

  chrome.downloads.download({
    url: message.url,
    filename: message.filename,
    conflictAction: message.conflictAction || "uniquify",
    saveAs: Boolean(message.saveAs),
  }, (downloadId) => {
    const error = chrome.runtime.lastError;
    if (error) sendResponse({ ok: false, error: error.message });
    else sendResponse({ ok: true, downloadId });
  });

  return true;
});
