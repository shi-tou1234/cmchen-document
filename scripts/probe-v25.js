module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(60); } return !!fn(); };

  const loaded = await waitFor(() => window.App && App.state.pdfDoc && App.state.rendered.get(1), 20000);
  push('夹具 PDF 已加载（探针前提）', loaded);
  if (!loaded) return { checks, stage: 'load' };

  // 进入看图模式并点开那张大图
  const toolBtn = document.querySelector('.ntool[data-tool="image"]');
  if (toolBtn) toolBtn.click();
  await sleep(150);
  const page = await App.state.pdfDoc.getPage(1);
  const imgs = await PdfImages.collect(page);
  push('定位到内嵌大图', imgs.length >= 1, 'count=' + imgs.length);
  if (!imgs.length) return { checks, stage: 'images' };
  const rect = imgs[0];
  const el = App.pageEl(1);
  const r = el.getBoundingClientRect();
  const s = App.state.scale || 1;
  el.dispatchEvent(new MouseEvent('click', {
    clientX: r.left + (rect.x + rect.w / 2) * s,
    clientY: r.top + (rect.y + rect.h / 2) * s,
    bubbles: true, cancelable: true,
  }));
  const opened = await waitFor(() => window.Lightbox && Lightbox.isOpen(), 15000);
  push('点图片打开灯箱', opened);
  if (!opened) return { checks, stage: 'open' };

  const pv = document.querySelector('#pdf-image-lightbox .lb-preview');
  if (!pv) return { checks, stage: 'preview' };
  const srcW = Lightbox.state.natW || pv.width;
  const srcH = Lightbox.state.natH || pv.height;
  const inlineW = () => parseFloat(pv.style.width) || 0;
  const inlineH = () => parseFloat(pv.style.height) || 0;

  push('拿到了原图像素尺寸', srcW > 1000, srcW + 'x' + srcH);

  // 关键不变量：画布位图永远不超过原图像素
  // （以前是「原图大小的位图 + CSS scale」，放大后合成纹理 = 位图×倍数，
  //   超过显卡纹理上限就整块不画 —— 看着像双击放大后变白）
  const checkBitmapBounded = (tag) => {
    push('位图不超过原图像素（' + tag + '）', pv.width <= srcW && pv.height <= srcH,
      pv.width + 'x' + pv.height + ' vs ' + srcW + 'x' + srcH);
  };
  checkBitmapBounded('初始');

  // CSS 里不能再有 scale()：缩放改成「按显示分辨率重绘」，不用 CSS 放大位图
  push('CSS 变换里没有 scale()（不会再撑爆合成纹理）', !/scale[(]/.test(pv.style.transform || ''),
    pv.style.transform || '(none)');

  // 初始：位图应该是「显示分辨率」而不是原图大小（省内存）
  push('初始位图按显示分辨率（不是原图大小）', pv.width < srcW * 0.9,
    'bitmap=' + pv.width + ' src=' + srcW);
  const w0 = inlineW();

  // 放大到最大
  const zoomIn = document.querySelector('#pdf-image-lightbox [data-lb-zoom-in]');
  for (let i = 0; i < 6; i++) { if (zoomIn) zoomIn.click(); await sleep(80); }
  await sleep(250);
  const wMax = inlineW();
  push('放大后显示尺寸变大', wMax > w0 * 1.5, w0 + ' -> ' + wMax);
  checkBitmapBounded('放大后');
  push('放大后位图跟着变清晰（随缩放增长）', pv.width > (Lightbox.state.natW * 0.05),
    'bitmap=' + pv.width);
  push('显示尺寸 = 适配尺寸 × 缩放倍数（不失控）', wMax <= w0 * Lightbox.MAX_SCALE * 1.05,
    w0 + ' -> ' + wMax + ' (max=' + Lightbox.MAX_SCALE + ')');

  // 缩回最小
  const zoomOut = document.querySelector('#pdf-image-lightbox [data-lb-zoom-out]');
  for (let i = 0; i < 8; i++) { if (zoomOut) zoomOut.click(); await sleep(80); }
  await sleep(250);
  push('缩回最小', Math.abs(Lightbox.state.scale - 1) < 0.001, 'scale=' + Lightbox.state.scale);
  checkBitmapBounded('缩回后');

  // 画布内容确实画了东西（不是一片空白）
  try {
    const ctx = pv.getContext('2d');
    const d = ctx.getImageData(Math.round(pv.width / 2), Math.round(pv.height / 2), 1, 1).data;
    push('画布中心有像素', d[3] > 0, [d[0], d[1], d[2], d[3]].join(','));
  } catch (e) { push('画布中心有像素', false, String(e && e.message || e)); }

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(200);
  push('Esc 能关闭灯箱', !Lightbox.isOpen());
  return { checks };
})()`;
