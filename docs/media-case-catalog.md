# 媒体案例目录

本目录只保存脱敏案例标识、预期结构和验收结果，不保存 Cookie、设备参数、签名、媒体文件或第三方扩展代码。

## CASE-IMG-001 图文

- 分享短链：`https://v.douyin.com/2_tDGyJ5f5I/`
- 作品 ID：`7594021740814413809`
- 已确认信号：公开跳转为 `/share/slides/...`，`schema_type=37`、`is_slides=1`
- 预期：`mediaType=multi_image`；原图按 `image-1..n` 顺序写入图片目录；不重复下载顶层合成视频
- 自动覆盖：`plugin/scripts/test-media-parts.mjs` 的 image carousel fixture
- 实机状态：待在登录浏览器中按发布手册 5.7 完成文件数和顺序核对

## CASE-MV-001 用户提供的多片段参考

- 分享短链：`https://v.douyin.com/sF7dQ2wdayk/`
- 预期：若详情明确返回多个视频对象，则归一为 `video-1..n`，每段独立选择最高画质并逐段保存
- 自动覆盖：`plugin/scripts/test-media-parts.mjs` 的 explicit multi-video fixture
- 当前限制：2026-07-16 在无登录公共解析中该短链与 CASE-IMG-001 返回了相同 slides ID，无法据此确认真实字段和真实视频段数量
- 实机状态：需要新的 `www.douyin.com/video/<id>` 直链或可稳定解析的新分享短链完成精确 fixture

## 新案例接入规则

1. 先保存脱敏后的 aweme 结构 fixture，不保存请求头、Cookie 或签名参数。
2. 只有接口明确暴露的图片/视频对象才能加入 `extractMediaParts`，不得根据标题或播放效果猜字段。
3. 新结构必须补解析、路径、断点恢复和 manifest 断言。
4. 自动测试通过后仍需在开发版扩展中完成一次文件数、顺序、MIME 和继续下载冒烟。
