'use strict';
/*
 * 标注扩展探针：下划线标注渲染 + 图片标注落盘（真实渲染进程）。
 * 被 test-anno-extras.js 调用。
 */
module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (fn()) return true; await sleep(80); } return !!fn(); };

  try {
    // 0. 打开文档
    const libReady = await waitFor(() => window.LibraryUI && LibraryUI.isOpen(), 10000);
    push('启动后文献库自动展开', libReady);
    const add = await pdfBridge.lib.addPdf('__SAMPLE__', { dedupe: true });
    push('样例 PDF 入库', !!(add && add.ok), JSON.stringify((add || {}).error));
    const key = add.item.key, filePath = add.item.attachment.path;
    const res = await pdfBridge.lib.openItem(key, 1);
    LibraryUI.hide();
    window.__libOpen(res);
    const loaded = await waitFor(() => window.App && App.state.pdfDoc && App.state.rendered.get(1), 25000);
    push('文档加载到第 1 页', loaded);
    if (!loaded) return { checks, stage: 'load' };

    // ===== 1. 下划线标注 =====
    const pageEl = App.pageEl(1);
    const uni = pageEl._unit || { w: 600, h: 800 };
    const rects = [
      { x: 60, y: 100, w: 220, h: 22 },
      { x: 60, y: 130, w: 180, h: 22 },
    ];
    const ul = Anno.addShape(1, {
      tool: 'mark', kind: 'underline', color: '#e53935', width: 0, rects,
      text: '带下划线的原文', comment: '',
    });
    push('下划线形状带稳定 id', !!(ul && ul.id && ul.id.startsWith('a')), ul && ul.id);
    await waitFor(() => pageEl.querySelector('.anno-base .text-underline'), 4000);
    const g = pageEl.querySelector('.anno-base .text-underline');
    push('页面渲染出下划线分组', !!g);
    const bars = g ? Array.from(g.querySelectorAll('rect')) : [];
    push('每行一个下划线（两条）', bars.length === 2, 'bars=' + bars.length);
    const thin = bars.every((b) => Math.abs((+b.getAttribute('height')) - 2) < 0.01);
    const wide = bars.every((b) => +b.getAttribute('width') > 100);
    push('下划线是细条（高 2、宽随行）', thin && wide,
      bars.map((b) => b.getAttribute('width') + '×' + b.getAttribute('height')).join(','));
    const noFill = bars.every((b) => (b.getAttribute('fill-opacity') || '1') === '0.95');
    push('下划线不整块填充（fill-opacity 0.95 细条）', noFill);

    // 保存后库里类型显示为「下划线」
    await App.flushAnnos();
    await sleep(300);
    const list1 = await pdfBridge.listAnnotations();
    const ulAnno = (list1 || []).find((a) => a.id === ul.id);
    push('标注列表识别为「下划线」', !!(ulAnno && ulAnno.kind === '下划线'), ulAnno && ulAnno.kind);

    // ===== 2. 图片标注落盘 =====
    // 1×1 透明 PNG（最小合法图），走真实 IPC：落盘 + 写标注文件
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const imgRes = await pdfBridge.saveImageAnno({
      path: filePath, page: 1, dataUrl: png,
      rect: { x: 120, y: 200, w: 160, h: 120 }, text: '图片标注 · 第 1 页',
    });
    push('图片标注保存成功', !!(imgRes && imgRes.ok), JSON.stringify(imgRes));
    push('图片落到 snapshots 目录', !!(imgRes && /^snapshots\\/img-.*\\.png$/.test(imgRes.image || '')), imgRes && imgRes.image);
    const imgBack = await pdfBridge.noteImage(imgRes && imgRes.image);
    push('图片标注的文件读得回来', !!(imgBack && imgBack.ok && /^data:image\\/png/.test(imgBack.dataUrl || '')), imgBack && (imgBack.error || 'ok'));

    // 标注文件里多了一条 tool:'image'
    const pages = await pdfBridge.loadAnnos(filePath);
    const imgShape = (pages[0] && pages[0].shapes || []).find((s) => s.tool === 'image');
    push('标注文件写入图片形状', !!(imgShape && imgShape.rects && imgShape.rects[0].w === 160), JSON.stringify(imgShape && imgShape.rects));
    push('图片形状带稳定 id', !!(imgShape && imgShape.id), imgShape && imgShape.id);

    // 列表里显示为「图片」
    const list2 = await pdfBridge.listAnnotations();
    const imgAnno = (list2 || []).find((a) => a.id === (imgShape && imgShape.id));
    push('标注列表识别为「图片」', !!(imgAnno && imgAnno.kind === '图片'), imgAnno && imgAnno.kind);

    // 页面重载后画出虚线框
    await waitFor(() => {
      const arr = (App.state.annos.get(1) || []);
      return arr.some((s) => s.tool === 'image');
    }, 6000);
    const dashed = pageEl.querySelector('.anno rect[stroke-dasharray]');
    push('页面上画出虚线框', !!dashed, dashed ? dashed.getAttribute('stroke-dasharray') : '');

    // ===== 3. 灯箱「存为标注」按钮存在 =====
    await App.openRegionLightbox(pageEl, 300, 300);
    const lbOpen = await waitFor(() => window.Lightbox && Lightbox.isOpen(), 15000);
    push('局部放大灯箱能打开', lbOpen);
    const btn = document.querySelector('#pdf-image-lightbox [data-lb-save-anno]');
    push('灯箱里有「存为标注」按钮', !!btn && !btn.hidden, btn ? btn.textContent : '');
    if (lbOpen) Lightbox.close();

    return { checks };
  } catch (e) {
    return { checks, fatal: String((e && e.stack) || e) };
  }
})()`;
