'use strict';
/*
 * SidecarStore —— 标注副文件（annotations/<hash>.json）的唯一读写入口。
 *
 * 为什么要有这一层：sidecar 的保存曾经散在主进程四个地方，每个入口各自 catch、
 * 各自决定「读失败怎么办」，于是同一个文件在不同入口有不同命运：
 *   · anno-save 已经区分 missing / ok / broken，损坏时拒绝覆盖；
 *   · anno-save-image 却把读失败当成「没有旧标注」，直接用新内容覆写，
 *     原文件里还能人工捞回的文字就没了（B02）；
 *   · anno-update 直接截断覆写，写到一半失败（磁盘满 / 无权限）原文件变成截断 JSON，
 *     而 catch 又把它解释成「没找到这条标注」，真正的写入失败被掩盖（B03）。
 *
 * 这里把三件事收成一套策略：
 *   read()   —— 读，结果分 missing / ok / broken，并把原因带出去；
 *   write()  —— 原子替换（先写临时文件再改名），失败抛出真实原因；
 *   update() —— 读改写一条龙：broken 默认拒绝，显式 force 时先备份再重建。
 *
 * 不做跨文件事务：标注真身在 sidecar，对象层在 library.json，两次写之间仍可能失败。
 * 调用方要先写真身、成功后再写库索引（见 anno-update / anno-save-image）。
 */
const fs = require('fs');
const path = require('path');

function createSidecarStore(opts) {
  const o = opts || {};
  const fileFor = o.fileFor || ((p) => p);
  const atomicWrite = o.atomicWrite;
  const atomicCreate = o.atomicCreate;
  const backupNameFor = o.backupNameFor || ((f) => f + '.bak-' + Date.now());

  // 读具体文件（迁移扫描按目录拿到的路径直接进来，不必再算 hash）
  function readPath(file) {
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return { status: 'missing', data: null, file, error: '' };
      return {
        status: 'broken', data: null, file,
        error: '读取失败：' + String((err && (err.code || err.message)) || err),
      };
    }
    let obj = null;
    try {
      obj = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch (e) {
      return { status: 'broken', data: null, file, error: 'JSON 解析失败：' + String((e && e.message) || e) };
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || (obj.pages != null && !Array.isArray(obj.pages))) {
      return { status: 'broken', data: null, file, error: '结构异常：pages 不是数组' };
    }
    return { status: 'ok', data: obj, file, error: '' };
  }

  function read(filePath) {
    if (!filePath) return { status: 'missing', data: null, file: '', error: '没有文档路径' };
    return readPath(fileFor(filePath));
  }

  // 原子写入；调用方拿到的 error 是磁盘的真实原因，不再统一成「没找到」
  function writePath(file, obj) {
    atomicWrite(file, JSON.stringify(obj));
    return { ok: true, file };
  }

  // 新建一份 sidecar，目标已存在时抛 EEXIST。搬标注（改名）走这里，
  // 不能走 writePath —— 后者是「替换」，会把目标路径上已有的标注整个盖掉（H02）。
  function createPath(file, obj) {
    if (atomicCreate) {
      atomicCreate(file, JSON.stringify(obj));
      return { ok: true, file };
    }
    if (fs.existsSync(file)) {
      const err = new Error('EEXIST: ' + file);
      err.code = 'EEXIST';
      throw err;
    }
    return writePath(file, obj);
  }

  function backupPath(file) {
    const b = backupNameFor(file);
    fs.copyFileSync(file, b);
    return b;
  }

  /*
   * 读改写。fn(data, st) 直接改 data，可以返回新对象。
   * 返回：
   *   { ok:true, data, backup, created }
   *   { ok:false, code:'broken'|'read'|'write', error, file }
   * broken 且没带 force 时不写盘——这是「不能拿空数据盖掉还能救的文件」的底线。
   */
  function update(filePath, fn, options) {
    if (!filePath) return { ok: false, code: 'read', file: '', error: '没有文档路径' };
    return updatePath(fileFor(filePath), fn, options);
  }

  function updatePath(file, fn, options) {
    const opt = options || {};
    const st = readPath(file);
    if (st.status === 'broken' && !opt.force) {
      return {
        ok: false, code: 'broken', file: st.file, annoPath: st.file,
        error: '标注文件已损坏，本次修改没有保存：' + path.basename(st.file) + '（' + st.error + '）',
      };
    }
    let backup = '';
    if (st.status === 'broken' && opt.force) {
      try { backup = backupPath(st.file); }
      catch (err) {
        return {
          ok: false, code: 'read', file: st.file, broken: true,
          error: '无法备份损坏的标注文件，为免丢数据已中止：' + String((err && err.message) || err),
        };
      }
    }
    const seed = st.status === 'ok'
      ? st.data
      : (typeof opt.empty === 'function' ? opt.empty() : { path: opt.docPath || '', saved: Date.now(), pages: [] });
    let next;
    try { next = fn(seed, st) || seed; }
    catch (err) { return { ok: false, code: 'update', file: st.file, error: String((err && err.message) || err) }; }
    try { writePath(st.file, next); }
    catch (err) {
      return {
        ok: false, code: 'write', file: st.file, broken: false, backup,
        error: '写入标注文件失败：' + String((err && (err.code || err.message)) || err),
      };
    }
    return { ok: true, data: next, file: st.file, backup, created: st.status === 'missing' };
  }

  return { read, readPath, writePath, createPath, backupPath, update, updatePath };
}

module.exports = { createSidecarStore };
