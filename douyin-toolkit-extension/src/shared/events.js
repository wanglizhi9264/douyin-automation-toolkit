let sequence = 0;
const pending = new Map();

export function sendPageRequest(type, payload = {}, timeoutMs = 30000) {
  const requestId = `req-${Date.now()}-${sequence++}`;
  const message = {
    source: "douyin-toolkit-sidebar",
    requestId,
    type,
    payload,
  };
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`${type} timed out`));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timeout });
    parent.postMessage(message, "*");
  });
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.source !== "douyin-toolkit-page") return;
  if (message.requestId === "boot") {
    window.dispatchEvent(new CustomEvent("douyin-toolkit-boot", { detail: message.payload }));
    return;
  }
  const entry = pending.get(message.requestId);
  if (!entry) return;
  clearTimeout(entry.timeout);
  pending.delete(message.requestId);
  if (message.error) entry.reject(new Error(message.error));
  else entry.resolve(message.payload);
});
