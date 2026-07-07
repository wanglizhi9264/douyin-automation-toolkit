# 抖音收藏与下载工具

Chrome MV3 插件版本，用浏览器自己的抖音登录态运行，后续逐步替代 Playwright 脚本。

## 当前能力

- 在 `www.douyin.com` 页面右侧注入本地侧边栏。
- 检测当前抖音网页登录态。
- 导入旧脚本的 `douyin-favorite-progress.json`，写入插件 IndexedDB。
- 展示总数、成功、待处理、暂停、当前游标与运行日志。
- 保留收藏、审计、下载入口，下一阶段接真实执行逻辑。

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
