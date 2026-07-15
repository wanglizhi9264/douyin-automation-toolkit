import fs from "node:fs";
import path from "node:path";

function asBoolean(value) {
  return value === true || value === 1 || value === "1";
}

export async function fetchSelfProfile(page) {
  return page.evaluate(async () => {
    const endpoint = "/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383&channel=channel_pc_web&publish_video_strategy_type=2&source=channel_pc_web";
    const response = await fetch(endpoint, { credentials: "include" });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, httpStatus: response.status, text: text.slice(0, 500) };
    }
    return {
      ok: response.ok && (json.status_code == null || json.status_code === 0),
      httpStatus: response.status,
      statusCode: json.status_code,
      statusMsg: json.status_msg,
      json,
    };
  });
}

export async function fetchLikedPage(page, {
  secUid,
  maxCursor = 0,
  minCursor = 0,
  count = 18,
}) {
  return page.evaluate(async (input) => {
    const params = new URLSearchParams({
      device_platform: "webapp",
      aid: "6383",
      channel: "channel_pc_web",
      sec_user_id: input.secUid,
      max_cursor: String(input.maxCursor || 0),
      min_cursor: String(input.minCursor || 0),
      count: String(input.count || 18),
      publish_video_strategy_type: "2",
      whale_cut_token: "",
      cut_version: "1",
    });
    const response = await fetch("/aweme/v1/web/aweme/favorite/?" + params, {
      credentials: "include",
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, httpStatus: response.status, text: text.slice(0, 500) };
    }
    const awemeList = json.aweme_list || json.awemeList || [];
    return {
      ok: response.ok
        && (json.status_code == null || json.status_code === 0)
        && Array.isArray(awemeList),
      httpStatus: response.status,
      statusCode: json.status_code,
      statusMsg: json.status_msg,
      awemeList,
      hasMore: json.has_more === true || json.has_more === 1 || json.has_more === "1",
      maxCursor: json.max_cursor ?? json.maxCursor ?? input.maxCursor,
      minCursor: json.min_cursor ?? json.minCursor ?? input.minCursor,
    };
  }, { secUid, maxCursor, minCursor, count });
}

export async function fetchBookmarkedPage(page, {
  cursor = 0,
  count = 10,
}) {
  return page.evaluate(async (input) => {
    const params = new URLSearchParams({
      device_platform: "webapp",
      aid: "6383",
      channel: "channel_pc_web",
      publish_video_strategy_type: "2",
    });
    const body = new URLSearchParams({
      count: String(input.count || 10),
      cursor: String(input.cursor || 0),
    });
    const response = await fetch("/aweme/v1/web/aweme/listcollection/?" + params, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, httpStatus: response.status, text: text.slice(0, 500) };
    }
    const awemeList = json.aweme_list || json.awemeList || [];
    return {
      ok: response.ok
        && (json.status_code == null || json.status_code === 0)
        && Array.isArray(awemeList),
      httpStatus: response.status,
      statusCode: json.status_code,
      statusMsg: json.status_msg,
      awemeList,
      hasMore: json.has_more === true || json.has_more === 1 || json.has_more === "1",
      cursor: json.cursor ?? input.cursor,
      total: Number(json.total ?? json.total_count ?? 0) || 0,
    };
  }, { cursor, count });
}

export async function fetchAwemeDetail(page, awemeId) {
  return page.evaluate(async (id) => {
    const params = new URLSearchParams({
      device_platform: "webapp",
      aid: "6383",
      channel: "channel_pc_web",
      aweme_id: id,
    });
    const response = await fetch("/aweme/v1/web/aweme/detail/?" + params, {
      credentials: "include",
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, httpStatus: response.status, text: text.slice(0, 500) };
    }
    const aweme = json.aweme_detail || json.aweme || json.item || json.data || null;
    return {
      ok: response.ok
        && (json.status_code == null || json.status_code === 0)
        && Boolean(aweme),
      httpStatus: response.status,
      statusCode: json.status_code,
      statusMsg: json.status_msg,
      aweme,
      desc: aweme?.desc || "",
      authorUid: aweme?.author?.uid || "",
      authorName: aweme?.author?.nickname || "",
      createTime: aweme?.create_time || 0,
      coverUrl: aweme?.video?.cover?.url_list?.[0] || "",
    };
  }, String(awemeId));
}

export async function requestWithRetry(task, {
  retries = 3,
  delayForAttempt = (attempt) => 7000 * attempt,
  onRetry = null,
} = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const result = await task(attempt);
      if (result?.ok) return result;
      lastError = new Error([
        result?.statusMsg,
        result?.text,
        result?.statusCode != null ? "status_code=" + result.statusCode : "",
        result?.httpStatus != null ? "HTTP " + result.httpStatus : "",
      ].filter(Boolean).join(" ") || "request failed");
    } catch (error) {
      lastError = error;
    }
    if (attempt >= retries) break;
    const delayMs = delayForAttempt(attempt);
    if (onRetry) onRetry({ attempt, delayMs, error: lastError });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw lastError || new Error("request failed");
}

export async function downloadMedia(context, url, destination, {
  expected = "video",
  timeoutMs = 120000,
} = {}) {
  const response = await context.request.get(url, {
    failOnStatusCode: false,
    timeout: timeoutMs,
    headers: {
      accept: "*/*",
      referer: "https://www.douyin.com/",
    },
  });
  const status = response.status();
  const headers = response.headers();
  const contentType = headers["content-type"] || "";
  const contentLength = Number(headers["content-length"] || 0);
  if (status === 206) throw new Error("unexpected partial response HTTP 206");
  if (status < 200 || status >= 300) throw new Error("media HTTP " + status);
  if (expected === "video" && !contentType.includes("video/mp4")) {
    throw new Error("video MIME is " + (contentType || "unknown"));
  }
  if (expected === "image" && !contentType.startsWith("image/")) {
    throw new Error("cover MIME is " + (contentType || "unknown"));
  }
  if (expected === "video" && !contentLength) {
    throw new Error("video content-length is missing");
  }

  const body = await response.body();
  if (!body.length) throw new Error("media body is 0 bytes");
  if (contentLength && body.length !== contentLength) {
    throw new Error("media size mismatch " + body.length + "/" + contentLength);
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporaryPath = destination + ".part";
  try {
    fs.writeFileSync(temporaryPath, body);
    fs.rmSync(destination, { force: true });
    fs.renameSync(temporaryPath, destination);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
  return {
    ok: true,
    httpStatus: status,
    contentType,
    contentLength: body.length,
    sizeLabel: (body.length / 1024 / 1024).toFixed(1) + "MB",
  };
}

export function booleanResponse(value) {
  return asBoolean(value);
}
