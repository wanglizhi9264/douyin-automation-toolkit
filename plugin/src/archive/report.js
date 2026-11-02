import { sourceProgress } from "../core/progress.js";
import { summary, counters, runCounters } from "../core/model.js";
import { httpStatus } from "../shared/http.js";
import { ROOT, now } from "./fs.js";
const SCOPES = { liked: "喜欢", bookmarked: "收藏", following: "关注" };
const STATUS = {
  downloaded: "已备份",
  failed: "下载失败",
  unsupported: "暂不支持",
  queued: "待处理",
  preparing: "准备中",
  downloading: "下载记录中",
  retry_wait: "等待重试",
  not_started: "待处理",
};
const OUTCOMES = {
  best: "最高候选成功",
  fallback: "同分辨率回退",
  degraded: "已降级",
  unknown: "最高候选未记录",
  image: "仅图片",
};
const quality = (value) => {
  if (!value) return "";
  if (!value.width || !value.height) return "";
  return `${value.width} × ${value.height}${value.codec ? " · " + String(value.codec).toUpperCase() : ""}${value.fps ? " · " + value.fps + " fps" : ""}${value.bitrate ? " · " + (value.bitrate / 1e6).toFixed(1) + " Mbps" : ""}`;
};
const unique = (list) => [...new Set(list.filter(Boolean))];
export function safeMediaPath(path) {
  const text = String(path || "");
  if (
    !text.startsWith("data/") ||
    text
      .split("/")
      .some((p) => !p || p === "." || p === ".." || /[\\\0]/.test(p))
  )
    return "";
  return text.split("/").map(encodeURIComponent).join("/");
}
function legacyQuality(meta) {
  if (meta.width && meta.height)
    return {
      width: meta.width,
      height: meta.height,
      codec: meta.codec,
      bitrate: meta.bitrate,
      fps: meta.fps,
    };
  const resolution = String(meta.resolution || meta.quality || "").match(
    /(\d{2,5})\s*[x×]\s*(\d{2,5})/i,
  );
  return resolution
    ? { width: +resolution[1], height: +resolution[2], codec: meta.codec || "" }
    : null;
}
function pathQuality(path) {
  const m = String(path).match(/\/(h26[45]|unknown)-(\d+)-(\d+)-\d+-(\d+)\//);
  return m
    ? { codec: m[1], width: +m[2], height: +m[3], bitrate: +m[4] }
    : null;
}
export async function readReportMetadata(io) {
  const names = [
    "download-state.json",
    "db_videos.json",
    "db_texts.json",
    "db_authors.json",
  ];
  const warnings = [];
  const values = await Promise.all(
    names.map(async (name) => {
      try {
        return await io.json(`${ROOT}/${name}`);
      } catch (e) {
        warnings.push(`未读取 ${name}，相关历史详情可能缺失`);
        return null;
      }
    }),
  );
  return {
    record: values[0] || {},
    videos: values[1] || {},
    texts: values[2] || {},
    authors: values[3] || {},
    warnings,
  };
}
export function buildReportModel(
  state,
  { folderLabel = "", generatedAt = now(), metadata = {} } = {},
) {
  const stats = summary(state),
    tasks = Object.values(state.tasks || {}).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    ),
    jobs = new Map();
  for (const task of tasks)
    for (const item of Object.values(task.items || {}))
      if (!jobs.has(item.id)) jobs.set(item.id, { ...item, task });
  const old = new Map();
  for (const item of metadata.record?.items || [])
    old.set(String(item.awemeId), {
      ...(old.get(String(item.awemeId)) || {}),
      ...item,
    });
  const ids = unique([...Object.keys(state.works || {}), ...jobs.keys()]);
  const rows = ids.map((id) => {
    const work = state.works[id] || {},
      job = jobs.get(id),
      meta = { ...(metadata.videos?.[id] || {}), ...(old.get(id) || {}) };
    const files = (work.files || [])
      .map((path) => state.files[path])
      .filter(Boolean);
    const parts = files.map((file) => ({
      partId: file.partId,
      kind: file.kind,
      path: file.path,
      size: file.size,
      actual: file.quality || pathQuality(file.path),
      highest: file.highest || null,
      outcome: file.qualityOutcome || "unknown",
      reason: file.fallbackReason || "",
      attempts: file.attempts || [],
    }));
    if (!parts.length) {
      const q = legacyQuality(meta);
      if (q)
        parts.push({
          partId: "video-1",
          kind: "video",
          actual: q,
          highest: null,
          outcome: "unknown",
          reason: "历史记录未保留最高候选，无法确认是否最高画质",
          path: meta.videoPath || meta.video || "",
        });
    }
    const media =
      work.mediaType ||
      meta.mediaType ||
      (parts.length && parts.every((p) => p.kind === "image")
        ? "image"
        : "video");
    const videos = parts.filter((p) => p.kind !== "image");
    const outcome = !work.complete
      ? "pending"
      : media === "image" || media === "multi_image"
        ? "image"
        : videos.some((p) => p.outcome === "degraded")
          ? "degraded"
          : videos.some((p) => p.outcome === "fallback")
            ? "fallback"
            : videos.length && videos.every((p) => p.outcome === "best")
              ? "best"
              : "unknown";
    const status = work.complete ? "downloaded" : job?.state || "not_started";
    const error = work.complete
      ? ""
      : job?.error ||
        Object.values(work.diagnostics || {}).find((d) => d.error)?.error ||
        meta.lastError ||
        "";
    const statusCode = httpStatus({ message: error });
    const paths = unique([
      ...parts.map((p) => p.path),
      ...(meta.mediaPaths || []),
      ...(meta.imagePaths || []),
      meta.videoPath,
      meta.video,
    ]);
    const updated =
      work.completedAt ||
      files
        .map((f) => f.updatedAt || "")
        .sort()
        .at(-1) ||
      meta.updatedAt ||
      (job ? job.task.createdAt : "") ||
      "";
    const sources = unique([
      ...(work.sources || []),
      ...(job ? [job.scope] : []),
    ]).filter((scope) => scope in SCOPES);
    const diagnostic = Object.entries(work.diagnostics || {})
      .filter(([partId]) => !parts.some((p) => p.partId === partId))
      .map(([partId, value]) => ({ partId, ...value }));
    return {
      id,
      desc: work.desc || meta.desc || metadata.texts?.[id] || "",
      author:
        work.authorName ||
        meta.authorName ||
        metadata.authors?.[work.authorUid || meta.authorUid]?.nickname ||
        "",
      sources,
      status,
      error,
      statusCode,
      media,
      outcome,
      quality:
        unique(videos.map((p) => quality(p.actual))).join(" / ") ||
        (outcome === "image" ? "图片作品" : "未记录"),
      parts,
      diagnostic,
      paths: paths.filter(safeMediaPath),
      updated,
      retryAt: job?.retryAt || null,
    };
  });
  const failures = rows.filter((row) =>
      ["failed", "unsupported"].includes(row.status),
    ),
    pending = rows.filter(
      (row) => !["downloaded", "failed", "unsupported"].includes(row.status),
    );
  const causes = {};
  for (const row of failures) {
    const key = row.statusCode
      ? `HTTP ${row.statusCode}`
      : row.status === "unsupported"
        ? "暂不支持"
        : "其他错误";
    causes[key] = (causes[key] || 0) + 1;
  }
  const outcomes = { best: 0, fallback: 0, degraded: 0, unknown: 0, image: 0 };
  for (const row of rows)
    if (row.status === "downloaded") outcomes[row.outcome]++;
  const sources = Object.entries(SCOPES).map(([scope,label])=>{
    const task=tasks.find(t=>t.scope===scope);
    const progress=sourceProgress(stats,scope,{task,ownerUid:state.owner?.uid});
    const display=task?.platformDisplayTotal;
    return {scope,label,saved:stats.sources[scope],total:progress.total,totalAt:progress.readAt,totalSource:progress.totalSource,displayTotal:progress.total===null && /^约[\d.]+[万亿w]$/i.test(display||"") ? display : null};
  });
  return {
    version: "0.8.5",
    folderLabel,
    generatedAt,
    updatedAt: state.updatedAt,
    owner: state.owner?.nickname || "",
    stats: {
      ...stats,
      failed: failures.length,
      pending: pending.length,
      rows: rows.length,
    },
    sources,
    causes,
    outcomes,
    rows,
    warnings: metadata.warnings || [],
    tasks: tasks.slice(0, 6).map((t) => ({
      scope: t.scope,
      status: t.status,
      createdAt: t.createdAt,
      counts: runCounters(t),
      lifetimeCounts: counters(t),
      run: t.run || null,
      sourceDone: t.sourceDone,
      sourceErrors: t.sourceErrors || [],
      retryState: t.retryState || null,
      recovery: t.recovery || null,
      sourceEnd: t.sourceEnd || null,
      sourceLastPage: t.sourceLastPage || null,
      sourcePageHistory: t.sourcePageHistory || [],
    })),
  };
}
function reportClient(DATA) {
  const $ = (id) => document.getElementById(id),
    esc = (v) =>
      String(v ?? "").replace(
        /[&<>"']/g,
        (c) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[c],
      ),
    num = (v) => Number(v || 0).toLocaleString("zh-CN");
  const scopes = { liked: "喜欢", bookmarked: "收藏", following: "关注" },
    states = {
      downloaded: "已备份",
      failed: "下载失败",
      unsupported: "暂不支持",
      queued: "待处理",
      retry_wait: "等待重试",
      downloading: "下载记录中",
      not_started: "待处理",
      preparing: "准备中",
    },
    qualities = {
      pending: "尚未完成下载",
      best: "最高候选成功",
      fallback: "同分辨率回退",
      degraded: "已降级",
      unknown: "最高候选未记录",
      image: "仅图片",
    };
  const q = (v) =>
    v?.width && v?.height
      ? `${v.width} × ${v.height}${v.codec ? " · " + String(v.codec).toUpperCase() : ""}${v.bitrate ? " · " + (v.bitrate / 1e6).toFixed(1) + " Mbps" : ""}`
      : "未记录";
  const pathHref = (path) =>
    String(path).split("/").map(encodeURIComponent).join("/");
  let page = 1,
    selectedScope = "",
    filterStatus = "",
    selectedQuality = "",
    query = "",
    sort = "recent",
    filtered = [],
    expanded = null;
  const pageSize = 50;
  const date = (value) =>
    value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
  function details(row) {
    return `<div class="detail-body"><div><span class="dim">作品 ID</span> ${esc(row.id)} · <span class="dim">记录更新</span> ${esc(date(row.updated))}</div>${row.error ? `<div class="error-text">${esc(row.error)}</div>` : ""}${row.parts.map((part) => `<div class="part"><b>${esc(part.partId)}</b><span>实际：${esc(q(part.actual))}</span><span>最高候选：${esc(q(part.highest))}</span>${part.reason ? `<small>回退原因：${esc(part.reason)}</small>` : ""}${part.attempts?.length ? `<details class="attempts"><summary>失败 / 重试记录 · ${part.attempts.length} 次</summary>${part.attempts.map((a) => `<div>${esc(date(a.at))} · 候选 ${esc(a.rank)} · ${esc(a.status ? "HTTP " + a.status : a.error)}${a.retryUntil ? " · 冷却至 " + esc(date(a.retryUntil)) : ""}<small>${esc(a.error)}</small></div>`).join("")}</details>` : ""}</div>`).join("")}${row.diagnostic.map((d) => `<div class="part"><b>${esc(d.partId)}</b><span>最高候选：${esc(q(d.highest))}</span><small>${esc(d.error || "")}</small></div>`).join("")}${row.paths.length ? row.paths.map((path) => `<div class="file-path"><a href="${esc(pathHref(path))}" target="_blank" rel="noopener">打开媒体 ↗</a><code>${esc(path)}</code></div>`).join("") : '<div class="dim">历史记录没有保留媒体路径，可在插件整理备份后重新生成报告。</div>'}</div>`;
  }
  function render() {
    filtered = DATA.rows.filter(
      (r) =>
        (!selectedScope || r.sources.includes(selectedScope)) &&
        (!filterStatus ||
          (filterStatus === "issues"
            ? ["failed", "unsupported"].includes(r.status)
            : filterStatus === "pending"
              ? !["downloaded", "failed", "unsupported"].includes(r.status)
              : r.status === filterStatus)) &&
        (!selectedQuality || r.outcome === selectedQuality) &&
        (!query ||
          [r.id, r.desc, r.author, r.error, r.quality]
            .join(" ")
            .toLowerCase()
            .includes(query)),
    );
    filtered.sort((a, b) =>
      sort === "issues"
        ? Number(["failed", "unsupported"].includes(b.status)) -
            Number(["failed", "unsupported"].includes(a.status)) ||
          String(b.updated).localeCompare(a.updated)
        : String(b.updated).localeCompare(a.updated) ||
          b.id.localeCompare(a.id),
    );
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    page = Math.min(Math.max(1, page), pages);
    const current = filtered.slice((page - 1) * pageSize, page * pageSize);
    $("rows").innerHTML = current.length
      ? current
          .map(
            (row) =>
              `<article class="work-row"><div class="work-title"><button class="details-toggle" data-id="${esc(row.id)}">${esc(row.desc || "历史作品（仅有完成索引）")}</button><small>${esc(row.author || "作者未记录")} <span class="work-id">· ${esc(row.id)}</span></small></div><div class="source-tags">${row.sources.map((s) => `<span>${scopes[s]}</span>`).join("")}</div><div><span class="state ${row.status === "downloaded" ? "ok" : row.status === "failed" ? "bad" : ""}">${states[row.status] || "待处理"}</span>${row.statusCode ? `<small class="error-text">HTTP ${row.statusCode}</small>` : ""}</div><div class="quality"><span>${esc(row.quality)}</span><small class="${row.outcome === "degraded" ? "error-text" : "dim"}">${qualities[row.outcome]}</small></div><div class="row-actions">${row.paths[0] ? `<a href="${esc(pathHref(row.paths[0]))}" target="_blank" rel="noopener">媒体 ↗</a>` : ""}${/^\d+$/.test(row.id) ? `<a href="https://www.douyin.com/${row.media.includes("image") ? "note" : "video"}/${row.id}" target="_blank" rel="noopener noreferrer">抖音 ↗</a>` : ""}<button data-id="${esc(row.id)}">详情</button></div></article>${expanded === row.id ? details(row) : ""}`,
          )
          .join("")
      : '<div class="empty">没有符合条件的作品。试试其他筛选条件。</div>';
    $("count").textContent =
      `${num(filtered.length)} 个作品 · 第 ${page} / ${num(pages)} 页`;
    $("prev").disabled = page <= 1;
    $("next").disabled = page >= pages;
    for (const button of document.querySelectorAll("[data-scope]"))
      button.classList.toggle(
        "selected",
        button.dataset.scope === selectedScope,
      );
  }
  document.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) return;
    if (target.dataset.id !== undefined) {
      expanded = expanded === target.dataset.id ? null : target.dataset.id;
      render();
    }
    if (target.dataset.scope !== undefined) {
      selectedScope = target.dataset.scope;
      page = 1;
      render();
    }
    if (target.dataset.issue !== undefined) {
      filterStatus = "issues";
      selectedQuality = query = selectedScope = "";
      $("search").value = $("quality").value = "";
      $("status").value = filterStatus;
      page = 1;
      render();
      $("library").scrollIntoView({ behavior: "smooth" });
    }
    if (target.dataset.quality !== undefined) {
      selectedQuality = target.dataset.quality;
      filterStatus = "downloaded";
      selectedScope = query = "";
      $("status").value = filterStatus;
      $("search").value = "";
      $("quality").value = selectedQuality;
      page = 1;
      render();
      $("library").scrollIntoView({ behavior: "smooth" });
    }
  });
  $("search").addEventListener("input", () => {
    query = $("search").value.trim().toLowerCase();
    page = 1;
    render();
  });
  $("status").onchange = () => {
    filterStatus = $("status").value;
    page = 1;
    render();
  };
  $("quality").onchange = () => {
    selectedQuality = $("quality").value;
    page = 1;
    render();
  };
  $("sort").onchange = () => {
    sort = $("sort").value;
    page = 1;
    render();
  };
  $("prev").onclick = () => {
    page--;
    render();
  };
  $("next").onclick = () => {
    page++;
    render();
  };
  $("reset").onclick = () => {
    query = selectedScope = filterStatus = selectedQuality = "";
    page = 1;
    $("search").value = $("status").value = $("quality").value = "";
    render();
  };
  $("csv").onclick = () => {
    const field = (v) => {
      let s = String(v ?? "");
      if (/^[=+@-]/.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    };
    const lines = [
      [
        "作品ID",
        "作品",
        "作者",
        "来源",
        "状态",
        "实际画质",
        "画质结果",
        "错误",
        "媒体路径",
      ],
      ...filtered.map((r) => [
        r.id,
        r.desc,
        r.author,
        r.sources.map((s) => scopes[s]).join("/"),
        states[r.status] || r.status,
        r.quality,
        qualities[r.outcome],
        r.error,
        r.paths.join(" | "),
      ]),
    ];
    const blob = new Blob(
        ["\ufeff" + lines.map((row) => row.map(field).join(",")).join("\r\n")],
        { type: "text/csv;charset=utf-8" },
      ),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = "抖音备份-当前筛选.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  render();
}
export function renderLibraryReport(model) {
  const esc = (v) =>
      String(v ?? "").replace(
        /[&<>"']/g,
        (c) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[c],
      ),
    num = (n) => Number(n || 0).toLocaleString("zh-CN"),
    bytes = (n) => {
      if (!n) return "0 B";
      const units = ["B", "KB", "MB", "GB", "TB"],
        i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)));
      return (n / 1024 ** i).toFixed(i > 1 ? 1 : 0) + " " + units[i];
    },
    date = (v) =>
      v ? new Date(v).toLocaleString("zh-CN", { hour12: false }) : "尚未记录";
  const task = model.tasks[0],
    retry = task?.retryState,
    taskState = {
      running: task?.counts.pending ? "下载中（记录）" : "检查中（记录）",
      paused: "已暂停",
      completed: "本轮完成",
      partial: "部分完成",
      starting: "准备中",
      pausing: "暂停中",
    };
  const retryMessage = retry
    ? task.status === "paused"
      ? `${retry.reason || "重试记录"} · 任务已暂停，进度已保留。冷却期限 ${date(retry.until)}，在插件中点击继续后重试。`
      : retry.until > Date.parse(model.generatedAt)
        ? `${retry.reason || "重试记录"} · 上次记录冷却至 ${date(retry.until)}。插件运行时会自动重试；暂停或关闭后需继续。`
        : `${retry.reason || "重试记录"} · 冷却已结束，后续继续情况以本次保存和失败记录为准。`
    : "";
  const help = {
    "HTTP 429":
      "请求过于频繁。新版插件冷却后自动重试；达到重试上限会保留进度并暂停。",
    "HTTP 403":
      "媒体地址可能过期，或当前账号无访问权限。新版会刷新一次作品地址；仍失败时记录原因。",
    "HTTP 404": "作品或媒体地址已失效，可稍后重试或检查抖音访问情况。",
    "HTTP 502": "服务暂时异常，新版会等待后重试。",
    "HTTP 503": "服务暂时不可用，新版会按服务端等待时间重试。",
  };
  const data = JSON.stringify(model)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `<!doctype html><html lang="zh-CN" data-report-version="0.8.5"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>抖音备份 · 本地报告</title><style>${REPORT_CSS}</style></head><body><div class="layout"><aside><div class="brand"><span class="brand-icon">↓</span>抖音备份</div><nav><a href="#overview">备份总览</a><a href="#library">全部作品</a><a href="#issues">需要处理 <span>${num(model.stats.failed)}</span></a><a href="#quality-summary">画质记录</a></nav><p>本地离线报告<br>v${model.version}<br>文件保存在你的电脑</p></aside><main><header><div><div class="eyebrow">本地资料库</div><h1>本地备份报告</h1><p>${esc(model.folderLabel)}${model.owner ? " · " + esc(model.owner) : ""}</p></div><div class="generated">报告生成于<br><b>${esc(date(model.generatedAt))}</b><span>静态快照，更新需在插件中生成报告</span></div></header><section id="overview" class="overview"><div><span>唯一已备份</span><strong>${num(model.stats.unique)}<small>个作品</small></strong><p>相同作品按 ID 只计算一次</p></div><button data-issue><span>需要处理</span><strong>${num(model.stats.failed)}</strong><p>查看失败原因与对应作品 ↗</p></button><div><span>待处理记录</span><strong>${num(model.stats.pending)}</strong><p>包含历史未完成记录；本次以最近运行为准</p></div><div><span>已完成媒体占用</span><strong class="size">${bytes(model.stats.bytes)}${model.stats.sizeKnown ? "" : "+"}</strong><p>${model.stats.sizeKnown ? "来自备份库中的完成文件记录" : `已知占用；${num(model.stats.unknownWorks)} 个历史作品缺少大小记录`}</p></div></section><section class="source-summary"><div class="section-title"><h2>来源备份统计</h2><span>累计包含历史喜欢 / 收藏，来源数量不相加作为总数</span></div><div class="source-grid">${model.sources.map((s) => `<div><div class="source-name">${s.label}</div><div><b>${num(s.saved)}</b><span>累计已备份</span></div><p>${s.scope === "following" ? "所选关注作者的作品" : `${s.label}总数 ${s.displayTotal || (s.total === null ? "平台未提供" : num(s.total))} · ${s.totalSource === "list" ? "上次完整读取" : s.displayTotal ? "页面近似值" : "平台上次读取"}`}</p></div>`).join("")}</div></section><section class="task-section"><div class="section-title"><h2>最近一次运行</h2><span>${task ? esc(SCOPES[task.scope]) + " · " + esc(taskState[task.status] || task.status) : "暂无任务记录"}</span></div>${task ? `<div class="task-numbers"><div><b>+${num(task.counts.saved)}</b><span>本次新下载</span></div><div><b>${num(task.counts.existing)}</b><span>已有跳过</span></div><div><b>${num(task.counts.read)}</b><span>本次检查</span></div><div><b>${num(task.counts.failed + task.counts.unsupported)}</b><span>需处理</span></div></div><p class="note">${task.retryOnly ? "本次仅重试失败作品，没有重新检查完整列表。" : task.sourceDone ? "本次可读取列表已到末页；平台总数可能包含本轮未返回的内容。" : "列表尚未检查完，不能将本次记录当作完整备份结果。"} 本次开始：${esc(date(task.run?.startedAt || task.createdAt))} · 保存记录更新：${esc(date(model.updatedAt))}。</p>${task.counts.upgraded ? `<p class="note">本次画质升级 ${num(task.counts.upgraded)} 个作品，不计入新增数量。</p>` : ""}${task.recovery ? `<p class="note">本轮失败项自动补下：${num(task.recovery.total)} 个，已补下 ${num(task.recovery.recovered || 0)} 个${task.recovery.status === "completed" ? `，仍需处理 ${num(task.recovery.remaining)} 个` : task.recovery.status === "paused" ? "，已暂停" : "，正在处理"}。最多补下一轮。</p>` : ""}${retry ? `<div class="notice">${esc(retryMessage)}</div>` : ""}${task.sourceErrors.length ? `<div class="notice">${esc(task.sourceErrors.join("；"))}</div>` : ""}${task.sourceLastPage ? `<details class="pagination-record"><summary>列表读取诊断</summary><pre>${esc(JSON.stringify({ lastPage: task.sourceLastPage, end: task.sourceEnd, recentPages: task.sourcePageHistory }, null, 2))}</pre></details>` : ""}` : '<p class="note">在插件中开始一次备份后，这里会显示增量下载记录。</p>'}</section><div class="two-columns"><section id="issues"><div class="section-title"><h2>需要处理的原因</h2><button data-issue>筛选作品 ↗</button></div>${
    Object.entries(model.causes)
      .sort((a, b) => b[1] - a[1])
      .map(
        ([cause, count]) =>
          `<div class="cause"><div><b>${esc(cause)}</b><span>${num(count)} 个作品</span></div><p>${esc(help[cause] || "查看作品详情中的具体错误，确认原因后再继续下载。")}</p></div>`,
      )
      .join("") || '<div class="blank-note">当前记录中没有待处理失败。</div>'
  }<p class="note">403 与 429 分开统计。报告本身不发起重试，也不改变下载状态。</p></section><section id="quality-summary"><div class="section-title"><h2>画质结果</h2><span>仅统计已备份作品</span></div>${Object.entries(
    OUTCOMES,
  )
    .map(
      ([key, label]) =>
        `<button class="quality-total" data-quality="${key}"><span>${label}</span><b>${num(model.outcomes[key])}</b></button>`,
    )
    .join(
      "",
    )}<p class="note">优先尝试接口提供的最高候选；回退时保留原因。历史记录没有最高候选时明确标为未记录。</p></section></div><section id="library"><div class="section-title library-title"><h2>全部作品</h2><button id="csv">导出当前筛选 CSV ↗</button></div><div class="filters"><input id="search" placeholder="搜索描述、作者、作品 ID 或错误" aria-label="搜索作品"><select id="status" aria-label="下载状态"><option value="">全部状态</option><option value="downloaded">已备份</option><option value="issues">需处理</option><option value="pending">待处理记录</option><option value="retry_wait">等待重试</option></select><select id="quality" aria-label="画质结果"><option value="">全部画质</option>${Object.entries(
    OUTCOMES,
  )
    .map(([key, label]) => `<option value="${key}">${label}</option>`)
    .join(
      "",
    )}</select><select id="sort" aria-label="排序"><option value="recent">最近记录优先</option><option value="issues">需处理优先</option></select><button id="reset">重置</button></div><div class="scope-tabs">${[["", "全部来源"], ...Object.entries(SCOPES)].map(([scope, label]) => `<button data-scope="${scope}">${label}</button>`).join("")}</div><div class="table-head"><span>作品 / 作者</span><span>来源</span><span>下载状态</span><span>实际画质 / 结果</span><span>查看</span></div><div id="rows"></div><div class="pagination"><span id="count"></span><div><button id="prev">上一页</button><button id="next">下一页</button></div></div></section>${model.warnings.length ? `<p class="notice">${esc(model.warnings.join("；"))}</p>` : ""}<footer>基于备份目录记录生成 · 文件外部变动需在插件中整理核对 · 离线可用，无需登录</footer></main></div><script>(${reportClient.toString()})(${data});</script></body></html>`;
}
const REPORT_CSS = `:root{color-scheme:light;font:14px/1.5 -apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI',sans-serif;color:#1d1d1f;--blue:#0071e3;--muted:#86868b;--line:#e9e9ed;--bg:#f5f5f7}*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:20px}body{margin:0;background:white}button,input,select{font:inherit}button,a,input,select{touch-action:manipulation}button{cursor:pointer;border:0;background:none;color:inherit}button:disabled{opacity:.35;cursor:default}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #0071e355;outline-offset:3px}a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}button:hover{color:var(--blue)}.layout{max-width:1560px;margin:auto;display:grid;grid-template-columns:188px minmax(0,1fr)}aside{height:100vh;position:sticky;top:0;border-right:1px solid var(--line);padding:30px 20px;display:flex;flex-direction:column}.brand{font-weight:600;display:flex;gap:9px;align-items:center}.brand-icon{display:grid;place-items:center;background:var(--blue);color:white;width:27px;height:27px;border-radius:8px;font-size:21px}nav{display:grid;gap:7px;margin-top:40px}nav a{color:#6e6e73;border-radius:6px;font-size:13px;padding:9px}nav a:hover{background:var(--bg);text-decoration:none;color:var(--blue)}nav span{float:right;color:var(--muted)}aside>p{font-size:11px;color:var(--muted);margin-top:auto;line-height:1.9}main{padding:45px 40px;min-width:0}header{display:flex;justify-content:space-between;gap:24px;align-items:flex-end;padding-bottom:27px;border-bottom:1px solid var(--line)}h1{font-size:27px;line-height:1.35;font-weight:600;letter-spacing:-.7px;margin:7px 0 10px}header p{font-size:12px;color:#6e6e73;margin:0;overflow-wrap:anywhere}.eyebrow{font-size:11px;color:var(--muted);letter-spacing:1px}.generated{font-size:10px;color:var(--muted);text-align:right;flex-shrink:0;line-height:1.8}.generated b{font-size:11px;color:#6e6e73;font-weight:400}.generated span{display:block;font-size:9px}.overview{display:grid;grid-template-columns:1.3fr 1fr 1fr 1.2fr;gap:22px;padding:30px 0;border-bottom:1px solid var(--line)}.overview>button{text-align:left;padding:0}.overview span{color:#6e6e73;font-size:12px}.overview strong{display:block;font-size:33px;line-height:1.25;font-weight:500;letter-spacing:-.8px;margin:9px 0 6px;font-variant-numeric:tabular-nums}.overview strong small{font-size:11px;font-weight:400;letter-spacing:0;color:var(--muted);margin-left:5px}.overview .size{font-size:28px}.overview p{font-size:10px;color:var(--muted);margin:0;line-height:1.7}section{scroll-margin-top:24px}.section-title{display:flex;gap:14px;align-items:center;justify-content:space-between;margin-bottom:17px}.section-title h2{font-size:15px;font-weight:600;margin:0}.section-title>span,.section-title>button{font-size:10px;color:var(--muted)}.section-title>button{color:var(--blue);padding:0}.source-summary,.task-section{padding:28px 0;border-bottom:1px solid var(--line)}.source-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:25px}.source-grid>div+div{border-left:1px solid var(--line);padding-left:25px}.source-name{font-size:12px;color:#6e6e73}.source-grid b{font-size:23px;font-weight:500;margin-right:8px;letter-spacing:-.5px}.source-grid span{font-size:10px;color:var(--muted)}.source-grid p{font-size:10px;color:var(--muted);margin:4px 0 0}.task-numbers{display:flex;gap:38px}.task-numbers b{font-size:23px;font-weight:500;display:block}.task-numbers>div:first-child b{color:var(--blue)}.task-numbers span{font-size:10px;color:var(--muted)}.note{font-size:10px;color:var(--muted);line-height:1.8;margin:14px 0 0}.pagination-record{font-size:11px;color:var(--muted);margin-top:14px}.pagination-record pre{max-height:240px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}.notice{font-size:11px;color:#805525;background:#fff8ef;padding:12px 14px;border-radius:7px;margin-top:14px;overflow-wrap:anywhere}.two-columns{display:grid;grid-template-columns:1fr 1fr;gap:35px;padding:29px 0;border-bottom:1px solid var(--line)}.two-columns>section+section{border-left:1px solid var(--line);padding-left:35px}.cause{margin:15px 0}.cause>div{display:flex;justify-content:space-between;gap:12px}.cause b{font-size:12px;font-weight:500}.cause span{font-size:11px;color:var(--muted)}.cause p{font-size:11px;color:#6e6e73;margin:4px 0;line-height:1.7}.quality-total{display:flex;justify-content:space-between;width:100%;padding:7px 0;font-size:11px;text-align:left}.quality-total b{font-weight:500}.blank-note{font-size:12px;color:#6e6e73;padding:20px 0}.library-title{padding-top:31px}.filters{display:flex;gap:8px;flex-wrap:wrap}.filters input,.filters select{border:1px solid #e3e3e8;border-radius:6px;background:#fff;padding:8px 10px;min-width:0;font-size:11px;color:#55555b}.filters input{flex:1;min-width:200px}.filters select{max-width:160px}.filters>button{font-size:11px;color:#6e6e73}.scope-tabs{display:flex;gap:18px;padding:18px 0 12px;border-bottom:1px solid var(--line)}.scope-tabs button{padding:0 0 7px;color:var(--muted);font-size:11px}.scope-tabs .selected{color:var(--blue);box-shadow:0 2px var(--blue)}.table-head,.work-row{display:grid;grid-template-columns:minmax(0,2.1fr) minmax(65px,.6fr) minmax(80px,.7fr) minmax(130px,1fr) 105px;gap:15px;align-items:center}.table-head{padding:12px 0;color:var(--muted);font-size:10px;border-bottom:1px solid var(--line)}.work-row{padding:17px 0;border-bottom:1px solid var(--line);font-size:11px}.work-title{min-width:0}.work-title button{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;padding:0;text-align:left;font-size:12px;line-height:1.6;font-weight:500;overflow-wrap:anywhere}.work-title small{display:block;color:var(--muted);font-size:10px;line-height:1.7;margin-top:4px}.work-id{font-size:9px}.source-tags{display:flex;flex-wrap:wrap;gap:4px}.source-tags span{font-size:10px;padding:2px 5px;background:var(--bg);border-radius:4px;color:#6e6e73}.state{color:#6e6e73}.state.ok{color:#4c637a}.state.bad,.error-text{color:#a4572e}.quality{font-size:10px;overflow-wrap:anywhere}.quality small,.work-row>div>small{display:block;font-size:9px;margin-top:4px}.dim{color:var(--muted)}.row-actions{display:flex;flex-wrap:wrap;gap:7px;font-size:10px}.row-actions button{padding:0;color:#6e6e73}.detail-body{padding:17px;background:#fafafa;border-bottom:1px solid var(--line);font-size:11px;line-height:1.8;overflow-wrap:anywhere}.part{display:flex;gap:12px;flex-wrap:wrap;margin-top:10px}.part small{width:100%;font-size:10px;color:#6e6e73}.file-path{display:grid;grid-template-columns:75px minmax(0,1fr);gap:8px;margin-top:9px}.file-path code{font-size:10px;color:#6e6e73;overflow-wrap:anywhere}.pagination{display:flex;justify-content:space-between;gap:15px;align-items:center;padding:20px 0;font-size:11px;color:var(--muted)}.pagination button{border:1px solid var(--line);border-radius:5px;padding:5px 10px;margin-left:7px;color:#55555b}.empty{padding:50px 0;text-align:center;color:var(--muted);font-size:12px}footer{font-size:10px;color:#a1a1a6;border-top:1px solid var(--line);padding-top:22px;margin-top:30px}@media(max-width:1100px){.layout{grid-template-columns:155px minmax(0,1fr)}main{padding:30px 24px}aside{padding:25px 15px}.table-head,.work-row{gap:10px;grid-template-columns:minmax(0,1.8fr) 60px 75px minmax(100px,1fr) 70px}.overview{gap:12px}.overview strong{font-size:29px}.generated{max-width:160px}.generated span{max-width:150px}.source-grid>div+div{padding-left:15px}.source-grid{gap:15px}}@media(max-width:800px){.layout{display:block}aside{height:auto;position:static;border-right:0;border-bottom:1px solid var(--line);padding:16px 22px;display:flex;flex-direction:row;justify-content:space-between;gap:20px}aside>p{display:none}nav{display:flex;gap:12px;margin:0}nav a{font-size:11px;padding:5px 0}nav span{display:none}header{align-items:flex-start}.generated{display:none}.overview{grid-template-columns:repeat(2,minmax(0,1fr));gap:25px}.overview strong{font-size:31px}.source-summary .section-title>span{max-width:55%;text-align:right}.table-head,.work-row{grid-template-columns:minmax(0,1.5fr) 65px 78px minmax(100px,1fr)}.row-actions{grid-column:1/-1;margin-top:3px;gap:14px}.table-head>span:last-child{display:none}.task-numbers{justify-content:space-between;gap:15px}}@media(max-width:540px){main{padding:25px 18px}.brand{font-size:12px;white-space:nowrap}aside{padding:14px 18px;gap:15px}nav a:nth-child(1),nav a:nth-child(4){display:none}h1{font-size:22px}.source-grid{gap:10px}.source-grid>div+div{padding-left:10px}.source-grid b{display:block;font-size:22px}.source-grid p{font-size:9px}.section-title>span{font-size:9px}.two-columns{grid-template-columns:1fr;gap:25px}.two-columns>section+section{border-left:0;border-top:1px solid var(--line);padding:24px 0 0}.table-head{display:none}.work-row{grid-template-columns:minmax(0,1fr) 85px;gap:10px}.work-title{grid-column:1/-1}.quality{grid-column:1/-1}.source-tags{grid-column:1}.row-actions{grid-column:1/-1}.filters input{min-width:100%;width:100%}.filters select{flex:1;max-width:47%}.task-numbers b{font-size:21px}.overview strong{font-size:29px}.pagination{font-size:10px}.pagination button{padding:5px 8px;margin-left:4px}}@media print{aside,.filters,.scope-tabs,.pagination,.row-actions,.generated span,#csv{display:none}.layout{display:block}main{padding:0}.work-row{break-inside:avoid}.overview strong{font-size:25px}}`;
export async function writeLibraryReport(
  repo,
  {
    folderLabel = repo.target?.label || "",
    lock = globalThis.navigator?.locks,
  } = {},
) {
  const write = async () => {
    await repo.load();
    const metadata = await readReportMetadata(repo.io),
      model = buildReportModel(repo.state, { folderLabel, metadata }),
      html = renderLibraryReport(model);
    const previous = await repo.io.read("本地库.html");
    if (previous && !previous.includes('data-report-version="0.8.5"'))
      await repo.io.write(
        `${ROOT}/backups/report-before-0.8.5-${Date.now()}.html`,
        previous,
      );
    await repo.io.write("本地库.html", html);
    return model;
  };
  if (!lock) throw new Error("当前浏览器不支持备份库锁");
  return lock.request(
    "douyin-archive-" + repo.state.id,
    { ifAvailable: true },
    async (acquired) => {
      if (!acquired) throw new Error("下载正在使用备份库，请先暂停再更新报告");
      return write();
    },
  );
}
