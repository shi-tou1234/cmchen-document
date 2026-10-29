'use strict';
/*
 * 文件指纹：用来在附件被改名 / 移动后，仍然能认出「这就是原来那个文件」。
 *
 * 为什么不能只比文件名：改名恰恰是最常见的场景（用户整理文件夹、按标题重命名）。
 * 为什么不能全文件哈希：几百 MB 的 PDF 每次打开都算一遍太贵。
 * 折中方案：文件大小 + 首 64 KB + 尾 64 KB 的 SHA-1。PDF 的结构（文件头、xref 表、
 * 尾部 trailer）都落在这两段里，实际区分度足够；不同文件同大小又同首尾的概率极低。
 *
 * 指纹必须在「文件还在的时候」算好并存进条目——文件丢了以后再算是不可能的。
 * 所以导入 / 重新定位 / 首次成功打开时都会补一次。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CHUNK = 64 * 1024;

function readAt(fd, position, length) {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, position);
  return buf.subarray(0, n);
}

// 返回 { size, hash }；读不了就返回 null（不抛错，调用方当「没有指纹」处理）
function fingerprintOf(filePath) {
  let fd = null;
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size <= 0) return null;
    const size = st.size;
    fd = fs.openSync(filePath, 'r');
    const h = crypto.createHash('sha1');
    h.update('size:' + size + '\n');
    if (size <= CHUNK * 2) {
      h.update(readAt(fd, 0, size));
    } else {
      h.update(readAt(fd, 0, CHUNK));
      h.update(readAt(fd, size - CHUNK, CHUNK));
    }
    return { size, hash: h.digest('hex') };
  } catch (_) {
    return null;
  } finally {
    try { if (fd !== null) fs.closeSync(fd); } catch (_) {}
  }
}

function sameFingerprint(a, b) {
  return !!(a && b && a.size > 0 && a.size === b.size
    && typeof a.hash === 'string' && a.hash && a.hash === b.hash);
}

// 目录遍历：默认 3 层、最多 5000 个文件，跳过明显的系统/工程目录，避免扫全盘。
function walkFiles(dir, opts) {
  const o = opts || {};
  const exts = Array.isArray(o.exts) && o.exts.length
    ? new Set(o.exts.map((e) => String(e).toLowerCase().replace(/^\./, '')))
    : null;
  const maxDepth = Number.isFinite(+o.maxDepth) ? Math.max(0, Math.floor(+o.maxDepth)) : 3;
  const maxFiles = Number.isFinite(+o.maxFiles) ? Math.max(1, Math.floor(+o.maxFiles)) : 5000;
  const skip = new Set(['node_modules', '.git', '$recycle.bin', 'system volume information', 'windows', 'appdata', 'program files', 'program files (x86)']);
  const out = [];
  const queue = [{ dir, depth: 0 }];
  while (queue.length && out.length < maxFiles) {
    const cur = queue.shift();
    let entries = [];
    try { entries = fs.readdirSync(cur.dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (out.length >= maxFiles) break;
      const full = path.join(cur.dir, e.name);
      if (e.isDirectory()) {
        if (cur.depth >= maxDepth) continue;
        const low = e.name.toLowerCase();
        if (skip.has(low) || low.startsWith('.')) continue;
        queue.push({ dir: full, depth: cur.depth + 1 });
      } else if (e.isFile()) {
        if (exts && !exts.has(path.extname(e.name).slice(1).toLowerCase())) continue;
        out.push(full);
      }
    }
  }
  return out;
}

/*
 * 在候选文件里给「失联的附件」找原文件。
 * targets: [{ key, fingerprint:{size,hash} }]
 * 返回 [{ key, path }]。
 *
 * 先按大小分桶，只对同大小的候选算哈希——目录里几千个文件时这是数量级的差别。
 * 一个候选文件只分配给一个条目（used 去重），避免同一份文件被两条记录抢走。
 */
function matchByFingerprint(targets, candidates) {
  const bySize = new Map();
  for (const p of candidates) {
    let st = null;
    try { st = fs.statSync(p); } catch (_) { continue; }
    if (!st.isFile() || st.size <= 0) continue;
    if (!bySize.has(st.size)) bySize.set(st.size, []);
    bySize.get(st.size).push(p);
  }
  const used = new Set();
  const out = [];
  for (const t of targets) {
    const fp = t && t.fingerprint;
    if (!fp || !fp.size || !fp.hash) continue;
    const list = bySize.get(fp.size) || [];
    for (const p of list) {
      if (used.has(p)) continue;
      const got = fingerprintOf(p);
      if (got && got.hash === fp.hash) {
        out.push({ key: t.key, path: p });
        used.add(p);
        break;
      }
    }
  }
  return out;
}

// 没有指纹时的兜底：同名（不区分大小写）且在同一个目录里。
// 只在「旧目录还在、只是文件名大小写或所在层级变了」这类场景有用；调用方应把它当低置信度结果。
function matchByBasename(targets, candidates) {
  const byName = new Map();
  for (const p of candidates) {
    const k = path.basename(p).toLowerCase();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(p);
  }
  const used = new Set();
  const out = [];
  for (const t of targets) {
    const name = String(t && t.name || '').toLowerCase();
    if (!name) continue;
    const list = byName.get(name) || [];
    const p = list.find((x) => !used.has(x));
    if (p) { out.push({ key: t.key, path: p }); used.add(p); }
  }
  return out;
}

module.exports = { fingerprintOf, sameFingerprint, walkFiles, matchByFingerprint, matchByBasename, CHUNK };
