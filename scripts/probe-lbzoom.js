module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(60); } return !!fn(); };

  // GPU 能力：最大纹理尺寸（决定被放大的 canvas 会不会画不出来）
  function gpuInfo() {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return { webgl: false };
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        webgl: true,
        maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        maxViewport: gl.getParameter(gl.MAX_VIEWPORT_DIMS),
        renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      };
    } catch (e) { return { err: String(e && e.message || e) }; }
  }

  const loaded = await waitFor(() => window.App && App.state.pdfDoc && App.state.rendered.get(1), 15000);
  push('夹具 PDF 已加载', loaded);
  if (!loaded) return { checks, stage: 'load' };

  const info = { gpu: gpuInfo(), dpr: window.devicePixelRatio };

  // 切到看图模式并点第二张图（那张大 JPEG）
  const toolBtn = document.querySelector('.ntool[data-tool="image"]');
  if (toolBtn) toolBtn.click();
  await sleep(150);
  const page = await App.state.pdfDoc.getPage(1);
  const imgs = await PdfImages.collect(page);
  const rect = imgs[imgs.length - 1];
  const el = App.pageEl(1);
  const r = el.getBoundingClientRect();
  const s = App.state.scale || 1;
  el.dispatchEvent(new MouseEvent('click', {
    clientX: r.left + (rect.x + rect.w / 2) * s,
    clientY: r.top + (rect.y + rect.h / 2) * s,
    bubbles: true, cancelable: true,
  }));
  const opened = await waitFor(() => window.Lightbox && Lightbox.isOpen(), 12000);
  push('灯箱已打开', opened);
  if (!opened) return { checks, stage: 'open', info };

  const pv = document.querySelector('#pdf-image-lightbox .lb-preview');
  const describe = () => {
    const b = pv.getBoundingClientRect();
    const cs = getComputedStyle(pv);
    const sc = Lightbox.state.scale;
    const layerW = Math.round(b.width * (window.devicePixelRatio || 1));
    const layerH = Math.round(b.height * (window.devicePixelRatio || 1));
    return {
      scale: sc,
      canvasPx: pv.width + 'x' + pv.height,
      cssPx: Math.round(b.width) + 'x' + Math.round(b.height),
      layerPx: layerW + 'x' + layerH,
      transform: cs.transform,
      inlineTransform: pv.style.transform,
      inlineAttr: pv.getAttribute('style'),
      count: document.querySelectorAll('.lb-preview').length,
      parentClass: pv.parentElement ? pv.parentElement.className : '',
      rootCount: document.querySelectorAll('#pdf-image-lightbox').length,
    };
  };
  info.before = describe();

  // 双击放大
  const rectPv = pv.getBoundingClientRect();
  pv.dispatchEvent(new MouseEvent('dblclick', {
    clientX: rectPv.left + rectPv.width / 2, clientY: rectPv.top + rectPv.height / 2,
    bubbles: true, cancelable: true, cancelable2: true,
  }));
  await sleep(400);
  info.afterDbl = describe();

  // 用工具栏的「＋」再试一次（走另一条路径）
  const zin = document.querySelector('#pdf-image-lightbox [data-lb-zoom-in]');
  if (zin) { zin.click(); await sleep(400); }
  info.afterBtn = describe();

  // 画布自己的像素是否还在（内容没丢）
  try {
    const ctx = pv.getContext('2d');
    const d = ctx.getImageData(Math.round(pv.width / 2), Math.round(pv.height / 2), 1, 1).data;
    info.centerPixel = [d[0], d[1], d[2], d[3]];
  } catch (e) { info.centerPixelErr = String(e && e.message || e); }

  push('双击后缩放变了', info.afterDbl.scale !== info.before.scale,
    info.before.scale + ' -> ' + info.afterDbl.scale);
  push('画布内容仍在', !!info.centerPixel, JSON.stringify(info.centerPixel));

  // 再双击一次（2x -> 3x）
  pv.dispatchEvent(new MouseEvent('dblclick', {
    clientX: rectPv.left + rectPv.width / 2, clientY: rectPv.top + rectPv.height / 2,
    bubbles: true, cancelable: true,
  }));
  await sleep(400);
  info.afterDbl2 = describe();

  // 隐藏窗口里 CSS 过渡不推进，截图看不到真实布局；抓图前先关掉过渡
  if (pv) { pv.style.transition = 'none'; pv.getBoundingClientRect(); }
  await sleep(200);
  info.afterNoTransition = describe();

  return { checks, info };
})()`;
