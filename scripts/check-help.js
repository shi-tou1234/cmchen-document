'use strict';
/*
 * 使用指南的「覆盖度对账」脚本 —— 防止界面加了按钮、说明却没跟上。
 *
 * 做三件事：
 *  1. 结构检查：topic id 唯一、必填字段齐、相关链接指向真实存在的节、
 *     action 指向 help.js 里真有的动作、ui 选择器在 index.html 里存在。
 *  2. 归属检查（硬失败）：index.html 里每个按钮 / 输入框 / 下拉框，
 *     都必须在下面 CONTROLS 里登记「由哪一节负责说明」；新加控件忘了登记就报错。
 *  3. 证据检查（提示）：被登记的控件，其 id、可见文字或 title 应当出现在
 *     那一节的正文里 —— 说明真的写了它，而不只是登记了一下。
 *
 * 运行：node scripts/check-help.js   （加 --strict 让提示也变成失败）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
const HELP_JS = fs.readFileSync(path.join(ROOT, 'src/renderer/help.js'), 'utf8');
const guide = require(path.join(ROOT, 'src/help-content.js'));

/* ---------- 控件 → 负责说明它的那一节 ---------- */
const CONTROLS = {
  // 打开 / 视图 / 工具栏
  'btn-library': 'ui-tour', 'lib-back': 'ui-tour', 'btn-sidebar': 'read-sidebar',
  'btn-open': 'open-file', 'file-name': 'open-file', 'btn-help': 'help-center',
  'lib-help': 'help-center', 'set-help': 'help-center', 'hint-help': 'help-center',
  'empty-help-btn': 'help-center', 'help-search': 'help-center', 'help-prev': 'help-center',
  'help-next': 'help-center', 'help-x': 'help-center',
  'btn-zoom-out': 'read-zoom', 'btn-zoom-in': 'read-zoom', 'scale-select': 'read-zoom',
  'btn-prev': 'read-views', 'btn-next': 'read-views', 'page-input': 'read-views', 'btn-spread': 'read-views',
  'btn-speak': 'read-speech', 'btn-speak-stop': 'read-speech',
  'btn-print': 'read-output',
  'btn-rotate-left': 'read-rotate', 'btn-rotate-right': 'read-rotate',
  'btn-split': 'read-split', 'ref-prev': 'read-split', 'ref-next': 'read-split',
  'ref-page': 'read-split', 'ref-follow': 'read-split', 'ref-pick': 'read-split', 'ref-close': 'read-split',
  'ref-picker-q': 'read-split', 'ref-picker-same': 'read-split',
  'ref-picker-x': 'read-split', 'ref-picker-close': 'read-split',
  'portal-cand': 'read-overview', 'overview-x': 'read-overview', 'overview-close': 'read-overview',
  'overview-q': 'read-overview',
  'btn-reflow': 'read-reflow', 'reflow-size': 'read-reflow', 'reflow-width': 'read-reflow',
  'reflow-close': 'read-reflow',
  'btn-ruler': 'read-ruler',
  'search-box': 'search-doc',

  // 标注
  'more-btn': 'draw-tools', 'note-color': 'draw-tools', 'note-width': 'draw-tools',
  'btn-undo': 'edit-anno', 'btn-clear-page': 'edit-anno',
  'btn-archive': 'anno-export', 'btn-save': 'anno-export',
  'text-editor': 'text-note', 'sel-color': 'anno-select',
  'comment-text': 'comments', 'comment-save': 'comments', 'comment-cancel': 'comments', 'comment-x': 'comments',
  'anno-edit-text': 'edit-anno', 'anno-edit-comment': 'edit-anno', 'anno-edit-color': 'edit-anno',
  'anno-edit-save': 'edit-anno', 'anno-edit-cancel': 'edit-anno', 'anno-edit-x': 'edit-anno',

  // 文献库：列表与条目
  'lib-sort': 'lib-list', 'lib-select-all': 'lib-list',
  'lib-new-coll': 'collections', 'lib-save-search': 'smart-coll',
  'lib-undo': 'undo', 'lib-redo': 'undo',
  'lib-dup': 'dup', 'dup-close': 'dup', 'dup-close2': 'dup',
  'lib-import-refs': 'refio', 'lib-export-refs': 'refio',
  'lib-bib': 'bib', 'lib-review': 'review-draft', 'lib-new-note': 'note-editor',
  'lib-import': 'lib-add', 'lib-empty-trash': 'trash',
  'lib-feeds': 'feeds', 'lib-recall': 'recall', 'lib-stats': 'lib-stats',
  'lib-settings': 'settings', 'settings-close': 'settings', 'set-save': 'settings',
  'set-theme': 'settings', 'set-sort': 'lib-list', 'set-view-mode': 'settings',
  'set-auto-index': 'settings', 'set-restore-tabs': 'read-tabs', 'set-split-view': 'settings',
  'set-invert-pages': 'focus-mode', 'set-fetch-email': 'meta', 'set-citekey': 'citekey',
  'set-fetch-proxy': 'fetch-pdf', 'set-fetch-openurl': 'fetch-pdf',
  'set-change-dir': 'move', 'set-open-dir': 'data-loc', 'set-backup': 'backup', 'set-restore': 'backup',
  'set-index': 'fulltext', 'set-reindex': 'fulltext', 'set-ft-clear': 'fulltext',
  'set-default-pdf': 'settings', 'set-devtools': 'settings', 'set-close': 'settings',

  // 详情面板
  'ld-type': 'detail', 'ld-title': 'detail', 'ld-year': 'detail', 'ld-publication': 'detail',
  'ld-volume': 'detail', 'ld-issue': 'detail', 'ld-pages': 'detail', 'ld-doi': 'detail',
  'ld-url': 'detail', 'ld-abstract': 'detail', 'ld-creator-add': 'detail',
  'ld-save': 'detail', 'ld-close': 'detail',
  'ld-fetch': 'meta', 'ld-fetch-pdf': 'fetch-pdf', 'ld-pdf-meta': 'meta',
  'ld-snapshot': 'snapshot', 'ld-snapshot-open': 'snapshot',
  'ld-note-add': 'subnote',
  'ld-cite-style': 'cite', 'ld-cite-copy': 'cite', 'ld-atc-btn': 'cite',
  'ld-atc-locator': 'cite', 'ld-atc-copy': 'cite', 'ld-atc-form': 'cite',
  'ld-citekey-copy': 'citekey', 'ld-citekey-at': 'citekey',
  'ld-rel-select': 'related', 'ld-rel-add': 'related', 'ld-similar-btn': 'related',
  'ld-tag-input': 'tags', 'ld-tag-add': 'tags',
  'ld-trash': 'trash', 'ld-restore': 'trash', 'ld-delete': 'trash',

  // 批量与标注视图
  'lib-bulk-edit': 'lib-bulk', 'lib-bulk-bib': 'bib', 'lib-bulk-rename': 'lib-files',
  'lib-bulk-fetch': 'fetch-pdf', 'lib-bulk-todo': 'lib-queue', 'lib-bulk-done': 'lib-queue',
  'lib-bulk-trash': 'trash', 'lib-bulk-clear': 'lib-bulk',
  'lib-anno-tag-input': 'anno-view', 'lib-anno-tag-add': 'anno-view',
  'lib-anno-note': 'anno-note', 'lib-anno-export': 'anno-export', 'lib-anno-recall': 'recall',
  'bulk-type': 'lib-bulk', 'bulk-year': 'lib-bulk', 'bulk-publication': 'lib-bulk',
  'bulk-add-tags': 'lib-bulk', 'bulk-remove-tags': 'lib-bulk', 'bulk-add-coll': 'lib-bulk',
  'bulk-save': 'lib-bulk', 'bulk-cancel': 'lib-bulk', 'bulk-close': 'lib-bulk',

  // 搜索与条件
  'lib-search': 'search-lib',
  'lib-query-btn': 'builder', 'qb-add': 'builder', 'qb-apply': 'builder',
  'qb-clear': 'builder', 'qb-close': 'builder',
  'lib-adv-btn': 'adv', 'adv-match': 'adv', 'adv-add': 'adv', 'adv-add-group': 'adv',
  'adv-clear': 'adv', 'adv-help': 'adv', 'adv-save': 'smart-coll', 'adv-apply': 'adv',
  'adv-cancel': 'adv', 'adv-close': 'adv',

  // 订阅 / 回顾 / 统计
  'feed-url': 'feeds', 'feed-add-btn': 'feeds', 'feed-refresh-btn': 'feeds',
  'feeds-close': 'feeds', 'feeds-close2': 'feeds', 'recall-close': 'recall',
  'recall-tab-review': 'recall-outline', 'recall-tab-outline': 'recall-outline',
  'set-recall-autolink': 'recall-outline',
  'stats-close': 'lib-stats', 'stats-close2': 'lib-stats',

  // 笔记
  'nv-back': 'note-editor', 'nv-title': 'note-editor', 'nv-save': 'note-editor',
  'nv-preview-toggle': 'note-editor', 'nv-md': 'note-editor',
  'nv-template': 'note-template', 'nv-export': 'note-export',
  'nv-meta-toggle': 'note-meta', 'nv-meta-status': 'note-meta',
  'nv-meta-tag-input': 'note-meta', 'nv-meta-source': 'note-meta',
  'set-note-hscale': 'note-meta', 'set-note-hweight': 'note-meta',
  'tbl-add-row': 'note-table', 'tbl-del-row': 'note-table', 'tbl-add-col': 'note-table',
  'tbl-del-col': 'note-table', 'tbl-ok': 'note-table', 'tbl-cancel': 'note-table', 'tbl-close': 'note-table',

  // 参考文献表 / 综述草稿
  'bib-style': 'bib', 'bib-scope': 'bib', 'bib-order': 'bib', 'bib-format': 'bib',
  'bib-title': 'bib', 'bib-keys': 'citekey', 'bib-csl-import': 'bib', 'bib-csl-manage': 'bib',
  'bib-copy': 'bib', 'bib-save': 'bib', 'bib-preview': 'bib',
  'bib-close': 'bib', 'bib-close2': 'bib',
  'review-scope': 'review-draft', 'review-group': 'review-draft', 'review-style': 'review-draft',
  'review-title': 'review-draft', 'review-quotes': 'review-draft', 'review-comments': 'review-draft',
  'review-refresh': 'review-draft', 'review-copy': 'review-draft', 'review-save': 'review-draft',
  'review-preview': 'review-draft', 'review-close': 'review-draft', 'review-close2': 'review-draft',

  // 命令面板 / 参考文献入库
  'cmd-input': 'palette',
  'refi-fetch': 'refimport', 'refi-all': 'refimport', 'refi-none': 'refimport',
  'refi-go': 'refimport', 'refi-cancel': 'refimport', 'refi-x': 'refimport',
  'btn-refimport': 'refimport',
};

// 纯 chrome：没有说明价值，登记在这里说明「为什么可以不写」
const IGNORE = {
  'hint-x': '首次提示条上的「知道了」，一次性文案，正文已在 quickstart 讲过入口',
  'tab-new': '标签条上的「＋」，本质是「再打开一份文档」，open-file / read-tabs 已覆盖',
};

/* ---------- 解析 ---------- */
function decode(s) {
  return String(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

const controls = [];
const seen = new Set();
const btnRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
let m;
while ((m = btnRe.exec(HTML))) {
  const attrs = m[1];
  const id = (attrs.match(/\bid="([a-zA-Z0-9_-]+)"/) || [])[1];
  if (!id || seen.has(id)) continue;
  seen.add(id);
  const title = (attrs.match(/\btitle="([^"]*)"/) || [])[1] || '';
  controls.push({ id, label: decode(m[2]) || decode(title), title: decode(title) });
}
const fieldRe = /<(input|select|textarea)\b([^>]*)>/g;
while ((m = fieldRe.exec(HTML))) {
  const attrs = m[2];
  const id = (attrs.match(/\bid="([a-zA-Z0-9_-]+)"/) || [])[1];
  if (!id || seen.has(id)) continue;
  seen.add(id);
  const title = (attrs.match(/\btitle="([^"]*)"/) || [])[1] || '';
  const ph = (attrs.match(/\bplaceholder="([^"]*)"/) || [])[1] || '';
  // 只有 placeholder、没有 title 的输入框：placeholder 是「输入提示」，不是控件名字，
  // 后面做文字对账时跳过（正文里讲的是字段名，比如「标注文字」）。
  controls.push({
    id,
    label: decode(title) || decode(ph),
    title: decode(title) || decode(ph),
    fromPlaceholder: !title && !!ph,
  });
}

const topics = [];
for (const g of guide.groups) for (const t of g.topics) topics.push(Object.assign({ group: g.id }, t));

const failures = [];
const warnings = [];
const fail = (msg) => failures.push(msg);

/* ---------- 1. 结构检查 ---------- */
const ids = new Set();
for (const t of topics) {
  if (!t.id) fail('有 topic 缺 id：' + JSON.stringify(t.title));
  if (ids.has(t.id)) fail('topic id 重复：' + t.id);
  ids.add(t.id);
  if (!t.title) fail(t.id + ' 缺 title');
  if (!t.summary) fail(t.id + ' 缺 summary');
  if (!Array.isArray(t.steps) || !t.steps.length) fail(t.id + ' 缺 steps');
  for (const s of t.steps || []) {
    if (typeof s === 'string') { if (!s.trim()) fail(t.id + ' 有空步骤'); continue; }
    if (!s.t || !s.d) fail(t.id + ' 有步骤缺 t/d');
  }
  for (const k of t.keys || []) if (!Array.isArray(k) || k.length !== 2) fail(t.id + ' 的 keys 格式不对');
}
for (const t of topics) {
  for (const see of t.see || []) if (!ids.has(see)) fail(t.id + ' 的 see 指向不存在的节：' + see);
}

const actionKeys = (() => {
  const i = HELP_JS.indexOf('const ACTIONS = {');
  const j = HELP_JS.indexOf('};', i);
  const body = HELP_JS.slice(i, j);
  return new Set(Array.from(body.matchAll(/^\s{4}([a-zA-Z]+):/gm)).map((x) => x[1]));
})();
for (const t of topics) {
  if (!t.action) continue;
  if (!actionKeys.has(t.action.id)) fail(t.id + ' 的 action 在 help.js 里没有：' + t.action.id);
  if (!t.action.label) fail(t.id + ' 的 action 缺 label');
}

const htmlIds = new Set(Array.from(HTML.matchAll(/\bid="([a-zA-Z0-9_-]+)"/g)).map((x) => x[1]));
for (const t of topics) {
  for (const sel of t.ui || []) {
    if (!sel.startsWith('#')) { fail(t.id + ' 的 ui 不是 #id 形式：' + sel); continue; }
    if (!htmlIds.has(sel.slice(1))) fail(t.id + ' 的 ui 在 index.html 里不存在：' + sel);
  }
}

// 指南自己的入口不能漏
for (const need of ['quickstart', 'help-center', 'shortcuts', 'trouble', 'limits', 'settings']) {
  if (!ids.has(need)) fail('缺少必需的节：' + need);
}

/* ---------- 2. 归属检查 ---------- */
for (const c of controls) {
  if (CONTROLS[c.id]) {
    if (!ids.has(CONTROLS[c.id])) fail(c.id + ' 指向不存在的节 ' + CONTROLS[c.id]);
    continue;
  }
  if (IGNORE[c.id]) continue;
  fail('控件未登记：' + c.id + '（' + (c.label || c.title || '无文字') + '）→ 请给它指定一节，或说明为什么不用写');
}
for (const id of Object.keys(CONTROLS)) {
  if (!htmlIds.has(id)) fail('CONTROLS 里的 ' + id + ' 在 index.html 里已不存在（说明过期了）');
}

/* ---------- 3. 证据检查 ---------- */
function topicText(t) {
  const parts = [t.title, t.summary, t.where || '', (t.keywords || []).join(' ')];
  for (const s of t.steps || []) parts.push(typeof s === 'string' ? s : (s.t + ' ' + s.d));
  for (const k of t.keys || []) parts.push(k[0] + ' ' + k[1]);
  for (const x of (t.tips || []).concat(t.limits || [])) parts.push(x);
  parts.push((t.ui || []).join(' '));
  return parts.join(' ');
}
function candidates(label) {
  const out = [];
  const raw = String(label || '').trim();
  if (!raw) return out;
  out.push(raw);
  const short = raw.split(/[：:（(·]/)[0].trim();
  if (short) out.push(short);
  const noParen = raw.replace(/[（(][^）)]*[）)]/g, '').trim();
  if (noParen) out.push(noParen);
  const first = raw.split(/[，,。；;\/]/)[0].trim();
  if (first) out.push(first);
  // 去掉常见动词 / 量词前缀，让「给选中的标注加标签」也能对上正文里的「加标签」
  const stripped = raw.replace(/^(给|把|按|用|从|为|选择|输入)/, '').trim();
  if (stripped) out.push(stripped);
  return out.filter((x) => x.length >= 2);
}

// 弹窗的关闭 / 取消 / 确定属于通用 chrome：正文用一句话概括，不必逐个点名
const CHROME_ID = /(close|close2|-x|-cancel|-ok)$/;

let evidenceMissing = 0;
for (const c of controls) {
  const topicId = CONTROLS[c.id];
  if (!topicId) continue;                     // 已忽略
  const t = topics.find((x) => x.id === topicId);
  if (!t) continue;
  if (CHROME_ID.test(c.id)) continue;
  if (c.fromPlaceholder) continue;
  const text = topicText(t).replace(/\s+/g, '');
  const hay = text + '|' + topicId;
  const labels = candidates(c.label).concat(candidates(c.title));
  if (!labels.some((x) => x.length >= 2)) continue;   // 纯图标 / 无文字控件，无从对账
  // 占位符不是「按钮名字」：`2024`、`1-12`、`https://`、长段输入提示都不逐字对账
  if (labels.some((x) => /^(https?:|[\d\-–—\/\.]+$)/.test(x))) continue;
  if (labels.some((x) => x.length > 28)) continue;
  const hit = hay.includes(c.id) ||
    labels.some((x) => {
      const n = x.replace(/\s+/g, '');
      if (hay.includes(n)) return true;
      // 长标签允许前 4 个字命中（正文常省略括号里的补充说明）
      return n.length >= 6 && hay.includes(n.slice(0, 4));
    });
  if (!hit) {
    evidenceMissing++;
    warnings.push('说明可能没写到：' + c.id + '（' + (c.label || c.title) + '）→ ' + topicId + ' 这一节没提到它');
  }
}

/* ---------- 输出 ---------- */
const groups = guide.groups.length;
console.log('使用指南 v' + guide.version + '：' + groups + ' 组 / ' + topics.length + ' 节 / ' + controls.length + ' 个界面控件');
for (const g of guide.groups) console.log('  · ' + g.title + '：' + g.topics.length + ' 节');

if (warnings.length) {
  console.log('\n提示 ' + warnings.length + ' 条：');
  for (const w of warnings) console.log('  - ' + w);
}
if (failures.length) {
  console.log('\n失败 ' + failures.length + ' 条：');
  for (const f of failures) console.log('  x ' + f);
  process.exit(1);
}
if (warnings.length && process.argv.includes('--strict')) {
  console.log('\n--strict：把提示当失败');
  process.exit(2);
}
console.log('\n通过：结构、归属与链接都对得上（' + evidenceMissing + ' 条文字证据待补）');
