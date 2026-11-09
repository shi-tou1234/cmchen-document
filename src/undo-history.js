'use strict';
/*
 * UndoHistory —— 实体 / 字段层面的撤销栈。
 *
 * 为什么不再用整库快照（v1.7.0 的写法）：
 *   1. 一次「添加标签」存一份整库 JSON，20 个撤销点就是 20 份。万条库实测
 *      堆增量约 559 MiB，而且局部操作要做 3 次整库 stringify。
 *   2. 更要命的是正确性：撤销时把整库替换回旧快照，会把「后来保存的页码、
 *      RSS 订阅、附件路径」一起回退。用户只撤销一个标签，却丢了阅读进度。
 *
 * 现在的模型：命令执行前只克隆「它可能写到的实体」，执行后与当前值比对，
 * 记录**变化的字段**（before / after）。撤销只写回这些字段，因此：
 *   · 一条命令只碰它自己的字段，别的数据不会被连带回退；
 *   · 栈里放的是差异，量级跟着「改了多少」走，不跟着库大小走。
 *
 * 实体的四种形态：
 *   item / collection / search / feed  数组里的对象（可按 id 增删）
 *   tagColor / annoMeta / annoTags / noteAlias  映射里的值
 *   note  item.notes[] 里的对象（id 形如 "条目 key\u0000笔记 id"）
 *
 * 补丁（patch）：
 *   { t:'fields', kind, id, b:{字段:值}, a:{字段:值} }   值可以是 MISSING（表示原本没有这个键）
 *   { t:'add',    kind, id, a:实体, index }              命令新建的实体
 *   { t:'del',    kind, id, b:实体, index }              命令删掉的实体
 *
 * 时间戳（updated）不参与差量：撤销「添加标签」不该把条目的修改时间拉回过去。
 */

const MISSING = Symbol('missing');
const NOTE_SEP = '\u0000';

// 不参与差量的字段：时间戳只反映「最后一次写」，把旧值写回去没有意义
const SKIP_FIELDS = new Set(['updated']);
// 条目自身的比较跳过 notes（笔记按条比较，见 notePatches）
const ITEM_SKIP = new Set(['updated', 'notes']);

function clone(v) {
  if (v === MISSING) return MISSING;
  if (v === null || typeof v !== 'object') return v;
  if (typeof structuredClone === 'function') return structuredClone(v);
  return JSON.parse(JSON.stringify(v));
}

const ARRAYS = {
  item: { field: 'items', keyOf: (x) => String(x.key) },
  collection: { field: 'collections', keyOf: (x) => String(x.id) },
  search: { field: 'searches', keyOf: (x) => String(x.id) },
  feed: { field: 'feeds', keyOf: (x) => String(x.id) },
};
const MAPS = {
  tagColor: 'tagColors',
  annoMeta: 'annoMeta',
  annoTags: 'annoTags',
  noteAlias: 'noteAliases',
};

function isKind(kind) { return !!(ARRAYS[kind] || MAPS[kind] || kind === 'note'); }

function arrOf(store, kind) {
  const spec = ARRAYS[kind];
  if (!spec) return null;
  const arr = store[spec.field];
  return Array.isArray(arr) ? arr : null;
}

function splitNoteId(id) {
  const s = String(id);
  const i = s.indexOf(NOTE_SEP);
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}

function getEntity(store, kind, id) {
  if (!store) return MISSING;
  const arr = arrOf(store, kind);
  if (arr) {
    const spec = ARRAYS[kind];
    const found = arr.find((x) => x && spec.keyOf(x) === String(id));
    return found === undefined ? MISSING : found;
  }
  if (kind === 'note') {
    const [itemKey, noteId] = splitNoteId(id);
    const it = (store.items || []).find((x) => x && String(x.key) === itemKey);
    if (!it || !Array.isArray(it.notes)) return MISSING;
    const n = it.notes.find((x) => x && String(x.id) === noteId);
    return n === undefined ? MISSING : n;
  }
  const mapField = MAPS[kind];
  if (!mapField) return MISSING;
  const map = store[mapField];
  if (!map || !Object.prototype.hasOwnProperty.call(map, String(id))) return MISSING;
  return map[String(id)];
}

function indexOfEntity(store, kind, id) {
  const arr = arrOf(store, kind);
  if (arr) {
    const spec = ARRAYS[kind];
    return arr.findIndex((x) => x && spec.keyOf(x) === String(id));
  }
  if (kind === 'note') {
    const [itemKey, noteId] = splitNoteId(id);
    const it = (store.items || []).find((x) => x && String(x.key) === itemKey);
    if (!it || !Array.isArray(it.notes)) return -1;
    return it.notes.findIndex((x) => x && String(x.id) === noteId);
  }
  return -1;
}

function removeEntity(store, kind, id) {
  const arr = arrOf(store, kind);
  if (arr) {
    const spec = ARRAYS[kind];
    const i = arr.findIndex((x) => x && spec.keyOf(x) === String(id));
    if (i >= 0) arr.splice(i, 1);
    return i >= 0;
  }
  if (kind === 'note') {
    const [itemKey, noteId] = splitNoteId(id);
    const it = (store.items || []).find((x) => x && String(x.key) === itemKey);
    if (!it || !Array.isArray(it.notes)) return false;
    const i = it.notes.findIndex((x) => x && String(x.id) === noteId);
    if (i >= 0) it.notes.splice(i, 1);
    return i >= 0;
  }
  const mapField = MAPS[kind];
  if (!mapField || !store[mapField]) return false;
  if (!Object.prototype.hasOwnProperty.call(store[mapField], String(id))) return false;
  delete store[mapField][String(id)];
  return true;
}

function insertEntity(store, kind, id, value, index) {
  const arr = arrOf(store, kind);
  if (arr) {
    const at = Number.isFinite(index) && index >= 0 ? Math.min(index, arr.length) : arr.length;
    arr.splice(at, 0, clone(value));
    return true;
  }
  if (kind === 'note') {
    const [itemKey, noteId] = splitNoteId(id);
    const it = (store.items || []).find((x) => x && String(x.key) === itemKey);
    if (!it) return false;
    if (!Array.isArray(it.notes)) it.notes = [];
    const at = Number.isFinite(index) && index >= 0 ? Math.min(index, it.notes.length) : it.notes.length;
    it.notes.splice(at, 0, clone(value));
    return true;
  }
  const mapField = MAPS[kind];
  if (!mapField) return false;
  if (!store[mapField]) store[mapField] = {};
  store[mapField][String(id)] = clone(value);
  return true;
}

// 只比较一层字段，但把「键不存在」与「值是 undefined」分开（MISSING 占位）
function diffFields(before, after, skipFields) {
  const b = {}; const a = {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    if (skipFields && skipFields.has(k)) continue;
    const hasB = before && Object.prototype.hasOwnProperty.call(before, k);
    const hasA = after && Object.prototype.hasOwnProperty.call(after, k);
    if (!hasB && !hasA) continue;
    const vb = hasB ? before[k] : MISSING;
    const va = hasA ? after[k] : MISSING;
    if (vb !== MISSING && va !== MISSING && sameValue(vb, va)) continue;
    if (vb === MISSING || va === MISSING) {
      b[k] = vb; a[k] = va;
      continue;
    }
    b[k] = clone(vb); a[k] = clone(va);
  }
  return Object.keys(b).length || Object.keys(a).length ? { b, a } : null;
}

function sameValue(x, y) {
  if (x === y) return true;
  if (x === MISSING || y === MISSING) return false;
  if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false;
  // 只比结构，不比引用：数组里塞了新元素也算变化
  return JSON.stringify(x) === JSON.stringify(y);
}

// 映射里的值有两种形态：对象（annoMeta）与标量 / 数组（tagColors、noteAliases、annoTags）。
// 后者不能按「对象字段」求差 —— 对数组下标执行 delete 只会留下空洞，JSON 里变成 null（R03）。
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function applyFields(entity, fields) {
  for (const k of Object.keys(fields)) {
    const v = fields[k];
    if (v === MISSING) delete entity[k];
    else entity[k] = clone(v);
  }
}

function applyPatch(store, patch, dir) {
  const { kind, id } = patch;
  if (patch.t === 'fields') {
    const target = getEntity(store, kind, id);
    if (target === MISSING) return false;
    applyFields(target, dir === 'undo' ? patch.b : patch.a);
    return true;
  }
  if (patch.t === 'add') {
    if (dir === 'undo') return removeEntity(store, kind, id);
    return insertEntity(store, kind, id, patch.a, patch.index);
  }
  if (patch.t === 'del') {
    if (dir === 'undo') return insertEntity(store, kind, id, patch.b, patch.index);
    return removeEntity(store, kind, id);
  }
  if (patch.t === 'value') {
    const v = dir === 'undo' ? patch.b : patch.a;
    if (v === MISSING) return removeEntity(store, kind, id);
    return insertEntity(store, kind, id, v, -1);
  }
  return false;
}

// 一条条目里笔记的增删改，按笔记 id 拆开记
function notePatches(itemKey, beforeNotes, afterNotes) {
  const b = Array.isArray(beforeNotes) ? beforeNotes : [];
  const a = Array.isArray(afterNotes) ? afterNotes : [];
  const bById = new Map(b.map((n, i) => [String(n && n.id), { n, i }]));
  const aById = new Map(a.map((n, i) => [String(n && n.id), { n, i }]));
  const out = [];
  for (const [id, rec] of aById) {
    if (bById.has(id)) continue;
    out.push({ t: 'add', kind: 'note', id: String(itemKey) + NOTE_SEP + id, a: clone(rec.n), index: rec.i });
  }
  for (const [id, rec] of bById) {
    if (aById.has(id)) continue;
    out.push({ t: 'del', kind: 'note', id: String(itemKey) + NOTE_SEP + id, b: clone(rec.n), index: rec.i });
  }
  for (const [id, rec] of aById) {
    const old = bById.get(id);
    if (!old) continue;
    const d = diffFields(old.n, rec.n, SKIP_FIELDS);
    if (d) out.push({ t: 'fields', kind: 'note', id: String(itemKey) + NOTE_SEP + id, b: d.b, a: d.a });
  }
  return out;
}

// 合并连续编辑后可能出现「改回原值」的字段：这类字段不该再占补丁
function prunePatch(p) {
  if (!p) return null;
  if (p.t === 'value') {
    if (p.b !== MISSING && p.a !== MISSING && sameValue(p.b, p.a)) return null;
    return p;
  }
  if (p.t !== 'fields') return p;
  const b = {}; const a = {};
  const keys = new Set([...Object.keys(p.b || {}), ...Object.keys(p.a || {})]);
  for (const k of keys) {
    const hasB = Object.prototype.hasOwnProperty.call(p.b || {}, k);
    const hasA = Object.prototype.hasOwnProperty.call(p.a || {}, k);
    if (hasB !== hasA) { if (hasB) b[k] = p.b[k]; else a[k] = p.a[k]; continue; }
    if (sameValue(p.b[k], p.a[k])) continue;
    b[k] = p.b[k]; a[k] = p.a[k];
  }
  if (!Object.keys(b).length && !Object.keys(a).length) return null;
  return { t: 'fields', kind: p.kind, id: p.id, b, a };
}

function createHistory(opts) {
  const o = opts || {};
  const getStore = o.getStore;
  const save = o.save || (() => true);
  const limit = o.limit || 20;

  let undoStack = [];
  let redoStack = [];

  function snapshotOne(kind, id) {
    const cur = getEntity(getStore(), kind, id);
    return {
      kind,
      id: String(id),
      before: cur === MISSING ? MISSING : clone(cur),
      index: indexOfEntity(getStore(), kind, id),
    };
  }

  /*
   * 命令执行前调用。touch：这条命令可能改写的实体；watch：可能新建/删除实体的种类。
   * 只有 touch 的实体会被克隆（成本跟着「改了多少」走）；watch 只记 id 集合。
   */
  function begin(touch, watch) {
    const store = getStore();
    const entries = new Map();
    for (const t of touch || []) {
      if (!t || !isKind(t[0]) || t[1] == null) continue;
      const id = String(t[1]);
      const key = t[0] + NOTE_SEP + id;
      if (entries.has(key)) continue;
      entries.set(key, snapshotOne(t[0], id));
    }
    const watched = new Map();
    for (const kind of watch || []) {
      if (!isKind(kind) || kind === 'note') continue;
      const ids = new Set();
      const refs = new Map();
      const arr = arrOf(store, kind);
      if (arr) {
        const spec = ARRAYS[kind];
        arr.forEach((x, i) => { if (x) { const k = spec.keyOf(x); ids.add(k); refs.set(k, { ref: x, index: i }); } });
      } else {
        const map = store[MAPS[kind]] || {};
        for (const k of Object.keys(map)) { ids.add(k); refs.set(k, { ref: map[k], index: -1 }); }
      }
      watched.set(kind, { ids, refs });
    }
    return { entries, watched };
  }

  // 由 token 生成补丁（与当前内存状态比对），不负责入栈
  function patchesOf(token) {
    const store = getStore();
    const patches = [];
    for (const rec of token.entries.values()) {
      const cur = getEntity(store, rec.kind, rec.id);
      if (rec.before === MISSING && cur === MISSING) continue;
      if (rec.before === MISSING) {
        patches.push({ t: 'add', kind: rec.kind, id: rec.id, a: clone(cur), index: indexOfEntity(store, rec.kind, rec.id) });
        continue;
      }
      if (cur === MISSING) {
        patches.push({ t: 'del', kind: rec.kind, id: rec.id, b: clone(rec.before), index: rec.index });
        continue;
      }
      if (MAPS[rec.kind] && (!isPlainObject(rec.before) || !isPlainObject(cur))) {
        if (!sameValue(rec.before, cur)) {
          patches.push({ t: 'value', kind: rec.kind, id: rec.id, b: clone(rec.before), a: clone(cur) });
        }
        continue;
      }
      if (rec.kind === 'item') {
        // 条目的字段与它的笔记分开记：撤销「添加笔记」不该顺带回退后来编辑过的另一条笔记
        const d = diffFields(rec.before, cur, ITEM_SKIP);
        if (d) patches.push({ t: 'fields', kind: 'item', id: rec.id, b: d.b, a: d.a });
        patches.push(...notePatches(rec.id, rec.before.notes, cur.notes));
        continue;
      }
      const d = diffFields(rec.before, cur, SKIP_FIELDS);
      if (d) patches.push({ t: 'fields', kind: rec.kind, id: rec.id, b: d.b, a: d.a });
    }
    for (const [kind, info] of token.watched) {
      const arr = arrOf(store, kind);
      const nowIds = new Set();
      if (arr) {
        const spec = ARRAYS[kind];
        for (const x of arr) if (x) nowIds.add(spec.keyOf(x));
      } else {
        const map = store[MAPS[kind]] || {};
        for (const k of Object.keys(map)) nowIds.add(k);
      }
      for (const id of nowIds) {
        if (info.ids.has(id)) continue;
        patches.push({ t: 'add', kind, id, a: clone(getEntity(store, kind, id)), index: indexOfEntity(store, kind, id) });
      }
      for (const id of info.ids) {
        if (nowIds.has(id)) continue;
        // 删除：命令执行前留下的引用仍带着内容，克隆进补丁就能还原
        const rec = info.refs.get(id) || {};
        patches.push({ t: 'del', kind, id, b: clone(rec.ref), index: typeof rec.index === 'number' ? rec.index : -1 });
      }
    }
    return patches;
  }

  function topMatching(coalesceKey) {
    if (!coalesceKey) return -1;
    const top = undoStack[undoStack.length - 1];
    if (!top || top.coalesce !== coalesceKey) return -1;
    if (Date.now() - (top.at || 0) >= (o.coalesceMs || 4000)) return -1;
    return undoStack.length - 1;
  }

  /*
   * 提交。coalesceKey 相同且间隔在窗口内时合并成一个撤销点。
   *
   * 合并必须按 **实体 + 字段** 走，不能按实体整条跳过（R02）：
   *   · 同一字段：保留窗口内最早的 before，取最新的 after；
   *   · 后来才第一次改的字段：把自己的 before / after 补进去（否则这次改动没有撤销点）；
   *   · 合并完逐字段去掉 before==after，实体没变化就丢掉补丁，整条命令没变化就丢掉撤销点
   *     （否则「v1→v2→v1」会留下一个「撤销出新内容」的假点）。
   */
  function commit(token, desc, extra) {
    const patchList = patchesOf(token);
    const e = extra || {};
    const idx = topMatching(e.coalesceKey);
    if (!patchList.length) {
      if (idx >= 0) { undoStack[idx].at = Date.now(); redoStack = []; }
      return false;
    }
    if (idx >= 0) {
      const merged = undoStack[idx].patches.map((p) => ({
        t: p.t, kind: p.kind, id: p.id,
        // 字段补丁是「字段 → 值」的映射，拷一层再改；值补丁本身就是数组/标量，原样带过去
        b: p.t === 'fields' ? Object.assign({}, p.b) : p.b,
        a: p.t === 'fields' ? Object.assign({}, p.a) : p.a,
        index: p.index,
      }));
      for (const p of patchList) {
        const same = merged.find((x) => x.kind === p.kind && x.id === p.id && x.t === p.t);
        if (!same) { merged.push(p); continue; }
        if (p.t === 'fields' && same.t === 'fields') {
          for (const k of Object.keys(p.b)) if (!(k in same.b)) same.b[k] = p.b[k];
          for (const k of Object.keys(p.a)) same.a[k] = p.a[k];
        } else {
          // add / del / value：同一实体只保留最初的 before 与最新的 after
          same.a = p.t === 'fields' ? same.a : p.a;
          if (p.t !== 'fields') same.b = p.b;
        }
      }
      const kept = merged.map(prunePatch).filter(Boolean);
      const entry = undoStack[idx];
      entry.patches = kept;
      entry.at = Date.now();
      if (!kept.length) { undoStack.splice(idx, 1); redoStack = []; return false; }
      redoStack = [];
      return true;
    }
    undoStack.push({ desc, patches: patchList, at: Date.now(), coalesce: e.coalesceKey || '' });
    if (undoStack.length > limit) undoStack.shift();
    redoStack = [];
    return true;
  }

  function applyAll(patches, dir) {
    const store = getStore();
    if (dir === 'undo') for (let i = patches.length - 1; i >= 0; i--) applyPatch(store, patches[i], 'undo');
    else for (const p of patches) applyPatch(store, p, 'redo');
  }

  function run(fromStack, toStack, label, dir) {
    const entry = fromStack[fromStack.length - 1];
    if (!entry) return { ok: false, error: '没有可' + label + '的操作' };
    applyAll(entry.patches, dir);
    try {
      save();
    } catch (err) {
      // save() 已把内存回滚到「最后一次成功落盘」的状态；栈指针不动，用户可重试
      return { ok: false, error: (dir === 'undo' ? '撤销' : '重做') + '失败：' + (err && err.message ? err.message : '无法保存') };
    }
    fromStack.pop();
    toStack.push(entry);
    if (toStack.length > limit) toStack.shift();
    return { ok: true, desc: entry.desc };
  }

  return {
    begin,
    commit,
    undo() { return run(undoStack, redoStack, '撤销', 'undo'); },
    redo() { return run(redoStack, undoStack, '重做', 'redo'); },
    info() {
      return {
        canUndo: undoStack.length,
        canRedo: redoStack.length,
        undoDesc: undoStack.length ? undoStack[undoStack.length - 1].desc : '',
        redoDesc: redoStack.length ? redoStack[redoStack.length - 1].desc : '',
      };
    },
    // 测试钩子：栈里实际存了多少字符。整库快照时代这个数按「份数 × 库大小」涨，
    // 差量之后只跟「改了几个字段」走，回归用它卡住回退。
    stats() {
      let chars = 0;
      for (const e of undoStack.concat(redoStack)) chars += JSON.stringify(e.patches).length;
      return { depth: undoStack.length, redo: redoStack.length, chars };
    },
    clear() { undoStack = []; redoStack = []; },
  };
}

module.exports = { createHistory, getEntity, MISSING, NOTE_SEP };
