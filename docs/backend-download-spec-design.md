# Backend 喜欢/收藏下载规格与设计

状态：已实现
版本：1.0
对应 backend：0.2.0
更新时间：2026-07-15

## 1. 目标与边界

backend 下载器需要在不依赖扩展 UI 的情况下，提供和插件一致的列表扫描、记录恢复、跳过已下载项、收藏分页和失败保护；视频清晰度选择继续使用本仓库原有的最高画质实现。

本次范围：

- 下载当前账号的喜欢视频；
- 下载当前账号的收藏视频；
- 从插件或 backend 写出的文件夹记录继续下载；
- 列表变化后识别新增、移出和重新出现；
- 保存媒体、manifest、状态和诊断日志；
- 支持安全暂停、重试、候选回退和连续失败熔断。

不在范围：

- 自动删除已经下载但后来取消喜欢/收藏的文件；
- 绕过登录验证、验证码、频控或平台风控；
- 将 Cookie、Token、媒体或个人记录上传到远端；
- 把图文作品伪装成视频下载。

## 2. 功能规格

| 编号 | 需求 | 验收条件 |
| --- | --- | --- |
| BDL-01 | 账号隔离 | 文件夹已有 user.uid 且与当前账号不一致时拒绝写入 |
| BDL-02 | 喜欢完整扫描 | 从第 1 页开始，按插件分页常量推进，只有可信终点才算完整 |
| BDL-03 | 收藏完整扫描 | POST 表单分页，从 cursor=0 开始，只有 has_more=false 且 cursor=0 才完成 |
| BDL-04 | 作用域隔离 | 主键为 `liked:<id>` 或 `bookmarked:<id>`，同 ID 不互相覆盖 |
| BDL-05 | 继续下载 | 读取 `download-state.json`，从第 1 页核对并跳过当前 scope 已下载项 |
| BDL-06 | 列表变更 | 完整扫描后生成 addedIds、removedIds、reappearedIds；首次只建立基线 |
| BDL-07 | 最高画质 | 直接复用插件候选排序，最多尝试 4 个高质量候选并保留普通候选 |
| BDL-08 | 完整写入 | 校验状态、MIME、长度和非空响应，使用 `.part` 后再替换目标 |
| BDL-09 | 可恢复诊断 | 每页、每候选、失败、暂停和对账均写入状态与日志；控制台为北京时间 |
| BDL-10 | 安全停止 | Ctrl+C/限制参数不对账；8 个连续作品失败熔断；不自动删除媒体 |

## 3. 架构

| 模块 | 职责 |
| --- | --- |
| `scripts/douyin-download.mjs` | CLI、浏览器生命周期、分页循环、跳过/下载、暂停与对账 |
| `scripts/douyin-download-api.mjs` | 账号、喜欢、收藏、详情请求；重试；媒体响应校验和落盘 |
| `scripts/douyin-download-core.mjs` | 记录兼容、复合键、原子检查点、快照差异、目录路径 |
| `plugin/src/shared/api.js` | 本项目原有最高画质候选排序和候选描述 |
| `plugin/src/shared/liked-sync.js` | 喜欢分页大小、限速、重试和可信终点状态机 |
| `plugin/src/shared/bookmarked-sync.js` | 收藏分页大小、限速、重试和可信终点状态机 |

数据流：

```text
Playwright 登录态
  -> 当前账号
  -> 从第 1 页扫描 liked 或 bookmarked
  -> 规范化为 scope:awemeId
  -> 已下载：跳过
  -> 未下载/失败：获取详情
  -> 原有最高画质排序
  -> 校验并写入媒体、manifest、状态、日志
  -> 可信完整终点
  -> 与上次完整快照对账
```

## 4. 状态与不变量

任务阶段：

```text
idle -> scanning -> downloading -> scanning -> completed
                    |                |
                    +-> failed       +-> paused
```

不变量：

1. 每次开始或继续都从第 1 页扫描，旧 cursor 只用于诊断，不作为恢复起点。
2. 跳过条件必须同时满足相同 scope 和 `downloadStatus=downloaded`。
3. 喜欢和收藏的相同 awemeId 是两条记录。
4. 暂停、接口错误、cursor 异常或进程失败不得覆盖上一次完整快照。
5. 只有可信完整扫描才允许把旧作品标记为 `listState=removed`。
6. 取消喜欢/收藏不删除本地媒体；重新出现时恢复为 present，并保留下载状态。
7. 首次读取没有快照的插件记录时，从当前同 scope items 迁移基线，避免把全部旧项误报为新增。
8. 写状态文件允许在 Windows 上重复保存；先尝试原子替换，必要时使用目标存在时的兼容回退。
9. 账号不一致立即停止，不把 A 账号记录写入 B 账号目录。
10. 所有本地路径使用插件目录结构和正斜杠记录格式。

## 5. 数据模型

核心字段示例：

```json
{
  "schemaVersion": 2,
  "user": { "uid": "...", "nickname": "..." },
  "current": {
    "scope": "bookmarked",
    "phase": "paused",
    "page": 3,
    "cursor": 123,
    "awemeId": "..."
  },
  "listSnapshots": {
    "bookmarked": {
      "completedAt": "...",
      "ids": ["..."],
      "missingIds": ["..."],
      "lastChanges": {
        "addedIds": [],
        "removedIds": [],
        "reappearedIds": []
      }
    }
  },
  "items": [{
    "itemKey": "bookmarked:123",
    "awemeId": "123",
    "source": "bookmarked",
    "downloadStatus": "downloaded",
    "listState": "present",
    "videoPath": "data/收藏/视频/123.mp4"
  }]
}
```

插件目前会忽略它不认识的 backend 快照扩展字段，但 backend 再次读取时仍能从插件保留的 items 迁移基线。媒体路径、scope、状态和画质字段保持双向恢复兼容。

## 6. 错误处理

- 账号、喜欢、收藏和详情接口均要求响应可解析且业务状态成功。
- 喜欢页最小间隔 5 秒；收藏页最小间隔 3 秒；重试按插件常量执行。
- cursor 不前进、非可信终点、预期非零但响应空列表都作为失败，不伪装完成。
- 候选下载失败会记录 rank、候选画质和错误，然后尝试下一候选。
- 媒体失败不会写 downloaded；成功媒体和 manifest 写入后才更新记录。
- Ctrl+C 在当前安全点保存 paused，不做列表移出判断。

## 7. 自动测试追踪

| 需求 | 自动测试 |
| --- | --- |
| BDL-01、BDL-04、BDL-05 | `test-douyin-download-core.mjs`、`test-douyin-download-api.mjs` |
| BDL-02、BDL-03 | backend 接口契约测试 + 插件 liked/bookmarked 状态机测试 |
| BDL-06 | 新增、移出、重新出现、首次基线单元测试 |
| BDL-07 | backend 直接导入插件 API；插件最高画质测试 |
| BDL-08 | MIME、长度、非空和 `.part` 落盘测试 |
| BDL-09 | 连续两次检查点保存和日志文件断言 |
| BDL-10 | 静态流程检查；真实 Ctrl+C 与熔断按人工冒烟验证 |

发布前必须同时运行：

```powershell
cd backend
npm run check

cd ..\plugin
npm run check

cd ..
git diff --check
```

## 8. 人工冒烟

使用专用测试目录，不要直接对唯一备份做故障注入。

1. 登录测试账号，运行喜欢命令并加 `--max-items 1`。
2. 确认状态为 paused，视频、manifest、状态、日志均已落盘。
3. 再运行 resume，确认从第 1 页核对且第一条已下载作品被跳过。
4. 运行收藏命令并加 `--max-items 1`，确认文件进入 `data/收藏`。
5. 在抖音新增一个喜欢或收藏，完整运行对应命令，确认 `addedIds`。
6. 移除一个项目，再完整运行，确认 `removedIds` 且本地媒体仍存在。
7. 把该项目重新加入，再完整运行，确认 `reappearedIds` 且不重复下载。
8. 使用另一个账号指向该目录，确认任务因账号不匹配而停止。
9. 对一个包含多码率的作品核对 manifest，确认成功候选的 codec、分辨率、fps、码率和大小与日志一致。
10. 中途 Ctrl+C，确认 paused 且没有生成错误的 removedIds。

真实接口与 CDN 会变化；自动测试通过不等于真实账号冒烟可以省略。
