import { getStoredDownloadTarget } from "../shared/download.js";
import { sendPageRequest } from "../shared/events.js";
import { Repository } from "../archive/repository.js";
import { Sources } from "../core/sources.js";
import { Engine } from "../core/engine.js";
import { createMediaDownloader } from "../core/media.js";
import { counters, runCounters, BUSY } from "../core/model.js";
import { sourceProgress, floatingProgress } from "../core/progress.js";
import { measureSizes } from "../maintenance/measure.js";
import { organize } from "../maintenance/organize.js";
import { writeLibraryReport } from "../archive/report.js";
const $ = (id) => document.getElementById(id),
  view = $("view");
const labels = { liked: "喜欢", bookmarked: "收藏", following: "关注" };
const iconPaths = {
  heart:
    '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4V3Z"/>',
  users:
    '<circle cx="9" cy="8" r="3"/><path d="M3 21v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v2"/>',
  folder:
    '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v1M3 7h18l-3 13H3V7Z"/>',
};
const icon = (name) =>
  `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${iconPaths[name]}</svg>`;
const stateLabels = {
  starting: "正在准备",
  running: "下载中",
  pausing: "正在暂停",
  paused: "已暂停",
  finalizing: "正在保存",
  completed: "已完成",
  partial: "部分完成",
};
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const number = (value) => Number(value || 0).toLocaleString("zh-CN");
const bytes = (value) => {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
};
let target = null,
  repo = null,
  engine = null,
  route = "home",
  error = "",
  loading = false,
  selectedAt = "",
  authors = [],
  authorCursor = null,
  authorsDone = false,
  authorsLoading = false,
  authorController = null,
  authorError = "",
  search = "",
  selected = new Set(),
  profile = null,
  organizing = false,
  organizeProgress = null,
  organizeResult = null,
  organizeController = null,
  reportWriting = false,
  reportTimer = null,
  renderTimer = null,
  measurementController = null,
  measurementPromise = null,
  measurementTimer = null,
  measurementResult = null,
  pluginHidden = false,
  progressTimer = null,
  ringItemId = null,
  selectionTimer = null,
  selectionDirty = false,
  selectionWriting = null,
  selectionRevision = 0;
function notice(message) {
  $("notice").textContent = message;
  $("notice").hidden = false;
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => ($("notice").hidden = true), 5500);
}
function schedule() {
  if (!renderTimer)
    renderTimer = setTimeout(() => {
      renderTimer = null;
      render();
    }, 180);
}
function latest() {
  return (
    engine?.task ||
    Object.values(repo?.state.tasks || {}).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    )[0]
  );
}
function busy() {
  return Boolean(loading || engine?.busy || organizing || reportWriting);
}
function back() {
  return '<button class="back" data-action="home">‹ 返回首页</button>';
}
function errorBox(message) {
  return message ? `<div class="error-box">${esc(message)}</div>` : "";
}
function sourceNumbers(scope, task = repo?.latestTask(scope)) {
  const engineProfile = engine?.profile;
  const current =
    (engineProfile?.readAt || "") > (profile?.readAt || "")
      ? engineProfile
      : profile || engineProfile;
  return sourceProgress(repo?.stats, scope, {
    profile: current,
    task,
    ownerUid: repo?.state.owner?.uid,
  });
}
function home() {
  return `<div class="folder"><span class="folder-icon" aria-hidden="true">${icon("folder")}</span><div class="folder-info"><div class="folder-name">${esc(target?.label || "选择文件夹")}</div></div><button class="link" data-action="folder" ${busy() ? "disabled" : ""}>${target ? "更改" : "选择"}</button></div>
  ${error && !repo ? errorBox(error) : ""}
  <div class="action-list">${[
    ["liked", "heart", "下载喜欢"],
    ["bookmarked", "bookmark", "下载收藏"],
    ["following", "users", "下载关注"],
  ]
    .map(
      ([scope, iconName, title]) =>
        `<button class="action" data-scope="${scope}" data-action="${engine?.busy && engine.task?.scope === scope ? "task" : scope}" ${!repo || (busy() && !(engine?.busy && engine.task?.scope === scope)) ? "disabled" : ""}><span class="action-icon" aria-hidden="true">${icon(iconName)}</span><span class="action-text"><span class="action-title">${title}</span></span><span class="chevron">›</span></button>`,
    )
    .join("")}</div>`;
}
function taskView() {
  const task = latest();
  if (!task) return back();
  const c = runCounters(task),
    values = sourceNumbers(task.scope, task),
    active = engine?.active || new Map(),
    running = engine?.busy;
  const retry = running && engine.sources.retry?.info;
  const ratio = c.read
    ? Math.min(
        100,
        ((c.saved + (c.upgraded || 0) + c.existing + c.failed + c.unsupported) /
          c.read) *
          100,
      )
    : 0;
  const status = running
    ? task.recovery?.status === "waiting" && !active.size
      ? "等待补下"
      : task.recovery?.status === "running"
        ? "补下中"
        : retry
      ? "等待中"
      : active.size
        ? "下载中"
        : "检查中"
    : stateLabels[task.status] || "已暂停";
  return `${back()}<div class="title-row"><h1>下载${esc(labels[task.scope])}</h1><span class="status">${status}</span></div>
  <div class="source-overview"><div><div class="overview-value" data-metric="platform-total">${task.scope === "following" ? number(task.authors.length) : values.displayTotal || (values.total === null ? "—" : number(values.total))}</div><div class="label">${task.scope === "following" ? "所选作者" : labels[task.scope] + "总数"}</div></div><div><div class="overview-value" data-metric="source-saved">${values.saved === null ? "—" : number(values.saved)}</div><div class="label">本地累计</div></div></div>
  <div class="task-total task-delta"><span class="delta-label">本次下载</span><span class="number" data-metric="new-downloads">+${number(c.saved)}</span>${c.upgraded ? `<span class="upgrade-count">升级 ${number(c.upgraded)}</span>` : ""}</div>
  ${task.scope === "following" ? `<div class="following-current">${esc(task.authors[[...active.values()][0]?.authorIndex ?? Math.min(task.cursor?.authorIndex || 0, task.authors.length - 1)]?.nickname || "")} · ${Math.min(task.authors.length, ([...active.values()][0]?.authorIndex ?? task.cursor?.authorIndex ?? 0) + 1)} / ${task.authors.length}</div>` : ""}
  <div class="activity-line ${running && !task.sourceDone ? "indeterminate" : ""}"><i style="width:${task.sourceDone ? ratio : running ? 35 : 0}%"></i></div>
  ${retry ? `<div class="retry-notice">${Math.max(1, Math.ceil((retry.until - Date.now()) / 1000))} 秒后自动继续</div>` : ""}
  <div class="stats task-stats">${[
    ["已检查", c.read],
    ["已跳过", c.existing],
    ["待下载", c.pending],
    ["未成功", c.failed + c.unsupported],
  ]
    .map(
      ([name, value]) =>
        `<div><div class="stat-value">${number(value)}</div><div class="stat-name">${name}</div></div>`,
    )
    .join("")}</div>
  ${active.size ? '<div class="section-head"><h2>当前下载</h2></div>' : ""}
  <div id="transfers">${[...active.values()].map(transferHTML).join("")}</div>
  <div class="task-controls"><button class="${running ? "secondary-btn" : "primary"} wide" data-action="${running ? "pause" : "download"}" ${!running && busy() ? "disabled" : ""}>${running ? "暂停下载" : "下载"}</button></div>`;
}
function lastFollowingBatch() {
  return (
    Object.values(repo?.state.tasks || {})
      .filter((task) => task.scope === "following" && !task.retryOnly)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null
  );
}
function rememberSelection() {
  selectionRevision++;
  selectionDirty = true;
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(
    () =>
      void saveSelection().catch((e) =>
        notice("作者选择保存失败：" + e.message),
      ),
    400,
  );
}
async function saveSelection() {
  clearTimeout(selectionTimer);
  if (selectionWriting) {
    await selectionWriting;
    if (selectionDirty) return saveSelection();
    return;
  }
  if (!selectionDirty || !repo) return;
  const current = repo,
    revision = selectionRevision;
  const choices = [
    ...(current.state.followingSelection?.authors || []),
    ...(lastFollowingBatch()?.authors || []),
    ...authors,
  ];
  const unique = new Map(choices.map((a) => [a.uid, a]));
  const chosen = [...selected]
    .map((uid) => unique.get(uid))
    .filter(Boolean)
    .map(({ uid, secUid, nickname }) => ({ uid, secUid, nickname }));
  const operation = async () => {
    await stopMeasurement();
    await navigator.locks.request(
      "douyin-archive-" + current.state.id,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) throw new Error("备份库正在使用，请暂停后保存选择");
        await current.load();
        await current.commit({
          followingSelection: {
            authors: chosen,
            updatedAt: new Date().toISOString(),
          },
        });
      },
    );
    if (repo === current && revision === selectionRevision)
      selectionDirty = false;
  };
  selectionWriting = operation();
  try {
    await selectionWriting;
  } finally {
    selectionWriting = null;
  }
}
function authorsView() {
  const shown = authors.filter(
    (a) => !search || a.nickname.toLowerCase().includes(search.toLowerCase()),
  );
  const chosen = authors.filter((a) => selected.has(a.uid));
  return `${back()}<h1>选择作者</h1>
  <input id="authorSearch" class="search" placeholder="搜索作者" value="${esc(search)}" aria-label="搜索作者">
  <div class="select-all"><label><input id="selectAll" type="checkbox" ${!authorsDone || !shown.length ? "disabled" : ""} ${shown.length && shown.every((a) => selected.has(a.uid)) ? "checked" : ""}>全选</label><span>${authorsLoading ? "加载中 · " : ""}${search ? shown.length : authors.length} 人</span></div>
  ${shown.map((a) => `<label class="author"><input type="checkbox" data-author="${esc(a.uid)}" ${selected.has(a.uid) ? "checked" : ""}><span class="avatar">${esc(a.nickname.slice(0, 1))}</span><span class="author-info"><span class="author-name">${esc(a.nickname)}</span></span></label>`).join("")}
  ${!authorsLoading && !authorsDone ? '<button class="link wide" data-action="loadAuthors">加载列表</button>' : ""}${errorBox(authorError)}
  <div class="author-controls"><button class="primary wide" data-action="startFollowing" ${!chosen.length || busy() ? "disabled" : ""}>下载 · ${chosen.length} 人</button></div>`;
}
function details() {
  return `${back()}<h1>设置</h1>
  ${
    !repo
      ? '<p class="intro">请先选择文件夹。</p>'
      : `
  ${repo.state.legacyOwnerUnknown ? '<div class="error-box">请确认历史备份属于当前账号。</div><button class="secondary-btn wide" data-action="bind" ' + (busy() ? "disabled" : "") + ">绑定当前账号</button>" : ""}
  <div class="detail-section"><button class="primary wide" data-action="report" ${busy() ? "disabled" : ""}>${reportWriting ? "正在更新…" : "更新 HTML 看板"}</button></div>
  <div class="detail-section"><button class="secondary-btn wide" data-action="${organizing ? "stopOrganize" : "organize"}" ${loading || engine?.busy || reportWriting ? "disabled" : ""}>${organizing ? "停止整理" : "整理备份"}</button>${organizing ? `<p class="subtle-note">已检查 ${number(organizeProgress?.checked)}</p>` : ""}</div>`
  }
  ${errorBox(error)}`;
}
function render() {
  view.classList.toggle("home-view", route === "home");
  const scroll = view.scrollTop,
    focused = document.activeElement?.id === "authorSearch",
    position = focused ? document.activeElement.selectionStart : 0;
  view.innerHTML =
    route === "home"
      ? home()
      : route === "task"
        ? taskView()
        : route === "authors"
          ? authorsView()
          : details();
  view.scrollTop = scroll;
  if (focused && $("authorSearch")) {
    $("authorSearch").focus();
    $("authorSearch").setSelectionRange(position, position);
  }
  $("account").textContent = repo?.state.owner?.nickname || "本地备份 · v0.8.6";
  $("footState").textContent = engine?.busy
    ? engine.active.size
      ? "下载中"
      : "检查中"
    : "";
  renderFloating();
  for (const button of document.querySelectorAll("[data-quick]")) {
    button.disabled =
      busy() && !(engine?.busy && engine.task?.scope === button.dataset.quick);
    button.title =
      engine?.busy && engine.task?.scope === button.dataset.quick
        ? "查看当前下载"
        : busy()
          ? "当前任务结束或暂停后可用"
          : button.dataset.quick === "following"
            ? "选择关注作者"
            : `下载${labels[button.dataset.quick]}`;
  }
}
function renderFloating() {
  $("runningDot").hidden = true;
  const ring = floatingProgress(engine?.task, engine?.active, ringItemId);
  ringItemId = ring.key;
  $("floatingProgress").toggleAttribute("hidden", !ring.visible);
  $("floatingProgress").classList.toggle("indeterminate", ring.value === null);
  $("floatingArc").style.strokeDasharray =
    `${ring.value ?? 18} ${100 - (ring.value ?? 18)}`;
  $("floating").title = ring.visible
    ? `${ring.label} · 点击查看进度，拖动调整位置`
    : "展开抖音备份 · 可拖动";
}
function transferHTML(item) {
  return `<div class="transfer" data-transfer="${esc(item.id)}"><div class="transfer-title">${esc(item.desc || item.id)}</div><div class="transfer-meta"><span data-transfer-meta>${esc(item.authorName || "准备媒体")}${item.parts ? ` · ${item.part}/${item.parts} 段` : ""}</span><span data-transfer-bytes>${bytes(item.loaded)}${item.total ? " / " + bytes(item.total) : ""}</span></div><div class="mini-bar"><i style="width:${item.total ? Math.min(100, (item.loaded / item.total) * 100) : 0}%"></i></div></div>`;
}
function scheduleProgress() {
  if (progressTimer) return;
  progressTimer = setTimeout(() => {
    progressTimer = null;
    renderFloating();
    const container = $("transfers");
    if (route !== "task" || !container) return;
    for (const item of engine?.active.values() || []) {
      const row = [...container.querySelectorAll("[data-transfer]")].find(
        (el) => el.dataset.transfer === item.id,
      );
      if (!row) {
        schedule();
        continue;
      }
      row.querySelector("[data-transfer-meta]").textContent =
        (item.authorName || "准备媒体") +
        (item.parts ? ` · ${item.part}/${item.parts} 段` : "");
      row.querySelector("[data-transfer-bytes]").textContent =
        bytes(item.loaded) + (item.total ? " / " + bytes(item.total) : "");
      row.querySelector(".mini-bar i").style.width =
        (item.total ? Math.min(100, (item.loaded / item.total) * 100) : 0) +
        "%";
    }
  }, 100);
}
function navigate(next) {
  route = next;
  view.scrollTop = 0;
  render();
}
async function refreshTarget() {
  if (pluginHidden || busy()) return;
  try {
    const next = await getStoredDownloadTarget();
    if (next?.selectedAt === selectedAt && repo) {
      return;
    }
    if (!next) {
      render();
      return;
    }
    target = next;
    if (next.permission !== "granted") {
      error = "文件夹授权已失效，请重新选择同一个备份文件夹。";
      repo = null;
      render();
      return;
    }
    stopAuthors();
    await stopMeasurement();
    measurementResult = null;
    loading = true;
    render();
    repo = await Repository.open(next);
    selectedAt = next.selectedAt;
    error = "";
    authors = [];
    authorCursor = null;
    authorsDone = false;
    selected.clear();
    for (const author of repo.state.followingSelection?.authors ??
      lastFollowingBatch()?.authors ??
      [])
      selected.add(author.uid);
    selectionDirty = false;
    search = "";
    profile = null;
    const sources = new Sources(sendPageRequest);
    engine = new Engine(repo, sources, createMediaDownloader(repo, sources));
    let wasRunning = false;
    engine.subscribe((_, kind) => {
      if (kind === "progress") {
        scheduleProgress();
        return;
      }
      if (wasRunning && !engine.busy) {
        const message = engine.error || engine.task?.sourceErrors?.[0];
        if (message) notice(message);
        scheduleReport();
        scheduleMeasurement();
      }
      wasRunning = engine.busy;
      schedule();
    });
    const task = latest();
    if (task)
      engine.task = {
        ...structuredClone(task),
        status: BUSY.has(task.status) ? "paused" : task.status,
      };
  } catch (e) {
    repo = null;
    error = e.message;
  } finally {
    loading = false;
    render();
  }
  scheduleMeasurement();
}
function scheduleReport() {
  clearTimeout(reportTimer);
  const currentRepo = repo;
  reportTimer = setTimeout(() => {
    if (repo === currentRepo && !busy()) void updateReport(true);
  }, 600);
}
async function updateReport(automatic) {
  if (!repo || busy()) return;
  clearTimeout(reportTimer);
  reportWriting = true;
  render();
  try {
    await writeLibraryReport(repo);
    if (!automatic) notice("已更新文件夹中的“本地库.html”");
  } catch (e) {
    if (!automatic) notice("报告更新失败：" + e.message);
  } finally {
    reportWriting = false;
    render();
  }
}
async function start(scope, authorsList = []) {
  if (!repo || busy() || (scope === "following" && !authorsList.length)) return;
  stopAuthors();
  await stopMeasurement();
  if (!repo || busy()) return;
  error = "";
  if (scope === "following") await saveSelection();
  const previous = repo.latestTask(scope);
  engine.start(
    scope,
    authorsList,
    previous?.status !== "completed" ? previous : null,
  );
  navigate("task");
}
function stopAuthors() {
  authorController?.abort();
  authorController = null;
  authorsLoading = false;
}
async function loadAuthors() {
  if (!engine || !repo || busy() || authorsLoading || authorsDone) return;
  const currentEngine = engine;
  const controller = (authorController = new AbortController());
  const { signal } = controller;
  authorsLoading = true;
  authorError = "";
  render();
  try {
    const currentProfile = await currentEngine.sources.profile(signal);
    if (signal.aborted || engine !== currentEngine) return;
    if (
      repo.state.owner?.uid &&
      String(repo.state.owner.uid) !== currentProfile.uid
    )
      throw new Error("备份库属于其他账号，请切换文件夹或登录原账号");
    profile = currentProfile;
    const seen = new Set(authors.map((a) => a.uid));
    const cursors = new Set([JSON.stringify(authorCursor)]);
    let noNewPages = 0;
    while (!signal.aborted && engine === currentEngine) {
      const page = await currentEngine.sources.authors(
        profile,
        authorCursor,
        signal,
      );
      if (signal.aborted || engine !== currentEngine) return;
      let added = 0;
      for (const author of page.authors) {
        if (!seen.has(author.uid)) {
          seen.add(author.uid);
          authors.push(author);
          added++;
        }
      }
      if (page.done) {
        authorCursor = page.cursor;
        authorsDone = true;
        break;
      }
      noNewPages = added ? 0 : noNewPages + 1;
      if (cursors.has(JSON.stringify(page.cursor)) || noNewPages >= 3)
        throw new Error(
          "关注列表分页没有继续前进，已保留加载结果，请稍后重试。",
        );
      authorCursor = page.cursor;
      cursors.add(JSON.stringify(authorCursor));
      render();
    }
  } catch (e) {
    if (!signal.aborted && engine === currentEngine) authorError = e.message;
  } finally {
    if (authorController === controller) {
      authorController = null;
      authorsLoading = false;
      render();
    }
  }
}
function stopMeasurement() {
  clearTimeout(measurementTimer);
  measurementController?.abort();
  return measurementPromise?.catch(() => {});
}
function scheduleMeasurement() {
  clearTimeout(measurementTimer);
  const current = repo;
  measurementTimer = setTimeout(() => {
    if (
      pluginHidden ||
      !current ||
      repo !== current ||
      busy() ||
      authorsLoading ||
      measurementPromise ||
      current.stats.sizeKnown
    )
      return;
    const controller = (measurementController = new AbortController());
    measurementPromise = measureSizes(current, {
      signal: controller.signal,
      onProgress: schedule,
    })
      .then((result) => {
        if (repo === current) measurementResult = result;
      })
      .catch((e) => {
        if (e.name !== "AbortError") measurementResult = { error: e.message };
      })
      .finally(() => {
        measurementPromise = null;
        measurementController = null;
        schedule();
      });
    schedule();
  }, 1200);
}
async function action(name) {
  try {
    if (name === "home") {
      stopAuthors();
      navigate("home");
      return;
    }
    if (name === "task") {
      navigate("task");
      return;
    }
    if (name === "folder") {
      if (busy()) return;
      const response = await chrome.runtime.sendMessage({
        type: "OPEN_FOLDER_PICKER_TAB",
      });
      if (!response?.ok)
        throw new Error(response?.error || "无法打开文件夹选择器");
      return;
    }
    if (name === "liked" || name === "bookmarked") {
      await start(name);
      return;
    }
    if (name === "following") {
      if (!repo || busy()) return;
      navigate("authors");
      if (!authorsDone) await loadAuthors();
      return;
    }
    if (name === "loadAuthors") {
      await loadAuthors();
      return;
    }
    if (name === "startFollowing") {
      await start(
        "following",
        authors.filter((a) => selected.has(a.uid)),
      );
      return;
    }
    if (name === "pause") {
      await engine.pause();
      render();
      return;
    }
    if (name === "download") {
      const task = latest();
      if (task) await start(task.scope, task.authors);
      return;
    }
    if (name === "bind") {
      if (busy()) return;
      await stopMeasurement();
      await navigator.locks.request(
        "douyin-archive-" + repo.state.id,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) throw new Error("备份库正在使用");
          await repo.load();
          const current = await engine.sources.profile();
          await repo.bind(current, true);
        },
      );
      notice("已绑定当前账号");
      render();
      return;
    }
    if (name === "report") {
      await updateReport(false);
      return;
    }
    if (name === "stopOrganize") {
      organizeController?.abort();
      return;
    }
    if (name === "organize") {
      if (busy()) return;
      await stopMeasurement();
      organizing = true;
      organizeResult = null;
      error = "";
      organizeController = new AbortController();
      render();
      try {
        organizeResult = await organize(repo, {
          signal: organizeController.signal,
          onProgress: (p) => {
            organizeProgress = p;
            schedule();
          },
        });
        notice(`已整理，清理 ${number(organizeResult.removed)} 个重复文件；分类目录已更新`);
      } catch (e) {
        if (e.name === "AbortError") notice("整理已停止，已完成的核对已保留");
        else throw e;
      } finally {
        organizing = false;
        scheduleReport();
        render();
      }
      return;
    }
  } catch (e) {
    error = e.message;
    notice(e.message);
    render();
  }
}
view.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (button && !button.disabled) void action(button.dataset.action);
});
view.addEventListener("input", (event) => {
  if (event.target.id === "authorSearch") {
    search = event.target.value;
    render();
  }
});
view.addEventListener("change", (event) => {
  if (event.target.dataset.author) {
    event.target.checked
      ? selected.add(event.target.dataset.author)
      : selected.delete(event.target.dataset.author);
    rememberSelection();
    render();
  }
  if (event.target.id === "selectAll" && authorsDone) {
    for (const author of authors.filter(
      (a) => !search || a.nickname.toLowerCase().includes(search.toLowerCase()),
    ))
      event.target.checked
        ? selected.add(author.uid)
        : selected.delete(author.uid);
    rememberSelection();
    render();
  }
});
function collapse(value) {
  setQuickMenu(false);
  parent.postMessage(
    {
      source: "douyin-toolkit-sidebar",
      type: "SET_SIDEBAR_COLLAPSED",
      payload: { collapsed: value },
    },
    "*",
  );
}
$("collapseBtn").addEventListener("click", () => collapse(true));
$("floating").addEventListener("click", (event) => {
  if (event.detail && Date.now() < suppressFloatingClickUntil) return;
  if (engine?.busy) navigate("task");
  collapse(false);
});
let menuTimer;
let suppressFloatingClickUntil = 0;
let dragState = null;
const dragMessage = (phase, x, y) =>
  parent.postMessage(
    {
      source: "douyin-toolkit-sidebar",
      type: "FLOATING_DRAG",
      payload: { phase, x, y },
    },
    "*",
  );
$("floating").addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  dragState = {
    id: event.pointerId,
    x: event.screenX,
    y: event.screenY,
    moved: false,
  };
  $("floating").setPointerCapture?.(event.pointerId);
});
$("floating").addEventListener("pointermove", (event) => {
  if (!dragState || dragState.id !== event.pointerId) return;
  if (
    !dragState.moved &&
    Math.hypot(event.screenX - dragState.x, event.screenY - dragState.y) < 5
  )
    return;
  if (!dragState.moved) {
    dragState.moved = true;
    setQuickMenu(false);
    $("floating").classList.add("dragging");
    dragMessage("start", dragState.x, dragState.y);
  }
  dragMessage("move", event.screenX, event.screenY);
});
function finishDrag(event) {
  if (!dragState || dragState.id !== event.pointerId) return;
  if (dragState.moved) {
    suppressFloatingClickUntil = Date.now() + 600;
    dragMessage(
      event.type === "pointercancel" ? "cancel" : "end",
      event.screenX,
      event.screenY,
    );
  }
  dragState = null;
  $("floating").classList.remove("dragging");
}
$("floating").addEventListener("pointerup", finishDrag);
$("floating").addEventListener("pointercancel", finishDrag);
let closing = false;
async function closePlugin() {
  if (closing) return;
  closing = true;
  try {
    stopAuthors();
    await stopMeasurement();
    await saveSelection();
    organizeController?.abort();
    if (engine?.busy) await engine.pause();
    setQuickMenu(false);
    pluginHidden = true;
    parent.postMessage(
      { source: "douyin-toolkit-sidebar", type: "CLOSE_SIDEBAR" },
      "*",
    );
  } catch (e) {
    notice("关闭前保存进度失败：" + e.message);
  } finally {
    closing = false;
  }
}
$("closeBtn").addEventListener("click", () => void closePlugin());
$("floatingClose").addEventListener("click", () => void closePlugin());
function setQuickMenu(open) {
  clearTimeout(menuTimer);
  open = Boolean(
    open && !dragState?.moved && document.body.classList.contains("collapsed"),
  );
  $("quickMenu").hidden = !open;
  $("floating").setAttribute("aria-expanded", String(open));
  parent.postMessage(
    {
      source: "douyin-toolkit-sidebar",
      type: "SET_FLOATING_MENU",
      payload: { open },
    },
    "*",
  );
}
$("floatingDock").addEventListener("pointerenter", () => setQuickMenu(true));
$("floatingDock").addEventListener("pointerleave", () => {
  menuTimer = setTimeout(() => {
    if (!$("floatingDock").contains(document.activeElement))
      setQuickMenu(false);
  }, 220);
});
$("floatingDock").addEventListener("focusin", () => setQuickMenu(true));
$("floatingDock").addEventListener("focusout", () => {
  menuTimer = setTimeout(() => {
    if (
      !$("floatingDock").contains(document.activeElement) &&
      !$("floatingDock").matches(":hover")
    )
      setQuickMenu(false);
  }, 100);
});
$("floatingDock").addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    document.activeElement?.blur();
    setQuickMenu(false);
  }
});
$("quickMenu").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-quick]");
  if (!button || button.disabled) return;
  const scope = button.dataset.quick;
  setQuickMenu(false);
  if (engine?.busy) {
    navigate("task");
    collapse(false);
    return;
  }
  if (!repo) {
    navigate("home");
    collapse(false);
    notice("请先选择并授权备份文件夹");
    return;
  }
  if (scope === "following") collapse(false);
  await action(scope);
});
$("menuBtn").addEventListener("click", () =>
  navigate(route === "details" ? "home" : "details"),
);
window.addEventListener("message", (event) => {
  if (
    event.data?.source === "douyin-toolkit-content" &&
    event.data.type === "SIDEBAR_VISIBILITY_STATE"
  ) {
    pluginHidden = !event.data.payload?.visible;
    if (!pluginHidden) void refreshTarget();
  }
  if (
    event.data?.source === "douyin-toolkit-content" &&
    event.data.type === "FLOATING_LAYOUT"
  ) {
    const p = event.data.payload;
    if (!p || !Number.isFinite(p.anchorX) || !Number.isFinite(p.anchorY))
      return;
    $("floatingDock").style.setProperty(
      "--anchor-x",
      p.offsets[0][0] < 0 ? "calc(100vw - 30px)" : "30px",
    );
    $("floatingDock").style.setProperty(
      "--anchor-y",
      p.offsets[2][1] < 0 ? "calc(100vh - 30px)" : "30px",
    );
    document.querySelectorAll("[data-quick]").forEach((button, i) => {
      button.style.setProperty("--qx", p.offsets[i][0] + "px");
      button.style.setProperty("--qy", p.offsets[i][1] + "px");
    });
  }
  if (
    event.data?.source === "douyin-toolkit-content" &&
    event.data.type === "SIDEBAR_COLLAPSE_STATE"
  ) {
    const collapsed = Boolean(event.data.payload?.collapsed);
    document.body.classList.toggle("collapsed", collapsed);
    if (!collapsed) setQuickMenu(false);
  }
});
window.addEventListener("focus", () => void refreshTarget());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshTarget();
});
window.addEventListener("beforeunload", (event) => {
  if (engine?.busy || organizing) {
    event.preventDefault();
    event.returnValue = "";
  }
});
setInterval(() => void refreshTarget(), 3000);
setInterval(() => {
  if ((engine?.busy || authorsLoading) && engine.sources.retry?.last)
    schedule();
}, 1000);
render();
void refreshTarget();
