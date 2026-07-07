# 抖音收藏与下载工具

Chrome MV3 插件版本，用浏览器自己的抖音登录态运行，后续逐步替代 Playwright 脚本。

## 当前能力

- 在 `www.douyin.com` 页面右侧注入本地侧边栏。
- 检测当前抖音网页登录态。
- 导入旧脚本的 `douyin-favorite-progress.json`，写入插件 IndexedDB。
- 展示总数、成功、待处理、暂停、当前游标与运行日志。
- 从导入进度继续收藏，遇到限流/异常自动暂停。
- 审计最近已成功项目，发现漏收藏会标回待处理。
- 下载已成功收藏项目的视频、封面和单条 manifest。

## 运行说明

- 「继续收藏」每次最多处理配置里的“每批数量”，结束后会自动审计最近 N 条。
- 「审计最近」只检查已成功收藏项目，不会重新刷喜欢列表。
- 「开始下载」只下载状态为成功、且未标记 downloaded 的项目。
- 下载默认保存到 Chrome 下载目录的 `DouyinBackup/` 下，避免 iframe 目录权限导致点击无反应。
- 遇到 `3009008`、稍后再试、访问频繁等提示时会暂停，等待下次手动继续。

## 本地安装

1. 打开 Chrome：`chrome://extensions`
2. 开启开发者模式。
3. 点击“加载已解压的扩展程序”。
4. 选择目录：`/Users/lichi/Digital_life/07_j/douyin-toolkit-extension`
5. 打开 `https://www.douyin.com/`，登录后点击扩展图标显示侧边栏。

## 开发命令

```bash
npm run check
npm run zip
```
