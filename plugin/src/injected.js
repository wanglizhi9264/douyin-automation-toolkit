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
  const cookies = Object.fromEntries(String(document.cookie || "").split("; ").filter(Boolean).map((entry) => {
    const separator = entry.indexOf("=");
    return separator >= 0 ? [entry.slice(0, separator), entry.slice(separator + 1)] : [entry, ""];
  }));
  let webId = String(globalThis.ssrData?.webId || "");
  if (!webId) {
    try {
      webId = String(JSON.parse(globalThis.localStorage?.getItem?.("SysInfo") || "{}")?.webid || "");
    } catch {}
  }
  const pcClientType = /(?:awemePcClient|electron)/i.test(userAgent)
    ? (platform.includes("Mac") ? "3" : "2")
    : "1";
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
    pc_client_type: pcClientType,
    webid: webId,
    uifid: cookies.UIFID || cookies.UIFID_TEMP || "",
    pc_libra_divert: platform.includes("Mac") ? "Mac" : (platform.includes("Win") ? "Windows" : ""),
    support_h265: cookies.hevc_supported === "true" ? "1" : "0",
    support_dash: cookies.is_dash_user === "1" ? "1" : "0",
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

async function diggAweme(awemeId) {
  const params = webParams();
  params.set("aweme_id", String(awemeId || ""));
  params.set("type", "1");
  return fetchJson(`/aweme/v1/web/commit/item/digg/?${params}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(),
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function visibleElement(element) {
  if (!(element instanceof HTMLElement)) return false;
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
}

function exactTextElements(text) {
  const expected = String(text || "").trim();
  return [...document.querySelectorAll("button,a,[role='button'],[role='listitem'],li,div,span")]
    .filter((element) => visibleElement(element) && String(element.textContent || "").trim() === expected)
    .filter((element) => ![...element.children].some((child) => String(child.textContent || "").trim() === expected));
}

function clickableElement(element) {
  return element?.closest?.(
    "[data-e2e='conversation-item'],.conversationConversationItemwrapper,button,a,[role='button'],[role='listitem'],li,[data-e2e='something-button']",
  ) || element;
}

function activateConversation(element) {
  element.scrollIntoView({ block: "nearest" });
  const rect = element.getBoundingClientRect();
  const options = { bubbles: true, cancelable: true, view: window,
    clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 };
  // The IM list can handle selection on pointer/mouse down, rather than click.
  element.dispatchEvent(new PointerEvent("pointerdown", { ...options, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 1 }));
  element.dispatchEvent(new MouseEvent("mousedown", { ...options, buttons: 1 }));
  element.dispatchEvent(new PointerEvent("pointerup", { ...options, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 0 }));
  element.dispatchEvent(new MouseEvent("mouseup", { ...options, buttons: 0 }));
  element.click();
}

function conversationListTargets(name) {
  const container = document.querySelector("#imSaasContainerId");
  if (!container) return [];
  return [...container.querySelectorAll("[data-e2e='conversation-item'],.conversationConversationItemwrapper")]
    .filter(visibleElement)
    .filter((item) => String(item.querySelector(".conversationConversationItemtitle")?.textContent || "").trim() === name);
}

function messageEntryCandidates() {
  const selectors = [
    "a[href*='/im']",
    "a[href*='message']",
    "[data-e2e*='im']",
    "[data-e2e*='message']",
    "[aria-label*='私信']",
    "[aria-label*='消息']",
    "[title*='私信']",
    "[title*='消息']",
  ].join(",");
  const candidates = [...document.querySelectorAll(selectors)].filter(visibleElement);
  for (const element of document.querySelectorAll("button,a,[role='button'],div,span")) {
    if (!visibleElement(element)) continue;
    const text = String(element.textContent || "").trim();
    if (/^(?:私信|消息)(?:\s*\d+)?$/.test(text)) candidates.push(element);
  }
  return [...new Set(candidates.map(clickableElement))].sort((a, b) => {
    const aText = `${a.getAttribute?.("aria-label") || ""} ${a.getAttribute?.("title") || ""} ${a.textContent || ""}`;
    const bText = `${b.getAttribute?.("aria-label") || ""} ${b.getAttribute?.("title") || ""} ${b.textContent || ""}`;
    return Number(/私信/.test(bText)) - Number(/私信/.test(aText));
  });
}

async function waitForExactText(text, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = exactTextElements(text);
    if (matches.length) return matches;
    await wait(250);
  }
  return [];
}

function setNativeInputValue(input, value) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function searchMessageConversation(name) {
  const containers = [...document.querySelectorAll("[role='dialog'],[class*='message'],[class*='Message'],[class*='chat'],[class*='Chat']")]
    .filter(visibleElement);
  const searchInputs = containers
    .flatMap((container) => [...container.querySelectorAll("input")])
    .filter((input) => visibleElement(input) && /搜索|查找|联系人|私信/.test(`${input.placeholder || ""} ${input.getAttribute("aria-label") || ""}`));
  if (!searchInputs.length) return [];
  const input = searchInputs[0];
  input.focus();
  setNativeInputValue(input, name);
  return waitForExactText(name, 6000);
}

async function openMessageListAndFind(name) {
  let matches = exactTextElements(name);
  if (matches.length) return matches;
  const clicked = new WeakSet();
  for (let attempt = 0; attempt < 3 && !matches.length; attempt += 1) {
    const entry = messageEntryCandidates().find((candidate) => !clicked.has(candidate));
    if (!entry) break;
    clicked.add(entry);
    entry.click();
    matches = await waitForExactText(name, 15000);
  }
  if (!matches.length) matches = await searchMessageConversation(name);
  return matches;
}

function conversationIdentityElement(element) {
  return element?.closest?.("[data-conversation-id],[data-user-id],[data-sec-uid],a[href]") || element;
}

function conversationTargetScore(element) {
  const identity = conversationIdentityElement(element);
  const rect = element.getBoundingClientRect();
  const selected = element.getAttribute?.("aria-selected") === "true"
    || identity.getAttribute?.("aria-selected") === "true"
    || /(?:active|selected|current)/i.test(`${element.className || ""} ${identity.className || ""}`);
  const hasConversationId = Boolean(
    identity.getAttribute?.("data-conversation-id")
      || identity.getAttribute?.("data-user-id")
      || identity.getAttribute?.("data-sec-uid"),
  );
  const href = String(identity.getAttribute?.("href") || "");
  return (selected ? 1_000_000 : 0)
    + (hasConversationId ? 100_000 : 0)
    + (/im|message|chat|conversation/i.test(href) ? 10_000 : 0)
    + (rect.left < innerWidth * 0.5 ? 1_000 : 0)
    - Math.max(0, rect.top);
}

function addVideoIdsFromText(ids, value) {
  const text = String(value || "");
  const patterns = [
    /(?:\/video\/|\/video\\\/|video%2F)(\d{16,22})(?!\d)/gi,
    /(?:aweme_id|awemeId|item_id|itemId|modal_id)(?:%3D|&quot;|["'])?\s*(?::|=|%3A)\s*(?:&quot;|["'])?(\d{16,22})(?!\d)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) ids.add(match[1]);
  }
  if (/^\d{16,22}$/.test(text)) ids.add(text);
}

function addVideoIdsFromReactData(ids, root) {
  const seen = new WeakSet();
  let inspected = 0;
  const inspect = (initial) => {
    const stack = [initial];
    while (stack.length && inspected < 60000) {
      const value = stack.pop();
      if (typeof value === "string") {
        addVideoIdsFromText(ids, value);
        continue;
      }
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);
      inspected += 1;
      let entries;
      try {
        entries = Object.entries(value);
      } catch {
        continue;
      }
      for (const [key, child] of entries) {
        if (/^(?:aweme_id|awemeId|item_id|itemId|modal_id)$/.test(key)) {
          addVideoIdsFromText(ids, child);
        }
        if (typeof child === "string") addVideoIdsFromText(ids, child);
        else if (child && typeof child === "object" && !/^_?ownerDocument$/.test(key)) stack.push(child);
      }
    }
  };
  for (const element of [root, ...root.querySelectorAll("*")]) {
    for (const key of Object.keys(element)) {
      if (key.startsWith("__reactProps$") || key.startsWith("__reactFiber$")) inspect(element[key]);
    }
    if (inspected >= 60000) break;
  }
}

function videoIdsIn(root) {
  const ids = new Set();
  if (!root) return ids;
  for (const element of root.querySelectorAll("a[href], [data-aweme-id], [data-awemeid], [data-item-id]")) {
    for (const value of [
      element.getAttribute("href"),
      element.getAttribute("data-aweme-id"),
      element.getAttribute("data-awemeid"),
      element.getAttribute("data-item-id"),
    ]) addVideoIdsFromText(ids, value);
  }
  addVideoIdsFromText(ids, root.innerHTML || "");
  addVideoIdsFromReactData(ids, root);
  return ids;
}

function conversationScrollRoot() {
  const exactSelectors = [
    ".messageMessageListlist",
    "#imSaasContainerId [class*='MessageList'][class*='list']",
    "#imSaasContainerId [class*='messageList'][class*='list']",
  ];
  for (const selector of exactSelectors) {
    const messageList = document.querySelector(selector);
    if (visibleElement(messageList)) return messageList;
  }
  const searchRoot = document.querySelector("#imSaasContainerId") || document;
  const candidates = [...searchRoot.querySelectorAll("main,section,div")].filter((element) => {
    if (!visibleElement(element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.height < 180 || rect.width < 180) return false;
    const style = getComputedStyle(element);
    return /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 40;
  });
  const score = (element) => {
    const rect = element.getBoundingClientRect();
    const rightPane = rect.left >= innerWidth * 0.18 ? 1_000_000 : 0;
    const nearBottom = element.scrollTop >= Math.max(0, element.scrollHeight - element.clientHeight - 120) ? 100_000 : 0;
    return rightPane + nearBottom + rect.left * 100 + element.clientHeight + Math.min(element.scrollHeight, 100_000) / 100;
  };
  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0] || null;
}

async function waitForConversationScrollRoot(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const root = conversationScrollRoot();
    if (root) return root;
    await wait(200);
  }
  return null;
}

function conversationRootDiagnostics() {
  const container = document.querySelector("#imSaasContainerId");
  const nodes = [...(container || document).querySelectorAll("div")]
    .filter((element) => {
      const name = String(element.className || "");
      return /message|list|conversation/i.test(name) || element.scrollHeight > element.clientHeight + 40;
    })
    .slice(0, 12)
    .map((element) => ({
      className: String(element.className || "").slice(0, 120),
      client: `${element.clientWidth}x${element.clientHeight}`,
      scroll: `${element.scrollWidth}x${element.scrollHeight}`,
      overflowY: getComputedStyle(element).overflowY,
    }));
  return { hasImContainer: Boolean(container), candidates: nodes };
}

function sharedAwemeCards(root) {
  if (!root) return [];
  return [...root.querySelectorAll(".MessageItemShareAwemecontainer")]
    .filter(visibleElement);
}

function sharedCardFingerprint(card) {
  const awemeId = sharedCardAwemeId(card);
  if (awemeId) return awemeId;
  const cover = (card.querySelector(":scope > img, img")?.getAttribute("src") || "").split("?")[0];
  const author = card.querySelector(".MessageItemShareAwemeauthorName")?.textContent || "";
  return `${cover}|${author}|${String(card.textContent || "").trim()}`;
}

function sharedCardAwemeId(card) {
  // Read only this message's parsedContent, never traverse unrelated React fibers.
  for (let element = card, depth = 0; element && depth < 5; element = element.parentElement, depth += 1) {
    for (const key of Object.keys(element).filter((name) => name.startsWith("__reactProps$"))) {
      const stack = [element[key]];
      const seen = new WeakSet();
      for (let inspected = 0; stack.length && inspected < 80; inspected += 1) {
        const value = stack.pop();
        if (!value || typeof value !== "object" || seen.has(value)) continue;
        seen.add(value);
        const content = value.message?.parsedContent;
        const id = String(content?.itemId || content?.item_id || content?.aweme_id || "");
        if (/^\d{16,22}$/.test(id)) return id;
        if (value.props) stack.push(value.props);
        if (value.children) stack.push(...(Array.isArray(value.children) ? value.children : [value.children]));
      }
    }
    if (element.matches("[data-e2e='msg-item-content']")) break;
  }
  return "";
}

function currentModalAwemeId() {
  const activeVideoId = document
    .querySelector("[data-e2e='modal-video-container'] [data-e2e='feed-active-video'][data-e2e-vid]")
    ?.getAttribute("data-e2e-vid") || "";
  if (/^\d{16,22}$/.test(activeVideoId)) return activeVideoId;
  const urlId = new URL(location.href).searchParams.get("modal_id") || "";
  return /^\d{16,22}$/.test(urlId) ? urlId : "";
}

function sharedAwemeModal() {
  // `#slidelist` is also the permanent home-feed container on /?recommend=1.
  // Treating it as a modal makes a failed card click look like an opened modal,
  // followed by the misleading "close button not found" error.
  return document.querySelector("[data-e2e='modal-video-container']");
}

async function closeSharedAwemeModal() {
  if (!sharedAwemeModal()) return;
  let closeButton = null;
  const readyDeadline = Date.now() + 30000;
  while (Date.now() < readyDeadline) {
    closeButton = document.querySelector(".o7hAjQkB .gesnxrtb") || document.querySelector(".o7hAjQkB");
    if (closeButton || !sharedAwemeModal()) break;
    await wait(100);
  }
  if (!sharedAwemeModal()) return;
  if (!closeButton) throw new Error("分享作品已打开，但没有找到视频弹窗关闭按钮");
  closeButton.click();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (!sharedAwemeModal()) return;
    await wait(50);
  }
  throw new Error("视频弹窗关闭超时，已停止扫描以避免离开当前私信");
}

async function openSharedCardAndProcess(card, { likeMissing = false } = {}) {
  const expectedId = sharedCardAwemeId(card);
  const previousId = currentModalAwemeId();
  const playButton = card.querySelector(".MessageItemShareAwemeplayIcon");
  if (!playButton) return { awemeId: "", liked: 0, alreadyLiked: 0, likeState: "not-opened" };
  playButton.click();
  const deadline = Date.now() + 30000;
  let awemeId = "";
  let retriedOpen = false;
  while (Date.now() < deadline) {
    const nextId = currentModalAwemeId();
    if (sharedAwemeModal() && nextId && (expectedId ? nextId === expectedId : nextId !== previousId)) {
      awemeId = nextId;
      break;
    }
    if (!retriedOpen && !sharedAwemeModal() && Date.now() > deadline - 20000) {
      // Card details are populated asynchronously by IM; retry only opening,
      // never toggle the like button on a timeout.
      playButton.click();
      retriedOpen = true;
    }
    await wait(50);
  }
  if (!awemeId && !sharedAwemeModal()) {
    return { awemeId: "", liked: 0, alreadyLiked: 0, likeState: "not-opened" };
  }
  let liked = 0;
  let alreadyLiked = 0;
  let likeState = "unknown";
  if (awemeId) {
    let diggButton = null;
    const stateDeadline = Date.now() + 15000;
    while (Date.now() < stateDeadline) {
      const activeVideo = sharedAwemeModal()?.querySelector(`[data-e2e='feed-active-video'][data-e2e-vid='${awemeId}']`);
      diggButton = activeVideo?.querySelector("[data-e2e='video-player-digg']") || null;
      likeState = String(diggButton?.getAttribute("data-e2e-state") || "unknown");
      if (["video-player-is-digged", "video-player-no-digged"].includes(likeState)) break;
      await wait(100);
    }
    if (likeState === "video-player-is-digged") {
      alreadyLiked = 1;
    } else if (likeMissing && likeState === "video-player-no-digged") {
      diggButton.click();
      const likeDeadline = Date.now() + 5000;
      while (Date.now() < likeDeadline) {
        likeState = String(diggButton.getAttribute("data-e2e-state") || "unknown");
        if (likeState === "video-player-is-digged") break;
        await wait(50);
      }
      if (likeState !== "video-player-is-digged") {
        await closeSharedAwemeModal();
        throw new Error(`分享作品 ${awemeId} 点赞后未确认成功`);
      }
      liked = 1;
    }
  }
  await closeSharedAwemeModal();
  return { awemeId, liked, alreadyLiked, likeState };
}

async function scanSharedAwemeCards(maxPages = 200, { likeMissing = false } = {}) {
  const ids = new Set();
  const processedCards = new Set();
  let stableRounds = 0;
  let scannedPages = 0;
  let cardFailures = 0;
  let liked = 0;
  let alreadyLiked = 0;
  let unknownLikeState = 0;
  const failedAwemeIds = [];
  while (scannedPages < Math.max(1, Math.min(Number(maxPages || 200), 500)) && stableRounds < 3) {
    const root = conversationScrollRoot();
    if (!root) throw new Error("私信会话已打开，但消息历史区域消失了");
    let discoveredThisRound = 0;
    // Opening/closing the player can replace the message DOM. Reacquire each
    // next card instead of retaining a snapshot of nodes from before a modal.
    for (;;) {
      const currentList = conversationScrollRoot();
      const card = sharedAwemeCards(currentList).find((candidate) => !processedCards.has(sharedCardFingerprint(candidate)));
      if (!card) break;
      const fingerprint = sharedCardFingerprint(card);
      if (!fingerprint || !card.isConnected) break;
      const expectedAwemeId = sharedCardAwemeId(card);
      processedCards.add(fingerprint);
      discoveredThisRound += 1;
      const savedTop = currentList.scrollTop;
      const processed = await openSharedCardAndProcess(card, { likeMissing });
      // The IM virtualizer/player can reset scroll position when its DOM is
      // rebuilt. Restore the scan cursor on the new list, not the detached one.
      const restoredList = conversationScrollRoot();
      if (!restoredList) throw new Error("关闭分享作品后消息历史区域消失了");
      restoredList.scrollTop = savedTop;
      restoredList.dispatchEvent(new Event("scroll", { bubbles: true }));
      await wait(150);
      if (processed.awemeId) ids.add(processed.awemeId);
      else {
        cardFailures += 1;
        failedAwemeIds.push(expectedAwemeId || "unknown");
      }
      liked += processed.liked;
      alreadyLiked += processed.alreadyLiked;
      if (processed.awemeId && !["video-player-is-digged", "video-player-no-digged"].includes(processed.likeState)) unknownLikeState += 1;
      window.postMessage({ source: TOOLKIT_SOURCE, type: "SHARED_SCAN_PROGRESS", payload: {
        processed: processedCards.size, found: ids.size, liked, alreadyLiked, failed: cardFailures,
        awemeId: processed.awemeId || expectedAwemeId,
      } }, location.origin);
    }
    const currentRoot = conversationScrollRoot();
    if (!currentRoot) break;
    const previousTop = currentRoot.scrollTop;
    const previousHeight = currentRoot.scrollHeight;
    const maxTop = Math.max(0, previousHeight - currentRoot.clientHeight);
    const nextTop = Math.min(maxTop, previousTop + Math.max(400, currentRoot.clientHeight * 0.85));
    currentRoot.scrollTop = nextTop;
    currentRoot.dispatchEvent(new Event("scroll", { bubbles: true }));
    await wait(900);
    scannedPages += 1;
    const settledRoot = conversationScrollRoot();
    const heightChanged = settledRoot?.scrollHeight !== previousHeight;
    const moved = (settledRoot?.scrollTop || 0) > previousTop + 1;
    const atBoundary = settledRoot && settledRoot.scrollTop >= settledRoot.scrollHeight - settledRoot.clientHeight - 2;
    stableRounds = atBoundary && discoveredThisRound === 0 && !heightChanged && !moved ? stableRounds + 1 : 0;
  }
  const root = conversationScrollRoot();
  return {
    ids: [...ids],
    scannedPages,
    reachedHistoryStart: stableRounds >= 3,
    processedCards: processedCards.size,
    cardFailures,
    liked,
    alreadyLiked,
    unknownLikeState,
    failedAwemeIds,
    diagnostics: {
      scrollHeight: root?.scrollHeight || 0,
      clientHeight: root?.clientHeight || 0,
      childCount: root?.querySelectorAll("*").length || 0,
    },
  };
}

async function scanSharedConversation(targetName, maxPages = 200, likeMissing = false) {
  const name = String(targetName || "").trim();
  if (!name) throw new Error("未配置私信用户昵称");
  const matches = await openMessageListAndFind(name);
  if (!matches.length) throw new Error(`自动打开私信后仍未找到用户“${name}”，请确认该会话存在且账号已登录`);
  let clickTargets = conversationListTargets(name);
  if (!clickTargets.length) clickTargets = [...new Set(matches.map(clickableElement))];
  const leftListTargets = clickTargets.filter((element) => element.getBoundingClientRect().left < innerWidth * 0.5);
  if (leftListTargets.length) clickTargets = leftListTargets;
  clickTargets.sort((a, b) => conversationTargetScore(b) - conversationTargetScore(a));
  const selectedConversation = clickTargets[0];
  const identityElement = conversationIdentityElement(selectedConversation);
  const conversationKey = String(
    identityElement.getAttribute?.("data-conversation-id")
      || identityElement.getAttribute?.("data-user-id")
      || identityElement.getAttribute?.("data-sec-uid")
      || identityElement.getAttribute?.("href")
      || "",
  );
  activateConversation(selectedConversation);
  const root = await waitForConversationScrollRoot(15000);
  if (!root) {
    const diagnostics = conversationRootDiagnostics();
    throw new Error(
      `已尝试选择“${name}”，但等待 15 秒仍未打开消息历史区域（私信容器：${diagnostics.hasImContainer ? "存在" : "不存在"}；候选：${JSON.stringify(diagnostics.candidates)}）`,
    );
  }
  root.scrollTop = 0;
  root.dispatchEvent(new Event("scroll", { bubbles: true }));
  await wait(400);
  const scan = await scanSharedAwemeCards(maxPages, { likeMissing: Boolean(likeMissing) });
  return {
    ok: true,
    targetName: name,
    conversationKey,
    awemeIds: scan.ids,
    scannedPages: scan.scannedPages,
    reachedHistoryStart: scan.reachedHistoryStart,
    processedCards: scan.processedCards,
    cardFailures: scan.cardFailures,
    liked: scan.liked,
    alreadyLiked: scan.alreadyLiked,
    unknownLikeState: scan.unknownLikeState,
    failedAwemeIds: scan.failedAwemeIds,
    diagnostics: scan.diagnostics,
  };
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

async function fetchBookmarkedPage(cursor = 0, count = 10) {
  const params = webParams();
  params.set("publish_video_strategy_type", "2");
  const body = new URLSearchParams();
  body.set("count", String(count || 10));
  body.set("cursor", String(cursor || 0));
  const result = await fetchJson("/aweme/v1/web/aweme/listcollection/?" + params, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const awemeList = result.json?.aweme_list || result.json?.awemeList || [];
  return {
    ...result,
    ok: result.ok && Array.isArray(awemeList),
    awemeList,
    hasMore: asBoolean(result.json?.has_more ?? result.json?.hasMore),
    cursor: result.json?.cursor ?? cursor,
    total: Number(
      result.json?.total
        ?? result.json?.total_count
        ?? result.json?.collect_count
        ?? result.json?.collection_count
        ?? result.json?.data?.total
        ?? result.json?.data?.total_count
        ?? result.json?.extra?.total
        ?? 0,
    ) || 0,
    hasTotal: [
      result.json?.total,
      result.json?.total_count,
      result.json?.collect_count,
      result.json?.collection_count,
      result.json?.data?.total,
      result.json?.data?.total_count,
      result.json?.extra?.total,
    ].some((value) => value != null && Number.isFinite(Number(value))),
  };
}

async function fetchFollowingPage(userId, secUid, offset = 0, count = 20, maxTime = 0, minTime = 0) {
  const params = webParams();
  params.set("user_id", String(userId || ""));
  params.set("sec_user_id", String(secUid || ""));
  params.set("source_type", "1");
  params.set("gps_access", "0");
  params.set("address_book_access", "0");
  params.set("is_top", "1");
  params.set("offset", String(offset || 0));
  params.set("count", String(count || 20));
  params.set("max_time", String(maxTime || 0));
  params.set("min_time", String(minTime || 0));
  const result = await fetchJson(`/aweme/v1/web/user/following/list/?${params}`);
  const users = result.json?.followings || result.json?.user_list || result.json?.users || [];
  return {
    ...result,
    ok: result.ok && Array.isArray(users),
    users,
    hasMore: asBoolean(result.json?.has_more ?? result.json?.hasMore),
    offset: Number(result.json?.offset ?? (Number(offset || 0) + users.length)),
    maxTime: result.json?.max_time ?? maxTime,
    minTime: result.json?.min_time ?? minTime,
    total: Number(result.json?.total ?? result.json?.mix_count ?? 0) || 0,
  };
}

async function fetchAuthorAwemePage(secUid, maxCursor = 0, count = 18) {
  const params = webParams();
  params.set("sec_user_id", String(secUid || ""));
  params.set("max_cursor", String(maxCursor || 0));
  params.set("count", String(count || 18));
  params.set("publish_video_strategy_type", "2");
  params.set("locate_query", "false");
  params.set("show_live_replay_strategy", "1");
  params.set("whale_cut_token", "");
  params.set("cut_version", "1");
  params.set("need_time_list", "0");
  params.set("time_list_query", "0");
  const result = await fetchJson(`/aweme/v1/web/aweme/post/?${params}`);
  const awemeList = result.json?.aweme_list || result.json?.awemeList || [];
  return {
    ...result,
    ok: result.ok && Array.isArray(awemeList),
    awemeList,
    hasMore: asBoolean(result.json?.has_more ?? result.json?.hasMore),
    maxCursor: result.json?.max_cursor ?? result.json?.maxCursor ?? maxCursor,
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
    userDigged: Boolean(
      aweme?.user_digged
        ?? aweme?.userDigged
        ?? aweme?.is_digg
        ?? aweme?.status?.user_digged
        ?? aweme?.status?.is_user_digged,
    ),
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
    if (type === "DIGG_AWEME") {
      reply(requestId, type, await diggAweme(payload.awemeId));
      return;
    }
    if (type === "SCAN_SHARED_CONVERSATION") {
      reply(requestId, type, await scanSharedConversation(payload.targetName, payload.maxPages, payload.likeMissing));
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
    if (type === "FETCH_BOOKMARKED_PAGE") {
      reply(requestId, type, await fetchBookmarkedPage(payload.cursor, payload.count));
      return;
    }
    if (type === "FETCH_FOLLOWING_PAGE") {
      reply(requestId, type, await fetchFollowingPage(payload.userId, payload.secUid, payload.offset, payload.count, payload.maxTime, payload.minTime));
      return;
    }
    if (type === "FETCH_AUTHOR_AWEME_PAGE") {
      reply(requestId, type, await fetchAuthorAwemePage(payload.secUid, payload.maxCursor, payload.count));
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
