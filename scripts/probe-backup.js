module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(60); } return !!fn(); };
  await waitFor(() => $$('#lib-grid .lib-card').length === 2, 6000);

  const st0 = await pdfBridge.getSettings();
  const dir = String(st0.dataDir).replace(/[\\\\/]+$/, '');
  const sum0 = await pdfBridge.lib.summary();
  const pdfPath = sum0.items[0].attachment.path;
  push('起始库有 2 条', sum0.items.length === 2, 'items=' + sum0.items.length);

  // 备份前写入一条标注
  await pdfBridge.saveAnnos(pdfPath, [{ page: 1, shapes: [{ tool: 'mark', color: '#ffeb3b', rects: [{ x: 1, y: 2, w: 30, h: 9 }], text: 'BEFORE', comment: '备份前的评论' }] }]);
  const beforeAnno = await pdfBridge.loadAnnos(pdfPath);
  push('备份前标注已写入', JSON.stringify(beforeAnno).indexOf('BEFORE') >= 0, JSON.stringify(beforeAnno).slice(0, 120));

  // 备份（目标目录不存在时应自动创建）
  const backupPath = dir + '/nested/backup-1.json';
  const bak = await pdfBridge.lib.backup(backupPath);
  push('一键备份成功', bak && bak.ok && bak.items === 2, JSON.stringify(bak));
  push('备份统计含 1 条标注', bak && bak.annotations === 1, String(bak && bak.annotations));

  // 备份后改库、改设置、改标注，模拟“用了一阵子”
  await pdfBridge.lib.updateItem('itA', { title: 'CHANGED' });
  const added = await pdfBridge.lib.addPdf(pdfPath);
  push('备份后新增条目', added && added.ok, JSON.stringify(added && added.ok));
  await pdfBridge.setSettings({ theme: 'dark' });
  await pdfBridge.saveAnnos(pdfPath, [{ page: 1, shapes: [{ tool: 'mark', color: '#ff9800', rects: [{ x: 5, y: 6, w: 40, h: 11 }], text: 'AFTER', comment: '备份后的评论' }] }]);
  const dirty = await pdfBridge.lib.summary();
  push('当前库已变成 3 条', dirty.items.length === 3, 'items=' + dirty.items.length);
  push('当前标题已改', (dirty.items.find((x) => x.key === 'itA') || {}).title === 'CHANGED');

  // 恢复
  const res = await pdfBridge.lib.restore(backupPath);
  push('恢复成功', res && res.ok, JSON.stringify(res));
  push('恢复返回 pre-restore 快照路径', !!(res && res.preBackup), res && res.preBackup);
  push('恢复的标注条数正确', res && res.annotations === 1, String(res && res.annotations));

  const restored = await pdfBridge.lib.summary();
  push('恢复后回到 2 条', restored.items.length === 2, 'items=' + restored.items.length);
  push('恢复后标题回到 Alpha', (restored.items.find((x) => x.key === 'itA') || {}).title === 'Alpha', JSON.stringify((restored.items.find((x) => x.key === 'itA') || {}).title));
  push('恢复后备份中不存在的新条目消失', !restored.items.some((x) => x.key === (added && added.item && added.item.key)), JSON.stringify(restored.items.map((x) => x.key)));

  const st1 = await pdfBridge.getSettings();
  push('恢复后主题回到 light', st1.theme === 'light', st1.theme);
  push('恢复保留当前数据目录', st1.dataDir === st0.dataDir, JSON.stringify([st0.dataDir, st1.dataDir]));

  const anno = await pdfBridge.loadAnnos(pdfPath);
  push('恢复后标注回到备份前', JSON.stringify(anno).indexOf('BEFORE') >= 0 && JSON.stringify(anno).indexOf('AFTER') < 0, JSON.stringify(anno).slice(0, 160));

  // 坏备份文件必须被拒绝，且不能破坏当前库
  const bad = await pdfBridge.lib.restore(dir + '/bad.json');
  push('拒绝非本程序备份', bad && bad.ok === false && /不是本程序/.test(bad.error), JSON.stringify(bad));
  const afterBad = await pdfBridge.lib.summary();
  push('坏备份不破坏当前库', afterBad.items.length === 2, 'items=' + afterBad.items.length);

  // 改名前的备份（app 标识 'pdf-reader'）必须仍能恢复
  const legacy = await pdfBridge.lib.restore(dir + '/legacy.json');
  push('恢复改名前的旧备份', legacy && legacy.ok, JSON.stringify(legacy));
  const afterLegacy = await pdfBridge.lib.summary();
  push('旧备份恢复后库有 2 条', afterLegacy.items.length === 2, 'items=' + afterLegacy.items.length);
  push('旧备份恢复后标题是 Alpha', (afterLegacy.items.find((x) => x.key === 'itA') || {}).title === 'Alpha', JSON.stringify(afterLegacy.items.map((x) => x.title)));
  const legacyAnno = await pdfBridge.loadAnnos(pdfPath);
  push('旧备份恢复后标注是 BEFORE', JSON.stringify(legacyAnno).indexOf('BEFORE') >= 0 && JSON.stringify(legacyAnno).indexOf('AFTER') < 0, JSON.stringify(legacyAnno).slice(0, 160));

  return { checks, backupPath: bak && bak.path, preBackup: res && res.preBackup, pdfPath };
})()`;
