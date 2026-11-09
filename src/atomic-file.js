'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Keep the last good destination intact until the complete replacement is ready.
// A locked destination must report failure; truncating it as a fallback loses data.
function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

/*
 * 同样是「先写临时文件、再落地」，但语义是「不存在才创建」：
 * 目标已经有文件时抛 EEXIST，绝不覆盖。附件改名搬标注必须用它（H02）——
 * 只 existsSync 查一次再写，检查与落地之间仍有窗口；而且「原文件坏了」
 * 从来不是覆盖另一个路径上有效标注的理由。
 * COPYFILE_EXCL 由文件系统保证失败即不覆盖，比手工判断可靠。
 */
function atomicCreate(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(tmp, data);
    fs.copyFileSync(tmp, file, fs.constants.COPYFILE_EXCL);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

module.exports = { atomicWrite, atomicCreate };
