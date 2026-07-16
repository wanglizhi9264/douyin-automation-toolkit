# 架构决策记录

ADR 用于记录已经落地、后续修改必须显式评估的关键取舍。

| ADR | 状态 | 决策 |
| --- | --- | --- |
| [0001](0001-scope-aweme-composite-key.md) | Accepted | 作品记录使用 `scope + awemeId` 复合键 |
| [0002](0002-resume-by-reconciliation.md) | Accepted | 继续下载从第一页重新对账，而不是恢复远端 cursor |
| [0003](0003-media-parts-and-part-checkpoints.md) | Accepted | 作品归一为媒体分段，并逐段保存续传检查点 |

新增 ADR 时使用不可变编号。若决策被替代，不删除旧 ADR，应新增 ADR 并在旧文档中标记 Superseded。
