# 抖音可访问接口与下载链路说明

这份文档沉淀当前项目已经验证过的抖音访问面、调用方式、限制、失败模式，以及继续扩展功能时应优先复用的代码位置。

目标不是罗列所有可能接口，而是明确:

- 现在已经打通了哪些接口
- 每个接口应该从哪里调用
- 哪些链路依赖登录态
- 哪些链路会踩 CORS、限流、登录、风控
- 新功能应该优先加在什么层，而不是重新摸索一遍

## 1. 三个执行层

当前项目实际有三层能力，不能混用概念。

### 1.1 后端 Playwright 层

位置:

- [backend/scripts/douyin-favorite-liked.mjs](/Users/lichi/Digital_life/07_j/backend/scripts/douyin-favorite-liked.mjs)

特点:

- 运行在 Playwright 打开的抖音页面里
- 通过 `page.evaluate()` 在页面上下文执行 `fetch`
- 依赖浏览器登录态和网页 cookie
- 适合长时间批处理、自动续跑、历史进度管理

适合做的事:

- 批量拉喜欢列表
- 批量点收藏
- 审计收藏状态
- 做自动暂停、重试、进度落盘

### 1.2 插件侧边栏层

位置:

- [plugin/src/sidebar/app.js](/Users/lichi/Digital_life/07_j/plugin/src/sidebar/app.js)
- [plugin/src/shared/events.js](/Users/lichi/Digital_life/07_j/plugin/src/shared/download.js)

特点:

- 运行在扩展 iframe 里
- UI、配置、日志、IndexedDB 状态都在这里
- 不适合直接抓抖音 CDN 视频文件
- 适合做状态机、按钮、下载队列、文件夹记录管理

适合做的事:

- 展示运行状态
- 控制开始、暂停、审计、下载
- 管理本地下载记录 JSON/HTML
- 选择并记住文件夹

### 1.3 抖音页面注入层

位置:

- [plugin/src/injected.js](/Users/lichi/Digital_life/07_j/plugin/src/injected.js)
- [plugin/src/content.js](/Users/lichi/Digital_life/07_j/plugin/src/content.js)

特点:

- 运行在 `www.douyin.com` 页面上下文
- 能直接复用抖音网页 cookie、登录态、页面可用参数
- 是插件访问抖音 Web API 的真正执行面
- 文件夹模式下的视频下载也应优先走这里

适合做的事:

- 调抖音 Web API
- 读取当前登录信息
- 读取作品详情
- 预检视频/封面 URL
- 将媒体下载后直接写入已授权文件夹

## 2. 当前已验证可用的抖音接口

这些接口已经在项目里出现过，或已在实现中使用。

### 2.1 当前用户信息

接口:

```text
GET /aweme/v1/web/user/profile/self/
```

公共参数:

```text
device_platform=webapp
aid=6383
channel=channel_pc_web
publish_video_strategy_type=2
source=channel_pc_web
```

当前用途:

- 检测是否已登录
- 获取当前用户信息

代码位置:

- [plugin/src/injected.js](/Users/lichi/Digital_life/07_j/plugin/src/injected.js)
- [plugin/src/sidebar/app.js](/Users/lichi/Digital_life/07_j/plugin/src/sidebar/app.js)

返回里当前项目真正依赖的字段:

- 用户昵称
- uid / secUid

风险:

- 未登录时可能返回非预期内容
- 依赖页面登录态，必须从抖音页面上下文发起

### 2.2 喜欢列表

接口:

```text
GET /aweme/v1/web/aweme/favorite/
```

公共参数:

```text
device_platform=webapp
aid=6383
channel=channel_pc_web
sec_user_id=<secUid>
max_cursor=<cursor>
count=<count>
```

当前用途:

- 从“喜欢”列表拉作品
- 后端自动化构建待收藏任务池

代码位置:

- [backend/scripts/douyin-favorite-liked.mjs](/Users/lichi/Digital_life/07_j/backend/scripts/douyin-favorite-liked.mjs)

项目里已知字段:

- `status_code`
- `status_msg`
- `has_more`
- `max_cursor`
- `aweme_list`

经验:

- `secUid` 可以从当前页面状态或脚本文本里取
- 喜欢列表分页依赖 `max_cursor`
- 同步喜欢列表时应从 `cursor = 0` 明确起跑，不要沿用收藏流程里的其他游标

风险:

- 接口对登录态敏感
- 大量翻页时容易碰到频率限制

### 2.3 收藏列表

接口:

```text
POST /aweme/v1/web/aweme/listcollection/
```

状态:

- 插件与 backend 收藏下载的主列表接口
- 页面登录态下使用表单体 `count=10&cursor=<cursor>`

当前契约:

- 内容：`aweme_list`
- 分页：`cursor`、`has_more`
- 总数兼容：`total`、`total_count`、`collect_count`、`collection_count` 及 `data/extra` 嵌套变体
- 可信终点：`has_more=false` 且 `cursor=0`
- 首次响应可作为概览缓存复用，不能为显示总数再请求一次第一页
- 接口没有 total 时保留“远端总数未知”，扫描计数不能冒充远端总数
- 3 秒最小间隔、最多 3 次和 7 秒/14 秒重试继续适用

### 2.4 作者作品列表

接口:

```text
GET /aweme/v1/web/aweme/post/
```

状态:

- 已记录
- 当前未作为主链路实现

潜在用途:

- 作者页批量备份
- 对单个作者建立补档任务

### 2.5 收藏动作

接口:

```text
POST /aweme/v1/web/aweme/collect/?aweme_id=<id>&action=1
```

公共参数:

```text
device_platform=webapp
aid=6383
channel=channel_pc_web
aweme_id=<awemeId>
action=1
```

当前用途:

- 将“喜欢”里的作品转为“收藏”

代码位置:

- [backend/scripts/douyin-favorite-liked.mjs](/Users/lichi/Digital_life/07_j/backend/scripts/douyin-favorite-liked.mjs)
- [plugin/src/injected.js](/Users/lichi/Digital_life/07_j/plugin/src/injected.js)

项目内状态判断:

- 成功后标记为 `favorited`
- 如果详情接口返回 `collect_stat === 1`，可直接标为 `already_favorited`

常见暂停条件:

- 收藏速度太快
- 稍后再试
- 访问频繁
- 风控验证

### 2.6 作品详情

接口:

```text
GET /aweme/v1/web/aweme/detail/?aweme_id=<id>
```

公共参数:

```text
device_platform=webapp
aid=6383
channel=channel_pc_web
aweme_id=<awemeId>
```

当前用途:

- 判断 `collect_stat`
- 审计是否真正收藏成功
- 取 `desc`
- 取作者昵称/uid
- 取 `create_time`
- 取封面 URL
- 取视频候选 URL

代码位置:

- [backend/scripts/douyin-favorite-liked.mjs](/Users/lichi/Digital_life/07_j/backend/scripts/douyin-favorite-liked.mjs)
- [plugin/src/injected.js](/Users/lichi/Digital_life/07_j/plugin/src/injected.js)
- [plugin/src/shared/api.js](/Users/lichi/Digital_life/07_j/plugin/src/shared/api.js)

项目里已实际依赖的字段:

- `aweme.collect_stat`
- `aweme.desc`
- `aweme.author.nickname`
- `aweme.author.uid`
- `aweme.create_time`
- `aweme.video.cover.url_list`
- `aweme.video.*` 里的视频 URL 候选
- `aweme.images[]` 中的原图地址
- 图片项中的 `video`、`video_info` 或 `live_photo.video`
- 明确返回的 `video_list`、`videos`、`video_segments` 和 `multi_video.*`
- 视频分段内部的 `bit_rate` 与 `play_addr*` 候选

重要经验:

- 这是最核心的“单条真相接口”
- 收藏、审计、下载三条链路都会依赖它
- 如果未来只能保一个核心接口知识面，优先维护这一个

## 3. 插件消息桥能力

插件不是直接在侧边栏里访问抖音接口，而是通过消息桥把请求转给页面注入层。

消息桥代码:

- [plugin/src/shared/events.js](/Users/lichi/Digital_life/07_j/plugin/src/shared/events.js)
- [plugin/src/content.js](/Users/lichi/Digital_life/07_j/plugin/src/content.js)
- [plugin/src/injected.js](/Users/lichi/Digital_life/07_j/plugin/src/injected.js)

当前已定义的能力如下。

### 3.1 `GET_SELF_PROFILE`

用途:

- 检测登录态

返回:

- 当前用户信息

### 3.2 `COLLECT_AWEME`

用途:

- 触发收藏动作

### 3.3 `FETCH_AWEME_DETAIL`

用途:

- 拉单条详情
- 做收藏前校验
- 做审计
- 做下载前元数据拉取

### 3.4 `PRECHECK_URL`

用途:

- 下载前预检媒体 URL
- 判断 MIME 类型、大小、是否是 206 分段响应

当前规则:

- 视频必须是 `video/mp4`
- 封面必须是 `image/*`
- 视频应有明确 `content-length`
- `206` 直接判为不可用

代码位置:

- [plugin/src/injected.js](/Users/lichi/Digital_life/07_j/plugin/src/injected.js)

### 3.5 `DOWNLOAD_TO_FOLDER`

用途:

- 在抖音页面上下文下载媒体，再写入用户已授权文件夹

为什么要有它:

- 扩展 iframe 直接抓 CDN 视频，容易踩跨域限制
- 文件夹模式下，页面上下文比扩展侧边栏更接近真实网页请求环境

当前实现:

- 先 `PRECHECK_URL`
- 再 `fetch(url, { credentials: "omit", mode: "cors" })`
- 拉到 Blob 后通过 File System Access API 写入文件夹

## 4. 下载链路的现实约束

这是后续最容易再次踩坑的部分。

### 4.1 不要把“接口可访问”和“媒体可下载”混为一谈

作品详情接口能拿到视频 URL，不代表扩展 iframe 能直接把它抓下来。

原因:

- 抖音详情接口和 CDN 媒体 URL 是两类资源
- 前者依赖网页登录态
- 后者更容易触发 CORS、重定向、分段响应、MIME 不一致等问题

### 4.2 文件夹模式和浏览器下载模式是两条链

文件夹模式:

- 目标是“不出现在浏览器下载记录里”
- 依赖 File System Access API
- 更适合做静态库、记录文件、断点续跑

浏览器下载模式:

- 目标是兼容性更高
- 依赖 `chrome.downloads.download`
- 更容易产生浏览器下载记录或提示

建议:

- 用户明确要求“不要在浏览器下载里看到记录”时，优先文件夹模式
- 文件夹模式失败时，不要静默退回浏览器下载模式，应明确告知

### 4.3 当前文件夹记录文件是下载续跑的唯一真相

当前约定:

- 下载状态文件: `data/.appdata/download-state.json`
- 静态报告页: `本地库.html`

设计原则:

- 有这个 JSON，就按这个文件夹继续
- 没有这个 JSON，就从这个文件夹的 0 状态开始
- 不应该把别的文件夹、本地旧 IndexedDB、全局喜欢总量直接显示成当前下载进度

### 4.4 下载前预检是必要的

当前已经验证有意义的预检项:

- HTTP 状态必须是 2xx
- 不能是 `206`
- 视频必须是 `video/mp4`
- 封面必须是 `image/*`
- 视频最好有 `content-length`

原因:

- 否则很容易出现下载中途才发现拿到的不是目标资源
- 预检失败信息比最终 `Failed to fetch` 更能定位问题

### 4.5 尽量下载最高画质的推荐策略

当前项目建议采用“候选排序 + 多候选预检 + 首个最优可用项”的方式，而不是只拿一个 URL 硬下。

当前策略要点:

- 优先从 `video.bit_rate[]` 收集候选
- 再把 `play_addr_h264`、`play_addr_h265`、`play_addr` 作为兜底候选
- 排序时同时考虑分辨率、码率、大小、fps、codec
- 开启“顶配优先”时，优先高分辨率、高码率、大文件，并允许优先 `h265`
- 关闭“顶配优先”时，优先 `h264` 的稳定候选
- 下载前对前 3 个候选逐个预检
- 选择第一个预检通过的最高分候选
- 所有候选都失败时，才回退到普通画质单候选

这样做的好处:

- 比“只试一个顶配 URL”更稳
- 比“直接拿默认 play_addr”更接近真实顶配
- 能把预检失败原因记录下来，便于后续分析不同 CDN、codec、分辨率的可用性

## 5. 当前项目已知的失败模式

### 5.1 登录态问题

典型表现:

- 接口返回非 JSON
- 页面出现扫码登录、手机号登录
- 页面内容变成风控或验证页

建议:

- 先查当前用户接口
- 再查页面文本信号

### 5.2 限流或风控

典型表现:

- `3009008`
- 稍后再试
- 访问频繁
- 登录异常

建议:

- 直接暂停
- 记录当前条目和原因
- 不要硬跑

### 5.3 收藏成功但实际未收藏

典型表现:

- 收藏动作接口表面成功
- 但详情接口 `collect_stat !== 1`

建议:

- 始终保留审计步骤
- 审计失败时标回 `pending`

### 5.4 媒体抓取失败

典型表现:

- `Failed to fetch`
- 跨域报错
- CDN 重定向后响应头不符合预期

建议:

- 优先页面上下文下载
- 先预检，再正式下载
- 顶配画质失败时，可回退到普通画质

## 6. 新功能开发建议

以后要继续做功能，优先按下面顺序判断加在哪一层。

### 6.1 如果是“抖音账号态相关”

优先加在:

- 页面注入层
- 或后端 Playwright 页面上下文

典型功能:

- 拉列表
- 查详情
- 点赞/收藏/取消
- 获取作者信息

### 6.2 如果是“批处理状态机”

优先加在:

- 后端脚本
- 或插件侧边栏状态机

典型功能:

- 批量续跑
- 重试
- 暂停恢复
- 进度统计

### 6.3 如果是“下载、落盘、本地库”

优先加在:

- 插件侧边栏负责调度
- 页面注入层负责抓资源
- 文件夹记录文件负责续跑真相

典型功能:

- 下载视频
- 下载封面
- 生成 HTML 静态库
- 按文件夹恢复状态

## 7. 继续扩展前的检查清单

做任何新能力前，先过一遍这几项。

1. 这次调的是抖音 JSON 接口，还是 CDN 媒体 URL。
2. 这次能力应该跑在后端、侧边栏，还是页面注入层。
3. 是否需要复用登录态和 cookie。
4. 是否需要按文件夹记录续跑，而不是按全局状态续跑。
5. 是否要先做预检，而不是直接下载。
6. 是否会触发限流或风控，失败时是否必须暂停。
7. 失败信息是否足够落盘，便于下一次继续定位。

## 8. 最值得优先复用的代码位置

后续开发时，先看这些文件，不要从零开始猜。

- [backend/scripts/douyin-favorite-liked.mjs](/Users/lichi/Digital_life/07_j/backend/scripts/douyin-favorite-liked.mjs)
  现有后端收藏、拉喜欢、审计的主实现。
- [plugin/src/injected.js](/Users/lichi/Digital_life/07_j/plugin/src/injected.js)
  页面上下文 API 访问和文件夹下载桥。
- [plugin/src/sidebar/app.js](/Users/lichi/Digital_life/07_j/plugin/src/sidebar/app.js)
  插件下载状态机、文件夹记录、运行日志。
- [plugin/src/shared/api.js](/Users/lichi/Digital_life/07_j/plugin/src/shared/api.js)
  视频候选 URL 和画质选择逻辑。
- [plugin/src/shared/download.js](/Users/lichi/Digital_life/07_j/plugin/src/shared/download.js)
  下载目标、文件写入、浏览器下载回退。

## 9. 后续可以补充但还没系统化的方向

这些方向已经有价值，但当前知识沉淀还不够完整。

- 收藏列表接口的完整分页结构
- 作者作品列表接口的参数与返回差异
- 视频不同画质字段的稳定优先级
- 抖音 CDN 各域名的跨域行为差异
- 取消收藏、取消点赞等反向动作
- 评论、合集、图文等非视频内容的下载结构
