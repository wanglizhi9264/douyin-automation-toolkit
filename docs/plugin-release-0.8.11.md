# 抖音备份 0.8.11

媒体 403 首试失败后最多回队 10 次。队列继续按冷却时间派发，每次重新获取作品详情和媒体地址。第 11 次媒体 403 后结束该项重试并记录达到上限。作品详情接口拒绝访问不归类为媒体 403。429 冷却及暂停见 [冷却队列实现](plugin-release-0.8.10.md)。

Chromium 对本地文件路径执行文件名检查，Unicode 格式字符属于拒绝范围。组合表情可能含 U+200D 零宽连接符，导致打开目标文件句柄失败。生成保存路径时清理此类字符。新命名沿用短 ID，已有含此类字符的命名在修正路径时使用完整作品 ID 区分同名。作者目录也使用清理后的名称。报告仍可展示原始作者与描述。

实现依据见 [Chromium 本地路径检查](https://chromium.googlesource.com/chromium/src/+/main/content/browser/file_system_access/file_system_access_manager_impl.cc) 和 [文件名字符规则](https://chromium.googlesource.com/chromium/src/+/HEAD/base/i18n/file_util_icu.cc)。
