'use strict';
/*
 * 第七轮审核 R7-01 / R7-02 的定向回归（真实 Electron，探针走界面同一条路径）
 *
 * R7-01：文档刚打开时，内存标注是空的、磁盘上的旧标注还没读回来。
 *        这会儿保存 / 归档，会把「空」当成「这份文档没有标注」写回去，
 *        一次性抹掉上次正常保存的标注——而主进程的损坏检查查不出来，
 *        因为新写的文件是完全合法的 JSON，和「用户删光了」长得一模一样。
 *        修法：每次加载建一个「路径 + 代际 + promise」的恢复凭据，写盘前先等它落地，
 *        只有状态是 ok / missing 才动笔。
 *
 * R7-02：显式重建会把损坏的原文备份成 `<hash>.broken-<时间戳>.json`，
 *        备份留在同一个目录里且后缀是 .json，于是每次扫描活动标注都会把它算进来，
 *        解析失败 → 扫描被判不完整 → 回顾不敢清理孤儿卡片、界面一直报错。
 *        修法：枚举活动 sidecar 一律排除备份命名（备份本身保留）。
 *
 * 运行：node scripts/test-r7-anno-guard.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const JSZip = require('jszip');
const { runProbe } = require('./probe-runner');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); return true; }
  fail++;
  console.log('  FAIL ' + name + (detail ? '  <- ' + detail : ''));
  return false;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-r7anno-'));
  const ud = path.join(tmp, 'ud');
  fs.mkdirSync(ud);
  try {
    const crypto = require('crypto');
    const sidecarFor = (p) => path.join(ud, 'annotations',
      crypto.createHash('sha1').update(path.resolve(p)).digest('hex').slice(0, 20) + '.json');
    fs.mkdirSync(path.dirname(sidecarFor('x')), { recursive: true });

    // ---------- 夹具 ----------
    // R7-01：一份正常文档，预先写好一份合法 sidecar（里面有一条一定能找到的标注）
    const guardPath = path.join(tmp, 'guard.pdf');
    fs.copyFileSync(SAMPLE, guardPath);
    fs.writeFileSync(sidecarFor(guardPath), JSON.stringify({
      path: guardPath, saved: 1,
      pages: [{ page: 1, shapes: [{ id: 'saved-1', tool: 'text', text: 'VALID_SAVED_ANNOTATION', at: { x: 20, y: 30 } }] }],
    }));
    // R7-02：一份 sidecar 损坏的文档，用来验「重建后的备份不再污染扫描」
    const brokenPath = path.join(tmp, 'broken.pdf');
    {
      const d = await PDFDocument.create();
      const font = await d.embedFont(StandardFonts.Helvetica);
      const pg = d.addPage([420, 560]);
      pg.drawText('RECOVER TARGET', { x: 40, y: 500, size: 18, font });
      fs.writeFileSync(brokenPath, await d.save());
    }
    fs.writeFileSync(sidecarFor(brokenPath),
      '{"pages":[{"page":1,"shapes":[{"id":"r2","tool":"text","text":"RECOVER_ME"}');

    fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify({
      version: 8,
      items: [
        { key: 'g1', itemType: 'journalArticle', title: '已保存标注的文档', year: '2024', attachment: { path: guardPath, name: 'guard.pdf' } },
        { key: 'b1', itemType: 'journalArticle', title: '标注损坏的文档', year: '2023', attachment: { path: brokenPath, name: 'broken.pdf' } },
      ],
    }));

    const arcPath = path.join(tmp, 'early.zip');
    const noZipPath = path.join(tmp, 'refused.zip');   // unknown 时不应该生成出来的包

    const probe = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (await fn()) return true; await sleep(60); } return !!(await fn()); };
  const checks = [];
  const push = (n, okFlag, d) => checks.push([n, !!okFlag, d === undefined ? '' : String(d)]);
  const countAnnos = () => Array.from(App.state.annos.values()).reduce((n, a) => n + ((a && a.length) || 0), 0);

  try {
    const ready = await waitFor(() => window.LibraryUI && LibraryUI.isOpen(), 12000);
    push('文献库就绪', ready);
    if (!ready) return { checks };

    // ---------- R7-01：打开 → 不等读完就归档 ----------
    const res = await pdfBridge.lib.openItem('g1', 1);
    LibraryUI.hide();
    window.__libOpen(res);
    const loaded = await waitFor(() => App.state.filePath === ${JSON.stringify(guardPath)} && App.state.pdfDoc, 25000);
    push('文档已打开', loaded, App.state.filePath);
    if (!loaded) return { checks };

    // 这两个是观测值，不是断言：恢复可能已经回来了（取决于这一轮机器快慢），
    // 真正要守住的是下面的结果——旧标注没被砸掉。
    const statusAtCall = App.state.annoState.status;
    const memAtCall = countAnnos();
    push('调用归档这一刻的状态可读出来', !!statusAtCall, statusAtCall + '/' + memAtCall);

    const arc = await App.exportArchive(${JSON.stringify(arcPath)});
    push('归档没有假装成功', !!arc, JSON.stringify(arc));
    push('归档里带上读回来的那条标注', !!(arc && arc.ok && arc.annotations >= 1), JSON.stringify(arc));

    const after = await pdfBridge.loadAnnosState(${JSON.stringify(guardPath)});
    const dump = JSON.stringify(after || {});
    push('磁盘上的旧标注没有被空数组覆盖', dump.indexOf('VALID_SAVED_ANNOTATION') >= 0, dump.slice(0, 200));
    push('磁盘标注仍是合法状态', !!(after && after.status === 'ok' && after.pages && after.pages.length >= 1),
      (after && after.status) + '/' + (after && after.pages && after.pages.length));

    // ---------- R7-01 的另一半：刚打开就改标注，不能因此丢掉旧的，也不丢新的 ----------
    const res2 = await pdfBridge.lib.openItem('g1', 1);
    window.__libOpen(res2);
    await waitFor(() => App.state.filePath === ${JSON.stringify(guardPath)} && App.state.pdfDoc, 25000);
    // 注意是「追加」而不是整页替换：真实绘画是往该页数组里加一条，
    // 用 set 覆盖整个数组等于先手动删掉别人已经恢复出来的标注，那是另一码事。
    const early = { id: 'early-1', tool: 'text', at: { x: 40, y: 50 }, text: 'EARLY_EDIT', size: 14, color: '#111111' };
    const arr = App.state.annos.get(1) || [];
    arr.push(early);
    App.state.annos.set(1, arr);
    await App.flushAnnos();                      // 早到的一次：可能被拦，也可能等完再写
    await waitFor(() => App.state.annoState.status === 'ok', 15000);
    await App.flushAnnos();                      // 读完之后的这一次必须成功
    const both = JSON.stringify(await pdfBridge.loadAnnosState(${JSON.stringify(guardPath)}) || {});
    push('早到的一次保存没有抹掉旧标注', both.indexOf('VALID_SAVED_ANNOTATION') >= 0, both.slice(0, 200));
    push('早画的那条最终也落了盘', both.indexOf('EARLY_EDIT') >= 0, both.slice(0, 200));

    // ---------- R7-02：重建后的备份不该被当成活动标注 ----------
    const res3 = await pdfBridge.lib.openItem('b1', 1);
    window.__libOpen(res3);
    const loaded3 = await waitFor(() => App.state.filePath === ${JSON.stringify(brokenPath)} && App.state.pdfDoc, 25000);
    push('打开损坏夹具', loaded3, App.state.filePath);
    const broke = await waitFor(() => App.state.annoState.status === 'broken', 15000);
    push('这份状态是 broken', broke, App.state.annoState.status);

    const rebuilt = await App.rebuildAnnosFile();
    push('显式重建成功并留下备份', !!(rebuilt && rebuilt.ok === true && rebuilt.backup), JSON.stringify(rebuilt));

    // 重建之后那份故意留着的损坏备份，不该让回顾继续报「扫描不完整」
    const st = await pdfBridge.recall.state(30);
    push('回顾认为扫描完整（备份没被算进活动标注）', st && st.scanIncomplete === false,
      JSON.stringify((st && st.scanFailures) || []));
    push('回顾没有报出扫描失败项', !!(st && (!st.scanFailures || st.scanFailures.length === 0)),
      JSON.stringify((st && st.scanFailures) || []));

    const list = await pdfBridge.listAnnotations();
    push('活动标注清单里没有备份的残留', Array.isArray(list), 'count=' + (Array.isArray(list) ? list.length : 'n/a'));

    // ---------- R7-01 的策略：unknown 就是不许写（竞态可能抓不到，这里直接把状态摆上去）----------
    // 回到那份正常文档，等它读完
    const res4 = await pdfBridge.lib.openItem('g1', 1);
    window.__libOpen(res4);
    await waitFor(() => App.state.filePath === ${JSON.stringify(guardPath)} && App.state.pdfDoc, 25000);
    await waitFor(() => App.state.annoState.status === 'ok', 15000);
    push('重新打开后恢复到了 ok', App.state.annoState.status === 'ok', App.state.annoState.status);

    await App.flushAnnos();
    const sizeBefore = await pdfBridge.loadAnnosState(${JSON.stringify(guardPath)});
    const beforeCount = ((sizeBefore && sizeBefore.pages) || []).reduce((n, p) => n + ((p.shapes || []).length), 0);

    App.state.annoState = { status: 'unknown', annoPath: '', error: '' };
    App.state.annos.set(1, [{ id: 'ghost', tool: 'text', at: { x: 5, y: 5 }, text: 'GHOST_WRITE', size: 14, color: '#111' }]);
    const refusedArc = await App.exportArchive(${JSON.stringify(noZipPath)});
    push('unknown 时归档被拦下', !!(refusedArc && refusedArc.ok !== true && refusedArc.error === 'anno-not-ready'),
      JSON.stringify(refusedArc));
    const refusedSave = await App.flushAnnos();
    push('unknown 时保存也被拦下', refusedSave !== true, JSON.stringify(refusedSave));
    const untouched = JSON.stringify(await pdfBridge.loadAnnosState(${JSON.stringify(guardPath)}) || {});
    push('被拦之后旧标注一条没少',
      untouched.indexOf('VALID_SAVED_ANNOTATION') >= 0 && untouched.indexOf('GHOST_WRITE') < 0,
      (beforeCount + ' -> ' + untouched.slice(0, 160)));

    // 恢复成功后仍要能正常写（守卫不能变成永久禁令）。
    // 这一步换到那份重建过的文档上试：guard 那份得留给外面的字节比对，别再动它。
    // 结束上面手动制造的 unknown/ghost 状态；真正的保存失败应阻止离开，
    // 不能依赖切文档丢弃测试注入的数据来恢复环境。
    App.state.annos = new Map((sizeBefore.pages || []).map(p => [p.page, p.shapes || []]));
    App.state.annoState = { status: sizeBefore.status, annoPath: sizeBefore.annoPath || '', error: '' };
    const res5 = await pdfBridge.lib.openItem('b1', 1);
    window.__libOpen(res5);
    await waitFor(() => App.state.filePath === ${JSON.stringify(brokenPath)} && App.state.pdfDoc, 25000);
    await waitFor(() => App.state.annoState.status === 'ok', 15000);
    App.state.annos.set(1, [{ id: 'after-ok', tool: 'text', at: { x: 60, y: 70 }, text: 'AFTER_OK_WRITE', size: 14, color: '#222' }]);
    const okSave = await App.flushAnnos();
    push('状态回到 ok 后保存恢复正常', okSave === true, JSON.stringify(okSave));

    return { checks };
  } catch (e) { push('探针未抛错', false, String((e && e.stack) || e).slice(0, 500)); return { checks }; }
})()`;

    const probeFile = path.join(tmp, 'probe.cjs');
    fs.writeFileSync(probeFile, 'module.exports=' + JSON.stringify(probe));
    const r = runProbe({
      probe: probeFile,
      env: { PDFREADER_LIBRARY: path.join(tmp, 'library.json'), PDFREADER_DATA_DIR: tmp, PDFREADER_NO_AUTO_INDEX: '1' },
      args: ['--user-data-dir=' + ud],
      label: 'r7-anno-guard',
      timeout: 300000,
    });
    const nProbeFail = r.fail;

    // ---------- 文件级断言 ----------
    if (fs.existsSync(arcPath)) {
      const zip = await JSZip.loadAsync(fs.readFileSync(arcPath));
      const jf = JSON.parse(await zip.file('annotations.json').async('string'));
      const texts = (jf.pages || []).reduce((a, p) => a.concat((p.shapes || []).map((s) => String(s.text || ''))), []);
      ok('归档包里有那份已保存的标注', texts.indexOf('VALID_SAVED_ANNOTATION') >= 0, texts.join('|').slice(0, 160));
    } else {
      ok('归档包里有那份已保存的标注', false, 'zip 不存在（归档被拦也可能：' + arcPath + '）');
    }
    ok('状态是 unknown 时不出归档包（擒贼先验没动手）', !fs.existsSync(noZipPath), noZipPath);

    // R7-01：磁盘上的原文件必须一条不少
    const guardSidecar = sidecarFor(guardPath);
    if (fs.existsSync(guardSidecar)) {
      const txt = fs.readFileSync(guardSidecar, 'utf8');
      ok('原 sidecar 仍是合法 JSON', (() => { try { JSON.parse(txt); return true; } catch (_) { return false; } })());
      ok('原 sidecar 里还有 VALID_SAVED_ANNOTATION', txt.indexOf('VALID_SAVED_ANNOTATION') >= 0);
      ok('早画的那条也在同一个文件里', txt.indexOf('EARLY_EDIT') >= 0, txt.slice(0, 160));
    } else {
      ok('原 sidecar 仍是合法 JSON', false, 'sidecar 不存在');
    }

    // R7-02：备份必须在，且没被写回活动标注
    const dir = path.dirname(sidecarFor(brokenPath));
    const files = fs.readdirSync(dir);
    const backups = files.filter((f) => /\.broken-\d+\.json$/.test(f));
    ok('重建留下了损坏原文的备份', backups.length >= 1, files.join(','));
    if (backups.length) {
      const saved = fs.readFileSync(path.join(dir, backups[backups.length - 1]), 'utf8');
      ok('备份里保留着可捞回的原文', saved.indexOf('RECOVER_ME') >= 0, saved.slice(0, 120));
    }
    const rebuiltTxt = fs.readFileSync(sidecarFor(brokenPath), 'utf8');
    ok('重建后的正式 sidecar 是合法 JSON',
      (() => { try { JSON.parse(rebuiltTxt); return true; } catch (_) { return false; } })(), rebuiltTxt.slice(0, 120));

    if (nProbeFail) fail += nProbeFail;
    pass += (r.total || 0) - (r.fail || 0);

    console.log('[r7-anno-guard] ' + (fail ? 'FAIL (' + fail + '/' + (pass + fail) + ')' : 'PASS (' + pass + ')'));
    process.exit(fail ? 2 : 0);
  } catch (e) {
    console.error('[r7-anno-guard] ERROR', e && e.message ? e.message : e);
    process.exit(3);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
})();
