export function httpError(status, retryAfter = null, message = "") {
  const error = new Error(message || `HTTP ${status}`);
  error.httpStatus = Number(status);
  error.retryAfter = retryAfter;
  return error;
}
export function httpStatus(error) {
  return Number(
    error?.httpStatus || error?.message?.match(/HTTP\s*(\d{3})/i)?.[1] || 0,
  );
}
export function retryAfterMs(value, now = Date.now()) {
  if (value === null || value === undefined || String(value).trim() === "")
    return 0;
  const text = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.ceil(Number(text) * 1000);
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}
