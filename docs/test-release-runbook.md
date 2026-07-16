# 测试、发布与故障取证手册

## 1. 目的

本手册把“功能写完”转换为可重复验证的发布流程。自动测试负责稳定契约，人工冒烟负责真实登录态、File System Access 和抖音/CDN 的动态行为。

## 2. 环境

- Windows 10/11 或其他可运行 Chromium 的桌面系统。
- Microsoft Edge 或 Google Chrome，支持 Manifest V3 和 File System Access API。
- Node.js 与 npm。
- 已登录的抖音网页。
- 一个专用于测试的空目录；不要直接对唯一备份目录做破坏性测试。

安装开发版：

1. 打开 `edge://extensions` 或 `chrome://extensions`。
2. 开启开发者模式。
3. 选择“加载解压缩的扩展”。
4. 选择仓库中的 `plugin` 目录。
5. 每次修改后点扩展“重新加载”，并刷新抖音页面。

## 3. 自动检查

在 `plugin` 目录运行：

```bash
npm run check
```

该命令必须依次通过：

| 脚本 | 保护的契约 |
| --- | --- |
| `check-extension.mjs` | manifest 资源存在、JS 可解析、版本资源完整 |
| `test-content-bridge.mjs` | iframe 与页面消息桥可启动和转发 |
| `test-download-target.mjs` | 文件夹权限复用、媒体 fetch、文件写入 |
| `test-download-record.mjs` | 文件夹记录恢复、账号隔离静态约束、复合 scope 键 |
| `test-bookmarked-sync.mjs` | 收藏分页、POST 表单、节流常量、同 ID 作用域隔离 |
| `test-liked-sync.mjs` | 喜欢页运行时请求和完整扫描循环 |
| `test-liked-state.mjs` | 喜欢归一化、状态合并和最高画质排序 |
| `test-media-parts.mjs` | 多图、live photo、显式多视频、路径和逐段续传契约 |
| `test-performance.mjs` | 阶段统计、快速官方总数、候选复用、检查点批量刷新和性能文件 |

测试失败不能通过删除断言或只放宽校验解决。先判断实现缺陷还是规格变更；规格变更必须同步更新产品规格和设计。

## 4. 规格追踪矩阵

| 规格 | 自动测试 | 人工验证 |
| --- | --- | --- |
| FR-01 登录与账号隔离 | `test-download-record` | 切换账号后复用旧目录应被拒绝 |
| FR-02 下载目录 | `test-download-target` | 重载扩展后不重选目录即可继续 |
| FR-03 喜欢列表 | `test-liked-sync`、`test-liked-state` | 实际扫描到可信终止 |
| FR-04 收藏列表 | `test-bookmarked-sync` | 日志显示页码、数量和可信结束 |
| FR-05 作用域幂等 | `test-bookmarked-sync`、`test-download-record` | 同一作品的喜欢/收藏状态独立 |
| FR-06 最高画质 | `test-liked-state` | 日志和 manifest 记录实际候选 |
| FR-07 文件写入 | `test-download-target` | 视频、封面、状态、`db_bookmarked` 路径正确 |
| FR-08 暂停继续 | 记录恢复与静态断言 | 暂停、刷新、继续后跳过已下载项 |
| FR-09 可观测性 | 扩展检查与静态断言 | UI 北京时间，日志可定位失败 |
| FR-09 可观测性 | `test-performance`、扩展检查 | 快速总数与性能文件能区分网络、主动等待和磁盘开销 |
| FR-10 多媒体续传 | `test-media-parts`、`test-download-record`、backend 核心测试 | 图文和多段作品逐段落盘，暂停后只续未完成段 |

## 5. 人工冒烟测试

### 5.1 基础加载

- 扩展重新加载无 manifest 错误。
- 打开 `www.douyin.com` 后侧边栏可打开和关闭。
- 未登录时点击下载得到明确登录提示，不显示空任务完成。
- UI 日志时间与北京时间一致。
- 打开侧边栏后无需扫描列表即可显示“抖音喜欢/抖音收藏”官方总数，并显示个人资料请求耗时。
- 官方总数与本地已下载、已扫描数量分开展示。

### 5.2 文件夹记忆

1. 选择一个空测试目录。
2. 开始任务并允许写出 `download-state.json`。
3. 暂停并刷新抖音页面。
4. 点击“继续下载”。
5. 验证没有再次弹出目录选择，或只出现浏览器规定的权限确认。
6. 验证 `current.scope` 与上次任务一致。

### 5.3 喜欢视频

1. 点击“下载喜欢视频”。
2. 确认日志出现第一页检查数量和预计总数。
3. 至少完成一个普通视频下载。
4. 确认视频位于 `data/点赞/视频`。
5. 暂停后继续，确认已下载作品不重复写入。

### 5.4 收藏视频

1. 点击“下载收藏视频”。
2. 确认日志按页推进，页面间隔不出现高频连续请求。
3. 确认收藏远端总数在第一页扫描前或同时出现，且第一页没有重复请求。
4. 至少完成一个收藏视频下载。
5. 确认视频位于 `data/收藏/视频`。
6. 确认 `db_bookmarked.json` 包含 downloaded ID。
7. 再次点击“继续下载”，确认从第一页核对但跳过已下载项。
8. 完整结束必须有任务完成日志，异常 cursor 不得显示完成。

### 5.5 最高画质

1. 开启“优先最高画质”。
2. 选择详情中包含多个 `bit_rate` 候选的作品。
3. 确认日志显示作品详情、codec、分辨率、fps、码率和大小。
4. 确认记录中的 resolution、width、height、bitrate、codec 与实际成功候选一致。
5. 第一候选失败时，确认日志记录候选序号并尝试下一候选。

### 5.6 同一作品跨作用域

1. 找到一个既在喜欢又在收藏中的视频。
2. 分别运行喜欢和收藏下载。
3. 验证 IndexedDB 存在 `liked:<id>` 和 `bookmarked:<id>` 两条记录。
4. 验证两条记录的 `downloaded` 状态互不覆盖。
5. 验证文件夹记录 `items` 中 source 正确。


### 5.7 图文与多段视频

1. 按 [媒体案例目录](media-case-catalog.md) 把案例加入喜欢或收藏测试范围。
2. 图文应写入 `data/<作用域>/图片/<awemeId>/<序号>.<扩展名>`，顺序与作品一致。
3. 多段视频应写入 `data/<作用域>/视频/<awemeId>/<序号>.mp4`，每段日志记录实际候选画质。
4. 下载一段后暂停或重载扩展，检查 `download-state.json` 的 `downloadedMediaParts`。
5. 点击继续后，日志应出现“跳过已完成媒体段”，不得重新传输已完成文件。
6. 全部内容段完成前作品不得是 `downloaded`；完成后 manifest 的 `parts` 数量与实际文件一致。
7. 对同一案例分别跑喜欢与收藏，验证 scope 路径和状态互不覆盖。
8. backend 使用同一目录 resume，验证能读取插件逐段记录并继续。

## 6. 故障注入

可安全执行：

- 页面请求前断网，验证任务等待网络恢复。
- 任务运行中点击暂停，验证状态落盘。
- 撤销目录权限，验证明确提示而不是静默降级。
- 使用账号 A 的测试目录切换到账号 B，验证拒绝写入。
- 测试桩让收藏 cursor 不前进，验证状态机抛错。
- 测试桩返回 `has_more=false`、cursor 非 0，验证仍继续。
- 测试桩让媒体返回 `text/html`、206 或 0 字节，验证候选失败。

不要通过高速请求真实抖音接口来故意触发风控。

## 7. 诊断资产

出现问题时按优先级收集：

1. `data/.appdata/performance-summary.json`。
2. `data/.appdata/download-log.json`。
3. `data/.appdata/download-state.json`。
4. `data/.appdata/db_likes.json` 或 `db_bookmarked.json`。
5. `本地库.html`。
6. 侧边栏最近日志截图。
7. 扩展版本、浏览器版本、失败 awemeId 和发生时间。

提交问题前必须移除 Cookie、Token、Authorization、签名参数、真实绝对路径和无关个人内容。

问题描述模板：

```text
插件版本：
浏览器及版本：
任务 scope：
失败时间（北京时间）：
当前页 / cursor：
awemeId：
期望行为：
实际行为：
最后三条结构化日志：
是否可稳定复现：
```

## 8. 常见故障定位

| 现象 | 优先检查 | 处理 |
| --- | --- | --- |
| 点击开始无反应 | content bridge、注入脚本语法、扩展是否重载 | 先跑检查，再重载扩展和页面 |
| “没有待下载”但总数非零 | profile、首个列表响应、验证码页 | 不清状态，重新登录或完成验证 |
| 收藏 cursor 不推进 | 日志中的 cursor、hasMore | 停止保存日志，修状态机前先补测试 |
| `DOWNLOAD_TO_FOLDER` 超时 | 候选 URL、CDN、文件大小 | 检查是否尝试下一候选 |
| 重复下载 | source、itemKey、`download-state.json` | 检查是否错误按 awemeId 单键恢复 |
| 继续下载跑错列表 | `current.scope`、`lastDownloadScope` | 以文件夹 scope 为准并补恢复测试 |
| 文件夹反复选择 | `downloadTarget` 句柄权限 | 重新授权并检查是否清除站点数据 |
| 大量连续失败 | 登录态、CDN、风控 | 依赖 8 次失败熔断，人工确认后再继续 |
| 打开侧栏总数慢 | `profile_api` | 若耗时高是资料接口或页面桥问题，不是列表扫描 |
| 每页推进慢 | `list_throttle_wait`、`list_api` | 主动等待高属风控节流；接口高才检查网络或登录态 |
| 小视频仍很慢 | `detail_api`、`video_request`、`video_transfer`、`video_write` | 分别判断重复详情、CDN 首包、网速和磁盘 |
| 每条结束卡顿 | `checkpoint_write`、`artifact_full_write`、`ui_render` | 检查点应轻量；完整资产只应分批出现 |
| 总时间高但网络快 | `item_delay`、`list_throttle_wait` | 这是主动保护等待，不能归因于带宽 |

## 9. 发布流程

### 9.1 版本与代码

- `manifest.json` 与 `package.json` 版本相同。
- 产品规格和文档索引版本已更新。
- 运行 `npm run check`。
- 运行 `git diff --check`。
- 确认没有媒体、Profile、真实日志或第三方扩展包。

### 9.2 打包

在 `plugin` 目录运行：

```bash
npm run zip
```

输出为 `plugin/dist/douyin-toolkit-extension.zip`。ZIP 至少包含 manifest、消息桥、侧边栏、`liked-sync.js`、`bookmarked-sync.js`、`api.js`、`db.js`、`download.js` 和 `download-record.js`。

`dist` 是可再生构建产物，不提交 Git。

### 9.3 Git

1. `git diff --cached --check`。
2. `git status --short --branch`。
3. 创建语义化提交。
4. `git fetch origin` 并确认无远端分叉。
5. `git push origin main`。
6. 确认 `main` 与 `origin/main` 同步。

## 10. 完成定义

一项下载功能只有在以下资产全部存在时才算完成：

- 实现代码。
- 自动测试。
- 产品规格或验收项。
- 架构设计中的数据流与不变量。
- 人工冒烟步骤。
- 可供故障取证的日志或状态文件。
- Git 提交并推送。

只在聊天里解释、只改 UI、只让单个样本成功，都不算完成。
