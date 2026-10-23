'use strict';
/*
 * 作者结构化（数据层 v6）。
 *
 * v5 的 creators 是字符串数组（"张三"、"Brown, John"），三处能力因此做不了：
 *   - 引用格式没法把姓和名拆开（APA 的 "Smith, J."、GB/T 的 "SMITH J"）；
 *   - 排序只能按整串比，"John Smith" 和 "Zhao, Wei" 排不出姓氏序；
 *   - citekey 推导要重新猜一次姓。
 * v6 起 creators 是结构化数组：
 *   { firstName:'John', lastName:'Smith', creatorType:'author' }
 *   { firstName:'',     lastName:'张三', creatorType:'author' }   ← 中文名不拆
 *   { firstName:'',     lastName:'中国科学院', creatorType:'author' } ← 机构名
 *
 * 兼容策略：normalizeCreators 同时吃字符串和对象，所以 v5 的旧库、
 * 手工改过的 library.json、恢复回来的旧备份都能直接读，读进来就顺手升级。
 *
 * 纯函数，主进程与渲染进程都能用（UMD 风格）：
 *   Node：   require('./creators.js')
 *   浏览器： <script src="../creators.js"></script> → window.Creators
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Creators = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const str = (v) => String(v == null ? '' : v).trim();

  // 只保留写论文真正常用到的四种角色；其余一律当作者
  const CREATOR_TYPES = [
    { id: 'author', label: '作者' },
    { id: 'editor', label: '编者' },
    { id: 'translator', label: '译者' },
    { id: 'contributor', label: '贡献者' },
  ];
  const TYPE_IDS = new Set(CREATOR_TYPES.map((t) => t.id));
  const DEFAULT_TYPE = 'author';

  const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

  function typeLabel(id) {
    const hit = CREATOR_TYPES.find((t) => t.id === id);
    return hit ? hit.label : '作者';
  }

  /*
   * 姓名拆分：
   *   "Smith, John"    → { lastName:'Smith', firstName:'John' }
   *   "John Smith"     → { lastName:'Smith', firstName:'John' }
   *   "J. R. Smith"    → { lastName:'Smith', firstName:'J. R.' }
   *   "张三"            → { lastName:'张三',  firstName:'' }     ← 中文不拆
   *   "{World Health Org}" → { lastName:'World Health Org', firstName:'' }
   *                        （BibTeX 的大括号约定 = 原样显示的机构名）
   */
  function parseName(raw) {
    let s = str(raw);
    if (!s) return { firstName: '', lastName: '' };
    const literal = /^\{[\s\S]*\}$/.test(s);
    if (literal) s = s.slice(1, -1).trim();
    if (!s) return { firstName: '', lastName: '' };
    if (literal) return { firstName: '', lastName: s };
    if (s.includes(',')) {
      const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
      return { lastName: parts[0] || '', firstName: parts.slice(1).join(' ') };
    }
    if (CJK.test(s)) return { firstName: '', lastName: s };   // 中文名整体当姓
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const last = parts[parts.length - 1];
      return { lastName: last, firstName: parts.slice(0, -1).join(' ') };
    }
    return { firstName: '', lastName: parts[0] || '' };
  }

  // 单个作者归一化：字符串 / 结构体 / 只给了全名的对象都能进
  function normalizeCreator(raw) {
    if (raw == null) return null;
    if (typeof raw === 'string') {
      const p = parseName(raw);
      if (!p.firstName && !p.lastName) return null;
      return { firstName: p.firstName, lastName: p.lastName, creatorType: DEFAULT_TYPE };
    }
    if (typeof raw !== 'object') return null;
    const t = str(raw.creatorType || raw.type).toLowerCase();
    const creatorType = TYPE_IDS.has(t) ? t : DEFAULT_TYPE;
    const firstName = str(raw.firstName != null ? raw.firstName : raw.given);
    const lastName = str(raw.lastName != null ? raw.lastName : raw.family);
    if (firstName || lastName) return { firstName, lastName, creatorType };
    const alt = str(raw.name || raw.fullName || raw.literal);
    if (!alt) return null;
    const p = parseName(alt);
    if (!p.firstName && !p.lastName) return null;
    return { firstName: p.firstName, lastName: p.lastName, creatorType };
  }

  // 一组作者归一化 + 去重（同名同角色只留一条）
  function normalizeCreators(raw) {
    const src = Array.isArray(raw) ? raw : (raw == null ? [] : [raw]);
    const out = [];
    const seen = new Set();
    for (const c of src) {
      const one = normalizeCreator(c);
      if (!one) continue;
      const key = creatorKey(one);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(one);
    }
    return out;
  }

  function creatorKey(c) {
    const one = normalizeCreator(c) || { firstName: '', lastName: '', creatorType: DEFAULT_TYPE };
    return [one.lastName.toLowerCase(), one.firstName.toLowerCase(), one.creatorType].join('|');
  }

  // 显示用：姓 + 名（"John Smith"）；只有一个字段就只显示它
  function displayName(c) {
    const one = normalizeCreator(c);
    if (!one) return '';
    if (one.firstName && one.lastName) {
      if (/^[\p{Script=Han}·]+$/u.test(one.lastName) && /^[\p{Script=Han}·]+$/u.test(one.firstName)) return one.lastName + one.firstName;
      return one.firstName + ' ' + one.lastName;
    }
    return one.lastName || one.firstName;
  }

  function displayList(list, sep) {
    return normalizeCreators(list).map(displayName).filter(Boolean).join(sep == null ? ', ' : sep);
  }

  // 兼容老代码：把结构化作者摊平成字符串数组
  function strings(list) {
    return normalizeCreators(list).map(displayName).filter(Boolean);
  }

  // 排序键：优先姓氏；没有姓就用名
  function sortName(c) {
    const one = normalizeCreator(c);
    if (!one) return '';
    return one.lastName || one.firstName;
  }

  // 首字母缩写：APA / IEEE 用 "J. M."，GB/T 用不带点的 "J M"
  function initials(given, withDots) {
    const s = str(given);
    if (!s) return '';
    const out = [];
    for (const w of s.split(/\s+/).filter(Boolean)) {
      const segs = w.split('-').filter(Boolean);
      const letters = segs.map((sg) => {
        const m = /[\p{L}]/u.exec(sg);
        return m ? m[0].toUpperCase() : '';
      }).filter(Boolean);
      if (!letters.length) continue;
      // 连字符名（Jean-Paul）逐段带点：J.-P.
      if (segs.length > 1) {
        out.push(letters.map((l) => (withDots === false ? l : l + '.')).join('-'));
      } else {
        out.push(withDots === false ? letters[0] : letters[0] + '.');
      }
    }
    return out.join(' ');
  }

  // 是否是「整体一个词」的名字（中文名 / 机构名），这类不做姓名拆分
  function isSingleToken(c) {
    const one = normalizeCreator(c);
    if (!one) return true;
    if (!one.firstName) return true;
    return false;
  }

  return {
    CREATOR_TYPES, TYPE_IDS, DEFAULT_TYPE,
    parseName, normalizeCreator, normalizeCreators, creatorKey,
    displayName, displayList, strings, sortName, initials, isSingleToken, typeLabel,
  };
});
