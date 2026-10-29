'use strict';
/*
 * 附件指纹回归（2026-10-29）
 * 覆盖：同内容不同名 → 同指纹；同大小不同内容 → 不同指纹；
 *       目录遍历的扩展名 / 深度 / 数量上限；批量匹配不会把同一文件分配给两个条目。
 * 运行：node scripts/test-fingerprint.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Fp = require('../src/fingerprint.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-fp-'));
let n = 0;
function ok(name, fn) {
  fn();
  n++;
  console.log('  ok ' + n + ' - ' + name);
}
function write(p, buf) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  return p;
}

try {
  const big = Buffer.alloc(300 * 1024, 7);
  const a = write(path.join(root, 'a.pdf'), big);
  const b = write(path.join(root, 'sub', 'renamed.pdf'), big);          // 改名后换目录
  const c = write(path.join(root, 'same-size-diff.pdf'), Buffer.alloc(300 * 1024, 8));
  const d = write(path.join(root, 'note.txt'), Buffer.from('hello'));

  ok('同内容不同名 → 指纹一致', () => {
    const fa = Fp.fingerprintOf(a), fb = Fp.fingerprintOf(b);
    assert.ok(fa && fb);
    assert.equal(fa.size, fb.size);
    assert.equal(fa.hash, fb.hash);
    assert.equal(Fp.sameFingerprint(fa, fb), true);
  });

  ok('同大小不同内容 → 指纹不同', () => {
    const fa = Fp.fingerprintOf(a), fc = Fp.fingerprintOf(c);
    assert.equal(fa.size, fc.size, '构造用例应同大小');
    assert.notEqual(fa.hash, fc.hash);
    assert.equal(Fp.sameFingerprint(fa, fc), false);
  });

  ok('不存在的文件返回 null', () => {
    assert.equal(Fp.fingerprintOf(path.join(root, 'nope.pdf')), null);
  });

  ok('目录遍历按扩展名过滤', () => {
    const list = Fp.walkFiles(root, { exts: ['pdf'], maxDepth: 3, maxFiles: 100 });
    assert.ok(list.includes(a));
    assert.ok(list.includes(b), '子目录里的文件也要找到');
    assert.ok(!list.includes(d), 'txt 不该出现');
  });

  ok('目录遍历受深度限制', () => {
    const deep = write(path.join(root, 'l1', 'l2', 'l3', 'deep.pdf'), Buffer.from('deep'));
    const shallow = Fp.walkFiles(root, { exts: ['pdf'], maxDepth: 1, maxFiles: 100 });
    assert.ok(!shallow.includes(deep), '深度 1 不该走到 l3');
    const deeper = Fp.walkFiles(root, { exts: ['pdf'], maxDepth: 4, maxFiles: 100 });
    assert.ok(deeper.includes(deep));
  });

  ok('目录遍历受数量上限约束', () => {
    const list = Fp.walkFiles(root, { exts: ['pdf'], maxDepth: 3, maxFiles: 1 });
    assert.equal(list.length, 1);
  });

  ok('按指纹匹配找回改名后的文件', () => {
    const targets = [{ key: 'k1', fingerprint: Fp.fingerprintOf(a) }];
    const hit = Fp.matchByFingerprint(targets, [b, c]);
    assert.equal(hit.length, 1);
    assert.equal(hit[0].key, 'k1');
    assert.equal(hit[0].path, b, '应命中同内容的 b，而不是同大小的 c');
  });

  ok('一个候选文件不会分配给两个条目', () => {
    const fp = Fp.fingerprintOf(a);
    const targets = [{ key: 'k1', fingerprint: fp }, { key: 'k2', fingerprint: fp }];
    const hit = Fp.matchByFingerprint(targets, [b]);
    assert.equal(hit.length, 1, '只有一个候选时只能认回一条');
  });

  ok('没有指纹的条目被跳过', () => {
    const hit = Fp.matchByFingerprint([{ key: 'k1', fingerprint: null }], [b]);
    assert.equal(hit.length, 0);
  });

  ok('同名兜底匹配（不区分大小写）', () => {
    const hit = Fp.matchByBasename([{ key: 'k1', name: 'RENAMED.PDF' }], [b]);
    assert.equal(hit.length, 1);
    assert.equal(hit[0].path, b);
  });
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
}

console.log('\ntest-fingerprint: ' + n + ' 项通过');
