# 抖音喜欢列表自动收藏 Spec

## 目标

自动读取网页版抖音「喜欢」列表里的真实作品，并确保每个作品都被收藏。任务可中断、可续跑；遇到接口失败、风控、稍后再试、登录态异常等情况时暂停，等待下次人工允许后继续。

## 当前采用方案

使用本地 Playwright 脚本复用独立浏览器登录态：

- 登录态目录：`.douyin-playwright-profile`
- 进度文件：`douyin-favorite-progress.json`
- 配置文件：`douyin-favorite.config.json`
- 主脚本：`scripts/douyin-favorite-liked.mjs`

执行入口：

```bash
npm run douyin:run
```

本地可视化控制台：

```bash
npm run douyin:dashboard
```

打开：

```text
http://127.0.0.1:4777
```

控制台能力：

- 点击「继续运行」即可按 `douyin:cycle -- --skip-history-audit` 的节奏续跑。
- 可勾选「重新刷新喜欢列表」，需要重新同步喜欢页时再打开。
- 可设置每批数量、每批后审计数量、点击间隔、审计失败阈值。
- 显示真实喜欢总数、已成功、待处理、审计返工、当前位置、状态分布、最近更新和日志。
- 点击「打开登录」可打开 Playwright 抖音窗口；登录后点「登录完成」保存登录态。
- 点击「释放浏览器占用」可处理 Playwright 浏览器 profile 被旧窗口占用的问题。

默认续跑时不再检查/同步喜欢列表，直接处理 `douyin-favorite-progress.json` 里已有的真实喜欢作品，避免浪费时间。

需要刷新喜欢列表时才显式运行：

```bash
npm run douyin:run -- --sync-liked
```

批量执行并自动复查：

```bash
npm run douyin:cycle
```

`douyin:cycle` 会先审计历史已标成功项，发现漏收藏就标回 `pending`；之后按配置每收藏一批再复查最近一批，适合长时间续跑。

## 已探索结论

1. 直接用 Codex Chrome Extension 接管日常 Chrome 不稳定，通信通道会断续。
2. DOM/坐标点击方案不稳定：
   - 喜欢页卡片不是稳定的普通链接。
   - 可视截图里有卡片，但 DOM 中常出现覆盖层或虚拟列表占位。
   - 直接打开作品详情页有时停在「视频数据加载中」。
3. API 方案稳定：
   - 喜欢列表接口可以返回真实作品 ID、描述、作者、收藏状态。
   - 收藏接口 POST 返回 `status_code: 0` 表示成功。
   - `collect_stat: 1` 表示已经收藏，可直接算成功。

## 使用的网页接口

喜欢列表，只读：

```text
GET /aweme/v1/web/aweme/favorite/
```

关键参数：

```text
device_platform=webapp
aid=6383
channel=channel_pc_web
sec_user_id=<当前登录用户 secUid>
max_cursor=<分页 cursor>
count=20
```

收藏作品：

```text
POST /aweme/v1/web/aweme/collect/
```

关键参数：

```text
device_platform=webapp
aid=6383
channel=channel_pc_web
aweme_id=<作品 ID>
action=1
```

注意：请求在浏览器页面上下文中执行，依赖抖音网页脚本自动补充 `verifyFp`、`msToken`、`a_bogus` 等参数。

## 进度状态

状态保存在 `douyin-favorite-progress.json`。

- `pending`：真实喜欢作品，尚未处理。
- `already_favorited`：接口显示已经收藏，直接算成功。
- `favorited`：本脚本已收藏成功。
- `paused_unverified`：收藏接口失败或无法确认，暂停。
- `blocked`：登录/风控/接口异常，暂停。
- `skipped_non_like_probe_artifact`：早期 DOM 探测误采集项，已忽略。

## 暂停规则

以下情况暂停，不继续硬跑：

- 喜欢列表接口连续重试失败。
- 收藏接口连续重试失败。
- 返回内容无法解析为 JSON。
- 返回 `status_code` 非 0，例如「稍后再试」或风控类提示。
- 无法读取当前登录用户 `secUid`。

## 当前节奏配置

当前已改为较快节奏：

```json
{
  "count": 20,
  "minDelayMs": 300,
  "maxDelayMs": 900,
  "retries": 3,
  "retryBaseDelayMs": 1500,
  "syncLikedBeforeRun": false,
  "stopAfterNoNewPages": 5,
  "cycleBatchSize": 100,
  "cycleAuditRecent": 120,
  "continueOnAuditFailure": true,
  "maxConsecutiveAuditFailures": 6
}
```

如果触发「稍后再试」，脚本会暂停。下次允许后直接重新运行：

```bash
npm run douyin:run
```

也可以临时覆盖节奏：

```bash
npm run douyin:run -- --min-delay-ms 1000 --max-delay-ms 3000
```

## 当前执行记录

已完成：

- 登录态建立。
- 喜欢列表接口确认可用。
- 收藏接口确认可用。
- 完整同步到约 4017 个真实喜欢作品。
- 已成功收藏一批作品，最新进度以 `douyin-favorite-progress.json` 为准。

截至最近一次暂停：

- 总记录：4025 条。
- 旧 DOM 探测误采集项：8 条，状态为 `skipped_non_like_probe_artifact`。
- 真实喜欢作品：4017 条。
- 已收藏成功：1561 条 `favorited`。
- 已确认本来已收藏：2 条 `already_favorited`。
- 已跳过失效作品：1 条 `skipped_inaccessible`。
- 待处理：2452 条 `pending`。
- 当前暂停项：index 1564，作品 ID `7644821321281409743`。
- 最新暂停原因：抖音返回 `status_code=3009008`，提示「收藏速度太快啦，休息一会儿再使用吧」。

后续继续：

```bash
npm run douyin:run
```

若要按「先检查历史，再每跑一批就复查」的节奏继续：

```bash
npm run douyin:cycle
```

可临时调整每批数量和复查数量：

```bash
npm run douyin:cycle -- --batch-size 100 --audit-recent 120
```

如已经完成历史审计，只想从下一批开始：

```bash
npm run douyin:cycle -- --skip-history-audit
```

如果历史审计因为临时网络错误暂停，`douyin:cycle` 会记录 `audit_paused_unverified` 和暂停 index。下次继续运行时会从该 index 往前审计，避免重复检查已经确认过的大段历史。

当前配置允许审计详情接口偶发失败时继续：脚本会保留原状态、记录错误并计入 `failed`，避免单条详情空响应卡死整轮。收藏接口失败仍然会暂停。

如果审计详情接口连续失败达到 `maxConsecutiveAuditFailures`，当前审计段会提前结束，脚本继续进入下一批收藏；这些失败项保留原状态并记录错误，后续可以再次单独审计。

## 独立审计

高速收藏模式可能出现接口返回成功但实际未收藏的漏网项。审计命令只检查，不执行收藏动作。

默认检查最近 100 个已标成功的作品：

```bash
npm run douyin:audit
```

检查最近 N 个：

```bash
npm run douyin:audit -- --recent 200
```

检查全部已标成功作品：

```bash
npm run douyin:audit -- --all
```

从指定 index 往前检查：

```bash
npm run douyin:audit -- --all --max-index 759
```

审计逻辑：

- 读取详情接口的 `collect_stat`。
- `collect_stat=1` 视为确认已收藏。
- `collect_stat!=1` 视为漏收藏，重新标为 `pending`，等待下一轮 `npm run douyin:run` 重新收藏。
- `status_code=2053` 视为视频不存在，标为 `skipped_inaccessible`。
- 审计详情接口临时失败时，默认保留原状态、记录错误并继续；可用 `--continue-on-audit-failure false` 改回失败即暂停。
- 连续审计失败达到阈值时，结束当前审计段，避免空响应拖慢主流程。
