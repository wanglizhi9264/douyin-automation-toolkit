const EXTENSION_ORIGIN = chrome.runtime.getURL("").replace(/\/$/, "");
const SIDEBAR_ID = "douyin-toolkit-sidebar";
const INJECTED_ID = "douyin-toolkit-injected";

let sidebarVisible = true;

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
}

function setSidebarVisible(visible) {
  sidebarVisible = visible;
  const frame = document.getElementById(SIDEBAR_ID);
  if (frame) frame.style.display = visible ? "block" : "none";
}

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === "TOGGLE_SIDEBAR") {
    setSidebarVisible(!sidebarVisible);
  }
  return false;
});

window.addEventListener("message", (event) => {
  if (event.source === window && event.data && event.data.source === "douyin-toolkit-page") {
    const frame = document.getElementById(SIDEBAR_ID);
    if (frame && frame.contentWindow) frame.contentWindow.postMessage(event.data, EXTENSION_ORIGIN);
    return;
  }
  if (event.origin === EXTENSION_ORIGIN && event.data && event.data.source === "douyin-toolkit-sidebar") {
    window.postMessage({ ...event.data, source: "douyin-toolkit-content" }, location.origin);
  }
});

ensureInjectedScript();
ensureSidebar();
