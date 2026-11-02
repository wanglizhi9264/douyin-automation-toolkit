import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const elements = new Map();
const windowListeners = new Map();
const runtimeListeners = [];
const forwarded = [];

function makeElement(tagName) {
  const listeners = new Map();
  return {
    tagName: tagName.toUpperCase(),
    id: "",
    src: "",
    type: "",
    dataset: {},
    style: {},
    contentWindow:
      tagName === "iframe"
        ? {
            postMessage(data, origin) {
              forwarded.push({ data, origin });
            },
          }
        : null,
    attributes: new Map(),
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    dispatch(type) {
      listeners.get(type)?.();
    },
    remove() {
      elements.delete(this.id);
    },
  };
}

globalThis.document = {
  getElementById(id) {
    return elements.get(id) || null;
  },
  createElement(tagName) {
    return makeElement(tagName);
  },
  documentElement: {
    appendChild(element) {
      elements.set(element.id, element);
    },
  },
};

globalThis.location = { origin: "https://www.douyin.com" };
globalThis.window = {
  addEventListener(type, listener) {
    windowListeners.set(type, listener);
  },
  postMessage() {},
};
globalThis.chrome = {
  runtime: {
    getURL(path = "") {
      return "chrome-extension://test-extension/" + path;
    },
    onMessage: {
      addListener(listener) {
        runtimeListeners.push(listener);
      },
    },
  },
};

const source = fs.readFileSync(
  new URL("../src/content.js", import.meta.url),
  "utf8",
);
vm.runInThisContext(source, { filename: "content.js" });

const frame = elements.get("douyin-toolkit-sidebar");
assert.ok(frame, "sidebar iframe should be appended during startup");

windowListeners.get("message")({
  source: globalThis.window,
  data: { source: "douyin-toolkit-page", type: "BOOT", payload: { ok: true } },
});
assert.equal(
  forwarded.length,
  0,
  "page messages should wait until iframe load",
);

frame.dispatch("load");
assert.equal(
  forwarded.length,
  4,
  "layout, queued message and default collapsed state sent after load",
);
assert.equal(frame.attributes.get("data-collapsed"), "true");
assert.equal(forwarded[0].origin, "chrome-extension://test-extension");
assert.ok(forwarded.some((x) => x.data.type === "BOOT"));

windowListeners.get("message")({
  origin: "chrome-extension://test-extension",
  source: frame.contentWindow,
  data: {
    source: "douyin-toolkit-sidebar",
    type: "SET_SIDEBAR_COLLAPSED",
    payload: { collapsed: true },
  },
});
assert.equal(
  frame.attributes.get("data-collapsed"),
  "true",
  "sidebar should collapse into its compact handle",
);
assert.equal(forwarded.at(-1).data.type, "SIDEBAR_COLLAPSE_STATE");
windowListeners.get("message")({
  origin: "chrome-extension://test-extension",
  source: frame.contentWindow,
  data: {
    source: "douyin-toolkit-sidebar",
    type: "SET_FLOATING_MENU",
    payload: { open: true },
  },
});
assert.equal(
  frame.attributes.get("data-menu-open"),
  "true",
  "hover expands frame to avoid clipping shortcuts",
);
windowListeners.get("message")({
  origin: "chrome-extension://test-extension",
  source: {},
  data: {
    source: "douyin-toolkit-sidebar",
    type: "SET_FLOATING_MENU",
    payload: { open: false },
  },
});
assert.equal(
  frame.attributes.get("data-menu-open"),
  "true",
  "only the actual sidebar may resize its frame",
);

windowListeners.get("message")({
  origin: "chrome-extension://test-extension",
  source: frame.contentWindow,
  data: {
    source: "douyin-toolkit-sidebar",
    type: "SET_SIDEBAR_COLLAPSED",
    payload: { collapsed: false },
  },
});
assert.equal(
  frame.attributes.get("data-collapsed"),
  "false",
  "sidebar should expand from its compact handle",
);
assert.equal(frame.attributes.get("data-menu-open"), "false");

runtimeListeners[0]({ type: "TOGGLE_SIDEBAR" });
assert.equal(
  frame.attributes.get("data-collapsed"),
  "true",
  "toolbar click minimizes and keeps floating controls visible",
);
runtimeListeners[0]({ type: "TOGGLE_SIDEBAR" });
assert.equal(
  frame.attributes.get("data-collapsed"),
  "false",
  "second toolbar click expands",
);

const forwardedBeforeCloneError = forwarded.length;
globalThis.window.postMessage = () => {
  throw new DOMException("clone failed", "DataCloneError");
};
windowListeners.get("message")({
  origin: "chrome-extension://test-extension",
  source: frame.contentWindow,
  data: {
    source: "douyin-toolkit-sidebar",
    requestId: "clone-error-1",
    type: "TEST_CLONE_ERROR",
    payload: {},
  },
});
assert.equal(forwarded.length, forwardedBeforeCloneError + 1);
assert.equal(forwarded.at(-1).data.requestId, "clone-error-1");
assert.match(forwarded.at(-1).data.error, /clone failed/);

runtimeListeners[0]({ type: "CLOSE_SIDEBAR" });
assert.equal(
  elements.has("douyin-toolkit-sidebar"),
  true,
  "close must preserve the iframe and its download engine",
);
assert.equal(frame.style.display, "none", "close hides the sidebar");
runtimeListeners[0]({ type: "TOGGLE_SIDEBAR" });
const recreatedFrame = elements.get("douyin-toolkit-sidebar");
assert.equal(
  recreatedFrame,
  frame,
  "toolbar click must reuse the existing engine",
);
assert.equal(frame.style.display, "block");

console.log("OK: content bridge runtime smoke test passed");

window.innerWidth = 390;
window.innerHeight = 760;
let storedPosition = null;
chrome.storage = {
  local: {
    set: async (value) => {
      storedPosition = value;
    },
  },
};
function moveBubble(x, y) {
  const origin = vm.runInThisContext("floatingLayout(false)");
  for (const [phase, a, b] of [
    ["start", 0, 0],
    ["move", x - origin.x, y - origin.y],
    ["end", x - origin.x, y - origin.y],
  ])
    windowListeners.get("message")({
      origin: "chrome-extension://test-extension",
      source: frame.contentWindow,
      data: {
        source: "douyin-toolkit-sidebar",
        type: "FLOATING_DRAG",
        payload: { phase, x: a, y: b },
      },
    });
}
windowListeners.get("message")({
  origin: "chrome-extension://test-extension",
  source: frame.contentWindow,
  data: {
    source: "douyin-toolkit-sidebar",
    type: "SET_SIDEBAR_COLLAPSED",
    payload: { collapsed: true },
  },
});
for (const [x, y] of [
  [34, 34],
  [356, 34],
  [34, 726],
  [356, 726],
  [195, 380],
]) {
  moveBubble(x, y);
  const layout = vm.runInThisContext("floatingLayout(true)");
  assert.ok(
    layout.left >= 0 &&
      layout.top >= 0 &&
      layout.left + layout.width <= 390 &&
      layout.top + layout.height <= 760,
    "radial layout remains on screen at every edge",
  );
}
assert.ok(
  storedPosition.douyinFloatingPosition.x > 0 &&
    storedPosition.douyinFloatingPosition.x < 1,
);
moveBubble(-1000, 5000);
assert.equal(vm.runInThisContext("floatingLayout(false)").x, 34);
assert.equal(vm.runInThisContext("floatingLayout(false)").y, 726);
window.innerHeight = 400;
windowListeners.get("resize")();
assert.ok(
  vm.runInThisContext("floatingLayout(true)").top +
    vm.runInThisContext("floatingLayout(true)").height <=
    400,
);
console.log(
  "OK: radial menu at four corners, drag clamp, remembered position and resize",
);
