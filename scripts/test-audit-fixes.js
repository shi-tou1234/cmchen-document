'use strict';
/*
 * 审核报告（B01–B12）与复查报告（R01–R04）的修复回归。
 *
 * 这里只放「纯逻辑 / 受控时序」部分，真实 Electron 的界面与几何检查分别在：
 *   B06 列表列位  → scripts/test-reading-progress.js
 *   B07/R02 对开位图与快速跳页 → scripts/test-two-page.js
 *   B08 富文档对开 → scripts/probe-richdoc.js（test-richdoc.js 驱动）
 *   B09 跨页反查  → scripts/test-smart-jump.js
 *
 * 约定（R04）：
 *   - 全部检查在同一个 async 入口里 await 完成后才汇总，绝不允许先打印 PASS 再退出；
 *   - 断言只收集不抛出，一段失败不影响后面几段，最终由失败条数决定退出码；
 *   - 被提取的 renderer.js 片段需要 window 替身（原函数里有 window.pdfBridge 判断）。
 *
 * 运行：node scripts/test-audit-fixes.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const results = [];
function ok(name, cond, detail) {
  results.push([name, !!cond, detail === undefined ? '' : String(detail)]);
  return !!cond;
}
function eq(name, actual, expected, detail) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  return ok(name, a === b, (detail ? detail + ' ' : '') + a);
}
function section(name, fn) {
  try { fn(); } catch (e) {
    ok('[' + name + '] 未抛错', false, e && e.message ? e.message : String(e));
  }
}
async function sectionAsync(name, fn) {
  try { await fn(); } catch (e) {
    ok('[' + name + '] 未抛错', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  }
}

// ---------- B01 / B03 / R01：书签的请求归属、串行提交与失败回滚 ----------
// 直接取 src/renderer/renderer.js 里的真实实现（不复制一份逻辑），用可延迟 / 可失败的
// IPC 替身驱动。切这段源码做时序验证是复查报告也采用的方式，所以渲染层保持
// 「状态声明在前、App.bookmarkToggle 赋值在末尾」的结构。
function loadBookmarkToggle() {
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/renderer.js'), 'utf8');
  const start = src.indexOf('// ---------- 用户书签');
  const end = src.indexOf('App.bookmarkToggle = bookmarkToggle;');
  if (start < 0 || end < 0 || end <= start) throw new Error('无法从 renderer.js 提取 bookmarkToggle');
  const block = src.slice(start, end);
  return new Function('App', 'pdfBridge', 'hasDoc', 'toast', 'renderBookmarks', 'initialSeq', 'window', `
    let loadSeq = initialSeq;
    ${block}
    return { toggle: bookmarkToggle, setSeq: (n) => { loadSeq = n; }, seq: () => loadSeq };
  `);
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const hasDoc = (s) => !!(s.pdfDoc || (s.richPages && s.richPages.length));

function bookmarkEnv(opts) {
  const o = opts || {};
  const app = {
    state: {
      pdfDoc: {}, numPages: 10, currentPage: 1,
      filePath: o.path || 'A.pdf',
      bookmarks: (o.bookmarks || []).slice(),
      bookmarksReady: o.bookmarksReady || null,
    },
  };
  const toasts = [];
  const pdfBridge = { bookmarksSave: o.save };
  const factory = loadBookmarkToggle();
  const env = factory(app, pdfBridge, hasDoc, (t) => toasts.push(t), () => {}, o.seq || 1, { pdfBridge });
  return { app, toasts, env };
}

async function bookmarks() {
  // 1) B01：A 的迟到回包不能写进 B
  await sectionAsync('B01', async () => {
    let release = null;
    const save = (p, list) => new Promise((res) => { release = () => res({ ok: true, bookmarks: list.slice() }); });
    const { app, env } = bookmarkEnv({ bookmarks: [{ page: 1, at: 1, label: '' }], save });
    const pending = env.toggle(2);
    await tick();
    ok('B01 保存期间内存未被提前改写', app.state.bookmarks.length === 1 && app.state.bookmarks[0].page === 1, JSON.stringify(app.state.bookmarks));
    app.state.filePath = 'B.pdf'; app.state.bookmarks = []; env.setSeq(6);
    release();
    await pending;
    eq('B01 迟到回包不污染新文档', app.state.bookmarks, []);
  });

  // 2) B03：单次保存失败不回滚
  await sectionAsync('B03', async () => {
    const { app, toasts, env } = bookmarkEnv({
      bookmarks: [{ page: 1, at: 1, label: '' }],
      save: async () => ({ ok: false, error: 'disk full' }),
    });
    const r = await env.toggle(2);
    ok('B03 失败返回 ok:false', r && r.ok === false, JSON.stringify(r));
    eq('B03 失败后内存书签不变', app.state.bookmarks.map((b) => b.page), [1]);
    ok('B03 失败有可见提示', toasts.some((t) => /书签保存失败/.test(t) && /可重试/.test(t)), toasts.join(' | '));
  });

  // 3) B03：失败后重试是「重新添加」，不是被当成已存在去删除
  await sectionAsync('B03-retry', async () => {
    let failNext = true;
    const { app, env } = bookmarkEnv({
      save: async (p, list) => (failNext ? { ok: false, error: 'disk full' } : { ok: true, bookmarks: list.slice() }),
    });
    await env.toggle(2);
    eq('B03 首次失败没有留下脏状态', app.state.bookmarks, []);
    failNext = false;
    await env.toggle(2);
    eq('B03 恢复后重试成功添加', app.state.bookmarks.map((b) => b.page), [2]);
  });

  // 4) B03：IPC 直接抛异常
  await sectionAsync('B03-throw', async () => {
    const { app, env } = bookmarkEnv({
      bookmarks: [{ page: 1, at: 1, label: '' }],
      save: () => { throw new Error('ipc broken'); },
    });
    const r = await env.toggle(2);
    ok('B03 IPC 抛异常被接住', r && r.ok === false && /ipc broken/.test(r.error || ''), JSON.stringify(r));
    eq('B03 IPC 异常后内存不变', app.state.bookmarks.map((b) => b.page), [1]);
  });

  // 5) R01：并发添加不同页，两次都要保留
  await sectionAsync('R01-add-both', async () => {
    const calls = [];
    const { app, env } = bookmarkEnv({
      save: async (p, list) => { calls.push(list.map((b) => b.page)); return { ok: true, bookmarks: list.slice() }; },
    });
    await Promise.all([env.toggle(2), env.toggle(3)]);
    eq('R01 并发添加两页都保留', app.state.bookmarks.map((b) => b.page), [2, 3]);
    eq('R01 落盘依次叠加（不是各写各的）', calls, [[2], [2, 3]]);
  });

  // 6) R01：同页连续 toggle 两次 = 加 + 删
  await sectionAsync('R01-toggle-twice', async () => {
    const calls = [];
    const { app, env } = bookmarkEnv({
      save: async (p, list) => { calls.push(list.map((b) => b.page)); return { ok: true, bookmarks: list.slice() }; },
    });
    await Promise.all([env.toggle(2), env.toggle(2)]);
    eq('R01 同页连按两次回到空', app.state.bookmarks, []);
    eq('R01 两次操作按顺序落盘', calls, [[2], []]);
  });

  // 7) R01：先成功后失败，内存与磁盘一致（保留成功的第 2 页）
  await sectionAsync('R01-ok-then-fail', async () => {
    let n = 0;
    const saved = [];
    const { app, toasts, env } = bookmarkEnv({
      save: async (p, list) => {
        n++;
        if (n === 1) { saved.push(list.map((b) => b.page)); return { ok: true, bookmarks: list.slice() }; }
        return { ok: false, error: 'disk full' };
      },
    });
    await Promise.all([env.toggle(2), env.toggle(3)]);
    eq('R01 成功后失败：内存保留成功的那条', app.state.bookmarks.map((b) => b.page), [2]);
    eq('R01 成功后失败：磁盘内容与内存一致', saved[saved.length - 1], [2]);
    ok('R01 成功后失败：失败的那页有提示', toasts.some((t) => /第 3 页/.test(t) && /失败/.test(t)), toasts.join(' | '));
  });

  // 8) R01：先失败后成功，成功的那条要留下
  await sectionAsync('R01-fail-then-ok', async () => {
    let n = 0;
    const { app, env } = bookmarkEnv({
      save: async (p, list) => {
        n++;
        return n === 1 ? { ok: false, error: 'disk full' } : { ok: true, bookmarks: list.slice() };
      },
    });
    await Promise.all([env.toggle(2), env.toggle(3)]);
    eq('R01 失败后成功：只保留成功的那条', app.state.bookmarks.map((b) => b.page), [3]);
  });

  // 9) R01：串行化 —— 第二次保存必须等第一次返回后才开始
  await sectionAsync('R01-serialized', async () => {
    const order = [];
    let releaseFirst = null;
    let n = 0;
    const { app, env } = bookmarkEnv({
      save: (p, list) => {
        n++;
        const id = n;
        order.push('start' + id);
        if (id === 1) return new Promise((res) => { releaseFirst = () => { order.push('end1'); res({ ok: true, bookmarks: list.slice() }); }; });
        order.push('end2');
        return Promise.resolve({ ok: true, bookmarks: list.slice() });
      },
    });
    const a = env.toggle(2);
    const b = env.toggle(3);
    await tick(); await tick();
    eq('R01 第二次保存不会与第一次并行', order, ['start1']);
    releaseFirst();
    await Promise.all([a, b]);
    eq('R01 两次保存严格串行', order, ['start1', 'end1', 'start2', 'end2']);
    eq('R01 串行后两页都在', app.state.bookmarks.map((b2) => b2.page), [2, 3]);
  });

  // 10) R01：书签还在读盘时按 B，不能用空数组覆盖磁盘上的书签
  await sectionAsync('R01-wait-load', async () => {
    let resolveLoad = null;
    const ready = new Promise((res) => { resolveLoad = res; });
    const { app, env } = bookmarkEnv({ bookmarks: [], bookmarksReady: ready, save: async (p, list) => ({ ok: true, bookmarks: list.slice() }) });
    const pending = env.toggle(2);
    await tick();
    eq('R01 读盘未完成时不提交空数组', app.state.bookmarks, []);
    app.state.bookmarks = [{ page: 1, at: 1, label: '' }];   // 模拟 restoreAnnos 读完
    resolveLoad();
    await pending;
    eq('R01 读盘完成后保留磁盘已有书签', app.state.bookmarks.map((b) => b.page), [1, 2]);
  });

  // 11) R05：切到别的文档后，旧队列里还没发送的任务必须取消，不能继续写盘
  await sectionAsync('R05-switch-away', async () => {
    const calls = [];
    let releaseFirst = null;
    const save = (p, list) => {
      calls.push(list.map((b) => b.page));
      if (calls.length === 1) return new Promise((res) => { releaseFirst = () => res({ ok: true, bookmarks: list.slice() }); });
      return Promise.resolve({ ok: true, bookmarks: list.slice() });
    };
    const { app, env } = bookmarkEnv({ path: 'A.pdf', save });
    const p2 = env.toggle(2);
    await tick();
    const p3 = env.toggle(3);
    await tick();
    app.state.filePath = 'B.pdf'; app.state.bookmarks = []; env.setSeq(2);   // 切到 B
    releaseFirst();
    const r3 = await p3;
    await p2;
    eq('R05 切走后旧队列不再写盘', calls, [[2]]);
    ok('R05 被取消的任务有明确结果', r3 && r3.canceled === true, JSON.stringify(r3));
    eq('R05 新文档书签不受影响', app.state.bookmarks, []);
  });

  // 12) R05：A→B→A，新代际已保存成功后，旧队列不得覆盖
  await sectionAsync('R05-reopen', async () => {
    const calls = [];
    let releaseFirst = null;
    const save = (p, list) => {
      calls.push(list.map((b) => b.page));
      if (calls.length === 1) return new Promise((res) => { releaseFirst = () => res({ ok: true, bookmarks: list.slice() }); });
      return Promise.resolve({ ok: true, bookmarks: list.slice() });
    };
    const { app, env } = bookmarkEnv({ path: 'A.pdf', save });
    const p2 = env.toggle(2);            // [2] 已发往磁盘，回复被暂缓
    await tick();
    const p3 = env.toggle(3);            // 排在旧队列里
    await tick();
    // 切到 B，再重新打开 A：新代际从磁盘读到 [2]
    app.state.filePath = 'B.pdf'; app.state.bookmarks = []; env.setSeq(2);
    app.state.filePath = 'A.pdf'; app.state.bookmarks = [{ page: 2, at: 1, label: '' }]; env.setSeq(3);
    const p4 = env.toggle(4);            // 新代际，排在同一条链后面
    await tick();
    releaseFirst();                      // 放行旧队列第一个回复
    await Promise.all([p2, p3, p4]);
    eq('R05 旧队列的待执行任务被取消', calls, [[2], [2, 4]]);
    eq('R05 新代际结果不被覆盖', app.state.bookmarks.map((b) => b.page), [2, 4]);
  });

  // 13) R05：关闭文档后，队列里的任务不再写盘
  await sectionAsync('R05-closed', async () => {
    const calls = [];
    let releaseFirst = null;
    const save = (p, list) => {
      calls.push(list.map((b) => b.page));
      if (calls.length === 1) return new Promise((res) => { releaseFirst = () => res({ ok: true, bookmarks: list.slice() }); });
      return Promise.resolve({ ok: true, bookmarks: list.slice() });
    };
    const { app, env } = bookmarkEnv({ path: 'A.pdf', save });
    const p2 = env.toggle(2);
    await tick();
    const p3 = env.toggle(3);
    await tick();
    app.state.pdfDoc = null; app.state.filePath = ''; app.state.bookmarks = []; env.setSeq(4);   // 关闭文档
    releaseFirst();
    await Promise.all([p2, p3]);
    eq('R05 关闭后不再产生新写入', calls, [[2]]);
  });
}

// ---------- B02：合并数据目录要带上订阅 ----------
function mergeFeeds() {
  const L = require('../src/library.js');
  const base = { items: [], feeds: [{ id: 'f1', url: 'https://a.example/rss', title: 'A 源', addedAt: 200 }] };
  const inc = {
    items: [],
    feeds: [
      { id: 'f2', url: 'https://b.example/rss', title: 'B 源', addedAt: 100 },
      { id: 'f1', url: 'https://a.example/rss', title: 'A 源（重复）', addedAt: 50 },
      { id: 'f2', url: 'https://c.example/rss', title: 'C 源', addedAt: 300 },
    ],
  };
  const merged = L.combineStores(base, inc);
  const urls = merged.feeds.map((f) => f.url).sort();
  eq('B02 合并保留双边订阅且按 URL 去重', urls, [
    'https://a.example/rss', 'https://b.example/rss', 'https://c.example/rss',
  ]);
  const ids = merged.feeds.map((f) => f.id);
  ok('B02 合并后订阅 ID 唯一', new Set(ids).size === ids.length, ids.join(','));
  const a = merged.feeds.find((f) => f.url === 'https://a.example/rss');
  ok('B02 同 URL 时保留当前库标题', a && a.title === 'A 源', a && a.title);
  ok('B02 同 URL 时 addedAt 取更早', a && a.addedAt === 50, a && a.addedAt);
  const c = merged.feeds.find((f) => f.url === 'https://c.example/rss');
  ok('B02 同 ID 不同 URL 重新分配 ID', c && c.id !== 'f2', c && c.id);

  const merged2 = L.combineStores(
    { items: [], feeds: [{ id: 'x', url: 'https://d.example/rss', title: 'https://d.example/rss', addedAt: 0 }] },
    { items: [], feeds: [{ id: 'y', url: 'https://d.example/rss', title: 'D 期刊', addedAt: 0 }] }
  );
  ok('B02 占位标题被可读标题替换', merged2.feeds.length === 1 && merged2.feeds[0].title === 'D 期刊', JSON.stringify(merged2.feeds));
  eq('B02 合并结果可重复归一化', L.combineStores(merged, { items: [] }).feeds.map((f) => f.url).sort(), urls);
}

// ---------- B04 / R03：EndNote XML 的文本内容 ----------
function endnoteXml() {
  const F = require('../src/formats.js');
  const rec = (titleXml) => F.parseEndNoteXml('<xml><records><record><titles><title>' + titleXml + '</title></titles></record></records></xml>')[0].title;

  // B04：内联样式不是正文
  eq('B04 样式包装的标题取文本', rec('<style face="normal">Example Paper</style>'), 'Example Paper');
  eq('B04 多层样式与斜体', rec('<style face="normal"><i>Deep</i> Work</style>'), 'Deep Work');
  eq('B04 实体解码仍正常', rec('Deep &amp; Learning &lt;methods&gt;'), 'Deep & Learning <methods>');
  eq('B04 纯 CDATA 原样', rec('<![CDATA[use x < y & z]]>'), 'use x < y & z');

  // R03：普通文本与 CDATA 混排，边界空白必须保留
  eq('R03 混合 CDATA 保留分隔空格', rec('Before <![CDATA[Middle]]> After'), 'Before Middle After');
  eq('R03 混合 CDATA 里的尖括号不丢', rec('Alpha <![CDATA[<Beta>]]> Gamma'), 'Alpha <Beta> Gamma');
  eq('R03 紧邻拼接不加多余空格', rec('pre<![CDATA[fix]]>'), 'prefix');
  eq('R03 CDATA 内实体不解码', rec('<![CDATA[a &amp; b]]>'), 'a &amp; b');
  eq('R03 多段 CDATA 与文本混排', rec('a<![CDATA[, b]]>c<![CDATA[ d]]>'), 'a, bc d');

  const full = F.parseEndNoteXml(`<?xml version="1.0" encoding="UTF-8"?><xml><records>
<record>
  <ref-type name="Book Section">5</ref-type>
  <titles><title><style face="normal">Example Paper</style></title>
    <secondary-title><style face="italic">J. Tests</style></secondary-title></titles>
  <contributors><authors><author><style face="normal">Smith</style>, John</author>
    <author><style face="normal"><i>Doe</i></style>, Jane</author></authors></contributors>
  <year>2021</year>
  <electronic-resource-num><style face="normal">10.1234/style</style></electronic-resource-num>
  <urls><related-urls><url><style face="normal">https://example.org/s</style></url></related-urls></urls>
  <abstract><![CDATA[use x < y & z]]></abstract>
  <publisher>A &amp; B</publisher>
</record>
<record>
  <ref-type name='Journal Article'>17</ref-type>
  <titles><title>Single quoted type</title></titles>
</record>
</records></xml>`)[0];
  eq('B04 样式包装的期刊取文本', full.publication, 'J. Tests');
  eq('B04 样式包装的作者姓名拆分正确', full.creators.map((c) => c.lastName + '/' + c.firstName), ['Smith/John', 'Doe/Jane']);
  eq('B04 样式包装的 DOI 取文本', full.doi, '10.1234/style');
  eq('B04 样式包装的 URL 取文本', full.url, 'https://example.org/s');
  eq('B04 Book Section 映射为图书章节', full.itemType, 'bookSection');
  eq('B04 单引号属性也能识别类型',
    F.parseEndNoteXml('<xml><records><record><ref-type name=\'Journal Article\'>17</ref-type><titles><title>T</title></titles></record></records></xml>')[0].itemType,
    'journalArticle');
}

// ---------- B05：条件构建器往返不能改变查询含义 ----------
function queryBuilder() {
  const Q = require('../src/query.js');
  const same = (a, b) => JSON.stringify(Q.parseQuery(a).tree) === JSON.stringify(Q.parseQuery(b).tree);

  for (const q of [
    'author:Smith year:2024',
    '"machine learning" -survey',
    'title:"machine learning" AND -tag:survey',
    'creator:Smith',
    '-note:草稿',
  ]) {
    const out = Q.buildQuery(Q.parseQueryToRows(q));
    ok('B05 往返语义等价：' + q, same(q, out), q + ' → ' + out);
  }
  for (const q of ['title:alpha OR title:beta', 'a OR (b AND c)', 'title:"未闭合', 'a | b']) {
    const rows = Q.parseQueryToRows(q);
    ok('B05 复杂语法标记为原串：' + q, rows.length === 1 && rows[0].raw === true, JSON.stringify(rows));
    eq('B05 原串原样返回：' + q, Q.buildQuery(rows), q);
  }
  const rows = [{ field: 'note', op: 'contains', value: 'a "quoted" word' }];
  eq('B05 含引号的值可往返', Q.parseQueryToRows(Q.buildQuery(rows)), rows, Q.buildQuery(rows));
  eq('B05 字段别名归一', Q.parseQueryToRows('creator:Smith'), [{ field: 'author', op: 'contains', value: 'Smith' }]);
  eq('B05 隐式 AND 拆成两行', Q.parseQueryToRows('author:Smith year:2024'), [
    { field: 'author', op: 'contains', value: 'Smith' },
    { field: 'year', op: 'contains', value: '2024' },
  ]);
  eq('B05 值里的冒号被引号保护', Q.buildQuery([{ field: '', op: 'contains', value: 'title:x' }]), '"title:x"');
  eq('B05 以减号开头的值被引号保护', Q.buildQuery([{ field: '', op: 'contains', value: '-x' }]), '"-x"');
}

// ---------- B10：智能跳转组行下标 ----------
function smartJumpLines() {
  const SJ = require('../src/smartjump.js');
  const items = [1, 3, 4, 2].map((n) => ({ str: String(n), x: n * 30, y: 700, w: 10, fh: 10 }));
  const rows = SJ.buildLines(items);
  eq('B10 组行文字按视觉顺序拼装', rows.map((r) => r.text), ['1234']);
  eq('B10 组行 idx 仍指向原始输入', rows[0].idx, [0, 3, 1, 2]);

  const split = [
    { str: '2]', x: 60, y: 700, w: 12, fh: 10 },
    { str: 'see [1', x: 10, y: 700, w: 40, fh: 10 },
  ];
  const r2 = SJ.buildLines(split);
  eq('B10 跨文本项引用标记拼回原样', r2.map((x) => x.text), ['see [12]']);
  const cite = SJ.extractCitation(r2[0].text, 5);
  ok('B10 拼好的标记可被识别', cite && cite.numbers.join() === '12', JSON.stringify(cite));
}

// ---------- B11：Atom 属性引号 / 命名空间 ----------
function atomLinks() {
  const F = require('../src/feedparse.js');
  const one = (xml) => F.parseFeed(xml).entries[0];

  let e = one(`<feed><title>T</title><entry><title>Paper</title><id>urn:uuid:abc</id>`
    + `<link rel='alternate' href='https://example.org/paper'/></entry></feed>`);
  eq('B11 单引号 href 被识别', e.url, 'https://example.org/paper');
  eq('B11 非 URL 的 id 单独保留', e.id, 'urn:uuid:abc');

  e = one(`<feed><title>T</title><entry><title>P</title>`
    + `<link rel="self" href="https://e.org/self"/><link rel="alternate" href="https://e.org/paper"/></entry></feed>`);
  eq('B11 alternate 优先于 self', e.url, 'https://e.org/paper');

  e = one(`<feed><title>T</title><entry><title>P</title><link rel="enclosure" href="https://e.org/pdf"/></entry></feed>`);
  eq('B11 只有 enclosure 时兜底使用', e.url, 'https://e.org/pdf');

  e = one(`<feed><title>T</title><entry><title>P</title><link href="https://e.org/plain"/></entry></feed>`);
  eq('B11 无 rel 的链接可用', e.url, 'https://e.org/plain');

  const ns = F.parseFeed(`<atom:feed xmlns:atom="http://www.w3.org/2005/Atom"><atom:title>NS 源</atom:title>`
    + `<atom:entry><atom:title>NS 文章</atom:title>`
    + `<atom:link rel='alternate' href='https://e.org/ns'/></atom:entry></atom:feed>`);
  eq('B11 命名空间前缀可解析', [ns.kind, ns.title, ns.entries[0].title, ns.entries[0].url],
    ['atom', 'NS 源', 'NS 文章', 'https://e.org/ns']);

  e = one(`<feed><title>T</title><entry><title>P</title><id>urn:uuid:only-id</id></entry></feed>`);
  eq('B11 只有 id 时 hasLink 为 false', [e.hasLink, e.url], [false, 'urn:uuid:only-id']);
}

// ---------- B12：统计面板的年份口径 ----------
function libStats() {
  const S = require('../src/libstats.js');
  const y = new Date().getFullYear();
  const st = S.compute([
    { key: 'a', year: '2000', created: Date.now() },
    { key: 'b', year: String(y), created: 0 },
    { key: 'c', year: '', created: Date.now() },
  ]);
  const pub = Object.fromEntries(st.byYear.map((r) => [r.year, r.count]));
  const cre = Object.fromEntries(st.byCreated.map((r) => [r.year, r.count]));
  ok('B12 出版年份仍按条目 year 分桶', pub['更早'] === 1 && pub[String(y)] === 1 && pub['未知'] === 1, JSON.stringify(pub));
  ok('B12 入库年份按 created 分桶', cre[String(y)] === 2 && cre['未知'] === 1, JSON.stringify(cre));
  ok('B12 老文献今天导入：出版更早 / 入库今年', pub['更早'] === 1 && cre[String(y)] === 2, JSON.stringify({ pub, cre }));
}

async function main() {
  const before = results.length;
  await sectionAsync('bookmarks', bookmarks);
  ok('书签时序用例确实执行了（R04）', results.length > before, 'checks=' + (results.length - before));
  section('mergeFeeds', mergeFeeds);
  section('endnoteXml', endnoteXml);
  section('queryBuilder', queryBuilder);
  section('smartJumpLines', smartJumpLines);
  section('atomLinks', atomLinks);
  section('libStats', libStats);
}

main().then(() => {
  const failed = results.filter((r) => !r[1]);
  for (const [name, pass, detail] of results) {
    if (!pass) console.log('  FAIL ' + name + (detail ? '  <- ' + detail : ''));
  }
  console.log('[audit-fixes] ' + (results.length - failed.length) + '/' + results.length + (failed.length ? ' FAIL' : ' PASS'));
  process.exitCode = failed.length ? 1 : 0;
}).catch((err) => {
  console.error('[audit-fixes] ERROR', err && err.stack ? err.stack : err);
  process.exitCode = 2;
});
