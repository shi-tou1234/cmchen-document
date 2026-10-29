# 文档索引

| 内容 | 文档 |
| --- | --- |
| 功能与使用方法 | [README](../README.md) |
| 模块、存储与异步约定 | [architecture.md](architecture.md) |
| 环境、测试、打包与维护 | [development.md](development.md) |
| 功能差距与规划依据 | [竞品调研](竞品调研-2026-10-26.md) |
| 版本变化 | [CHANGELOG](../CHANGELOG.md) |

截图保存在 `images/`，由使用说明引用。

维护时直接更新对应文档，版本变化汇总到 CHANGELOG；不新增逐轮审核、验收、修复计划或开发流水记录。测试证据由可重复执行的回归脚本提供。移动或删除文档后运行 `node scripts/check-doc-links.js` 检查本地链接。
