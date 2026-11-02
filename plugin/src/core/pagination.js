const own = (object, key) =>
  Object.prototype.hasOwnProperty.call(object || {}, key);
const token = (value) => {
  const text = String(value ?? 0);
  try {
    return /^-?\d+$/.test(text) ? BigInt(text).toString() : text;
  } catch {
    return text;
  }
};
export function cursorKey(cursor, scope) {
  const known =
    scope === "liked"
      ? ["maxCursor", "minCursor"]
      : scope === "bookmarked"
        ? ["cursor"]
        : ["authorIndex", "maxCursor"];
  const value = cursor || {};
  const fields = Object.keys(value).some((k) => !known.includes(k))
    ? Object.keys(value)
    : known;
  return JSON.stringify(fields.sort().map((key) => [key, token(value[key])]));
}
export function inspectPage(page, scope, input) {
  const current = input || {},
    json = page?.json;
  const rawFlag = json ? (json.has_more ?? json.hasMore) : page?.hasMore;
  const hasMore = [true, 1, "1"].includes(rawFlag)
    ? true
    : [false, 0, "0"].includes(rawFlag)
      ? false
      : null;
  const mainKey = scope === "bookmarked" ? "cursor" : "maxCursor";
  const rawKey = scope === "bookmarked" ? "cursor" : "max_cursor";
  const cursorPresent = json
    ? own(json, rawKey) || own(json, mainKey)
    : own(page, mainKey);
  const returned = cursorPresent
    ? json
      ? (json[rawKey] ?? json[mainKey])
      : page[mainKey]
    : (current[mainKey] ?? 0);
  const next =
    scope === "bookmarked"
      ? { cursor: returned }
      : scope === "following"
        ? { authorIndex: current.authorIndex || 0, maxCursor: returned }
        : {
            maxCursor: returned,
            minCursor: page?.minCursor ?? current.minCursor ?? 0,
          };
  const trace = {
    at: new Date().toISOString(),
    scope,
    inputCursor: structuredClone(current),
    outputCursor: next,
    hasMore,
    hasMorePresent: json
      ? own(json, "has_more") || own(json, "hasMore")
      : typeof page?.hasMore === "boolean",
    cursorPresent,
    itemCount: Array.isArray(page?.awemeList) ? page.awemeList.length : null,
    httpStatus: page?.httpStatus ?? null,
    statusCode: page?.statusCode ?? null,
  };
  const bad = (reason) => ({ ...trace, decision: "retry", reason, next });
  if (
    !Array.isArray(page?.awemeList) ||
    hasMore === null ||
    (json && !own(json, "aweme_list") && !own(json, "awemeList"))
  )
    return bad("响应缺少有效列表或分页标记");
  if (hasMore !== page.hasMore) return bad("分页标记解析不一致");
  const text = String(returned ?? "");
  const valid =
    typeof returned === "number"
      ? Number.isSafeInteger(returned) &&
        (returned >= 0 || (!hasMore && returned === -1))
      : typeof returned === "string" &&
        (/^\d+$/.test(text) || (!hasMore && ["", "-1"].includes(text)));
  if (cursorPresent && !valid) return bad("响应游标格式异常");
  if (!hasMore)
    return {
      ...trace,
      decision: "end",
      reason:
        cursorPresent && token(returned) === "0"
          ? "canonical_end"
          : "explicit_end",
      confirm: !(cursorPresent && token(returned) === "0"),
      next,
    };
  if (!cursorPresent) return bad("还有下一页，但响应未提供游标");
  if (token(returned) === "0") return bad("还有下一页，但游标回到了起点");
  if (cursorKey(next, scope) === cursorKey(current, scope))
    return bad("还有下一页，但游标没有前进");
  return {
    ...trace,
    decision: page.awemeList.length ? "continue" : "skip_empty",
    reason: page.awemeList.length ? "cursor_advanced" : "empty_page_advanced",
    next,
  };
}
export class PaginationError extends Error {
  constructor(reason, { items = [], cursor = null, trace = [] } = {}) {
    super(`列表暂时未能继续：${reason}。已保留进度，可稍后继续。`);
    this.name = "PaginationError";
    this.page = { items, cursor, done: false, trace };
  }
}
