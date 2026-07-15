const EXTENSION_ORIGIN = chrome.runtime.getURL("").replace(/\/$/, "");
const SIDEBAR_ID = "douyin-toolkit-sidebar";
const INJECTED_ID = "douyin-toolkit-injected";

let sidebarVisible = true;

let sidebarReady = false;
const pendingSidebarMessages = [];

function flushSidebarMessages() {
  const frame = document.getElementById(SIDEBAR_ID);
  if (!sidebarReady || !frame?.contentWindow) return;
  while (pendingSidebarMessages.length) {
    frame.contentWindow.postMessage(pendingSidebarMessages.shift(), EXTENSION_ORIGIN);
  }
}

function postToSidebar(data) {
  const frame = document.getElementById(SIDEBAR_ID);
  if (!sidebarReady || !frame?.contentWindow) {
    pendingSidebarMessages.push(data);
    if (pendingSidebarMessages.length > 100) pendingSidebarMessages.shift();
    return;
  }
  try {
    frame.contentWindow.postMessage(data, EXTENSION_ORIGIN);
  } catch (error) {
    pendingSidebarMessages.push(data);
    console.warn("[douyin-toolkit] sidebar message deferred", error);
  }
}

function ensureInjectedScript() {
  if (document.getElementById(INJECTED_ID)) return;
  const script = document.createElement("script");
  script.id = INJECTED_ID;
  script.type = "module";
  script.src = chrome.runtime.getURL("src/injected.js");
  script.dataset.extensionOrigin = EXTENSION_ORIGIN;
  document.documentElement.appendChild(script);
}

function ensureSidebar() {
  if (document.getElementById(SIDEBAR_ID)) return;
  const frame = document.createElement("iframe");
  frame.id = SIDEBAR_ID;
  frame.src = chrome.runtime.getURL("src/sidebar/index.html");
  frame.setAttribute("title", "抖音收藏备份助手");
  document.documentElement.appendChild(frame);
  frame.addEventListener("load", () => {
    sidebarReady = true;
    flushSidebarMessages();
  }, { once: true });
}

function removeSidebar() {
  const frame = document.getElementById(SIDEBAR_ID);
  if (frame) frame.remove();
  sidebarVisible = false;
  sidebarReady = false;
  pendingSidebarMessages.length = 0;
}

function setSidebarVisible(visible) {
  sidebarVisible = visible;
  const frame = document.getElementById(SIDEBAR_ID);
  if (frame) frame.style.display = visible ? "block" : "none";
}

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === "TOGGLE_SIDEBAR") {
    if (!document.getElementById(SIDEBAR_ID)) {
      ensureSidebar();
      setSidebarVisible(true);
    } else {
      setSidebarVisible(!sidebarVisible);
    }
  }
  if (message && message.type === "CLOSE_SIDEBAR") {
    removeSidebar();
  }
  return false;
});


function postToPage(data) {
  try {
    window.postMessage({ ...data, source: "douyin-toolkit-content" }, location.origin);
  } catch (error) {
    postToSidebar({
      source: "douyin-toolkit-page",
      requestId: data?.requestId,
      type: data?.type,
      payload: null,
      error: "\u9875\u9762\u6d88\u606f\u8f6c\u53d1\u5931\u8d25\uff1a" + (error?.message || String(error)),
    });
  }
}
window.addEventListener("message", (event) => {
  if (event.source === window && event.data && event.data.source === "douyin-toolkit-page") {
    postToSidebar(event.data);
    return;
  }
  if (event.origin === EXTENSION_ORIGIN && event.data && event.data.source === "douyin-toolkit-sidebar") {
    if (event.data.type === "CLOSE_SIDEBAR") {
      removeSidebar();
      return;
    }
    postToPage(event.data);
  }
});

ensureInjectedScript();
ensureSidebar();
