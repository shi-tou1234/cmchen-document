// 文档链接检查：扫描仓库内所有 .md 的相对链接，确认目标文件真实存在。
//
// 为什么需要：docs 整理时把历史验收记录移进 archive/、截图移进 images/，会同时
// 打断 CHANGELOG / README 与归档文件之间的相对路径。这类死链不影响程序，但会让
// 后来的人找不到证据，所以移动文档后跑一遍。
//
// 用法：node scripts/check-doc-links.js
// 退出码：0 全部有效；1 存在死链（会逐条打印 文件:行号 -> 目标）。
//
// 说明：围栏代码块与行内代码里的 [x](y) 是举例，不是链接，先抹掉再匹配；
// 外链（http/https/mailto）与纯锚点（#xxx）跳过。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'dist', '.workbuddy', 'trove-fixes']);

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p, out);
    } else if (/\.md$/i.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

function main() {
  const files = walk(ROOT, []);
  let links = 0;
  const broken = [];

  for (const file of files) {
    // 行号要基于原文，所以先记录抹掉的字符为空格，保持偏移不变
    const raw = fs.readFileSync(file, 'utf8');
    const text = raw
      .replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));

    const re = /\]\(([^)\s]+)\)/g;
    let m;
    while ((m = re.exec(text))) {
      const target = m[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const clean = decodeURI(target.split('#')[0]);
      if (!clean) continue;
      links++;
      const abs = path.resolve(path.dirname(file), clean);
      if (!fs.existsSync(abs)) {
        broken.push({
          file: path.relative(ROOT, file),
          line: text.slice(0, m.index).split('\n').length,
          target,
        });
      }
    }
  }

  for (const b of broken) console.log('BROKEN ' + b.file + ':' + b.line + ' -> ' + b.target);
  console.log('---');
  console.log('scanned ' + files.length + ' md files, ' + links + ' relative links, ' + broken.length + ' broken');
  process.exit(broken.length ? 1 : 0);
}

main();
