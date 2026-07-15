# ADR-0001：作品记录使用作用域复合键

- 状态：Accepted
- 日期：2026-07-15
- 影响版本：插件 0.3.0+

## 背景

同一 `awemeId` 可以同时出现在用户的喜欢列表和收藏列表。早期 IndexedDB `items` 仅以 `awemeId` 为主键，后写入的来源会覆盖先前记录，导致下载状态、目标路径和失败原因串线。

## 决策

业务作品使用以下主键：

```text
itemKey = normalizeScope(source) + ":" + awemeId
```

- `favorite_api` 归一到 `liked`。
- 收藏使用 `bookmarked`。
- 文件夹下载记录恢复同样按 `source + awemeId` 匹配。
- IndexedDB 升级到 v2，新增 `scopedItems`，旧 `items` 数据在升级事务中迁移。

## 后果

正面：

- 喜欢和收藏的 `downloadStatus`、路径、错误互不覆盖。
- 新来源可以通过新增 scope 安全扩展。
- 文件夹断点恢复与浏览器状态模型一致。

代价：

- 所有读取和恢复代码必须知道 scope。
- 旧的只按 `awemeId` 处理的工具需要升级。
- 当前单条 manifest 仍只按 `awemeId` 命名；未来若不同 scope 需要不同内容，必须升级文件路径契约。

## 约束

- 禁止重新引入只按 `awemeId` 合并下载状态的逻辑。
- 新列表来源必须定义稳定 scope。
- 任何迁移变更必须增加同 ID 跨作用域测试。
