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
  return new URLSearchParams({
    device_platform: "webapp",
    aid: "6383",
    channel: "channel_pc_web",
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

async function downloadToFolder(rootHandle, relativePath, url) {
  let response;
  try {
    response = await fetch(url, {
      credentials: "omit",
      mode: "cors",
      headers: {
        "accept": "*/*",
      },
    });
  } catch (error) {
    throw new Error(`页面抓取失败：${error?.message || String(error)}`);
  }
  if (!response.ok) {
    throw new Error(`页面抓取失败：HTTP ${response.status}`);
  }
  const blob = await response.blob();
  if (!blob.size) throw new Error("页面抓取失败：0 字节");
  await writeToHandle(rootHandle, relativePath, blob);
  return {
    ok: true,
    size: blob.size,
    contentType: blob.type || "",
  };
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
    if (type === "DOWNLOAD_TO_FOLDER") {
      reply(requestId, type, await downloadToFolder(payload.rootHandle, payload.relativePath, payload.url));
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
