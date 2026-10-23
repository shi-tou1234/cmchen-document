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

module.exports = { atomicWrite };
