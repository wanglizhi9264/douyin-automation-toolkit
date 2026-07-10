# 抖音收藏备份助手

这是一个本地运行的抖音收藏与备份工具集，主要用于把网页版抖音「喜欢」列表里的作品批量加入收藏，并对已处理作品做审计和下载备份。

项目当前包含两条路线：

- Chrome 插件：直接使用当前浏览器里的抖音登录态，在抖音网页内显示侧边栏，执行收藏、审计和下载。
- 后端脚本：早期 Playwright 自动化脚本和本地 dashboard，用于批处理、调试和历史数据迁移。

## 目录结构

```text
.
├── AGENTS.md      # 项目给 Agent/协作者看的工作说明
├── SPEC.md        # 产品和技术方案说明
├── plugin/        # Chrome MV3 插件
├── backend/       # Playwright 脚本、本地 dashboard、配置和本地数据
└── frontend/      # 预留的独立前端目录
```

## Chrome 插件

插件目录：

```text
plugin/
```

安装方式：

1. 打开 Chrome：`chrome://extensions`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本项目里的 `plugin/` 目录
5. 打开 `https://www.douyin.com/`，使用侧边栏操作

常用命令：

```bash
cd plugin
npm run check
npm run zip
```

插件能力：

- 检测当前抖音网页登录态
- 导入后端进度文件
- 从断点继续收藏
- 已收藏作品直接算成功
- 审计最近处理过的作品，漏收藏会标回待处理
- 下载已成功收藏作品的视频、封面和单条 manifest
- 遇到限流、登录异常或接口异常时暂停并记录原因

## 后端脚本

后端目录：

```text
backend/
```

安装依赖：

```bash
cd backend
npm install
```

常用命令：

```bash
npm run douyin:login
npm run douyin:run
npm run douyin:audit
npm run douyin:cycle
npm run douyin:dashboard
```

本地 dashboard 默认地址：

```text
http://127.0.0.1:4777/
```

## 本地数据

本地进度和个人数据不会提交到 Git：

```text
backend/data/douyin-favorite-progress.json
backend/data/douyin-full-audit-result.json
backend/.douyin-playwright-profile/
plugin/dist/
```

这些文件包含运行状态、浏览器 profile 或构建产物，只在本机使用。

## GitHub

远程仓库：

```text
git@github.com:wanglizhi9264/douyin-automation-toolkit.git
```

当前主分支：

```text
main
```

## 注意事项

- 本项目不复制第三方闭源插件代码，只参考公开可观察的功能形态重新实现。
- 不绕过抖音风控；出现「稍后再试」「访问频繁」等提示时应暂停，等待后续手动继续。
- 下载内容默认保存到本地，不上传到任何远程服务。
- 批量操作请控制节奏，避免触发平台限流。
