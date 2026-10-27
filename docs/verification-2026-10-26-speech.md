# 源码验收记录 · 2026-10-26 · 朗读

本轮为 **1.3.0** 源码上的未发布朗读改动：跨页连续朗读、句级高亮、暂停 / 恢复与位置记忆。验收对象是当前源码，不是 `build/` 里的旧安装包。

## 执行结果

| 范围 | 结果 | 说明 |
| --- | --- | --- |
| 新增回归 `test-reader-speech` 首轮 | 15 / 15，通过 | 断句、首句高亮、H/U 标注当前句、旋转 90° 下换句、停止清理、同页续读 |
| 新增回归 `test-reader-speech` 第二次启动 | 13 / 13，通过 | 跨启动恢复句序、跨页跳过空白页、暂停 / 恢复、读到末尾 |
| 文本层与朗读相关旧回归 | 12 个脚本，全部通过 | selection 16、search-highlight 14、reader-plus 17、reader-extras 19、reader-rotate-split 47 + 6、anno、anno-extras 18、anno-objects 20 + 15、native-annos 32、zoom-mode 25、session 9、note-item 14 |
| 直接 Electron 交互测试 | 3 / 3，通过 | test-pen、test-real-input、test-lazy-render，使用隔离 userData |
| 全量 81 个脚本 | 未执行 | 本轮只跑新增与受影响链路；未跑的脚本不能据此声称通过 |
| 打包产物 | 未执行 | 未重新打包，旧 exe 不代表本轮改动 |
| 实体音频验收 | 未执行 | 用假语音驱动验证句序与状态机，没有断言真的出声 |

## 重点验证

- **断句**：测试 PDF 第 1 页三句（`First sentence. Second sentence. Third sentence.`）被切成 3 句；空白第 2 页返回 0 句。
- **句级高亮**：首句高亮数量大于 0，DOM 落在 `#page-1 .speech-hl`；换到第二句后高亮仍在；旋转 90° 后换句仍能画出，说明坐标走的是旋转后的文字框。
- **跨页**：第 1 页读完自动准备下一页；第 2 页无文字被跳过，直接到第 3 页；正文当前页、状态栏和高亮一起跟到第 3 页。
- **朗读中标注**：按 `H` 生成一条 `mark` 标注，文本等于当前句；按 `U` 生成 `underline` 标注；重复按同一种会提示已标注。
- **暂停 / 恢复**：第二次点击进入 `paused` 并调用驱动 pause；再点回到 `speaking` 并调用 resume。
- **位置记忆**：停止在第 1 页第 2 句后重新开始，从第 2 句续读；关闭进程后用同一 userData 再启动，仍从第 2 句续读（`localStorage`）。
- **停止与末尾**：停止后 `idle`、高亮清空、调用 cancel；读完最后一页自动结束并清空高亮。
- **不串文档**：位置保存带 `docKey` 校验，切文档时不会把上一本的页码写到新文档。

## 已知限制

- 句级高亮、H/U 标注当前句与句序记忆只对 PDF 生效；富文档可以跨页连续朗读，但没有句级高亮。
- 朗读依赖系统语音；`not-allowed` / `synthesis-unavailable` / `audio-busy` 会停止并提示，其它错误会跳到下一句，避免卡死。
- 断句是启发式：英文缩写（如 `Dr.`）在句点后接空格时可能被误切；超长无标点段落会按 180 字硬切。
- 位置记忆存在本机 `localStorage`，不写入文献库、不参与备份；移动或重命名文件后按新路径重新记忆。
- 大文档逐句建 Range 的性能只在本机小样本上验证，未做长文档压力测试。

## 收尾

本轮修改了 `renderer.js`、`selection.js`、`styles.css`，新增 `test-reader-speech.js` 与 `probe-reader-speech.js`，同步 README、架构、开发文档、CHANGELOG 与版本号。未暂存、提交、推送，未重新打包或发布。
