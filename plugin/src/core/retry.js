import { sleep, checkAbort } from "./model.js";
import { httpStatus, retryAfterMs } from "../shared/http.js";
export class RetryCoordinator {
  constructor({
    now = Date.now,
    wait = sleep,
    random = Math.random,
    rateBaseMs = 15000,
    transientBaseMs = 2000,
    maxRateRetries = 5,
    maxTransientRetries = 5,
    maxForbiddenRetries = 5,
    forbiddenBaseMs = 2500,
  } = {}) {
    Object.assign(this, {
      now,
      wait,
      random,
      rateBaseMs,
      transientBaseMs,
      maxRateRetries,
      maxTransientRetries,
      maxForbiddenRetries,
      forbiddenBaseMs,
    });
    this.until = 0;
    this.last = null;
    this.listeners = new Set();
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit() {
    for (const listener of this.listeners) listener(this.info);
  }
  get info() {
    return this.until > this.now() ? { ...this.last, until: this.until } : null;
  }
  restore(info) {
    if (info?.until > this.until) {
      this.until = info.until;
      this.last = { ...info };
      this.emit();
    }
  }
  async ready(signal) {
    while (this.until > this.now()) {
      checkAbort(signal);
      await this.wait(Math.min(60000, this.until - this.now()), signal);
    }
    checkAbort(signal);
    if (this.last && this.until <= this.now()) {
      this.last = null;
      this.until = 0;
      this.emit();
    }
  }
  async run(
    operation,
    { signal, onRetry, label = "请求", retryForbidden = false } = {},
  ) {
    for (let attempt = 0; ; attempt++) {
      await this.ready(signal);
      try {
        return await operation();
      } catch (error) {
        checkAbort(signal);
        const status = httpStatus(error),
          rate = status === 429,
          forbidden = retryForbidden && status === 403;
        const transient =
          error.retryable === true ||
          [408, 425, 500, 502, 503, 504].includes(status) ||
          (!status &&
            /Failed to fetch|network(?:\s*error)?|connection (?:reset|closed|aborted)|网络|超时|timed out|fetch failed/i.test(
              error.message || "",
            ));
        if (!rate && !transient && !forbidden) throw error;
        const max = rate
          ? this.maxRateRetries
          : forbidden
            ? this.maxForbiddenRetries
            : this.maxTransientRetries;
        const base =
          (rate
            ? this.rateBaseMs
            : forbidden
              ? this.forbiddenBaseMs
              : this.transientBaseMs) *
          2 ** Math.min(attempt, 5);
        const delay = Math.max(
          retryAfterMs(error.retryAfter, this.now()),
          Math.min(base, rate ? 300000 : 30000) * (1 + this.random() * 0.2),
        );
        const info = {
          until: Math.max(
            this.until,
            this.now() + (forbidden && attempt >= max ? 0 : Math.ceil(delay)),
          ),
          status,
          attempt: attempt + 1,
          maxRetries: max,
          label,
          reason: rate
            ? "HTTP 429 限流"
            : forbidden
              ? "媒体暂不可访问，稍后重试"
              : "暂时性请求失败",
          exhausted: attempt >= max,
        };
        this.until = info.until;
        this.last = info;
        this.emit();
        await onRetry?.(info);
        if (attempt >= max) {
          error.retryExhausted = true;
          error.retryUntil = info.until;
          error.message += `；自动重试已达上限，进度已保留`;
          throw error;
        }
      }
    }
  }
}
