const EXTENSION_ORIGIN = chrome.runtime.getURL("").replace(/\/$/, "");
const SIDEBAR_ID = "douyin-toolkit-sidebar";
const INJECTED_ID = "douyin-toolkit-injected";

let sidebarVisible = true;
let sidebarCollapsed = true;

let sidebarReady = false;
let floatingMenuOpen = false;
let floatingPosition = null;
let floatingDrag = null;
const POSITION_KEY = "douyinFloatingPosition";
function floatingLayout(open = floatingMenuOpen) {
  const width = window.innerWidth || 1024,
    height = window.innerHeight || 768;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const x = clamp(
    floatingPosition?.x ?? width - 42,
    34,
    Math.max(34, width - 34),
  );
  const y = clamp(floatingPosition?.y ?? 42, 34, Math.max(34, height - 34));
  const dx = x > width / 2 ? -1 : 1,
    dy = y > height / 2 ? -1 : 1;
  const radius = Math.min(
    80,
    Math.max(44, (dx > 0 ? width - x : x) - 28),
    Math.max(44, (dy > 0 ? height - y : y) - 28),
  );
  const diagonal = radius / Math.sqrt(2);
  const offsets = [
    [radius * dx, 0],
    [diagonal * dx, diagonal * dy],
    [0, radius * dy],
  ];
  const minX = open ? Math.min(-30, ...offsets.map(([a]) => a - 24)) : -30;
  const minY = open ? Math.min(-30, ...offsets.map(([, b]) => b - 24)) : -30;
  const maxX = open ? Math.max(30, ...offsets.map(([a]) => a + 24)) : 30;
  const maxY = open ? Math.max(30, ...offsets.map(([, b]) => b + 24)) : 30;
  return {
    left: x + minX,
    top: y + minY,
    width: maxX - minX,
    height: maxY - minY,
    anchorX: -minX,
    anchorY: -minY,
    offsets,
    x,
    y,
    open,
    dragging: Boolean(floatingDrag),
  };
}
function applyFloatingLayout() {
  const frame = document.getElementById(SIDEBAR_ID);
  if (!frame) return;
  const layout = floatingLayout();
  for (const key of ["left", "top", "width", "height"])
    frame.style[key] = sidebarCollapsed ? layout[key] + "px" : "";
  frame.style.right = sidebarCollapsed ? "auto" : "";
  frame.setAttribute(
    "data-menu-open",
    String(sidebarCollapsed && floatingMenuOpen),
  );
  postToSidebar({
    source: "douyin-toolkit-content",
    type: "FLOATING_LAYOUT",
    payload: layout,
  });
}
function saveFloatingPosition() {
  const layout = floatingLayout(false);
  void chrome.storage?.local
    ?.set?.({
      [POSITION_KEY]: {
        x: layout.x / (window.innerWidth || 1024),
        y: layout.y / (window.innerHeight || 768),
      },
    })
    ?.catch?.(() => {});
}
const pendingSidebarMessages = [];

function flushSidebarMessages() {
  const frame = document.getElementById(SIDEBAR_ID);
  if (!sidebarReady || !frame?.contentWindow) return;
  while (pendingSidebarMessages.length) {
    frame.contentWindow.postMessage(
      pendingSidebarMessages.shift(),
      EXTENSION_ORIGIN,
    );
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
  frame.setAttribute("data-collapsed", String(sidebarCollapsed));
  frame.setAttribute("data-menu-open", "false");
  document.documentElement.appendChild(frame);
  applyFloatingLayout();
  frame.addEventListener(
    "load",
    () => {
      sidebarReady = true;
      flushSidebarMessages();
      setSidebarCollapsed(sidebarCollapsed);
    },
    { once: true },
  );
}

function removeSidebar() {
  setSidebarVisible(false);
}

function setSidebarCollapsed(collapsed) {
  const frame = document.getElementById(SIDEBAR_ID);
  if (!frame) return;
  sidebarCollapsed = Boolean(collapsed);
  frame.setAttribute("data-collapsed", String(sidebarCollapsed));
  floatingMenuOpen = false;
  applyFloatingLayout();
  frame.setAttribute(
    "title",
    sidebarCollapsed ? "展开抖音收藏备份助手" : "抖音收藏备份助手",
  );
  postToSidebar({
    source: "douyin-toolkit-content",
    type: "SIDEBAR_COLLAPSE_STATE",
    payload: { collapsed: sidebarCollapsed },
  });
}

function setSidebarVisible(visible) {
  sidebarVisible = visible;
  const frame = document.getElementById(SIDEBAR_ID);
  if (frame) frame.style.display = visible ? "block" : "none";
  postToSidebar({source:"douyin-toolkit-content",type:"SIDEBAR_VISIBILITY_STATE",payload:{visible}});
}

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === "TOGGLE_SIDEBAR") {
    if (!document.getElementById(SIDEBAR_ID)) {
      ensureSidebar();
      setSidebarVisible(true);
    } else {
      const open = !sidebarVisible || sidebarCollapsed;
      setSidebarVisible(true);
      setSidebarCollapsed(!open);
    }
  }
  if (message && message.type === "CLOSE_SIDEBAR") {
    removeSidebar();
  }
  return false;
});

function postToPage(data) {
  try {
    window.postMessage(
      { ...data, source: "douyin-toolkit-content" },
      location.origin,
    );
  } catch (error) {
    postToSidebar({
      source: "douyin-toolkit-page",
      requestId: data?.requestId,
      type: data?.type,
      payload: null,
      error:
        "\u9875\u9762\u6d88\u606f\u8f6c\u53d1\u5931\u8d25\uff1a" +
        (error?.message || String(error)),
    });
  }
}
window.addEventListener("message", (event) => {
  if (
    event.source === window &&
    event.data &&
    event.data.source === "douyin-toolkit-page"
  ) {
    postToSidebar(event.data);
    return;
  }
  if (
    event.origin === EXTENSION_ORIGIN &&
    event.data &&
    event.data.source === "douyin-toolkit-sidebar"
  ) {
    if (event.source !== document.getElementById(SIDEBAR_ID)?.contentWindow)
      return;
    if (event.data.type === "SET_FLOATING_MENU") {
      floatingMenuOpen =
        sidebarCollapsed && !floatingDrag && Boolean(event.data.payload?.open);
      applyFloatingLayout();
      return;
    }
    if (event.data.type === "FLOATING_DRAG") {
      if (!sidebarCollapsed) return;
      const p = event.data.payload || {};
      if (![p.x, p.y].every(Number.isFinite)) return;
      if (p.phase === "start") {
        const layout = floatingLayout(false);
        floatingDrag = { screenX: p.x, screenY: p.y, x: layout.x, y: layout.y };
        floatingMenuOpen = false;
      }
      if (floatingDrag) {
        floatingPosition = {
          x: floatingDrag.x + p.x - floatingDrag.screenX,
          y: floatingDrag.y + p.y - floatingDrag.screenY,
        };
        if (p.phase === "end" || p.phase === "cancel") {
          const layout = floatingLayout(false);
          floatingPosition = { x: layout.x, y: layout.y };
          floatingDrag = null;
          saveFloatingPosition();
        }
        applyFloatingLayout();
      }
      return;
    }
    if (event.data.type === "SET_SIDEBAR_COLLAPSED") {
      setSidebarCollapsed(event.data.payload?.collapsed);
      return;
    }
    if (event.data.type === "CLOSE_SIDEBAR") {
      removeSidebar();
      return;
    }
    postToPage(event.data);
  }
});

ensureInjectedScript();
ensureSidebar();

window.addEventListener("resize", () => {
  if (floatingPosition) {
    const layout = floatingLayout(false);
    floatingPosition = { x: layout.x, y: layout.y };
  }
  applyFloatingLayout();
});
void chrome.storage?.local
  ?.get?.(POSITION_KEY)
  ?.then?.((saved) => {
    const p = saved?.[POSITION_KEY];
    if (
      p &&
      Number.isFinite(p.x) &&
      Number.isFinite(p.y) &&
      !floatingDrag &&
      !floatingPosition
    ) {
      floatingPosition = {
        x: p.x * (window.innerWidth || 1024),
        y: p.y * (window.innerHeight || 768),
      };
      applyFloatingLayout();
    }
  })
  ?.catch?.(() => {});
