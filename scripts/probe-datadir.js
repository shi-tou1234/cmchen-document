module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(60); } return !!fn(); };
  await waitFor(() => $$('#lib-grid .lib-card').length >= 1, 6000);

  const st0 = await pdfBridge.getSettings();
  const dir = String(st0.dataDir).replace(/[\\\\/]+$/, '');
  // 测试约定：数据目录名以 -move/-merge/-replace 结尾，探针据此选择迁移模式
  const mode = dir.slice(dir.lastIndexOf('-') + 1);
  const base = dir.replace(/[\\\\/][^\\\\/]*$/, '');
  const target = base + '/dataB';
  const norm = (p) => String(p).replace(/\\\\/g, '/').replace(/\\/+$/, '').toLowerCase();

  const sum0 = await pdfBridge.lib.summary();
  push('切换前库可读', sum0.items.length >= 1, 'items=' + sum0.items.length);
  const r = await pdfBridge.lib.chooseDataDir(target, mode);
  push('切换数据目录成功（' + mode + '）', r && r.ok, JSON.stringify(r));
  const st1 = await pdfBridge.getSettings();
  push('设置里 dataDir 指向新目录', norm(st1.dataDir) === norm(target), JSON.stringify([st1.dataDir, target]));
  const sum1 = await pdfBridge.lib.summary();
  push('切换后库可读', sum1.items.length >= 1, 'items=' + sum1.items.length);
  const again = await pdfBridge.lib.chooseDataDir(target, mode);
  push('重复切换到同一目录提示 unchanged', again && again.ok && again.unchanged === true, JSON.stringify(again));

  return { checks, mode, target, before: sum0.items.length, after: sum1.items.length, keys: sum1.items.map((x) => x.key), collections: sum1.collections.map((c) => c.id) };
})()`;
