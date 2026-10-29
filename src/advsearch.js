'use strict';
/*
 * 条件检索（对标 Zotero 的「高级检索」）。
 *
 * 和 query.js 的分工：
 *   query.js    —— 搜索框里的那一条串（词 / 短语 / -排除 / 字段限定 / OR），用起来快，写起来也快
 *   advsearch   —— 多行条件 + 全部/任一 + 运算符（包含 / 是 / 为空 / 大于…），用来表达搜索框说不清的事
 *
 * 为什么不做成「把条件编译成查询串」：`标注数 > 3`、`摘要为空`、`有红色高亮` 这三类用字符串语法
 * 表达会立刻变成自造方言，保存的检索还没法无损还原成条件行。Zotero 自己也是两条路：
 * 搜索框一条、高级检索一条，保存的检索里存的是条件数组。这里照做。
 *
 * 条件形态（v36 起可以嵌套）：
 *   叶子：{ field, op, value }
 *   组：  { match: 'all' | 'any', conditions: [ 叶子 | 组 … ] }
 * 顶层永远是一个组。嵌套让「(标题含 A 或 摘要含 A) 且 有红色标注」这类需求一条就能表达，
 * Zotero 的高级检索也是这个结构（条件组）。深度上限 4 层，够用且能挡住递归爆栈。
 *
 * UMD：主进程可 require，渲染进程 <script> 引入后是 window.AdvSearch。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AdvSearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const str = (v) => String(v == null ? '' : v);
  const MAX_DEPTH = 4;

  // 折叠：大小写 + 拉丁变音（café → cafe）。与 query.js 的口径一致，
  // 免得「搜索框能搜到、条件检索搜不到」这种莫名其妙的不一致。
  function fold(s) {
    let out = str(s).toLowerCase();
    if (/[\u00c0-\u024f]/.test(out)) {
      out = out.replace(/[\u00c0-\u024f]/g, (c) => c.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
    }
    return out.replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
  }

  function creatorsText(it) {
    const list = Array.isArray(it && it.creators) ? it.creators : [];
    return list.map((c) => {
      if (typeof c === 'string') return c;
      return [str(c && c.lastName), str(c && c.firstName)].filter(Boolean).join(' ');
    }).filter(Boolean).join('; ');
  }

  function tagsText(it) {
    const t = it && it.tags;
    return Array.isArray(t) ? t.join(', ') : '';
  }

  function yearOf(it) {
    const m = /(\d{4})/.exec(str(it && it.year));
    return m ? Number(m[1]) : NaN;
  }

  function annosOf(it, ctx) {
    if (!it) return [];
    if (ctx && typeof ctx.annosOf === 'function') {
      try { return ctx.annosOf(it) || []; } catch (_) { return []; }
    }
    return Array.isArray(it.annotations) ? it.annotations : [];
  }

  // 字段表。type 决定可用的运算符，也决定值控件长什么样（界面据此渲染）。
  // date 类字段存毫秒时间戳，0 / 缺失都算「没有日期」。
  const FIELDS = [
    { id: 'any', label: '任意字段', type: 'text', get: (it) => [it.title, creatorsText(it), it.publication, it.abstract, it.year, tagsText(it), it.doi].filter(Boolean).join(' ') },
    { id: 'title', label: '标题', type: 'text', get: (it) => str(it.title) },
    { id: 'author', label: '作者', type: 'text', get: (it) => creatorsText(it) },
    { id: 'publication', label: '期刊 / 出版物', type: 'text', get: (it) => str(it.publication || it.journal || it.bookTitle) },
    { id: 'abstract', label: '摘要', type: 'text', get: (it) => str(it.abstract) },
    { id: 'tag', label: '标签', type: 'text', get: (it) => tagsText(it) },
    { id: 'doi', label: 'DOI', type: 'text', get: (it) => str(it.doi) },
    { id: 'year', label: '年份', type: 'number', get: (it) => yearOf(it) },
    { id: 'dateAdded', label: '加入日期', type: 'date', get: (it) => Number(it && it.created) || 0 },
    { id: 'dateModified', label: '修改日期', type: 'date', get: (it) => Number(it && it.updated) || 0 },
    { id: 'itemType', label: '条目类型', type: 'enum', get: (it) => str(it.itemType || 'document') },
    { id: 'readStatus', label: '阅读状态', type: 'enum', get: (it) => str(it.readStatus || '') },
    { id: 'hasAttachment', label: '有附件', type: 'bool', get: (it) => !!(it && it.attachment && it.attachment.path) },
    { id: 'attachmentPath', label: '附件路径', type: 'text', get: (it) => str(it && it.attachment && it.attachment.path) },
    { id: 'annoCount', label: '标注数', type: 'number', get: (it, ctx) => annosOf(it, ctx).length },
    { id: 'hasAnnotation', label: '有标注', type: 'bool', get: (it, ctx) => annosOf(it, ctx).length > 0 },
    { id: 'annoKind', label: '标注类型', type: 'annoEnum', get: (it, ctx) => annosOf(it, ctx).map((a) => str(a.kind)).filter(Boolean) },
    { id: 'annoColor', label: '标注颜色', type: 'annoEnum', get: (it, ctx) => annosOf(it, ctx).map((a) => str(a.color)).filter(Boolean) },
    { id: 'annoText', label: '标注文字或批注', type: 'text', get: (it, ctx) => annosOf(it, ctx).map((a) => str(a.text) + ' ' + str(a.comment)).join(' ') },
    { id: 'annoHasComment', label: '标注带批注', type: 'bool', get: (it, ctx) => annosOf(it, ctx).some((a) => str(a.comment).trim() !== '') },
  ];

  const FIELD_BY_ID = new Map(FIELDS.map((f) => [f.id, f]));

  // 运算符表：值要输入时 needsValue=true。「为空 / 不为空 / 有 / 没有」不需要值，
  // 界面要据此把值输入框禁掉，否则用户会以为填了才算数。
  const OPS = {
    text: [
      { id: 'contains', label: '包含', needsValue: true },
      { id: 'notContains', label: '不包含', needsValue: true },
      { id: 'is', label: '是', needsValue: true },
      { id: 'isNot', label: '不是', needsValue: true },
      { id: 'beginsWith', label: '开头是', needsValue: true },
      { id: 'endsWith', label: '结尾是', needsValue: true },
      { id: 'regex', label: '匹配正则', needsValue: true, hint: '不区分大小写，如 ^deep|attention' },
      { id: 'notRegex', label: '不匹配正则', needsValue: true, hint: '不区分大小写' },
      { id: 'isEmpty', label: '为空', needsValue: false },
      { id: 'isNotEmpty', label: '不为空', needsValue: false },
    ],
    number: [
      { id: 'eq', label: '等于', needsValue: true },
      { id: 'gt', label: '大于', needsValue: true },
      { id: 'lt', label: '小于', needsValue: true },
      { id: 'gte', label: '不小于', needsValue: true },
      { id: 'lte', label: '不大于', needsValue: true },
      { id: 'isEmpty', label: '为空', needsValue: false },
      { id: 'isNotEmpty', label: '不为空', needsValue: false },
    ],
    // 日期：值是「天」。不比绝对日期，是因为绝大多数人问的是「最近 N 天加进来的」，
    // 而绝对日期要日期选择器 + 时区口径，收益抵不上复杂度。
    date: [
      { id: 'withinDays', label: '距今不超过', needsValue: true, hint: '单位：天。今天算 0' },
      { id: 'olderThanDays', label: '距今超过', needsValue: true, hint: '单位：天' },
      { id: 'isEmpty', label: '为空', needsValue: false },
      { id: 'isNotEmpty', label: '不为空', needsValue: false },
    ],
    enum: [
      { id: 'is', label: '是', needsValue: true },
      { id: 'isNot', label: '不是', needsValue: true },
      { id: 'isEmpty', label: '为空', needsValue: false },
      { id: 'isNotEmpty', label: '不为空', needsValue: false },
    ],
    bool: [
      { id: 'has', label: '是', needsValue: false },
      { id: 'hasNot', label: '否', needsValue: false },
    ],
    // 批注属性：值是多值的（一条条目可能有很多标注），所以「是」= 存在这类标注
    annoEnum: [
      { id: 'has', label: '有', needsValue: true },
      { id: 'hasNot', label: '没有', needsValue: true },
    ],
  };

  const ENUM_OPTIONS = {
    itemType: [
      ['journalArticle', '期刊论文'], ['magazineArticle', '杂志文章'], ['newspaperArticle', '报纸文章'],
      ['book', '图书'], ['bookSection', '图书章节'], ['conferencePaper', '会议论文'],
      ['thesis', '学位论文'], ['report', '报告'], ['preprint', '预印本'], ['manuscript', '手稿'],
      ['webpage', '网页'], ['blogPost', '博客'], ['dataset', '数据集'], ['software', '软件'],
      ['patent', '专利'], ['standard', '标准'], ['document', '文档'],
    ],
    readStatus: [['todo', '待读'], ['reading', '在读'], ['done', '已读']],
  };

  function fieldOf(id) { return FIELD_BY_ID.get(String(id || '')) || null; }

  function opsFor(fieldId) {
    const f = fieldOf(fieldId);
    return f ? (OPS[f.type] || []) : [];
  }

  function opDef(fieldId, opId) {
    return opsFor(fieldId).find((o) => o.id === opId) || null;
  }

  // 组的判定：带 conditions 数组的对象就是组。叶子永远没有这个键，所以不会歧义。
  function isGroup(x) {
    return !!(x && typeof x === 'object' && Array.isArray(x.conditions));
  }

  // 条件是否「已填完」：字段与运算符都在表里，且需要值的时候值非空。
  function isComplete(c) {
    if (!c || typeof c !== 'object') return false;
    if (isGroup(c)) return normalize(c).conditions.length > 0;
    const f = fieldOf(c.field);
    if (!f) return false;
    const op = opDef(c.field, c.op);
    if (!op) return false;
    if (op.needsValue) return str(c.value).trim() !== '';
    return true;
  }

  function normalizeLeaf(c) {
    const f = fieldOf(c.field);
    if (!f) return null;
    const op = opDef(c.field, c.op);
    if (!op) return null;
    // 引擎不改写值：截断是存储层的事（保存的检索才会落盘），
    // 在这里截会让「测试里 500 字的值」和「用户输入的 500 字」表现不一致。
    const value = str(c.value);
    if (op.needsValue && !value.trim()) return null;
    return { field: str(c.field), op: str(c.op), value: op.needsValue ? value : '' };
  }

  // 递归规范化：丢掉不完整 / 未知的条件；空组整个丢掉。
  // 保留空组没有意义（它对结果没有任何约束），却会让描述文案和计数都变复杂。
  function normalize(spec, depth) {
    const d = depth || 0;
    const s = spec && typeof spec === 'object' ? spec : {};
    const match = s.match === 'any' ? 'any' : 'all';
    const list = Array.isArray(s.conditions) ? s.conditions : [];
    const out = [];
    for (const c of list) {
      if (!c || typeof c !== 'object') continue;
      if (isGroup(c)) {
        if (d + 1 >= MAX_DEPTH) continue;          // 超过深度上限：丢弃而不是抛错
        const g = normalize(c, d + 1);
        if (g.conditions.length) out.push(g);
        continue;
      }
      const leaf = normalizeLeaf(c);
      if (leaf) out.push(leaf);
    }
    return { match, conditions: out };
  }

  function num(v) {
    const t = str(v).replace(/[^\d.+-]/g, '');
    // 注意别直接 Number('')：那是 0，会让「年份 > abc」把所有带年份的条目都放进来
    if (!t || !/[\d]/.test(t)) return NaN;
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
  }

  // 正则编译带缓存：同一个模式在一整库条目上会编译上百次，缓存几乎是免费的。
  // 非法正则返回 null，调用方按「不命中」处理（而不是让整次检索抛错）。
  const reCache = new Map();
  function compileRe(pattern) {
    const p = str(pattern);
    if (!p || p.length > 200) return null;
    if (reCache.has(p)) return reCache.get(p);
    let re = null;
    try { re = new RegExp(p, 'i'); } catch (_) { re = null; }
    if (reCache.size > 200) reCache.clear();
    reCache.set(p, re);
    return re;
  }

  function testOne(c, it, ctx, nowMs) {
    const f = fieldOf(c.field);
    if (!f) return true;                 // 未知字段不参与过滤，别把结果全清空
    const raw = f.get(it, ctx);
    const v = str(c.value).trim();
    const op = c.op;

    if (f.type === 'bool') {
      const on = !!raw;
      if (op === 'has') return on;
      if (op === 'hasNot') return !on;
      return true;
    }
    if (f.type === 'number') {
      const n = Number(raw);
      const has = Number.isFinite(n);
      if (op === 'isEmpty') return !has;
      if (op === 'isNotEmpty') return has;
      const target = num(v);
      if (!has || !Number.isFinite(target)) return false;
      if (op === 'eq') return n === target;
      if (op === 'gt') return n > target;
      if (op === 'lt') return n < target;
      if (op === 'gte') return n >= target;
      if (op === 'lte') return n <= target;
      return true;
    }
    if (f.type === 'date') {
      const n = Number(raw);
      const has = Number.isFinite(n) && n > 0;
      if (op === 'isEmpty') return !has;
      if (op === 'isNotEmpty') return has;
      const days = num(v);
      if (!has || !Number.isFinite(days) || days < 0) return false;
      // 「距今」按自然日算：今天 00:00 到今天 23:59 都记为 0 天，
      // 这样「距今不超过 0 天」= 今天，跟人的说法一致。
      const startOfToday = new Date(nowMs).setHours(0, 0, 0, 0);
      const startOfThat = new Date(n).setHours(0, 0, 0, 0);
      const age = Math.round((startOfToday - startOfThat) / 86400000);
      if (op === 'withinDays') return age >= 0 ? age <= days : true;   // 未来时间（时区乱）不算「距今超过」
      if (op === 'olderThanDays') return age > days;
      return true;
    }
    if (f.type === 'annoEnum') {
      const list = Array.isArray(raw) ? raw : [];
      const hit = list.some((x) => fold(x) === fold(v));
      if (op === 'has') return hit;
      if (op === 'hasNot') return !hit;
      return true;
    }
    // text / enum
    const hay = fold(raw);
    const needle = fold(v);
    if (op === 'regex' || op === 'notRegex') {
      const re = compileRe(v);                 // 正则区分大小写没意义，统一 i
      if (!re) return false;
      const on = re.test(str(raw));            // 原文比 fold 更可靠：\b、大写、标点都按原样
      return op === 'regex' ? on : !on;
    }
    if (op === 'isEmpty') return hay === '';
    if (op === 'isNotEmpty') return hay !== '';
    if (op === 'is') return hay === needle;
    if (op === 'isNot') return hay !== needle;
    if (op === 'beginsWith') return hay.startsWith(needle);
    if (op === 'endsWith') return hay.endsWith(needle);
    if (op === 'notContains') return hay.indexOf(needle) < 0;
    return hay.indexOf(needle) >= 0;     // contains（默认）
  }

  function matchesNode(node, it, ctx, nowMs) {
    if (!node) return true;
    if (isGroup(node)) {
      const list = node.conditions || [];
      if (!list.length) return true;
      const test = (c) => matchesNode(c, it, ctx, nowMs);
      return node.match === 'any' ? list.some(test) : list.every(test);
    }
    return testOne(node, it, ctx, nowMs);
  }

  function matches(it, spec, ctx) {
    const s = normalize(spec);
    if (!s.conditions.length) return true;
    const nowMs = (ctx && Number(ctx.now)) || Date.now();
    return matchesNode(s, it, ctx, nowMs);
  }

  function filter(items, spec, ctx) {
    const list = Array.isArray(items) ? items : [];
    const s = normalize(spec);
    if (!s.conditions.length) return list.slice();
    const nowMs = (ctx && Number(ctx.now)) || Date.now();
    return list.filter((it) => matchesNode(s, it, ctx, nowMs));
  }

  function fieldLabel(id) {
    const f = fieldOf(id);
    return f ? f.label : str(id);
  }

  function opLabel(fieldId, opId) {
    const o = opDef(fieldId, opId);
    return o ? o.label : str(opId);
  }

  function unitOf(field) {
    // 只有「距今 N 天」需要单位：年份写「2010」比「2010 年」更贴近用户输入的原文
    return field && field.type === 'date' ? ' 天' : '';
  }

  // 条件 → 人能读的一句话（列表顶部横幅、保存的检索名都用它）
  function describeCondition(c, depth) {
    // 括号由 describe 负责：组自己再包一层会变成 ((…))，读起来像出错
    if (isGroup(c)) return describe(c, (depth || 0) + 1);
    const f = fieldOf(c && c.field);
    if (!f) return '';
    const op = opDef(c.field, c.op);
    if (!op) return '';
    if (f.type === 'bool') return f.label + '：' + (c.op === 'has' ? '是' : '否');
    if (!op.needsValue) return f.label + ' ' + op.label;
    const val = str(c.value).trim();
    let shown = f.type === 'enum' ? enumLabel(c.field, val) : val;
    if (op.id === 'regex' || op.id === 'notRegex') shown = '/' + val + '/i';
    else if (f.type === 'date' || f.type === 'number') shown = val + unitOf(f);
    return f.label + ' ' + op.label + ' “' + shown + '”';
  }

  function describe(spec, depth) {
    const s = normalize(spec);
    if (!s.conditions.length) return '';
    const parts = s.conditions.map((c) => describeCondition(c, depth || 0));
    const joined = parts.join(s.match === 'any' ? ' 或 ' : ' 且 ');
    // 只有嵌套组才加括号：顶层全加一层括号读起来更累
    return (depth && s.conditions.length > 1) ? '(' + joined + ')' : joined;
  }

  function enumLabel(fieldId, value) {
    const opts = ENUM_OPTIONS[fieldId];
    if (!opts) return value;
    const hit = opts.find((x) => x[0] === value);
    return hit ? hit[1] : value;
  }

  // 条件总数（含各组里的），用于上限控制与「几项条件」的文案
  function countConditions(node) {
    if (!node) return 0;
    if (!isGroup(node)) return 1;
    return (node.conditions || []).reduce((n, c) => n + (isGroup(c) ? countConditions(c) : 1), 0);
  }

  // 组数（不含顶层）：界面用来显示「其中 N 组」
  function countGroups(node, depth) {
    if (!node || !isGroup(node)) return 0;
    let n = (depth || 0) > 0 ? 1 : 0;
    for (const c of node.conditions || []) if (isGroup(c)) n += countGroups(c, (depth || 0) + 1);
    return n;
  }

  return {
    FIELDS, OPS, ENUM_OPTIONS, MAX_DEPTH,
    fieldOf, opsFor, opDef, isComplete, isGroup, normalize,
    matches, filter, describe, describeCondition, fieldLabel, opLabel, enumLabel,
    countConditions, countGroups, unitOf,
    fold,
  };
});
