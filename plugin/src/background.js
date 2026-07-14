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
    const pickerUrl = new URL(chrome.runtime.getURL("src/folder-picker/index.html"));
    if (sender.tab?.id != null) pickerUrl.searchParams.set("returnTabId", String(sender.tab.id));
    chrome.tabs.create({ url: pickerUrl.toString() }, (tab) => {
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
    if (error || downloadId == null) {
      sendResponse({ ok: false, error: error?.message || "Chrome did not create a download" });
      return;
    }
    let settled = false;
    let timeout = null;
    const finish = (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.downloads.onChanged.removeListener(onChanged);
      sendResponse(response);
    };
    const readDownload = () => {
      chrome.downloads.search({ id: downloadId }, (items) => {
        const searchError = chrome.runtime.lastError;
        const item = items?.[0];
        finish({
          ok: !searchError && item?.state === "complete",
          downloadId,
          state: item?.state || "unknown",
          error: searchError?.message || item?.error || "",
          filename: item?.filename || message.filename,
          bytesReceived: item?.bytesReceived || 0,
          totalBytes: item?.totalBytes || 0,
        });
      });
    };
    const onChanged = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === "complete") readDownload();
      if (delta.state.current === "interrupted") {
        finish({
          ok: false,
          downloadId,
          state: "interrupted",
          error: delta.error?.current || "Chrome download interrupted",
          filename: message.filename,
        });
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
    timeout = setTimeout(() => {
      finish({
        ok: false,
        downloadId,
        state: "timeout",
        error: "Timed out waiting for Chrome download (10 minutes)",
        filename: message.filename,
      });
    }, 10 * 60 * 1000);
  });

  return true;
});
