# 项目文档

更新于 2026-11-10。当前现代扩展版本 **0.8.9**。从以下文档阅读当前行为：

| 文档 | 回答的问题 |
| --- | --- |
| [产品规格 v0.3](plugin-product-spec-v0.3.md) | 为谁备份、每页显示什么、点击后发生什么、数量和完成如何定义 |
| [技术实现基线](implementation-spec-0.8.7.md) 与 [0.8.8 实现变更](plugin-release-0.8.8.md) 与 [0.8.9 队列策略](plugin-release-0.8.9.md) | 消息桥、并发、分页、2 秒预算、补下、v2 提交、续传、升级和报告如何实现 |
| [架构与业务规则](architecture-design.md) | 各层职责、事实源与关键边界 |
| [测试与发布](test-release-runbook.md) | 回归入口、人工反例、验证证据、超时和打包交付 |
| [安装说明](../plugin/INSTALL.md) | 如何加载、更新和使用扩展 |
| [架构决策](adr/README.md) | 哪些旧决策保留、哪些已由 ADR-0004 替代 |

规格 v0.3 对应插件 0.8.9，并非插件版本号。功能后续变化时应同步产品规格、实现和测试；仅整理文档不提升扩展版本。

## 历史材料

以下保留当时的讨论与审查证据，不作为当前规则：

- [产品 Spec v0.2](plugin-product-spec-v0.2.md)、[Spec v0.1](plugin-product-spec-v0.1.md)、[设计方案 v1](plugin-design-v1.md)。
- [实现规格 0.7.2](implementation-spec-0.7.2.md)、[历史架构](architecture-design-legacy.md)、[历史测试发布手册](test-release-runbook-legacy.md)。
- [2026-10-09 业务审查](project-audit-2026-10-09.md)、[媒体案例](media-case-catalog.md)。历史问题是否关闭，需要对照后续实现和验证，不能一律算作现代问题或一律宣告解决。

后端是独立工具，安装和互操作以 backend 文档及当前技术规格的边界为准；旧私信/一键流程记录不代表现代侧栏入口。

## 版本更新记录

- [0.7.0 本地试用交付与验证](plugin-release-0.7.0.md)

- [0.7.1 累计备份与增量进度修订](plugin-release-0.7.1.md)

- [0.7.2 本地报告、429 冷却与画质记录](plugin-release-0.7.2.md)

- [0.7.3 非零末页游标与列表恢复修复](plugin-release-0.7.3.md)

- [0.7.4 每次从最新列表开始检查](plugin-release-0.7.4.md)

- [0.7.5 悬浮快捷入口与完整关注名单](plugin-release-0.7.5.md)：真实账号只读验证35位关注，完整自动分页、提前选择下载及悬浮菜单。

- [0.7.6 悬浮交互与统计显示](plugin-release-0.7.6.md)：环绕菜单、拖动、关闭、细进度环，收藏近似数和已知媒体占用。

- [0.7.7 稳定进度与失败重试](plugin-release-0.7.7.md)：同心外环、减少界面重绘、403刷新重试、只重试失败作品。

- [0.7.8 自动升级画质与关注续下](plugin-release-0.7.8.md)：安全升级画质、选择持久化、逐作者下载与检查点续下。

- [0.7.9 仅升级未达最高画质的记录](plugin-release-0.7.9.md)：最高标记直接跳过，降级/回退才检查，未知不盲重下。

- [0.8.0 简洁版](plugin-release-0.8.0.md)：统一完整下载流程、精简首页与任务区、详细信息归到 HTML 看板。

- [0.8.1 右侧通高侧栏](plugin-release-0.8.1.md)：统一贴边布局、清晰留白，保留简洁下载流程。

- [0.8.2 重试与目录整理](plugin-release-0.8.2.md)

- [0.8.3 媒体分类目录](plugin-release-0.8.3.md)

- [0.8.4 可读文件名](plugin-release-0.8.4.md)

- [0.8.5 快速跳过与自动补下](plugin-release-0.8.5.md)

- [0.8.6 分类报告](plugin-release-0.8.6.md)

- [0.8.7 清晰状态与恢复提示](plugin-release-0.8.7.md)

- [0.8.8 下载与暂停提速](plugin-release-0.8.8.md)

- [0.8.9 扫描期间空闲重试](plugin-release-0.8.9.md)
