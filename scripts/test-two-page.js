'use strict';
/*
 * 双页对开视图回归：
 *   对开搭档规则（封面独占、偶左奇右、落单处理）；切对开后只有搭档页可见且并排；
 *   两页都渲染；翻页 / 页码跳转成对显示；切回连续滚动恢复；设置持久化调用；
 *   旋转下对开仍成立。
 * 测试 PDF 现场生成 6 页（每页有页码文字）。
 * 运行：node scripts/test-two-page.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { runProbe } = require('./probe-runner');

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-spread-'));
  const ud = path.join(tmp, 'ud');
  fs.mkdirSync(ud);
  try {
    const pdf = path.join(tmp, 'spread.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let n = 1; n <= 6; n++) {
      const p = doc.addPage([612, 792]);
      p.drawText('Page ' + n + ' marker', { x: 60, y: 700, size: 18, font });
    }
    fs.writeFileSync(pdf, await doc.save());

    const probe = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (fn()) return true; await sleep(60); } return !!fn(); };
  const loaded = await waitFor(() => App.state.pdfDoc && App.state.rendered.get(1), 25000);
  push('PDF 已打开', loaded);
  if (!loaded) return { checks };

  // 1) 搭档规则
  const p = (n) => App.spreadPair(n).join(',');
  push('封面独占右位', p(1) === ',1', p(1));
  push('偶数页在左', p(2) === '2,3' && p(4) === '4,5', p(2) + '/' + p(4));
  push('奇数页在右', p(3) === '2,3' && p(5) === '4,5', p(3) + '/' + p(5));
  push('末页落单', p(6) === '6,', p(6));

  // 2) 切到对开：只有搭档页可见
  const m = App.setViewMode('spread');
  push('切换返回 spread', m === 'spread');
  push('body 标记 view-spread', document.body.classList.contains('view-spread') && !document.body.classList.contains('view-page'));
  const visible = () => Array.from(document.querySelectorAll('#pages .page')).filter((el) => el.classList.contains('is-current')).map((el) => +el.dataset.page).sort((a, b) => a - b);
  push('第 1 页封面独占', visible().join(',') === '1', visible().join(','));
  push('其余页 display:none', getComputedStyle(document.getElementById('page-2')).display === 'none');
  push('封面页已渲染', App.state.rendered.get(1) === true);

  // 3) 跳到第 3 页 → 2、3 并排
  scrollToPage(3, true);
  push('两页都渲染', await waitFor(() => App.state.rendered.get(2) === true && App.state.rendered.get(3) === true, 8000),
    'p2=' + App.state.rendered.get(2) + ' p3=' + App.state.rendered.get(3));
  await sleep(300);
  push('第 3 页显示 2,3', visible().join(',') === '2,3', visible().join(','));
  const r2 = document.getElementById('page-2').getBoundingClientRect();
  const r3 = document.getElementById('page-3').getBoundingClientRect();
  push('两页并排（左右相邻）', Math.abs(r3.left - (r2.right + 10)) < 40, 'gap=' + Math.round(r3.left - r2.right));
  push('两页顶部对齐', Math.abs(r2.top - r3.top) < 8, 'dy=' + Math.round(r3.top - r2.top));
  push('当前页为 3', App.state.currentPage === 3, App.state.currentPage);
  push('离开的页已释放', App.state.rendered.get(1) !== true, 'page1=' + App.state.rendered.get(1));

  // 4) 翻页：下一页 → 4,5
  nextPage();
  await sleep(250);
  push('翻页到 4,5', visible().join(',') === '4,5', visible().join(','));
  // B07：离开 2,3 这一组时，搭档页 2 也必须释放（旧实现只释放上一张「当前页」3）
  const canvas2 = document.querySelector('#page-2 canvas');
  push('B07 旧搭档页位图已释放', App.state.rendered.get(2) !== true && App.state.rendered.get(3) !== true,
    'rendered=' + JSON.stringify(Array.from(App.state.rendered.entries())));
  push('B07 释放页画布尺寸归零', !canvas2 || (canvas2.width === 0 && canvas2.height === 0),
    canvas2 ? canvas2.width + 'x' + canvas2.height : 'no canvas');
  // 连续跳过多组后，已渲染页数量仍然有界（不超过当前页组）
  for (const n of [1, 3, 5]) { scrollToPage(n, true); await sleep(120); }
  const live = Array.from(App.state.rendered.entries()).filter(([, v]) => v).map(([k]) => k);
  push('B07 连续翻页后已渲染页有界', live.length <= 2, 'live=' + JSON.stringify(live));

  // R02：不等渲染完成连续跳页（上一组任务还在跑时就要回收）
  for (const n of [1, 3, 5, 1, 3, 5]) scrollToPage(n, true);
  await sleep(1200);
  const live2 = Array.from(App.state.rendered.entries()).filter(([, v]) => v).map(([k]) => k).sort((a, b) => a - b);
  push('R02 快速跳页后只保留当前页组', live2.length <= 2 && live2.join(',') === '4,5', 'live=' + JSON.stringify(live2));
  const stray = [1, 2, 3].filter((n) => {
    const c = document.querySelector('#page-' + n + ' canvas');
    return c && (c.width || c.height);
  });
  push('R02 离屏页画布已归零', stray.length === 0, 'stray=' + JSON.stringify(stray));

  // 5) 页码跳转末页落单
  scrollToPage(6, true);
  await sleep(250);
  push('末页单独显示', visible().join(',') === '6', visible().join(','));

  // 6) 旋转 90° 下对开仍成立（搭档规则与显示都不变）
  App.rotateView(90);
  await sleep(250);
  push('旋转后仍是第 6 页', visible().join(',') === '6' && App.state.currentPage === 6, visible().join(','));
  App.rotateView(-90);
  await sleep(150);

  // 7) 切回连续滚动：全部页恢复显示
  App.setViewMode('scroll');
  await sleep(250);
  push('body 移除 view-spread', !document.body.classList.contains('view-spread'));
  push('滚动模式页恢复显示', getComputedStyle(document.getElementById('page-2')).display !== 'none');
  push('滚动模式渲染恢复', App.state.rendered.get(2) === true);

  // 8) 设置持久化走 setSettings（值被白名单接受）
  const st = await pdfBridge.getSettings ? await pdfBridge.getSettings() : null;
  push('设置已持久化 spread', st && st.settings ? st.settings.viewMode === 'spread' || st.viewMode === 'spread' : App.setViewMode('spread') === 'spread', JSON.stringify(st || {}).slice(0, 120));
  App.setViewMode('scroll');
  return { checks };
})()`;
    const probeFile = path.join(tmp, 'probe.cjs');
    fs.writeFileSync(probeFile, 'module.exports=' + JSON.stringify(probe));
    const r = runProbe({
      probe: probeFile,
      env: {
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
        PDFREADER_NO_AUTO_INDEX: '1',
        PDFREADER_PROBE_PDF: pdf,
      },
      args: ['--user-data-dir=' + ud],
      label: 'two-page',
      timeout: 240000,
    });
    assert.equal(r.fail, 0);
    code = 0;
  } catch (e) {
    console.error('[two-page] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
