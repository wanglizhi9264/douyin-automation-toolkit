let sequence = 0;
const pending = new Map();

export function sendPageRequest(type, payload = {}, timeoutMs = 30000, signal) {
  const requestId = `req-${Date.now()}-${sequence++}`;
  const message = {
    source: "douyin-toolkit-sidebar",
    requestId,
    type,
    payload,
  };
  return new Promise((resolve, reject) => {
    if(signal?.aborted){reject(new DOMException('任务已暂停','AbortError'));return;}
    const cleanup=()=>signal?.removeEventListener('abort',stop);
    const stop=()=>{clearTimeout(timeout);pending.delete(requestId);cleanup();reject(new DOMException('任务已暂停','AbortError'));};
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      cleanup();
      reject(new Error(`${type} timed out`));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timeout, cleanup });
    signal?.addEventListener('abort',stop,{once:true});
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
  entry.cleanup?.();
  pending.delete(message.requestId);
  if (message.error) entry.reject(new Error(message.error));
  else entry.resolve(message.payload);
});
