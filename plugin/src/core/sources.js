import { parseLikedProfile } from "../shared/liked-sync.js";
import { parseBookmarkedProfile } from "../shared/bookmarked-sync.js";
import { sleep, checkAbort } from "./model.js";
import { countOrUnknown } from "./progress.js";
import { httpError } from "../shared/http.js";
import { RetryCoordinator } from "./retry.js";
import { inspectPage, cursorKey, PaginationError } from "./pagination.js";

// One page request at a time; media transfers use their own two-slot pool.
export class Sources {
  constructor(
    request,
    {
      intervals = {
        liked: 5000,
        bookmarked: 3000,
        following: 1200,
        detail: 400,
      },
      paginationDelays = [1200, 3000],
      paginationWait = sleep,
      maxEmptyPages = 12,
    } = {},
  ) {
    this.request = request;
    this.intervals = intervals;
    this.paginationDelays = paginationDelays;
    this.paginationWait = paginationWait;
    this.maxEmptyPages = maxEmptyPages;
    this.chain = Promise.resolve();
    this.nextAt = 0;
    this.retry = new RetryCoordinator();
  }
  call(type, payload, signal, interval = 0) {
    const operation = async () => {
      checkAbort(signal);
      await sleep(Math.max(0, this.nextAt - Date.now()), signal);
      try {
        const result = await this.retry.run(
          async () => {
            const response = await this.request(type, payload, 60000, signal);
            if (!response?.ok)
              throw httpError(
                response?.httpStatus || 0,
                response?.retryAfter,
                response?.httpStatus
                  ? `接口请求失败：HTTP ${response.httpStatus}`
                  : response?.error ||
                      response?.message ||
                      response?.statusMsg ||
                      "接口读取失败，请检查抖音登录状态",
              );
            return response;
          },
          {
            signal,
            label: "列表 / 作品详情",
            onRetry: (info) => this.onRetry?.(info),
          },
        );
        checkAbort(signal);
        if (!result?.ok)
          throw new Error(
            result?.error ||
              result?.message ||
              "接口读取失败，请检查抖音登录状态",
          );
        return result;
      } finally {
        this.nextAt = Date.now() + interval;
      }
    };
    const result = this.chain.then(operation);
    this.chain = result.catch(() => {});
    return result;
  }
  async profile(signal) {
    const raw = await this.call("GET_SELF_PROFILE", {}, signal);
    const profile = parseLikedProfile(raw);
    if (!profile.uid || !profile.secUid)
      throw new Error("无法确认当前账号，请先登录抖音并刷新页面");
    profile.bookmarkedTotal = parseBookmarkedProfile(raw).expectedTotal;
    const user = raw.json?.user || raw.json?.user_info || raw.json;
    const readCount = (keys) => {
      for (const key of keys) {
        const value = countOrUnknown(user?.[key]);
        if (value !== null) return value;
      }
      return null;
    };
    profile.totals = {
      liked: readCount(["favoriting_count", "favoritingCount"]),
      bookmarked: readCount([
        "collect_count",
        "collection_count",
        "aweme_collect_count",
        "collectCount",
      ]),
    };
    profile.totals.bookmarked ??= countOrUnknown(raw.bookmarkedCount);
    profile.bookmarkedDisplay =
      typeof raw.bookmarkedDisplay === "string" &&
      /^约[\d.]+[万亿w]$/i.test(raw.bookmarkedDisplay)
        ? raw.bookmarkedDisplay
        : null;
    profile.followingAuthorTotal = readCount([
      "following_count",
      "followingCount",
    ]);
    profile.readAt = new Date().toISOString();
    return profile;
  }
  async probeBookmarkedTotal(profile, signal) {
    const page = await this.call(
      "FETCH_BOOKMARKED_PAGE",
      { cursor: 0, count: 10 },
      signal,
      this.intervals.bookmarked,
    );
    if (!Array.isArray(page.awemeList) || typeof page.hasMore !== "boolean")
      return;
    this.bookmarkedFirstPage = { uid: profile.uid, page, at: Date.now() };
    const total = page.hasTotal === true ? countOrUnknown(page.total) : null;
    if (total !== null) profile.totals.bookmarked = total;
    profile.readAt = new Date().toISOString();
  }
  async bookmarkedPage(profile, cursor, signal, interval) {
    const cached = this.bookmarkedFirstPage;
    this.bookmarkedFirstPage = null;
    if (
      !(cursor.cursor || 0) &&
      cached?.uid === profile.uid &&
      Date.now() - cached.at < 15000
    )
      return cached.page;
    return this.call(
      "FETCH_BOOKMARKED_PAGE",
      { cursor: cursor.cursor || 0, count: 10 },
      signal,
      interval,
    );
  }
  detail(id, signal) {
    return this.call(
      "FETCH_AWEME_DETAIL",
      { awemeId: id },
      signal,
      this.intervals.detail,
    );
  }
  async authors(profile, cursor, signal) {
    const current = cursor || { offset: 0, maxTime: 0, minTime: 0 };
    const page = await this.call(
      "FETCH_FOLLOWING_PAGE",
      { userId: profile.uid, secUid: profile.secUid, count: 20, ...current },
      signal,
      this.intervals.following,
    );
    if (!Array.isArray(page.users) || typeof page.hasMore !== "boolean")
      throw new Error("关注列表格式异常");
    const authors = page.users
      .map((raw) => ({
        uid: String(raw.uid || raw.id || raw.user_info?.uid || ""),
        secUid: String(
          raw.sec_uid ||
            raw.secUid ||
            raw.sec_user_id ||
            raw.user_info?.sec_uid ||
            "",
        ),
        nickname: raw.nickname || raw.user_info?.nickname || "未命名作者",
        awemeCount: Number(raw.aweme_count || 0),
      }))
      .filter((a) => a.uid && a.secUid);
    if (authors.length !== page.users.length)
      throw new Error("关注列表未返回有效作者标识，请稍后重试");
    const next = {
      offset: page.offset ?? current.offset + page.users.length,
      // The response max_time is the newest entry of THIS page. Reusing it
      // repeats that page. Its min_time is the boundary for older follows.
      maxTime:
        Number(page.minTime) > 0
          ? page.minTime
          : (page.maxTime ?? current.maxTime),
      minTime: 0,
    };
    if (page.hasMore && JSON.stringify(next) === JSON.stringify(current))
      throw new Error("关注列表未读完，接口没有返回下一页。可稍后重试");
    return { authors, cursor: next, done: page.hasMore === false };
  }
  async page(task, profile, signal, { seenCursors } = {}) {
    const scope = task.scope,
      cursor = task.cursor || {},
      interval = this.intervals[scope];
    const authorIndex = cursor.authorIndex || 0;
    if (scope === "following" && !task.authors[authorIndex])
      return { items: [], cursor, done: true, trace: [] };
    const observed = new Map(),
      trace = [];
    let endings = 0,
      lastReason = "分页响应异常";
    const request = () =>
      scope === "liked"
        ? this.call(
            "FETCH_LIKED_PAGE",
            {
              secUid: profile.secUid,
              maxCursor: cursor.maxCursor || 0,
              minCursor: cursor.minCursor || 0,
              count: 18,
            },
            signal,
            interval,
          )
        : scope === "bookmarked"
          ? this.bookmarkedPage(profile, cursor, signal, interval)
          : this.call(
              "FETCH_AUTHOR_AWEME_PAGE",
              {
                secUid: task.authors[authorIndex].secUid,
                maxCursor: cursor.maxCursor || 0,
                count: 18,
              },
              signal,
              interval,
            );
    for (let attempt = 0; attempt <= this.paginationDelays.length; attempt++) {
      checkAbort(signal);
      const page = await request();
      checkAbort(signal);
      for (const item of Array.isArray(page.awemeList) ? page.awemeList : []) {
        const id = String(item?.aweme_id || item?.awemeId || item?.id || "");
        if (id) observed.set(id, item);
      }
      if (
        scope === "bookmarked" &&
        page.hasTotal === true &&
        countOrUnknown(page.total) !== null
      ) {
        profile.totals ||= {};
        profile.totals.bookmarked = countOrUnknown(page.total);
        profile.readAt = new Date().toISOString();
      }
      const result = inspectPage(page, scope, cursor);
      result.attempt = attempt + 1;
      if (result.decision === "end") {
        endings++;
        if (!result.confirm || endings >= 2) {
          trace.push({
            ...result,
            decision: "end_confirmed",
            confirmations: endings,
          });
          const next =
            scope === "following"
              ? { authorIndex: authorIndex + 1, maxCursor: 0 }
              : result.next;
          const done =
            scope !== "following" || authorIndex + 1 >= task.authors.length;
          return {
            items: [...observed.values()],
            cursor: next,
            done,
            trace,
            emptyPages: 0,
            end: {
              kind: result.reason,
              confirmations: endings,
              responseCursor: result.outputCursor,
              at: result.at,
            },
          };
        }
        result.decision = "confirm_end";
        lastReason = "末页使用非零游标，正在确认列表终点";
      } else {
        endings = 0;
        if (["continue", "skip_empty"].includes(result.decision)) {
          if (seenCursors?.has(cursorKey(result.next, scope))) {
            result.decision = "retry";
            result.reason = "分页游标出现循环";
          } else {
            const emptyPages =
              result.decision === "skip_empty"
                ? (task.sourceEmptyPages || 0) + 1
                : 0;
            if (emptyPages <= this.maxEmptyPages) {
              trace.push(result);
              return {
                items: [...observed.values()],
                cursor: result.next,
                done: false,
                trace,
                emptyPages,
              };
            }
            result.decision = "retry";
            result.reason = `已连续跨过 ${this.maxEmptyPages} 个空页，暂缓继续读取`;
          }
        }
        lastReason = result.reason;
      }
      trace.push(result);
      if (attempt < this.paginationDelays.length) {
        await this.onPaginationRetry?.({
          message:
            result.decision === "confirm_end"
              ? "正在确认列表最后一页…"
              : `列表翻页暂时没有推进，正在自动重试 ${attempt + 1}/${this.paginationDelays.length}…`,
          trace: result,
        });
        await this.paginationWait(this.paginationDelays[attempt], signal);
      }
    }
    throw new PaginationError(lastReason, {
      items: [...observed.values()],
      cursor: task.cursor,
      trace,
    });
  }
}
