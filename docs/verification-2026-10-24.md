# 源码验收记录 · 2026-10-24

本轮针对源码提交 **15b1808**（旧 Markdown 子笔记来源链接修复）复核。结果：在下述测试范围内未发现新的阻塞缺陷；R01–R06、N01–N05 和 M01 对应回归均通过。本轮没有修改产品代码、依赖或版本号。

## 执行结果

| 范围 | 结果 | 说明 |
| --- | --- | --- |
| Node 驱动回归 | 75 / 75，通过 | 覆盖数据、保存失败、迁移恢复、搜索、列表、标注、笔记、引用、格式、会话等；其中部分脚本会启动 Electron |
| 直接 Electron 交互测试 | 3 / 3，通过 | test-pen.js、test-real-input.js、test-lazy-render.js，使用隔离 userData |
| M01 独立复测 | 通过 | 沿用前轮原始复现场景，真实详情面板导出并检查保存数据和最终 HTML |
| 打包产物 | 未执行 | 未重建 exe，也未将旧构建结果计入本轮 |
| 完整人工视觉与性能验收 | 未执行 | 不把脚本通过等同于所有布局、设备及大库性能已验收 |

脚本总数为 79：本轮执行 78 个，另外 1 个为 test-packaged.js。直接渲染器测试壳会出现未注册 settings-get、csl-styles、lib-summary 的日志；这些壳只用于各自交互断言，其退出码与 PASS 结果不能证明完整主进程集成。

## 重点闭环

| 问题 | 验证入口与结果 |
| --- | --- |
| R01 批注扫描跨文档串写 | test-r01-anno-race，通过取消、内存与落盘归属断言 |
| R02–R05 模板、图片与链接导出 | test-review-r02-r05，通过选区保留、特殊文件名、截图、真实链接和导出资源核对 |
| R06 恢复截断、N05 后台页码覆盖 | test-session-restore，通过多标签、失联文件、激活项、后台切换及逐项页码核对 |
| N01 保存失败仍导出旧内容 | test-n01-note-export-save，通过失败取消、内容保留、回滚及重试 |
| N02–N04 富文本结构、缺图、查询参数 | test-n02-n04-note-content，通过正文结构、可见缺图说明和参数解析核对 |
| M01 旧 Markdown 子笔记来源丢失 | test-m01-legacy-md-note 与独立旧场景均通过 |

M01 独立场景中，旧笔记最初只有 Markdown text、html 为空。界面渲染后链接的真实 URL 位于 data-md-link，保存清洗使 href 变为 #。最终导出的 HTML 仍包含 https://example.org/paper?a=1&amp;b=2，来源 URL 与查询参数保留。

## 证据

本机证据目录（位于仓库外，不随源码发布）：

```text
C:/Users/24256/.codex/visualizations/2026/10/23/01a1691d-d8e0-7330-9a77-8c631c3be42d/trove-recheck-15b1808/
```

- test-results.json：75 个脚本的退出码、耗时与摘要，旁边保留逐项日志。
- direct-tests.json：三个直接 Electron 测试的结果。
- markdown-child-evidence.json：旧笔记保存前后内容和导出 HTML。
- real-input-details.json：真实鼠标测试从临时目录归档的断言详情。

测试使用隔离数据；没有以真实用户库作为故障注入对象。历史评审与 2026-10-23 的修复计划保留为当时记录，当前结果以本文为准。

## 已知限制与收尾

PDF 中文等文字标注导出仍受 Helvetica 编码限制；CSL 为参考文献表子集；复杂富文本转换可能简化；搜索仍在主进程执行。JSON 备份不含外部原始文档和全文索引，受管资源上限 60 MB。HTML/Markdown 图片导出需要连同旁边的 .files 目录携带。以上边界详见 [README](../README.md)。

本轮重写 README、架构、开发文档与未发布变更记录。清理 test-export.js 生成的 assets/sample-annotated.pdf，以及已归档详情的临时 pdfreader-real-input.json；正式测试脚本、历史报告和证据、依赖、构建目录保留。

没有暂存、提交或推送，没有重新打包或发布。文档描述当前源码，不表示已有安装包包含这些修复。
