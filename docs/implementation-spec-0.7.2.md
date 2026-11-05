# 实现规格说明书：插件 0.7.2 / 后端 0.3.0

> 历史文档：本文保留当时讨论/实现记录，已由 [当前 0.8.7 对应文档](implementation-spec-0.8.7.md) 替代。正文中的“当前”“尚未实施”、旧数量与恢复规则不代表现版本。


> 启动规则已由 [0.7.4](plugin-release-0.7.4.md) 改为每次从最新列表开始检查，媒体按全库索引跳过或续传，不继承旧列表游标。

> 分页规则已由 [0.7.3 修复](plugin-release-0.7.3.md) 更新：明确无下一页时不要求游标为 0，非标准末页会确认后结束。本文其余部分保留 0.7.2 版本记录。

更新：2026-10-28。本文按当前代码逐文件核对生成，描述**已实现的行为**（是什么），不是目标要求（应该是什么）。目标要求见 [Spec v0.2](plugin-product-spec-v0.2.md) 与 [设计方案 v1](plugin-design-v1.md)；历史行为与旧问题见 [架构与业务规则](architecture-design.md) 和 [项目业务审查 2026-10-09](project-audit-2026-10-09.md)。

版本基线：`plugin/manifest.json` 0.7.2、`plugin/package.json` 0.7.2、`backend/package.json` 0.3.0（工作区含未提交修改）。文中函数名、常量值、文件路径均为代码实际值。

## 1. 总体结构

仓库三部分：

| 目录 | 内容 | 版本 |
| --- | --- | --- |
| `plugin/` | Chrome MV3 扩展（抖音备份） | 0.7.2 |
| `backend/` | Playwright 自动化脚本与 dashboard（独立工具，非插件运行依赖） | 0.3.0 |
| `frontend/` | 预留，仅 README，无代码 | — |

插件内部**两代 UI 并存**：

- 新代：`sidebar/index.html` + `sidebar/modern-app.js`（598 行）+ `core/`（Engine 流水线）+ `archive/`（Repository v2 事件日志备份库）+ `maintenance/`（闲时整理）。manifest 当前实际加载的侧栏。
- 旧代：`sidebar/legacy.html` + `sidebar/app.js`（4123 行），基于 `download-state.json` 体系，含喜欢转收藏、私信分享点赞、"一键完整备份"。保留作兼容测试样本（`npm run check` 中的 `test-sidebar-ui` 等仍测它），不打入便携扩展包。

## 2. 插件 manifest 与运行上下文

- MV3，name「抖音备份」，version 0.7.2。
- permissions：`storage`、`tabs`、`downloads`、`downloads.ui`。
- host_permissions（https）：`www.douyin.com`、`*.douyin.com`、`*.douyinpic.com`、`*.douyinvod.com`、`*.douyinstatic.com`、`*.byteimg.com`、`*.bytecdntp.com`、`*.bytedance.com`、`*.snssdk.com`、`*.zjcdn.com`、`*.pstatp.com`、`*.bytecdn.cn`、`*.ibytedtos.com`。
- service worker：`src/background.js`；content script：`src/content.js` + `src/content.css`（仅 `https://www.douyin.com/*`，`document_idle`）。
- web_accessible_resources 暴露 injected、sidebar、shared、core、archive、maintenance、folder-picker 及 archive.svg。
- 无显式 worker 声明；`maintenance/organize.js` 以 `new Worker(new URL("./hash-worker.js", import.meta.url), {type:"module"})` 动态创建哈希 Worker。

### 2.1 background.js（service worker）

- `onInstalled`（install）→ 打开 `https://www.douyin.com/`。
- 工具栏点击：活动页是 douyin.com 则发 `{type:"TOGGLE_SIDEBAR"}`，否则新开 douyin 页。
- 消息处理：
  - `OPEN_FOLDER_PICKER_TAB`：560×520 popup 打开 folder-picker，带 `returnTabId`。
  - `SET_DOWNLOAD_UI` `{enabled}`：`chrome.downloads.setUiOptions`，不支持时回 `{ok:true, supported:false}`。
  - `DOWNLOAD_URL` `{url, filename, conflictAction?, saveAs?}`：`chrome.downloads.download`（默认 conflictAction `uniquify`），监听 `onChanged` 至 complete/interrupted，**超时 10 分钟**回 `{ok:false, state:"timeout"}`。

### 2.2 content.js（双向桥）

iframe id `douyin-toolkit-sidebar`（src/sidebar/index.html），注入 script id `douyin-toolkit-injected`。页面加载即注入并创建侧栏。消息路由按 `window.postMessage` 的 `source` 字段：

- `douyin-toolkit-page`（页面/injected）→ 转发 sidebar；侧栏未就绪时进 `pendingSidebarMessages`（上限 100，超限丢弃最旧）。
- `douyin-toolkit-sidebar` 且 origin 等于扩展源 → 本地处理 `SET_SIDEBAR_COLLAPSED`、`CLOSE_SIDEBAR`，其余转发页面（改 source 为 `douyin-toolkit-content`）。
- runtime 消息 `TOGGLE_SIDEBAR` / `CLOSE_SIDEBAR`；折叠状态以 `SIDEBAR_COLLAPSE_STATE` 通知侧栏。

### 2.3 injected.js（页面主世界模块，997 行）

- 统一回包 source `TOOLKIT_SOURCE = "douyin-toolkit-page"`；启动即 `reply("boot","BOOT",{href,title})`。
- `webParams()`：签名公共参数 `device_platform=webapp, aid=6383, channel=channel_pc_web, version_code=170400 / version_name=17.4.0`，h265/dash 支持来自 cookie，webid 取 SSR 数据或 localStorage，uifid 取 cookie。
- API 封装（页面内 fetch，credentials include）：`getSelfProfile`、`collectAweme`（POST collect，action=1）、`diggAweme`（POST digg，type=1）、`fetchLikedPage`（favorite，count=18）、`fetchBookmarkedPage`（listcollection POST，count=10，total 从 total/total_count/collect_count/collection_count/data.total/extra.total 多字段探测）、`fetchFollowingPage`（count=20）、`fetchAuthorAwemePage`（post，count=18）、`fetchAwemeDetail`。
- 私信分享扫描（DOM 自动化）：`scanSharedConversation(targetName, maxPages=200, likeMissing)`；入口点击重试 3 次、文本等待 15/8/6s、轮询 250ms；modal 打开 30s、点赞确认 5s、关闭 30s；每页滚动 `max(400, clientHeight*0.85)`，页间 900ms、卡片间 150ms；**`stableRounds>=3` 且处于边界且无新卡才判定 `reachedHistoryStart`**，页数上限 `min(maxPages,500)`。进度经 `SHARED_SCAN_PROGRESS` 消息发出 `{processed, found, liked, alreadyLiked, failed, awemeId}`。
- 下载原语：`precheckUrl`（AbortController 15s，校验 2xx、非 206、MIME、视频须有 content-length）；`downloadToFolder(Once)`（header 15s、总超时 100000ms，blob 大小须等于 content-length），经 OPFS/FileSystemHandle 写入。

### 2.4 消息协议汇总

**chrome.runtime**：`TOGGLE_SIDEBAR`、`CLOSE_SIDEBAR`、`OPEN_FOLDER_PICKER_TAB`、`SET_DOWNLOAD_UI`、`DOWNLOAD_URL`。

**window.postMessage**（sidebar ⇄ content ⇄ injected，请求携带 `requestId`，默认超时 30000ms，超时 reject `"{type} timed out"`）：

- 请求 type：`GET_SELF_PROFILE`、`COLLECT_AWEME {awemeId}`、`DIGG_AWEME {awemeId}`、`SCAN_SHARED_CONVERSATION {targetName, maxPages, likeMissing}`、`FETCH_AWEME_DETAIL {awemeId}`、`PRECHECK_URL {url, options}`、`FETCH_LIKED_PAGE {secUid, maxCursor, minCursor, count}`、`FETCH_BOOKMARKED_PAGE {cursor, count}`、`FETCH_FOLLOWING_PAGE {userId, secUid, offset, count, maxTime, minTime}`、`FETCH_AUTHOR_AWEME_PAGE {secUid, maxCursor, count}`、`DOWNLOAD_TO_FOLDER {rootHandle, relativePath, url, options}`。
- 单向通知：`SHARED_SCAN_PROGRESS`、`BOOT`、`SIDEBAR_COLLAPSE_STATE`。

## 3. 新代下载引擎（core/）

scope 取值：`liked | bookmarked | following`（旧代"一键备份"= following scope，cursor 含 `authorIndex` 逐作者推进）。

### 3.1 core/sources.js（Sources）

- 分页间隔：`{liked:5000, bookmarked:3000, following:1200, detail:400}` ms；请求超时 60000ms；串行链（`chain`/`nextAt`）保证列表请求一次一个。
- `profile()`：无 uid/secUid 抛"无法确认当前账号"；totals 从 `favoriting_count` 等 4 个键读取。
- 终点判定：liked/bookmarked `hasMore===false && cursor==="0"`；following 当前作者完且 `authorIndex+1>=authors.length`。
- 防护：游标不推进抛"列表尚未完整读取，分页游标异常；已下载的作品会保留"；关注列表 offset 未推进抛"关注列表未读完…"。

### 3.2 core/retry.js（RetryCoordinator）

- 默认 `rateBaseMs=15000`、`transientBaseMs=2000`、`maxRateRetries=4`、`maxTransientRetries=2`。
- 分类：429 → rate；408/425/500/502/503/504 或无状态码且消息匹配 `/Failed to fetch|NetworkError|网络|超时|timed out|fetch failed/i` → transient；其余直接抛。
- 退避：`base * 2**min(attempt,5)`；delay = max(retryAfter, min(base, 429 上限 300000 / transient 上限 30000) × (1+0~20% 抖动))。
- 耗尽：`error.retryExhausted=true`，message 追加"；自动重试已达上限，进度已保留"。冷却状态可经 `restore(info)` 跨任务恢复。

### 3.3 core/media.js

- 候选排序 `rankedCandidates`：面积（width×height）降序 → bitrate → fps → size；URL 去重。图集用 `[{url,width,height}]`，视频用 candidates+fallbackCandidate。
- 落盘路径：**`data/媒体/{safe(awemeId)}/{variant}/{safe(partId)}.{mp4|jpg}`**，variant = `[codec|kind, width, height, size, bitrate]` 连接归一。
- 断点判定：已有该 partId 的 complete file、磁盘 size 与记录一致且无 `{path}.resume.json` 残留 → 跳过。
- 候选失败继续下一个；429、库 poisoned、Quota/NotAllowed/NotReadable/Security/NoModificationAllowed 错误直接终止；全部失败且 `httpStatus ∈ {401,403,404}` 且未刷新过 → 重新取详情后重试一次（refreshed）。
- 每次尝试记入 `diagnostics.attempts`（保留末 24 条）。画质结果 `qualityOutcome ∈ {best, fallback, degraded, unknown, image}`；file record 含 `quality/highest/candidateRank/candidateCount/qualityOutcome/fallbackReason/refreshedAddress` 等。
- 全部 part 完成 → `works[id].complete=true`。

### 3.4 core/engine.js（Engine）

- 构造 `(repo, sources, download, {capacity=64})`；队列容量 64，**生产者反压阈值 46**（queue+active>46 时生产者 sleep 80ms）；**2 个消费者并发**；消费者空队列 sleep 60ms。
- Web Lock 名 `"douyin-archive-" + repo.state.id`（`ifAvailable:true`），抢不到抛"其他标签页正在使用这个备份库…"；无 Web Locks 支持直接拒绝。
- 每页生产前重取 profile，uid 变化 → abort + `sourceErrors=["账号已切换，任务已暂停，请回到原账号继续"]`。
- 已完成作品（works.complete）只并入来源：`state = lastTask===task.id ? "saved" : "existing"`。
- 消费者错误：fatal（poisoned/429/文件系统权限类）→ abort 整任务；item 状态 aborted→`queued`、unsupported→`unsupported`、其余→`failed`。
- 生产者 429 → abort + 任务转 paused 保留进度与 retryState。
- `pause()`：abort → status `pausing` → 落盘后 `paused`；AbortError 不计失败。
- 收尾调用 `repo.compact()`；`finishStatus` 见 3.5。

### 3.5 core/model.js / core/progress.js

- `counters(task)` → `{read, saved, existing, failed, unsupported, pending}`，恒等 `read = saved+existing+failed+unsupported+pending`。
- **完成判定 `finishStatus`**：`sourceDone===true && pending==0 && failed==0 && unsupported==0 && sourceErrors.length===0` → `completed`；任一失败/不支持/源错误非零 → `partial`；否则（未读完或仍有 pending）→ `paused`。
- `summary(state)`：unique 按 complete works 计，bytes 按 complete files 累加；legacy 且无文件记录 → `sizeKnown=false`。
- `sourceProgress`：total = live（同账号 profile）?? recorded（任务匹配且非"无时间戳的 0"），来源 `live|recorded|unknown`；**不推导剩余数或覆盖率**，仅提供 `historicalExceedsTotal` 布尔（本地累计可大于平台当前总数）。

## 4. v2 备份库（archive/）

### 4.1 archive/fs.js

- `safePath` 拒绝空/`.`/`..`/`/`/`\`/`\0`。`seal/unseal`：内容包 `{body, sha256}`，校验失败抛"备份记录校验失败"。
- `ROOT = "data/.appdata"`。
- `inspectFolder(handle)` 识别顺序：
  1. 有 `archive.json` 且 schemaVersion===2 → `modern`（版本≠2 抛"备份库格式版本不受支持"）；
  2. 有 `download-index.json`（v1）→ `legacy`（附 `old: download-state.json`）；
  3. 仅 `download-state.json` 有 items → `legacy-state`；
  4. 目录非空（忽略 `.DS_Store`）→ 抛"此文件夹有文件，但没有可识别的备份记录…"；
  5. → `empty`。

### 4.2 archive/repository.js（Repository）

- `BASE = "data/.appdata/v2"`。目录结构：`archive.json`（schemaVersion 2、id、owner、createdAt）、`v2/heads/{a|b}.json`、`v2/journal/{seq}-{txId}.json`、`v2/snapshots/{uuid}.json`，全部 seal 带 SHA-256。
- 载入：读双 head 按 revision 降序尝试 → unseal 快照 → 沿 tail 链回放 journal（校验 `event.seq` 连续）；两 head 均损坏抛"备份记录损坏，已保留原文件"。
- 旧库迁移：`download-index.json` 的 scopes.completed 与 `download-state.json` 的 downloaded items 迁移为 `works`（`complete:true, legacy:true`）；owners（archive.owner、index.user、old.user）uid 不一致抛"历史记录的账号归属不一致"；有 works 且无 owner → `legacyOwnerUnknown=true`。
- state：`{schemaVersion:2, id, owner, works:{}, files:{}, tasks:{}, aliases:{}, updatedAt, verifiedAt, legacyOwnerUnknown}`。
- `commit(patch)`：事件 `{seq, txId, parent, patch, at}` 不可变写 journal，head 双写交替（revision 奇数→b、偶数→a）并写后读回验证；失败置 `poisoned`（后续 commit 抛"记录保存失败，暂停下载后请重新打开备份库"）；经 `chain` 串行化。
- `apply(patch)` 支持 works/files(removed)/tasks/aliases(from→to)/taskUpdate/owner/verifiedAt，增量维护 stats。
- `compact()`：新快照 + head{tail:null}。
- `bind(profile, explicit)`：uid 冲突抛"此备份库属于其他账号"；`legacyOwnerUnknown` 且非显式抛"历史库归属未确认…"。

### 4.3 archive/report.js（v2 本地报告）

- `writeLibraryReport(repo)`：Web Lock（ifAvailable）互斥，抢不到抛"下载正在使用备份库，请先暂停再更新报告"；旧报告先备份为 `data/.appdata/backups/report-before-0.7.2-{ts}.html`。
- `buildReportModel`：works + tasks.items + 旧元数据（download-state/db_videos/db_texts/db_authors，缺失记 warnings）合并；行含 sources/status/error/statusCode/media/outcome/quality/parts/diagnostics/paths；totals={unique, bytes, sizeKnown, failed, pending, rows}；causes 按 HTTP 状态码归类。
- HTML 报告（`data-report-version="0.7.2"`）：客户端分页 50/页，支持来源/状态/画质筛选、排序、搜索、CSV 导出（文件名"抖音备份-当前筛选.csv"，公式注入防护前缀 `'`），429/403/404/502/503 有帮助文案，冷却 retryState 倒计时提示；离线打开不请求网络。

## 5. 新代侧栏（modern-app.js）与 folder-picker

- 四视图：`home` / `task` / `authors` / `details`，纯 JS 重绘 `#view`；footer 标"本地备份 · v0.7.2"。
- home：文件夹卡（unique 作品数、bytes 或"待统计"）、三个来源入口（副标题=平台总数 · 本地累计）、最近任务条。
- task：平台总数 / 累计已备份 / "本轮 +N"；`已检查 = 新下载 + 已有跳过 + 待处理 + 需处理`；429 冷却倒计时；传输条标"最高画质优先 · 最多 2 路"；失败展示前 10 条。
- authors：分页加载关注作者 + 搜索 + 全选。
- details：库统计、历史库绑定（`repo.bind(profile, explicit)`）、手动"更新本地报告"（writeLibraryReport）、"整理备份"（organize）。
- 轮询：`refreshTarget` 每 3s / focus / visibilitychange；账号刷新 60s 节流；引擎停止后 600ms 自动写报告；任务忙时 `beforeunload` 拦截。
- folder-picker：`showDirectoryPicker({mode:"readwrite"})` → `inspectFolder` → `Repository.open`（识别/迁移/初始化）→ Web Lock → 写 archive.json + 首个 snapshot + head a → handle 存 IndexedDB config `downloadTarget` → 激活 `returnTabId` 原标签 → 700ms 后关窗。

## 6. 闲时维护（maintenance/）

`organize(repo, {signal, onProgress, lock})`，同一把 Web Lock（ifAvailable），抢不到抛"备份库正在下载，请先暂停任务"。流程：

1. 删除 `files` 中 `pendingDelete` 记录对应文件，回写 `{path, removed:true}`。
2. 导入 `{ROOT}/manifests/*.json` 旧清单：逐 part 校验存在/size/无 `.resume.json`（optional 封面可缺）；complete → 补 works/files 记录（source `favorite_api`→liked）；不完整 → 记 issues、legacy work 置 `complete:false`。
3. 全量 files 核对：size 不符 / 0 字节 / 有 partial → issues + 置 `complete:false`；按 `workId|partId|kind|size` 分组。
4. 组内 ≥2 条：Worker 分块哈希，与保留副本相同 → **先** commit 引用改指 + `aliases{from→to}` + `pendingDelete:true`，**再**删文件（中断只会多出文件、不会悬挂引用）。
5. commit `verifiedAt` + `compact()`；返回 `{checked, reclaimed, removed, issues, unknown}`。

`hash-worker.js`：1MB 分块 SHA-256，逐块 digest 拼接后再整体 digest，内存有界。

## 7. 共享模块（shared/）

- `api.js`：候选打分 `area*1e9 + bitrate*1e3 + size + fps*1e5 + qualityType`（preferBestQuality 时 h265 加 5e4，否则 h264 加 1e15）；`extractMediaParts` 产出 `image-N`（carousel）、`live-video-N`、`video-N`（segment）/`video-1`（primary）；`mediaTypeForParts` ∈ mixed/multi_image/image/multi_video/video/unsupported；`normalizeAweme` 输出含 mediaParts/videoCandidates(≤5)/downloadStatus 等。
- `liked-sync.js`：`LIKED_PAGE_SIZE=18, LIKED_PAGE_MIN_INTERVAL_MS=5000, LIKED_PAGE_MAX_RETRIES=3`；终态 maxCursor "0"/"-1"/""；游标不前进抛 "liked cursor did not advance"；`reconcileLikedLocalIds` 计算 likedArchived。
- `bookmarked-sync.js`：`BOOKMARKED_PAGE_SIZE=10, MIN_INTERVAL_MS=3000, MAX_RETRIES=3`；合并时强制 `source="bookmarked"、collectStat=1`；重试延迟 `7000*attempt`。
- `db.js`：IndexedDB 库 `douyin_toolkit` 版本 2；对象仓 `config(key)`、`items(awemeId, 旧)`、`scopedItems(itemKey="scope:awemeId"，索引 status/source/index/updatedAt；旧 items 自动迁移)`、`logs(id auto，recentLogs 倒序 120)`、`runs`、`downloadJobs(awemeId)`。
- `download.js`：`downloadVerifiedMedia` headerTimeout 30000ms（首包）、totalTimeout 120000ms（停滞，收到 chunk 重置）；`Range: bytes={N}-` 续传，206 校验 content-range 完整且起点==本地大小；resumeKey = URL origin+pathname，与 `.resume.json` 不一致则清空重下；`createWritable({keepExistingData}) + seek + truncate(offset+received)`；finalSize!==expectedTotal 抛"大小不一致"；成功删除 `.resume.json`。`chooseDownloadTarget` 顺序：已存目录 → chrome.downloads → showDirectoryPicker → anchor 兜底。
- `download-index.js`：`DOWNLOAD_SCOPES=["liked","bookmarked","following"]`，schemaVersion 1，每 scope completed 为排序 ID 数组。
- `download-record.js`：从 download-state.json 恢复浏览器侧下载状态，仅接受 downloaded 或有已下载段的记录。
- `events.js`：`sendPageRequest(type,payload,timeout=30000,signal)`；`boot` 触发 CustomEvent。
- `http.js`：`httpError`（挂 httpStatus/retryAfter）、`httpStatus`（message 正则兜底）、`retryAfterMs`（秒数或 HTTP-date）。
- `performance.js`：`MAX_SAMPLES=2000`（超限从头裁剪）；summarize 按 stage 输出 p50/p95/p99 等，bottlenecks 取 totalMs 前 5。
- `report.js`（旧代报告）：`buildLocalLibraryHtml` 轻量本地库 HTML，行级搜索防抖 100ms、分页 100/页、七宫格统计（含"消失留存"）；`buildEnhancedDownloadReportHtml` 完整版（分页 200、4 图表）当前未被 app.js 调用。
- `state.js`：DEFAULT_CONFIG `batchSize=100, auditRecent=120, minDelayMs=300, maxDelayMs=900, …`；`SUCCESS_STATUSES={favorited, already_favorited, skipped_inaccessible}`。

## 8. 旧代侧栏（app.js，legacy.html）

两视图 tab（download/favorite）。主要入口：下载喜欢/收藏/关注、继续下载（恢复 progress.current.scope）、一键完整备份、喜欢转收藏批次、审计、导入旧进度、诊断日志导出；关注面板展开即同步作者（缓存 10 分钟）。

- 下载目录体系：`data/{点赞|收藏|关注}/{视频|图片|封面}/…`，文件按 awemeId 命名（分段 `{order 补零}.{ext}`）。
- 状态文件（`data/.appdata/`）：
  - `download-state.json`（schemaVersion 3）：items 按 `scope:awemeId` 合并去重、totals、current、localCounts、user、performance；仅 forceFull 收尾整体重写。
  - `download-progress.json`：小检查点，`scheduleCompactWrite` **1200ms** 延迟合并写；读取时 progress 较新则覆盖 record.current。
  - `download-counts.json`：首屏计数缓存（含 likedCurrent/likedArchived/likedReconciledAt）；完成时 max 合并。
  - `download-index.json`：v1 完成索引；缺失时扫描目录重建（带 `.resume.json` 的剔除）。
  - `manifests/{awemeId}.json`：单作品清单（成功即写）。
  - `backups/{YYYY-MM-DD}/download-metadata.json`：每日一次轻量备份。
  - `db_likes/db_bookmarked/db_authors/db_videos/db_texts.json` + `说明.txt`：forceFull 时全量重建的派生展示数据。
  - `performance-summary.json`、`logs/diagnostic-{stamp}.json`。
- 下载节流：作品间随机 300–900ms；候选缓存 `CANDIDATE_CACHE_MAX_AGE_MS=10min`；preferBestQuality 时最多试 4 个候选（fallback 降级 rank=99）；**连续 8 个作品失败熔断**。
- 增量边界：上次全量完成后，整页作品均已在索引 → 停止新检查、继续全量分页核对"消失留存"（`reconcileLikedLocalIds`），fullScan 后更新 likedCurrent/likedArchived。
- 喜欢转收藏（runFavoriteBatch）：detail `collectStat===1` → already_favorited；statusCode 2053 → skipped_inaccessible；限流（3009008 或文案匹配）→ paused_rate_limited 整批暂停；批次取 `batchSize=100` 条 runnable；成功后 `runAudit(auditRecent)` 复查，未真正收藏打回 pending（"审计发现未真正收藏"）。
- 私信分享点赞（一键第一步）：`SCAN_SHARED_CONVERSATION {targetName:"王立志"（硬编码）, maxPages:200, likeMissing:true}`，请求超时 30 分钟；`sharedConversationBinding` 记录 conversationKey，变化即抛"账号标识与上次不同…"；**只补点赞不取消**；ids 为空、cardFailures>0、未 reachedHistoryStart、unknownLikeState>0 任一情况即中止后续下载阶段（已点赞不撤销）。
- 一键顺序：私信点赞 → liked → bookmarked → following；phase 以"异常"开头或"已暂停"即中止。前置要求已选至少一位关注作者。

## 9. 后端（backend/ 0.3.0）

### 9.1 下载工具

- `douyin-download.mjs`：命令 `liked|bookmarked|resume|download`；CLI 参数 `--output --profile-dir --covers --best --headless --min-delay-ms --max-delay-ms --media-timeout-ms --max-items --max-pages --scope`。默认目录 `data/douyin-backup`；Playwright 持久化 profile `backend/.douyin-playwright-profile/`。直接 import `plugin/src/shared/{api,liked-sync,bookmarked-sync}.js` 复用插件解析。账号不符抛 "backup folder belongs to another Douyin account"；连续 8 个作品失败熔断；`--max-items/--max-pages/SIGINT` → phase paused（不做列表对账）。
- `douyin-download-core.mjs`：记录层 `DOWNLOAD_RECORD_SCHEMA_VERSION=3`；复合键 `scope:awemeId`（`favorite_api→liked`、`collection→bookmarked` 归一）；`loadDownloadRecord` 可从 log 回灌（≤2000 条）；**每次保存全量重写** download-state.json + download-log.json（.tmp+rename）；列表对账 `reconcileListSnapshot`（added/removed/reappeared/missingIds 单调累积，removed 只改记录不删媒体）。
- `douyin-download-api.mjs`：page.evaluate 同源 fetch；`downloadMedia` 校验：拒绝 206、必须 2xx、video/mp4+content-length、图片 image/*、字节数一致；`.part` 临时文件 + rename。**无 HTTP Range 字节续传**（逐段续传：`downloadedMediaParts[partId].status==="downloaded"` 跳过）。
- 终点可信：`scanState.finished && fullScan`（has_more=false 且终态 cursor=0）才允许 reconcile，否则抛 "untrusted cursor"。

### 9.2 喜欢转收藏与 dashboard

- `douyin-favorite-liked.mjs`：命令 `login/probe/run(run-api)/run-ui/audit/cycle`；进度文件 `backend/data/douyin-favorite-progress.json`；run-ui 为 DOM 点击版（按钮打分阈值 ≥70，暂停 exitCode=2）；audit 用 detail 接口复查 collect_stat，连续失败上限后写 `audit_degraded`；cycle = 历史审计 + {run-api(批量) → audit(recent)} 循环。
- `douyin-dashboard.mjs`：`127.0.0.1:4777`（`DOUYIN_DASHBOARD_PORT` 可覆盖）；路由 `/`、`/api/status`、POST `/api/run|/api/stop|/api/login-done|/api/config|/api/clear-log|/api/cleanup-browser`；只编排 favorite-liked 子进程，只读写 progress.json 与 config；**不读写插件备份目录**，与下载进度（.appdata/download-state.json）完全双轨。
- `config/douyin-favorite.config.json`：收藏自动化 11 键（count/minDelayMs/maxDelayMs/retries/retryBaseDelayMs/syncLikedBeforeRun/stopAfterNoNewPages/cycleBatchSize/cycleAuditRecent/continueOnAuditFailure/maxConsecutiveAuditFailures）+ download* 7 键（downloadRoot/downloadCovers/downloadPreferBestQuality/downloadHeadless/downloadMinDelayMs/downloadMaxDelayMs/mediaTimeoutMs），不同脚本各取所需。

### 9.3 私信探针

- `probe-shared-conversation.mjs`：登录 Chrome 打开 jingxuan 页，截取 `plugin/src/injected.js` 函数体注入执行；默认只读 2 轮，`--full` 最多 200 轮，`--like` 才有真实点赞副作用；输出 `backend/data/shared-conversation-probe/{progress,result,page,failure}.json|png`；`--full` 未达历史起点或有失败/未知点赞态 → 退出码 1。
- `inspect-shared-scroll.mjs` / `inspect-shared-card.mjs`：手动诊断脚本（滚动根验证 / 卡片 React props 检查）。
- `test-shared-conversation.mjs`（`npm run test:shares`）：合成 DOM + 真实 injected.js 函数的运行时回归。

### 9.4 插件/后端互操作边界（现状）

1. 后端不维护 `download-index.json` / `download-counts.json` / 本地 HTML，每次全量重写 state/log → 后端写过的库，插件可能使用过期紧凑索引；**禁止并发写同一目录**。
2. 续传语义不同：插件 HTTP Range 字节续传；后端逐段、拒绝 206。
3. 后端 `normalizeDownloadRecord` 强制压 schemaVersion 3，无版本拒写。
4. 关注作者下载、私信→三阶段完整编排不在后端命令覆盖范围。
5. 保持兼容的面：媒体相对路径、manifests、逐段状态、source 归一、log events/logs 双字段。

## 10. 测试命令

- 插件：`npm run check`（18 个脚本，含旧代合约回归）、`npm run check:ui`（Playwright + 合成接口 + 真实 OPFS）、`npm run check:report-ui`、`npm run report`、`npm run zip`、`node scripts/benchmark-performance.mjs`。
- 后端：`npm run check`（语法 + 两个下载测试）、`npm run test:shares`、`npm run douyin:probe-shares`（`--full` / `--full --like`）。

## 11. 关键常量速查

| 常量 | 值 | 位置 |
| --- | --- | --- |
| 队列容量 / 反压阈值 / 消费者数 | 64 / 46 / 2 | core/engine.js |
| 列表间隔 liked/bookmarked/following/detail | 5000/3000/1200/400 ms | core/sources.js |
| 429 基数 / 上限 / 最大重试 | 15000ms / 300000ms / 4 | core/retry.js |
| transient 基数 / 上限 / 最大重试 | 2000ms / 30000ms / 2 | core/retry.js |
| 退避指数 / 抖动 | 2^min(attempt,5) / 0–20% | core/retry.js |
| 媒体首包 / 停滞超时 | 30000 / 120000 ms | shared/download.js |
| 页面桥请求超时 | 30000 ms | shared/events.js |
| Sources 请求超时 | 60000 ms | core/sources.js |
| DOWNLOAD_URL 超时 | 10 分钟 | background.js |
| compact 写合并窗口 | 1200 ms | sidebar/app.js |
| 喜欢页大小 / 间隔 / 重试 | 18 / 5000ms / 3 | shared/liked-sync.js |
| 收藏页大小 / 间隔 / 重试 | 10 / 3000ms / 3 | shared/bookmarked-sync.js |
| 作品间随机延迟 | 300–900 ms | 双端一致 |
| 连续失败熔断 | 8 个作品 | 双端一致 |
| 候选尝试上限（best）| 4（fallback rank=99） | 双端一致 |
| 候选缓存 | 10 分钟 | sidebar/app.js |
| 性能样本上限 | 2000 | shared/performance.js |
| 私信扫描页数 / 超时 / 历史起点 | min(200,500) / 30 分钟 / stableRounds≥3 | injected.js、app.js |
| 哈希分块 | 1 MB SHA-256 | maintenance/hash-worker.js |
| IndexedDB | douyin_toolkit v2，6 个对象仓 | shared/db.js |
| v2 schemaVersion / state schema | 2 | archive/fs.js、repository.js |
| 旧 state schemaVersion | 3 | 双端 download-state.json |
| dashboard 端口 | 4777 | backend/scripts/douyin-dashboard.mjs |
