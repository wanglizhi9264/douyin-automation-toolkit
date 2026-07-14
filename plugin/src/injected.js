const TOOLKIT_SOURCE = "douyin-toolkit-page";

function reply(requestId, type, payload, error = null) {
  window.postMessage({
    source: TOOLKIT_SOURCE,
    requestId,
    type,
    payload,
    error,
  }, "https://www.douyin.com");
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: "include",
    ...options,
    headers: {
      "accept": "application/json, text/plain, */*",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      ok: false,
      httpStatus: response.status,
      text: text.slice(0, 500),
    };
  }
  return {
    ok: response.ok && (json.status_code == null || json.status_code === 0),
    httpStatus: response.status,
    statusCode: json.status_code,
    statusMsg: json.status_msg,
    json,
  };
}

function webParams() {
  const userAgent = navigator.userAgent || "";
  const browserVersion = userAgent.match(/(?:Edg|Chrome)\/(\d+(?:\.\d+)*)/)?.[1] || "";
  const platform = navigator.platform || "";
  const connection = navigator.connection || {};
  return new URLSearchParams({
    device_platform: "webapp",
    aid: "6383",
    channel: "channel_pc_web",
    version_code: "170400",
    version_name: "17.4.0",
    update_version_code: "170400",
    cookie_enabled: String(Boolean(navigator.cookieEnabled)),
    screen_width: String(globalThis.screen?.width || 0),
    screen_height: String(globalThis.screen?.height || 0),
    browser_language: navigator.language || "zh-CN",
    browser_platform: platform,
    browser_name: userAgent.includes("Edg/") ? "Edge" : "Chrome",
    browser_version: browserVersion,
    browser_online: String(navigator.onLine !== false),
    engine_name: "Blink",
    engine_version: browserVersion,
    os_name: platform.includes("Win") ? "Windows" : (platform.includes("Mac") ? "Mac OS" : ""),
    cpu_core_num: String(navigator.hardwareConcurrency || 0),
    device_memory: String(navigator.deviceMemory || ""),
    platform: "PC",
    downlink: String(connection.downlink || ""),
    effective_type: connection.effectiveType || "",
    round_trip_time: String(connection.rtt || ""),
  });
}

async function getSelfProfile() {
  const params = webParams();
  params.set("publish_video_strategy_type", "2");
  params.set("source", "channel_pc_web");
  const result = await fetchJson(`/aweme/v1/web/user/profile/self/?${params}`);
  return result;
}

async function collectAweme(awemeId) {
  const params = webParams();
  params.set("aweme_id", awemeId);
  params.set("action", "1");
  return fetchJson(`/aweme/v1/web/aweme/collect/?${params}`, { method: "POST" });
}

function asBoolean(value) {
  return value === true || value === 1 || value === "1";
}

async function fetchLikedPage(secUid, maxCursor = 0, minCursor = 0, count = 18) {
  const params = webParams();
  params.set("sec_user_id", secUid);
  params.set("max_cursor", String(maxCursor || 0));
  params.set("min_cursor", String(minCursor || 0));
  params.set("count", String(count || 18));
  params.set("publish_video_strategy_type", "2");
  params.set("whale_cut_token", "");
  params.set("cut_version", "1");
  const result = await fetchJson(`/aweme/v1/web/aweme/favorite/?${params}`);
  const awemeList = result.json?.aweme_list || result.json?.awemeList || [];
  return {
    ...result,
    ok: result.ok && Array.isArray(awemeList),
    awemeList,
    hasMore: asBoolean(result.json?.has_more ?? result.json?.hasMore),
    maxCursor: result.json?.max_cursor ?? result.json?.maxCursor ?? maxCursor,
    minCursor: result.json?.min_cursor ?? result.json?.minCursor ?? minCursor,
  };
}

async function fetchAwemeDetail(awemeId) {
  const params = webParams();
  params.set("aweme_id", awemeId);
  const result = await fetchJson(`/aweme/v1/web/aweme/detail/?${params}`);
  const aweme = result.json?.aweme_detail || result.json?.aweme || result.json?.item || result.json?.data || null;
  return {
    ...result,
    ok: result.ok && Boolean(aweme),
    collectStat: aweme?.collect_stat ?? null,
    desc: aweme?.desc ?? "",
    authorName: aweme?.author?.nickname ?? "",
    authorUid: aweme?.author?.uid ?? "",
    createTime: aweme?.create_time ?? 0,
    coverUrl: aweme?.video?.cover?.url_list?.[0] || "",
    aweme,
  };
}

async function writeToHandle(rootHandle, relativePath, data) {
  const parts = String(relativePath || "").split("/").filter(Boolean);
  const fileName = parts.pop();
  let dir = rootHandle;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  const file = await dir.getFileHandle(fileName, { create: true });
  const writable = await file.createWritable();
  await writable.write(data);
  await writable.close();
}

async function precheckUrl(url, { expected = "video" } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(url, {
      credentials: "omit",
      mode: "cors",
      signal: controller.signal,
      headers: {
        "accept": "*/*",
      },
    });
  } catch (error) {
    throw new Error(`预检失败：${error?.message || String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
  const contentType = response.headers.get("content-type") || "";
  const contentLength = Number(response.headers.get("content-length") || 0);
  const acceptRanges = response.headers.get("accept-ranges") || "";
  if (!String(response.status).startsWith("2")) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error(`预检失败：HTTP ${response.status}`);
  }
  if (response.status === 206) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error("预检失败：分段响应 206");
  }
  if (expected === "video" && !contentType.includes("video/mp4")) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error(`预检失败：视频 MIME 为 ${contentType || "unknown"}`);
  }
  if (expected === "image" && !contentType.startsWith("image/")) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error(`预检失败：封面 MIME 为 ${contentType || "unknown"}`);
  }
  if (expected === "video" && !contentLength) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error("预检失败：未知视频大小");
  }
  await response.body?.cancel?.().catch(() => {});
  return {
    ok: true,
    httpStatus: response.status,
    contentType,
    contentLength,
    acceptRanges,
    sizeLabel: contentLength ? `${(contentLength / 1024 / 1024).toFixed(1)}MB` : "",
  };
}

async function downloadToFolder(rootHandle, relativePath, url, options = {}) {
  const expected = options.expected || "video";
  const precheck = options.precheck?.ok ? options.precheck : await precheckUrl(url, { expected });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 100000);
  let response;
  try {
    response = await fetch(url, {
      credentials: "omit",
      mode: "cors",
      signal: controller.signal,
      headers: { "accept": "*/*" },
    });
  } catch (error) {
    throw new Error(`页面抓取失败：${error?.message || String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`页面抓取失败：HTTP ${response.status}`);
  const blob = await response.blob();
  if (!blob.size) throw new Error("页面抓取失败：0 字节");
  if (precheck.contentLength && blob.size !== precheck.contentLength) {
    throw new Error(`页面抓取失败：大小不一致 ${blob.size}/${precheck.contentLength}`);
  }
  await writeToHandle(rootHandle, relativePath, blob);
  return {
    ok: true,
    size: blob.size,
    contentType: blob.type || "",
    precheck,
  };
}

async function downloadToFolderOnce(rootHandle, relativePath, url, options = {}) {
  const expected = options.expected || "video";
  const controller = new AbortController();
  const headerTimeout = setTimeout(() => controller.abort(), 15000);
  const totalTimeout = setTimeout(() => controller.abort(), 100000);
  try {
    const response = await fetch(url, {
      credentials: "omit",
      mode: "cors",
      signal: controller.signal,
      headers: { "accept": "*/*" },
    });
    clearTimeout(headerTimeout);
    const contentType = response.headers.get("content-type") || "";
    const contentLength = Number(response.headers.get("content-length") || 0);
    const acceptRanges = response.headers.get("accept-ranges") || "";
    if (!String(response.status).startsWith("2")) {
      throw new Error("\u9875\u9762\u6293\u53d6\u5931\u8d25\uff1aHTTP " + response.status);
    }
    if (response.status === 206) {
      throw new Error("\u9875\u9762\u6293\u53d6\u5931\u8d25\uff1a\u5206\u6bb5\u54cd\u5e94 206");
    }
    if (expected === "video" && !contentType.includes("video/mp4")) {
      throw new Error("\u9875\u9762\u6293\u53d6\u5931\u8d25\uff1a\u89c6\u9891 MIME \u4e3a " + (contentType || "unknown"));
    }
    if (expected === "image" && !contentType.startsWith("image/")) {
      throw new Error("\u9875\u9762\u6293\u53d6\u5931\u8d25\uff1a\u5c01\u9762 MIME \u4e3a " + (contentType || "unknown"));
    }
    if (expected === "video" && !contentLength) {
      throw new Error("\u9875\u9762\u6293\u53d6\u5931\u8d25\uff1a\u672a\u77e5\u89c6\u9891\u5927\u5c0f");
    }
    const blob = await response.blob();
    if (!blob.size) {
      throw new Error("\u9875\u9762\u6293\u53d6\u5931\u8d25\uff1a0 \u5b57\u8282");
    }
    if (contentLength && blob.size !== contentLength) {
      throw new Error("\u9875\u9762\u6293\u53d6\u5931\u8d25\uff1a\u5927\u5c0f\u4e0d\u4e00\u81f4 " + blob.size + "/" + contentLength);
    }
    await writeToHandle(rootHandle, relativePath, blob);
    return {
      ok: true,
      size: blob.size,
      contentType: blob.type || contentType,
      precheck: {
        ok: true,
        httpStatus: response.status,
        contentType,
        contentLength: blob.size,
        acceptRanges,
        sizeLabel: (blob.size / 1024 / 1024).toFixed(1) + "MB",
      },
    };
  } catch (error) {
    controller.abort();
    if (String(error?.message || "").startsWith("\u9875\u9762\u6293\u53d6\u5931\u8d25")) throw error;
    throw new Error("\u9875\u9762\u6293\u53d6\u5931\u8d25\uff1a" + (error?.message || String(error)));
  } finally {
    clearTimeout(headerTimeout);
    clearTimeout(totalTimeout);
  }
}


window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  const message = event.data;
  if (message?.source !== "douyin-toolkit-content") return;
  const { requestId, type, payload } = message;
  try {
    if (type === "GET_SELF_PROFILE") {
      reply(requestId, type, await getSelfProfile());
      return;
    }
    if (type === "COLLECT_AWEME") {
      reply(requestId, type, await collectAweme(payload.awemeId));
      return;
    }
    if (type === "FETCH_AWEME_DETAIL") {
      reply(requestId, type, await fetchAwemeDetail(payload.awemeId));
      return;
    }
    if (type === "PRECHECK_URL") {
      reply(requestId, type, await precheckUrl(payload.url, payload.options || {}));
      return;
    }
    if (type === "FETCH_LIKED_PAGE") {
      reply(requestId, type, await fetchLikedPage(payload.secUid, payload.maxCursor, payload.minCursor, payload.count));
      return;
    }
    if (type === "DOWNLOAD_TO_FOLDER") {
      reply(requestId, type, await downloadToFolderOnce(payload.rootHandle, payload.relativePath, payload.url, payload.options || {}));
      return;
    }
    reply(requestId, type, null, `Unknown request type: ${type}`);
  } catch (error) {
    reply(requestId, type, null, error?.message || String(error));
  }
});

reply("boot", "BOOT", {
  href: location.href,
  title: document.title,
});
