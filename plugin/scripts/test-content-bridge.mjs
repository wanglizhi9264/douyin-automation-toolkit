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
    contentWindow: tagName === "iframe" ? {
      postMessage(data, origin) {
        forwarded.push({ data, origin });
      },
    } : null,
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

const source = fs.readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
vm.runInThisContext(source, { filename: "content.js" });

const frame = elements.get("douyin-toolkit-sidebar");
assert.ok(frame, "sidebar iframe should be appended during startup");

windowListeners.get("message")({
  source: globalThis.window,
  data: { source: "douyin-toolkit-page", type: "BOOT", payload: { ok: true } },
});
assert.equal(forwarded.length, 0, "page messages should wait until iframe load");

frame.dispatch("load");
assert.equal(forwarded.length, 1, "queued page message should flush after iframe load");
assert.equal(forwarded[0].origin, "chrome-extension://test-extension");
assert.equal(forwarded[0].data.type, "BOOT");

windowListeners.get("message")({
  origin: "chrome-extension://test-extension",
  data: {
    source: "douyin-toolkit-sidebar",
    type: "SET_SIDEBAR_COLLAPSED",
    payload: { collapsed: true },
  },
});
assert.equal(frame.attributes.get("data-collapsed"), "true", "sidebar should collapse into its compact handle");
assert.equal(forwarded.at(-1).data.type, "SIDEBAR_COLLAPSE_STATE");

windowListeners.get("message")({
  origin: "chrome-extension://test-extension",
  data: {
    source: "douyin-toolkit-sidebar",
    type: "SET_SIDEBAR_COLLAPSED",
    payload: { collapsed: false },
  },
});
assert.equal(frame.attributes.get("data-collapsed"), "false", "sidebar should expand from its compact handle");

runtimeListeners[0]({ type: "TOGGLE_SIDEBAR" });
assert.equal(frame.style.display, "none", "toolbar click should hide an open sidebar");
runtimeListeners[0]({ type: "TOGGLE_SIDEBAR" });
assert.equal(frame.style.display, "block", "second toolbar click should show the sidebar");

const forwardedBeforeCloneError = forwarded.length;
globalThis.window.postMessage = () => {
  throw new DOMException("clone failed", "DataCloneError");
};
windowListeners.get("message")({
  origin: "chrome-extension://test-extension",
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
assert.equal(elements.has("douyin-toolkit-sidebar"), false, "close should remove the sidebar");
runtimeListeners[0]({ type: "TOGGLE_SIDEBAR" });
const recreatedFrame = elements.get("douyin-toolkit-sidebar");
assert.ok(recreatedFrame, "toolbar click should recreate a closed sidebar");
recreatedFrame.dispatch("load");

console.log("OK: content bridge runtime smoke test passed");
