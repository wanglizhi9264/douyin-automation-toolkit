# 项目文档入口

浏览器插件当前版本：`0.4.0`。

当前实现和维护必须从以下文档开始：

1. [产品规格](docs/product-spec.md)：用户目标、功能边界、需求编号和验收条件。
2. [下载架构设计](docs/architecture-design.md)：组件、消息协议、分页状态机、数据模型、画质与恢复策略。
3. [测试与发布手册](docs/test-release-runbook.md)：自动测试、人工冒烟、诊断取证和发布步骤。
6. [性能与可观测性](docs/performance-observability.md)：快速总数、阶段耗时、落盘节奏和诊断方法。
4. [文档维护规则](docs/README.md)：文档优先级和每类变更需要同步的资产。
5. [架构决策记录](docs/adr/README.md)：关键取舍及其后果。


## Backend 下载资产

- [Backend 使用说明](backend/README.md)：安装、登录、喜欢/收藏/继续下载命令和目录结构。
- [Backend 下载规格与设计](docs/backend-download-spec-design.md)：需求编号、架构、不变量、状态模型、测试追踪和人工冒烟。
- Backend 变更发布前同时运行 `backend/npm run check`、`plugin/npm run check` 和 `git diff --check`。
根目录旧 `SPEC.md` 和 `docs/douyin-access-surfaces.md` 创建于早期里程碑，保留作历史参考。涉及收藏下载、继续下载、文件夹记录和最高画质时，以本页链接的新文档、当前代码和自动测试为准。

## 完成定义

下载相关改动只有同时具备以下内容才算完成：

- 实现代码。
- 自动测试。
- 产品规格或验收项。
- 架构设计或 ADR。
- 人工验证步骤。
- 可落盘的状态与诊断信息。
- Git 提交并推送。

不得把聊天记录当作唯一设计资产。
