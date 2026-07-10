# 抖音收藏与下载浏览器插件 Spec

## 目标

把现有抖音喜欢列表收藏工具升级为一个本地浏览器插件：

- 重点方向是下载备份能力：下载喜欢、收藏、已成功收藏作品的视频和封面。
- 直接使用用户当前浏览器里的抖音登录态。
- 在抖音网页内提供侧边控制台。
- 一键继续收藏喜欢列表里的作品，作为下载前的数据准备能力。
- 批量审计已收藏状态，漏收藏自动返工，作为下载完整性的辅助能力。
- 用 Git 管理代码、配置、spec 和迭代记录。

原则：不复制第三方扩展代码，只参考功能架构，重新实现。

## 下载功能优先级

当前项目后续迭代优先围绕下载链路展开：

- 稳定获取喜欢列表、收藏列表、作者作品列表。
- 稳定解析视频、封面、作者、描述、创建时间等元数据。
- 可靠选择可下载的视频 URL，优先兼容 mp4/h264。
- 支持用户选择本地目录，并在授权目录内写入视频、封面和 manifest。
- 支持断点续跑、失败重试、跳过已存在、批次暂停。
- 提供清晰的下载状态、失败原因和审计统计。
- 收藏/审计功能保持服务于下载完整性的定位，不喧宾夺主。

## 第三方扩展学习记录

已获得授权用于学习分析「抖珍藏」扩展。当前可获取的是 Chrome 安装后的发布包，不是作者原始源码仓库。

本机路径：

```text
~/Library/Application Support/Google/Chrome/Default/Extensions/ldllbcnpihgljdgpjgdopgeejenhnabf/2.8.38_0
```

观察到的下载相关设计：

- Manifest V3 扩展，content script 注入到 `www.douyin.com` 和部分资源域。
- 主逻辑在打包后的 JS 中，体积较小但已压缩。
- UI 通过扩展 iframe 和远程 UI iframe 通信，页面上下文负责调用抖音 Web API。
- 使用 `showDirectoryPicker({ mode: "readwrite" })` 让用户选择备份目录。
- 目录结构使用 `data/点赞`、`data/收藏`、`data/关注/<authorId>`，分别保存视频和封面。
- 本地状态写入 `data/.appdata/`，包括 likes、authors、videos、bookmarked、following 等拆分数据文件。
- 视频 URL 从 `video.bit_rate`、`play_addr_h264`、`play_addr_h265`、`play_addr` 等字段中选择。
- 下载前校验 HTTP 状态、`content-type` 是否包含 `video/mp4`、`content-length` 是否存在、结果是否 0 字节。
- 对 403、分段响应、超时、大文件等情况有专门失败路径或重试路径。

已迁移到本项目的下载策略：

- 优先使用用户授权的本地文件夹，而不是浏览器下载目录。
- 保存结构采用 `data/点赞/视频`、`data/点赞/封面`、`data/.appdata`。
- 每条下载前增加预检：HTTP 2xx、非 206、视频 MIME 为 `video/mp4`、视频大小存在、结果非 0 字节。
- 顶配画质预检或下载失败时，自动回退到普通 h264 候选地址。
- 本地 `.appdata` 写入 `download-state.json`、`db_likes.json`、`db_authors.json`、`db_videos.json`、`db_texts.json` 和单条 manifest。

学习边界：

- 不复制第三方扩展实现代码。
- 不提交第三方扩展包或其解包文件。
- 只把架构、数据流、边界处理策略转化为我们自己的实现方案。

## 是否值得做

建议做。

原因：

- 现在的 Playwright 独立 profile 容易遇到登录态过期、profile 被占用、需要另开窗口等问题。
- 浏览器插件可以直接使用当前 Chrome 里的抖音登录态，不需要额外登录。
- 下载功能天然适合插件：可以使用 `showDirectoryPicker` 让用户授权本地目录，然后在页面里写入文件。
- 现有 dashboard 的数据展示可以复用思路，插件 UI 只需要换成注入式侧边栏。
- 后续使用成本最低：打开抖音，点插件/侧边栏按钮即可。

## 不做什么

- 不直接复制「抖珍藏」或其他闭源扩展代码。
- 不绕过抖音风控。
- 不隐藏失败原因。
- 不强行连续运行；遇到限流、登录异常、接口异常时暂停并记录。
- 不把视频上传到任何远程服务。

## 技术形态

采用 Chrome Manifest V3 扩展。

建议目录：

```text
plugin/
  manifest.json
  src/
    background.js
    content.js
    injected.js
    sidebar/
      index.html
      app.js
      style.css
    shared/
      api.js
      db.js
      download.js
      state.js
      events.js
  docs/
    spec.md
  package.json
```

### 组件职责

`content.js`

- 注入侧边栏容器。
- 注入 `injected.js` 到抖音页面上下文。
- 负责页面上下文与扩展上下文之间的消息转发。

`injected.js`

- 在 `www.douyin.com` 页面上下文运行。
- 使用当前网页登录态调用抖音 Web API。
- 负责喜欢列表、收藏列表、详情、收藏动作、下载 URL 探测。

`background.js`

- 管理插件生命周期。
- 可承担跨上下文下载 fallback。
- 处理插件图标点击、打开抖音页面等。

`sidebar/app.js`

- 控制台 UI。
- 显示状态、进度、日志、当前暂停原因。
- 提供运行、停止、审计、下载、选择目录等按钮。

`shared/db.js`

- IndexedDB 状态存储。
- 保存作品列表、状态、审计结果、下载状态、配置。

`shared/download.js`

- 目录授权。
- 视频/封面写入。
- 断点续跑、跳过已存在、失败重试。

## 数据存储

插件内使用 IndexedDB，命名：

```text
douyin_toolkit
```

对象仓库：

```text
config
items
runs
logs
downloadJobs
```

### item 字段

```json
{
  "awemeId": "string",
  "index": 0,
  "source": "liked | collection | author",
  "status": "pending | favorited | already_favorited | skipped_inaccessible | paused_unverified",
  "collectStat": 0,
  "desc": "",
  "authorUid": "",
  "authorName": "",
  "url": "",
  "coverUrl": "",
  "videoUrl": "",
  "downloadStatus": "not_started | downloaded | failed | skipped_existing",
  "lastError": "",
  "createdAt": "",
  "updatedAt": ""
}
```

### 配置字段

```json
{
  "batchSize": 100,
  "auditRecent": 120,
  "minDelayMs": 300,
  "maxDelayMs": 900,
  "syncLikedBeforeRun": false,
  "continueOnAuditFailure": true,
  "maxConsecutiveAuditFailures": 6,
  "downloadCovers": true,
  "skipExistingDownloads": true
}
```

## 抖音接口

已确认或可复用的接口：

喜欢列表：

```text
GET /aweme/v1/web/aweme/favorite/
```

收藏列表：

```text
GET /aweme/v1/web/aweme/listcollection/
```

作者作品：

```text
GET /aweme/v1/web/aweme/post/
```

当前用户：

```text
GET /aweme/v1/web/user/profile/self/
```

收藏作品：

```text
POST /aweme/v1/web/aweme/collect/?aweme_id=<id>&action=1
```

作品详情：

```text
GET /aweme/v1/web/aweme/detail/?aweme_id=<id>
```

注意：

- 请求必须从抖音页面上下文发起，以复用 cookie、msToken、verifyFp、a_bogus 等网页参数。
- 接口失败、空响应、状态码异常都要记录，不硬跑。

## 收藏流程

1. 用户打开 `https://www.douyin.com`。
2. 插件注入侧边栏。
3. 用户点击「继续收藏」。
4. 若配置允许，先同步喜欢列表；默认不重新同步。
5. 从 `pending` 或 `paused_unverified` 的第一条开始处理。
6. 如果 `collect_stat === 1`，直接标为 `already_favorited`。
7. 否则调用收藏接口。
8. 成功后标为 `favorited`。
9. 每批完成后审计最近 N 条。
10. 审计发现 `collect_stat !== 1`，标回 `pending`。
11. 遇到 `3009008` 等限流，暂停并显示冷却提示。

## 下载流程

### 下载入口

UI 提供：

- 下载喜欢列表
- 下载收藏列表
- 下载当前已成功收藏项
- 只下载未下载
- 下载封面
- 选择下载目录

### 目录结构

建议使用简洁结构：

```text
DouyinBackup/
  liked/
    videos/
      000001-<awemeId>.mp4
    covers/
      000001-<awemeId>.jpg
    manifest.json
  collection/
    videos/
    covers/
    manifest.json
  data/
    items.json
    runs.json
```

文件名规则：

```text
<index padded>-<awemeId>.mp4
<index padded>-<awemeId>.jpg
```

不把标题放进文件名，避免非法字符和超长路径。标题、作者、描述写入 `manifest.json`。

### 视频 URL 选择

从 aweme 数据中尝试：

- `video.bit_rate[*].play_addr.url_list`
- `video.play_addr_h264.url_list`
- `video.play_addr_h265.url_list`
- `video.play_addr.url_list`

选择策略：

1. 优先 h264，兼容性最好。
2. 若配置开启高质量，优先 width/bitrate 更高的地址。
3. 对候选 URL 发起 HEAD 或短 fetch 验证。
4. 要求 `content-type` 包含 `video/mp4`。
5. 记录 `content-length`。

### 写入方式

优先使用浏览器 File System Access API：

```js
showDirectoryPicker({ mode: "readwrite" })
```

然后：

- `getDirectoryHandle`
- `getFileHandle`
- `createWritable`
- `write`
- `close`

如果浏览器环境不支持，再考虑降级为 `chrome.downloads`。

### 下载状态

```text
not_started
downloading
downloaded
skipped_existing
failed
```

失败记录：

- HTTP 状态码
- MIME 类型不对
- 文件大小未知
- 0 字节
- 403
- 网络中断
- 写文件失败

## UI 设计

保留现在 dashboard 的信息结构，改为插件侧边栏：

- 顶部状态：运行中 / 空闲 / 暂停 / 限流
- 进度条：成功数 / 总数
- 操作按钮：
  - 继续收藏
  - 停止
  - 同步喜欢列表
  - 审计最近
  - 选择下载目录
  - 开始下载
  - 停止下载
- 配置：
  - 每批数量
  - 审计数量
  - 间隔
  - 是否下载封面
  - 是否跳过已存在
- 数据区：
  - 状态分布
  - 当前作品
  - 最近日志
  - 审计返工列表
  - 下载失败列表

## 迁移现有数据

保留现有文件：

```text
backend/data/douyin-favorite-progress.json
backend/config/douyin-favorite.config.json
```

插件第一版提供「导入现有进度」按钮：

1. 用户选择 `backend/data/douyin-favorite-progress.json`。
2. 插件读取 JSON。
3. 转换为 IndexedDB items。
4. 保留 `index`、`awemeId`、`status`、`collectStat`、`desc`、`author`、`lastError`。

也可以先做一个本地转换脚本，把现有 JSON 转成插件可导入格式。

## Git 管理

初始化 Git 仓库，建议提交节奏：

1. `chore: scaffold extension project`
2. `feat: inject sidebar on douyin web`
3. `feat: add indexeddb state layer`
4. `feat: port favorite cycle workflow`
5. `feat: add audit workflow`
6. `feat: add download directory and manifest`
7. `feat: add mp4 and cover downloader`
8. `feat: add import from existing progress`
9. `docs: document extension workflows`

`.gitignore`：

```text
node_modules/
dist/
.DS_Store
*.log
downloads/
DouyinBackup/
*.crx
*.pem
```

不要提交：

- cookie
- 下载的视频
- 本地备份目录
- Chrome profile
- 个人进度数据，除非明确需要样例脱敏数据

## 开发阶段

### 当前状态：Milestone 1 基线

已完成：

- 初始化 Git 管理范围和忽略规则。
- 建立 `plugin/` MV3 插件目录。
- 实现抖音页面侧边栏注入。
- 实现插件 iframe 与抖音页面上下文消息桥。
- 实现当前网页登录态检测接口。
- 实现 IndexedDB 状态层与旧进度 JSON 导入。
- 实现基础进度、游标、日志和配置展示。
- 增加 `npm run check` 静态校验和 `npm run zip` 打包命令。
- 接入继续收藏流程：详情预检、已收藏直接成功、接口收藏、限流暂停。
- 接入最近审计流程：漏收藏标回 `pending`，不可访问按规则跳过。
- 接入下载第一版：下载已成功收藏项目的视频、封面和单条 manifest。

仍需增强：

- 同步喜欢列表入口仍是可选项，当前主要依赖导入旧进度。
- 下载功能需要用真实视频样本验证更多 CDN、图文、失效作品和 403 场景。
- 下载 manifest 目前按单条写入，后续可增加汇总 `items.json`。

### Milestone 1：插件壳和 UI

目标：

- 可以在抖音页面出现侧边栏。
- 可以显示静态 UI。
- 可以读写 IndexedDB config。

验收：

- 打开 `https://www.douyin.com` 后出现控制台。
- 刷新后配置仍保留。

### Milestone 2：迁移收藏流程

目标：

- 实现喜欢列表同步。
- 实现续跑收藏。
- 实现限流暂停。
- 实现最近审计。

验收：

- 能从现有进度导入。
- 点击「继续收藏」能从断点继续。
- 遇到 `3009008` 自动暂停。

### Milestone 3：下载备份

目标：

- 用户选择下载目录。
- 下载视频和封面。
- 跳过已存在文件。
- 保存 manifest。

验收：

- 能下载 5 条测试作品。
- manifest 包含标题、作者、awemeId、来源、文件路径、下载时间。
- 中断后再次运行不会重复下载。

### Milestone 4：完整可用

目标：

- 喜欢、收藏、已成功收藏项都可下载。
- 下载失败可重试。
- UI 显示下载进度和失败原因。

验收：

- 能批量下载至少 100 条。
- 失败不会阻塞整批。
- 页面刷新后进度还在。

## 风险

- 抖音接口字段可能变化。
- 视频 URL 可能限时，需要边获取边下载。
- 部分视频可能无 mp4、失效、私密、图文或直播回放。
- 高速收藏仍会触发 `3009008`。
- File System Access API 只在 Chromium 系浏览器可用。
- 插件 UI 远程依赖必须避免；我们的实现应全部本地化。

## 推荐执行顺序

先做插件收藏功能，再做下载功能。

原因：

- 收藏流程我们已经验证过，迁移风险小。
- 下载功能依赖更多边界情况，适合在插件状态层稳定后接入。
- 现在本地 dashboard 仍可继续跑，不影响插件开发。
