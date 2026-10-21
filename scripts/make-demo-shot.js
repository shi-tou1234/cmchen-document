'use strict';
/*
 * 生成 README 用的界面截图（临时工具，不参与发布）。
 *   node scripts/make-demo-shot.js
 * 产物：docs/screenshot-library.png、docs/screenshot-reader.png
 *
 * 做法：造一份 4 页的演示 PDF + 一个含 7 条目的演示库，丢进临时 userData 启动真实 app，
 * 隐藏窗口跑探针，等界面稳定后 capturePage。不会碰用户自己的数据。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const DOCS = path.join(ROOT, 'docs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-shot-'));
const DEMO_PDF = path.join(TMP, 'demo-paper.pdf');
const LIB = path.join(TMP, 'library.json');
const UDD = path.join(TMP, 'ud');
fs.mkdirSync(UDD, { recursive: true });

const INK = rgb(0.11, 0.13, 0.18);
const MUTED = rgb(0.42, 0.45, 0.52);
const ACCENT = rgb(0.11, 0.32, 0.72);

async function makeDemoPdf(file) {
  const doc = await PDFDocument.create();
  doc.setTitle('Local-First Reading: A Demo Document');
  doc.setAuthor('Trove Demo');
  const serif = await doc.embedFont(StandardFonts.TimesRoman);
  const serifBold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const sans = await doc.embedFont(StandardFonts.Helvetica);

  const W = 595.28, H = 841.89, M = 64;
  const page1 = doc.addPage([W, H]);
  let y = H - 92;
  page1.drawText('Local-First Reading', { x: M, y, size: 26, font: serifBold, color: INK });
  y -= 44;
  page1.drawText('A demo document for Trove', { x: M, y, size: 15, font: serif, color: MUTED });
  y -= 40;
  page1.drawText('Trove Demo', { x: M, y, size: 12, font: sans, color: INK });
  y -= 16;
  page1.drawText('September 2026', { x: M, y, size: 10, font: sans, color: MUTED });
  y -= 46;
  page1.drawText('Abstract', { x: M, y, size: 14, font: serifBold, color: ACCENT });
  y -= 26;
  const abstract = [
    'This document exists to show how Trove renders, annotates and indexes a typical',
    'paper. Everything you see is local: the library, the annotations, the full-text',
    'index and the reading position all live in plain JSON files on this machine.',
    '',
    'The reader keeps the text layer selectable, remembers the page you stopped at,',
    'and exports a copy with your highlights burned into the page. Word, PowerPoint,',
    'Excel, Markdown and EPUB files go through the same reading surface.',
  ];
  for (const line of abstract) {
    if (line) page1.drawText(line, { x: M, y, size: 11.5, font: serif, color: INK });
    y -= 19;
  }
  y -= 18;
  page1.drawText('Keywords: local-first, document management, annotation', {
    x: M, y, size: 10, font: sans, color: MUTED,
  });
  page1.drawLine({ start: { x: M, y: M + 26 }, end: { x: W - M, y: M + 26 }, thickness: 0.7, color: rgb(0.8, 0.83, 0.88) });
  page1.drawText('1', { x: W / 2 - 3, y: M, size: 10, font: sans, color: MUTED });

  const page2 = doc.addPage([W, H]);
  y = H - 80;
  page2.drawText('1  Why local first', { x: M, y, size: 16, font: serifBold, color: INK });
  y -= 34;
  const p2 = [
    'A personal library is small enough to fit on one disk, but it is also the place',
    'where years of reading accumulate. Keeping it in a format you can read with a',
    'text editor is a feature, not a shortcut: it survives the app, the machine and',
    'the next rewrite of this software.',
    '',
    'Trove stores the library as one JSON file and each document annotation set as',
    'its own file keyed by the attachment path. Deleting an item never touches the',
    'PDF on disk. Exporting a backup copies settings, library and annotations; the',
    'full-text index is rebuildable and therefore stays out of the archive.',
    '',
    'The trade-off is scale. A few thousand items are comfortable; a hundred',
    'thousand are not. When that day comes, the data layer is small enough to move',
    'to SQLite without rewriting the reader.',
  ];
  for (const line of p2) {
    if (line) page2.drawText(line, { x: M, y, size: 11.5, font: serif, color: INK });
    y -= 19;
  }
  y -= 26;
  page2.drawRectangle({ x: M, y: y - 74, width: W - M * 2, height: 86, color: rgb(0.96, 0.97, 0.99) });
  page2.drawText('Design note', { x: M + 16, y: y - 8, size: 11, font: sans, color: ACCENT });
  page2.drawText('Every delete entry point only edits the index.', { x: M + 16, y: y - 30, size: 11, font: serif, color: INK });
  page2.drawText('The file on disk is never removed by the app.', { x: M + 16, y: y - 48, size: 11, font: serif, color: INK });
  page2.drawText('2', { x: W / 2 - 3, y: M, size: 10, font: sans, color: MUTED });

  const page3 = doc.addPage([W, H]);
  y = H - 80;
  page3.drawText('2  Reading surface', { x: M, y, size: 16, font: serifBold, color: INK });
  y -= 34;
  const p3 = [
    'PDF pages are rendered lazily: only the pages near the viewport keep a bitmap,',
    'so a 1200-page manual scrolls without exhausting memory. The text layer is laid',
    'over the canvas, which makes selection, search and excerpting behave like text',
    'even though the page itself is an image.',
    '',
    'Annotations are vectors drawn on an SVG layer above the page. They survive',
    'zoom, re-render and page recycling, and they can be exported as Markdown, CSV',
    'or a PDF copy with the marks burned in.',
  ];
  for (const line of p3) {
    if (line) page3.drawText(line, { x: M, y, size: 11.5, font: serif, color: INK });
    y -= 19;
  }
  y -= 20;
  page3.drawText('Page 3 of the demo document. Try selecting this sentence.', {
    x: M, y, size: 11.5, font: serif, color: ACCENT,
  });
  page3.drawText('3', { x: W / 2 - 3, y: M, size: 10, font: sans, color: MUTED });

  fs.writeFileSync(file, await doc.save());
}

function seedLibrary() {
  const items = [
    ['知识库', '面向个人知识库的本地全文检索方法', 'journalArticle', '张三', '2024', '情报学报', ['检索', '本地优先'], ['papers'], '梳理倒排索引与子串匹配在万级文档下的取舍，并给出一套可重建的索引格式。'],
    ['知识库', '文档标注数据的增量持久化设计', 'conferencePaper', '李四', '2023', '人机交互会议', ['标注', '存储'], ['papers'], '讨论按页增量写入、崩溃恢复与多标签页并发保存时的冲突处理。'],
    ['工程', '阅读器渲染性能优化笔记', 'report', '王五', '2025', '', ['渲染', '性能'], ['notes'], '懒渲染、位图回收与缩放不跳页的实测记录，含 1200 页手册的滚动数据。'],
    ['工程', '多格式文档转换中的安全边界', 'journalArticle', '赵六', '2024', '软件学报', ['安全', '格式'], ['papers', 'notes'], 'Word / PPT / EPUB 转 HTML 时的脚本剥离、远程图片与内联资源策略。'],
    ['待读', '离线优先的文献库架构', 'preprint', '陈七', '2026', 'arXiv', ['架构', '本地优先'], ['inbox'], '单文件库、附件路径哈希与备份恢复的边界条件。'],
    ['待读', '用户阅读行为与页码记忆', 'thesis', '周八', '2022', '某大学', ['阅读', '交互'], ['inbox'], '研究阅读中断后回到原页的预期，以及页码记忆失败的常见原因。'],
    ['工程', 'Zotero 交互模式调研', 'webpage', 'Trove', '2026', '', ['交互'], ['notes'], '单击选中、双击打开、右键菜单、多选与键盘导航的行为清单。'],
  ];
  const collections = [
    { id: 'papers', name: '论文', parentId: null },
    { id: 'notes', name: '工程笔记', parentId: null },
    { id: 'inbox', name: '待读', parentId: null },
  ];
  const now = Date.now();
  const data = {
    version: 5,
    collections,
    searches: [],
    tagColors: { '本地优先': '#2f6fd0', '检索': '#2f9e6f', '渲染': '#b06a1f' },
    items: items.map((it, i) => ({
      key: 'demo' + (i + 1),
      itemType: it[2],
      title: it[1],
      creators: [it[3]],
      year: it[4],
      publication: it[5],
      volume: '', issue: '', pages: it[2] === 'journalArticle' ? '45-67' : '',
      doi: '', url: '', abstract: it[8], note: '',
      language: 'zh', tags: it[6], collectionIds: it[7],
      attachment: { path: DEMO_PDF, name: 'demo-paper.pdf' },
      page: it[0] === '知识库' ? 2 : 1,
      created: now - i * 86400000,
      updated: now - i * 86400000,
      deletedAt: 0,
    })),
  };
  fs.writeFileSync(LIB, JSON.stringify(data, null, 2));
}

const LIB_PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(50); } return false; };
  await waitFor(() => document.querySelectorAll('#lib-grid .lib-card').length > 0, 8000);
  await sleep(300);
  const first = document.querySelector('#lib-grid .lib-card');
  if (first) { first.click(); await sleep(500); }
  await sleep(700);
  return { cards: document.querySelectorAll('#lib-grid .lib-card').length };
})()`;

const READER_PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    if (App.state.mode === 'pdf' && App.state.rendered.get(1)) break;
    await sleep(100);
  }
  // 整页视图：README 里能一眼看到版心和标注位置
  const sel = document.querySelector('#scale-select');
  if (sel) { sel.value = 'page-fit'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  // 等 restoreAnnos 的异步加载落地，否则注入的标注会被空集合覆盖
  await sleep(1500);
  // 两条文字高亮：rects 用「scale=1 的页面像素」（= PDF 点），左上原点
  App.state.annos.set(1, [
    { tool: 'mark', color: '#ffd84d', rects: [{ x: 64, y: 264, w: 392, h: 15 }], text: '本地、可读、可迁移' },
    { tool: 'mark', color: '#ffd84d', rects: [{ x: 64, y: 283, w: 462, h: 15 }], text: '页码记忆与索引' },
  ]);
  if (window.Anno && Anno.renderPage) Anno.renderPage(1);
  if (App.scrollToPage) App.scrollToPage(1, true);
  await sleep(900);
  return { page: App.state.currentPage, pages: App.state.numPages, rendered: !!App.state.rendered.get(1), scale: App.state.scale };
})()`;

function launch(probeName, probeSrc, extraEnv) {
  const probeFile = path.join(TMP, probeName + '.js');
  fs.writeFileSync(probeFile, 'module.exports = ' + JSON.stringify(probeSrc) + ';');
  const env = Object.assign({}, process.env, {
    PDFREADER_PROBE: probeFile,
    PDFREADER_LIBRARY: LIB,
    PDFREADER_NO_AUTO_INDEX: '1',
  }, extraEnv);
  delete env.ELECTRON_RUN_AS_NODE;
  const out = execFileSync(ELECTRON, ['.', '--no-sandbox', '--disable-gpu', '--user-data-dir=' + UDD], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 120000,
  });
  const line = String(out).split(/\r?\n/).find((l) => l.includes('[probe-result]'));
  console.log('  ' + (line || '(no probe result)'));
}

(async () => {
  fs.mkdirSync(DOCS, { recursive: true });
  await makeDemoPdf(DEMO_PDF);
  seedLibrary();
  fs.writeFileSync(path.join(UDD, 'window-state.json'),
    JSON.stringify({ width: 1440, height: 900, x: 80, y: 60 }));

  console.log('[shot] library');
  launch('lib-shot', LIB_PROBE, {
    PDFREADER_LIBUI: '1',
    PDFREADER_PROBE_SHOT: path.join(DOCS, 'screenshot-library.png'),
  });

  console.log('[shot] reader');
  const readerPdf = path.join(TMP, 'demo-paper-reader.pdf');
  fs.copyFileSync(DEMO_PDF, readerPdf);
  launch('reader-shot', READER_PROBE, {
    PDFREADER_PROBE_PDF: readerPdf,
    PDFREADER_PROBE_SHOT: path.join(DOCS, 'screenshot-reader.png'),
  });

  for (const f of ['screenshot-library.png', 'screenshot-reader.png']) {
    const st = fs.statSync(path.join(DOCS, f));
    console.log('[shot] ' + f + ' ' + Math.round(st.size / 1024) + ' KB');
  }
})().catch((e) => { console.error(e); process.exit(1); });
