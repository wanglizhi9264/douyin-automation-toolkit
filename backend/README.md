# Backend 下载器

backend 0.3.0 提供与浏览器插件一致的喜欢/收藏扫描、远端收藏总数、图文/多段媒体和逐段续传语义，并继续复用插件中的最高画质候选排序。它可以直接指向插件已经使用过的备份文件夹。

## 安装与登录

```powershell
cd backend
npm install
npx playwright install chromium
npm run douyin:login
```

登录命令和下载命令共用 `backend/.douyin-playwright-profile/`。首次启动下载时如果页面仍未登录，请在打开的 Chromium 窗口完成登录，再重新运行命令。
运行时优先使用 Playwright 自带 Chromium；如果该浏览器包尚未下载，会自动使用本机已安装的 Microsoft Edge 或 Google Chrome。无论使用哪个可执行文件，都只使用独立的 `backend/.douyin-playwright-profile/`，不会复用日常浏览器用户目录。


## 下载命令

使用配置中的默认目录 `backend/data/douyin-backup/`：

```powershell
npm run douyin:download-liked
npm run douyin:download-bookmarked
npm run douyin:download-resume
```

指定插件已经使用的备份目录：

```powershell
npm run douyin:download-liked -- --output "D:\DouyinBackup"
npm run douyin:download-bookmarked -- --output "D:\DouyinBackup"
npm run douyin:download-resume -- --output "D:\DouyinBackup"
```

`resume` 从 `download-state.json` 的 `current.scope` 恢复上一次的喜欢或收藏任务。恢复时不会盲信旧 cursor，而是从第一页重新核对列表，并跳过对应 scope 中 `downloadStatus=downloaded` 的作品。因此列表新增、删除或顺序变化后仍能正确续传。

可选参数：

| 参数 | 含义 |
| --- | --- |
| `--output <path>` | 备份根目录；绝对路径或相对 backend 的路径 |
| `--headless true|false` | 是否无头运行，默认 false |
| `--covers true|false` | 是否下载封面，默认 true |
| `--best true|false` | 是否使用插件最高画质排序，默认 true |
| `--max-items <n>` | 本次最多尝试下载 n 条，用于安全冒烟 |
| `--max-pages <n>` | 本次最多扫描 n 页，用于安全冒烟 |
| `--media-timeout-ms <n>` | 单个媒体请求超时，默认 120000 |
| `--min-delay-ms <n>` / `--max-delay-ms <n>` | 作品之间随机等待范围 |

`--max-items`、`--max-pages` 或 Ctrl+C 会把任务保存为 paused；暂停不会把尚未扫描到的旧作品误判为已经移出列表。

## 记录与目录

```text
<output>/
└─ data/
   ├─ 点赞/
   │  ├─ 视频/<awemeId>.mp4
   │  └─ 封面/<awemeId>.jpg
   ├─ 收藏/
   │  ├─ 视频/<awemeId>.mp4
   │  └─ 封面/<awemeId>.jpg
   └─ .appdata/
      ├─ download-state.json
      ├─ download-log.json
      └─ manifests/<awemeId>.json
```

喜欢和收藏使用 `scope:awemeId` 复合键；同一作品同时存在于两个列表时是两条独立记录。backend 能读取插件的 `mediaParts` 和 `downloadedMediaParts`，并逐段继续：

- 图文：`data/<点赞|收藏>/图片/<awemeId>/<序号>.<扩展名>`；
- 多段视频：`data/<点赞|收藏>/视频/<awemeId>/<序号>.mp4`；
- 普通单视频仍为 `data/<点赞|收藏>/视频/<awemeId>.mp4`，兼容既有备份。

只有列表到达可信终点（`has_more=false` 且终止 cursor 为 0）后才更新快照：

- `addedIds`：相对上一次完整扫描新增；
- `removedIds`：上次存在、本次完整扫描未出现；
- `reappearedIds`：曾移出、当前重新出现。

移出列表只更新记录，不自动删除已经下载的媒体。控制台时间按北京时间显示，JSON 中使用 ISO 时间，便于跨时区诊断。

## 画质与下载校验

媒体分段解析、视频详情和候选排序直接复用 `plugin/src/shared/api.js`。每个视频分段默认依次尝试最多 4 个最高画质候选，再保留普通地址作为回退候选；每段成功即更新 `download-state.json`。媒体写入前后校验：

- HTTP 必须为 2xx，拒绝 206；
- 视频必须为 `video/mp4`，封面必须为 `image/*`；
- 视频必须有 `content-length`；
- 响应体不能为 0 字节，长度必须与响应头一致；
- 先写 `.part`，完成后再替换正式文件。

连续 8 个作品失败会熔断，避免登录失效、CDN 异常或风控时持续请求。

## 测试

```powershell
cd backend
npm run check
```

自动检查覆盖记录迁移、复合键、连续检查点保存、列表新增/移出/重新出现、喜欢和收藏接口参数、媒体校验、临时文件写入以及 resume 范围恢复。真实账号、真实 CDN 和 Playwright 登录态仍需按设计文档中的人工冒烟步骤验证。
