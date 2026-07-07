chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    chrome.tabs.create({ url: "https://www.douyin.com/" });
  }
});

chrome.action.onClicked.addListener(async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const active = tabs[0];
  if (active?.url?.startsWith("https://www.douyin.com/")) {
    chrome.tabs.sendMessage(active.id, { type: "TOGGLE_SIDEBAR" }).catch(() => {});
    return;
  }
  chrome.tabs.create({ url: "https://www.douyin.com/" });
});
