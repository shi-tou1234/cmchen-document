module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(60); } return !!fn(); };

  const loaded = await waitFor(() => window.App && App.state.pdfDoc && App.state.numPages >= 1 && App.state.rendered.get(1), 15000);
  push('夹具 PDF 已加载（探针前提）', loaded, 'pages=' + (window.App ? App.state.numPages : 0));
  if (!loaded) return { checks, stage: 'load' };

  // 页面上应该能定位到那张内嵌位图
  const page = await App.state.pdfDoc.getPage(1);
  const imgs = await PdfImages.collect(page);
  push('能定位到页面里的内嵌位图', imgs.length === 1, 'count=' + imgs.length);
  if (!imgs.length) return { checks, stage: 'images' };
  const rect = imgs[0];
  push('图片矩形尺寸合理', rect.w > 20 && rect.h > 20, 'w=' + rect.w.toFixed(1) + ' h=' + rect.h.toFixed(1));

  // 切到看图模式
  const toolBtn = document.querySelector('.ntool[data-tool="image"]');
  push('工具栏有「看图」按钮', !!toolBtn);
  if (toolBtn) toolBtn.click();
  await sleep(120);
  push('已进入看图模式', document.body.classList.contains('tool-image'), document.body.className);

  // 点图片中心
  const el = App.pageEl(1);
  const r = el.getBoundingClientRect();
  const s = App.state.scale || 1;
  const cx = r.left + (rect.x + rect.w / 2) * s;
  const cy = r.top + (rect.y + rect.h / 2) * s;
  el.dispatchEvent(new MouseEvent('click', { clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
  const opened = await waitFor(() => window.Lightbox && Lightbox.isOpen(), 8000);
  push('点图片打开灯箱', opened, 'isOpen=' + (window.Lightbox ? Lightbox.isOpen() : 'n/a'));
  if (!opened) return { checks, stage: 'open' };

  const counter = document.querySelector('#pdf-image-lightbox .lb-counter');
  push('灯箱有计数', !!counter && /1\\s*\\/\\s*1/.test(counter.textContent || ''), counter ? counter.textContent : 'null');
  const preview = document.querySelector('#pdf-image-lightbox .lb-preview');
  push('灯箱里画出了图', !!preview && preview.width > 10 && preview.height > 10,
    preview ? preview.width + 'x' + preview.height : 'null');
  const cap = document.querySelector('#pdf-image-lightbox .lb-caption');
  push('灯箱有说明文字', !!cap && /第 1 页/.test(cap.textContent || ''), cap ? cap.textContent : 'null');

  // 缩放：点「＋」后百分比变大
  const zoomIn = document.querySelector('#pdf-image-lightbox [data-lb-zoom-in]');
  const label = document.querySelector('#pdf-image-lightbox [data-lb-zoom-reset]');
  const before = label ? label.textContent : '';
  if (zoomIn) zoomIn.click();
  await sleep(150);
  const after = label ? label.textContent : '';
  push('点「＋」能放大', before !== after && /%$/.test(after), before + ' -> ' + after);

  // 复位
  const zoomReset = document.querySelector('#pdf-image-lightbox [data-lb-zoom-reset]');
  if (zoomReset) zoomReset.click();
  await sleep(150);
  push('点百分比能复位缩放', (label ? label.textContent : '') === '100%', label ? label.textContent : 'null');

  // 滚轮缩放（以指针为中心）
  if (preview) {
    const pr = preview.getBoundingClientRect();
    preview.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, clientX: pr.left + pr.width / 2, clientY: pr.top + pr.height / 2, bubbles: true, cancelable: true }));
    await sleep(150);
    push('滚轮能缩放', (label ? label.textContent : '') !== '100%', label ? label.textContent : 'null');
    if (zoomReset) zoomReset.click();
  }

  // 触控板：一次手势连发很多小 delta，不能一下把缩放冲到上限（那会看着闪）
  if (preview) {
    const s0 = Lightbox.state.scale;
    const pr2 = preview.getBoundingClientRect();
    for (let i = 0; i < 24; i++) {
      preview.dispatchEvent(new WheelEvent('wheel', { deltaY: -3, clientX: pr2.left + pr2.width / 2, clientY: pr2.top + pr2.height / 2, bubbles: true, cancelable: true }));
    }
    await sleep(300);
    const s1 = Lightbox.state.scale;
    push('触控板连发小 delta 缩放平缓（不直接冲到上限）', s1 > s0 && s1 <= 2.5, 'before=' + s0 + ' after=' + s1.toFixed(2));
    push('缩放后没有超出上限', s1 <= Lightbox.MAX_SCALE + 0.001, 'scale=' + s1);
  }

  // 键盘：Esc 关闭
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(200);
  push('Esc 能关闭灯箱', !Lightbox.isOpen(), 'isOpen=' + Lightbox.isOpen());

  // 点非图片区域 → 应该开「局部放大」，而不是毫无反应
  await toolBtn.click();
  await sleep(100);
  const el2 = App.pageEl(1);
  const r2 = el2.getBoundingClientRect();
  const px = r2.left + 12, py = r2.top + 12;
  el2.dispatchEvent(new MouseEvent('click', { clientX: px, clientY: py, bubbles: true, cancelable: true }));
  const openedRegion = await waitFor(() => window.Lightbox && Lightbox.isOpen(), 12000);
  push('点空白处会开「局部放大」', openedRegion, 'isOpen=' + (window.Lightbox ? Lightbox.isOpen() : 'n/a'));
  if (openedRegion) {
    const cap2 = document.querySelector('#pdf-image-lightbox .lb-caption');
    push('局部放大有说明文字', !!cap2 && /局部放大/.test(cap2.textContent || ''), cap2 ? cap2.textContent : 'null');
    const pv = document.querySelector('#pdf-image-lightbox .lb-preview');
    push('局部放大画出了内容', !!pv && pv.width > 10 && pv.height > 10, pv ? pv.width + 'x' + pv.height : 'null');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await sleep(200);
  }

  return { checks };
})()`;
