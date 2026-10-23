'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOTS = new Set(['snapshots', 'styles', 'attachments']);
const MAX_BACKUP_BYTES = 60 * 1024 * 1024;
function safeName(name) {
  const s = String(name).replace(/\\/g, '/');
  if (!ROOTS.has(s.split('/')[0]) || s.split('/').some(p => !p || p === '.' || p === '..' || /[:\x00]/.test(p))) {
    throw new Error('备份资源路径不合法：' + name);
  }
  return s;
}
function listFiles(dir) {
  const out = [];
  function walk(rel) {
    const full = path.join(dir, rel);
    if (!fs.existsSync(full)) return;
    if (fs.lstatSync(full).isSymbolicLink()) throw new Error('资源目录包含符号链接：' + rel);
    if (fs.statSync(full).isDirectory()) {
      for (const name of fs.readdirSync(full)) walk(path.join(rel, name));
    } else out.push(rel.replace(/\\/g, '/'));
  }
  for (const root of ROOTS) walk(root);
  return out;
}
function readBundle(dir, limit = MAX_BACKUP_BYTES) {
  const out = {};
  let bytes = 0;
  for (const rel of listFiles(dir)) {
    const file = path.join(dir, rel);
    bytes += fs.statSync(file).size;
    if (bytes > limit) throw new Error('托管资源超过备份上限（60 MB），备份未生成；请复制整个数据目录备份');
    out[rel] = fs.readFileSync(file).toString('base64');
  }
  return out;
}

// Stage every write and its previous contents before publishing any of them.
// Rollback uses rename so a partially installed library cannot become the active one.
class FileTransaction {
  constructor() {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-transaction-'));
    this.entries = [];
  }
  add(target, data, source) {
    const n = this.entries.length;
    const staged = path.join(this.dir, n + '.new');
    const previous = path.join(this.dir, n + '.old');
    if (source) fs.copyFileSync(source, staged);
    else fs.writeFileSync(staged, data);
    const exists = fs.existsSync(target);
    if (exists) fs.copyFileSync(target, previous);
    this.entries.push({ target, staged, previous, exists, installed: false });
  }
  remove(target) {
    if (!fs.existsSync(target)) return;
    const previous = path.join(this.dir, this.entries.length + '.old');
    fs.copyFileSync(target, previous);
    this.entries.push({ target, previous, exists: true, remove: true, installed: false });
  }
  commit() {
    try {
      for (const e of this.entries) {
        if (e.remove) { fs.unlinkSync(e.target); e.installed = true; continue; }
        fs.mkdirSync(path.dirname(e.target), { recursive: true });
        // The temporary file must share the destination volume (data can live on another drive).
        const tmp = e.target + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
        try { fs.copyFileSync(e.staged, tmp); fs.renameSync(tmp, e.target); e.installed = true; }
        finally { try { fs.unlinkSync(tmp); } catch (_) {} }
      }
    } catch (err) {
      const failures = [];
      for (const e of this.entries.slice().reverse()) {
        if (!e.installed) continue;
        try {
          if (e.exists) {
            const tmp = e.target + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
            try { fs.copyFileSync(e.previous, tmp); fs.renameSync(tmp, e.target); }
            finally { try { fs.unlinkSync(tmp); } catch (_) {} }
          }
          else fs.unlinkSync(e.target);
        } catch (restoreError) { failures.push(restoreError.message); }
      }
      if (failures.length) {
        this.preserve = true;
        throw new Error(err.message + '；回滚未完成，恢复文件保留在 ' + this.dir + '：' + failures.join('；'));
      }
      throw err;
    }
  }
  dispose() { if (!this.preserve) fs.rmSync(this.dir, { recursive: true, force: true }); }
}

function fingerprint(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null))) hash.update(buf.subarray(0, n));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}
function installResources(tx, targetDir, sourceDir, bundle) {
  const map = new Map();
  const files = bundle ? Object.keys(bundle) : listFiles(sourceDir);
  const names = new Set();
  const planned = new Map();
  let bytes = 0;
  for (const name of files) {
    const rel = safeName(name);
    if (names.has(rel.toLowerCase())) throw new Error('备份资源路径重复：' + name);
    names.add(rel.toLowerCase());
    const source = bundle ? null : path.join(sourceDir, rel);
    if (bundle && (typeof bundle[name] !== 'string' || bundle[name].length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(bundle[name]))) throw new Error('备份资源编码不合法：' + name);
    if (bundle && bundle[name].length > Math.ceil((MAX_BACKUP_BYTES - bytes) / 3) * 4 + 4) throw new Error('备份资源超过 60 MB 上限');
    const data = bundle ? Buffer.from(String(bundle[name]), 'base64') : null;
    if (data) {
      if (data.toString('base64') !== bundle[name]) throw new Error('备份资源编码不合法：' + name);
      bytes += data.length;
      if (bytes > MAX_BACKUP_BYTES) throw new Error('备份资源超过 60 MB 上限');
    }
    let destRel = rel;
    const digest = data ? crypto.createHash('sha256').update(data).digest('hex') : fingerprint(source);
    let attempt = 0;
    while (planned.has(destRel.toLowerCase()) || fs.existsSync(path.join(targetDir, destRel))) {
      const existing = planned.get(destRel.toLowerCase()) || fingerprint(path.join(targetDir, destRel));
      if (existing === digest) break;
      const ext = path.extname(rel);
      destRel = rel.slice(0, rel.length - ext.length) + '-' + digest.slice(0, 12) + (attempt ? '-' + attempt : '') + ext;
      attempt++;
    }
    map.set(rel, destRel);
    if (!planned.has(destRel.toLowerCase()) && !fs.existsSync(path.join(targetDir, destRel))) tx.add(path.join(targetDir, destRel), data, source);
    planned.set(destRel.toLowerCase(), digest);
  }
  return map;
}

function remapStore(store, sourceDir, targetDir, map) {
  const out = JSON.parse(JSON.stringify(store));
  function remap(value) {
    if (!value) return value;
    const rel = path.isAbsolute(value) ? path.relative(sourceDir || targetDir, value).replace(/\\/g, '/') : value.replace(/\\/g, '/');
    if (!map.has(rel)) return value; // External documents remain at their original paths.
    return path.isAbsolute(value) ? path.join(targetDir, map.get(rel)) : map.get(rel);
  }
  const replacements = [];
  for (const [from, to] of map) {
    replacements.push([from, to], [from.replace(/\//g, '\\'), to]);
    if (sourceDir) {
      const abs = path.join(sourceDir, from), dest = path.join(targetDir, to);
      replacements.push([abs, dest], [abs.replace(/\\/g, '/'), dest.replace(/\\/g, '/')]);
    }
  }
  replacements.sort((a, b) => b[0].length - a[0].length);
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const byText = new Map(replacements);
  const pattern = replacements.length ? new RegExp(replacements.map(([s]) => escape(s)).join('|'), 'g') : null;
  for (const it of out.items || []) {
    if (it.attachment) it.attachment.path = remap(it.attachment.path);
    if (it.snapshot) { it.snapshot.path = remap(it.snapshot.path); it.snapshot.png = remap(it.snapshot.png); }
    for (const n of it.notes || []) {
      n.image = remap(n.image);
      for (const field of ['text', 'html']) if (pattern && n[field]) n[field] = n[field].replace(pattern, s => byText.get(s));
    }
  }
  return out;
}

module.exports = { FileTransaction, readBundle, installResources, remapStore, safeName };
