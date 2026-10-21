'use strict';
/*
 * PDF 内嵌位图的定位与抽取（供「看图」模式点开放大用）。
 *
 * 做法：走 PDF.js 的操作符列表，自己跟踪 CTM（save / restore / transform /
 * setTransform），把每张内嵌位图在页面坐标系里的矩形算出来；能拿到原始位图
 * 就直接用原图像素（照片放大不糊），拿不到再退回「按区域高分辨率重渲染裁切」。
 *
 * 已知边界：
 *   - 只认直接画在页面上的位图；画在 Form XObject 里的图这版不认；
 *   - 图片蒙版（stencil mask）不算可见图片，跳过；
 *   - 矢量插图（不是位图）不算「图片」，看图模式会提示这里没有图片——
 *     矢量图放大用阅读器自己的缩放就行，本来就不糊。
 */
const PdfImages = (function () {
  // 矩阵相乘：m1 ∘ m2（先作用 m2，再作用 m1），与 pdf.js 的 Util.transform 一致
  function mul(m1, m2) {
    return [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ];
  }
  function apply(m, x, y) {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }
  function norm(a) {
    return [a[0], a[1], a[2], a[3], a[4], a[5]];
  }

  // 操作符列表 → [{ matrix, objId, inline }]，matrix 是 PDF 用户空间里的绘制矩阵
  function collectFromOpList(opList, ctm0) {
    const OPS = (window.pdfjsLib && window.pdfjsLib.OPS) || {};
    const out = [];
    let ctm = norm(ctm0 || [1, 0, 0, 1, 0, 0]);
    const stack = [];
    const fn = opList.fnArray || [];
    const args = opList.argsArray || [];
    for (let i = 0; i < fn.length; i++) {
      const op = fn[i];
      const a = args[i] || [];
      if (op === OPS.save) {
        stack.push(ctm.slice());
      } else if (op === OPS.restore) {
        ctm = stack.pop() || ctm;
      } else if (op === OPS.transform) {
        ctm = mul(ctm, norm(a.slice(0, 6)));
      } else if (op === OPS.setTransform) {
        ctm = norm(a.slice(0, 6));
      } else if (op === OPS.paintImageXObject) {
        // args: [objId, width, height]（pdf.js 3.x）——图画在单位正方形里，摆放由当前 CTM 决定
        out.push({ matrix: ctm.slice(), objId: a[0], inline: false, natW: a[1], natH: a[2] });
      } else if (op === OPS.paintJpegXObject) {
        // args: [objId]——按当前 CTM 画在单位正方形里
        out.push({ matrix: ctm.slice(), objId: a[0], inline: false });
      } else if (op === OPS.paintInlineImageXObject) {
        // args: [data, width, height]
        out.push({ matrix: ctm.slice(), objId: null, inline: true, data: a[0], width: a[1], height: a[2] });
      }
    }
    return out;
  }

  // 单位正方形四角 → 包围盒（PDF 用户空间）
  function bboxOf(matrix) {
    const pts = [apply(matrix, 0, 0), apply(matrix, 1, 0), apply(matrix, 1, 1), apply(matrix, 0, 1)];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const x = Math.min.apply(null, xs);
    const y = Math.min.apply(null, ys);
    return { x, y, w: Math.max.apply(null, xs) - x, h: Math.max.apply(null, ys) - y };
  }

  // 页面上所有内嵌位图 → [{ x, y, w, h }]，坐标是「scale=1 的视口像素」
  async function collect(page) {
    if (!page) return [];
    let opList = null;
    try { opList = await page.getOperatorList(); } catch (_) { return []; }
    if (!opList) return [];
    const items = collectFromOpList(opList, [1, 0, 0, 1, 0, 0]);
    const vp = page.getViewport({ scale: 1 });
    const vt = vp.transform;
    const out = [];
    for (const it of items) {
      const m = mul(vt, it.matrix);
      const b = bboxOf(m);
      if (!(b.w > 1 && b.h > 1)) continue;          // 忽略退化矩形
      if (b.w * b.h < 64) continue;                 // 忽略极小的装饰点
      out.push({ x: b.x, y: b.y, w: b.w, h: b.h, objId: it.objId, inline: it.inline,
        natW: it.natW || 0, natH: it.natH || 0 });   // 原始像素尺寸（合成重渲染时保清晰度用）
    }
    out.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    return out;
  }

  // 命中测试：单位坐标点落在哪张图里
  function findAt(images, x, y) {
    if (!images || !images.length) return null;
    for (let i = images.length - 1; i >= 0; i--) {
      const r = images[i];
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r;
    }
    return null;
  }

  // 取 PDF.js 已经解码好的位图对象（可能还没解码完，给它一点时间）
  function getObj(page, objId, timeout) {
    return new Promise((resolve) => {
      if (!page || !page.objs || objId == null) { resolve(null); return; }
      let settled = false;
      const done = (obj) => { if (!settled) { settled = true; resolve(obj || null); } };
      let obj = null;
      try { obj = page.objs.get(objId, done); } catch (_) { obj = null; }
      if (obj) { done(obj); return; }
      setTimeout(() => done(null), timeout || 1500);
    });
  }

  function drawTo(canvas, w, h) {
    canvas.width = Math.max(1, Math.round(w));
    canvas.height = Math.max(1, Math.round(h));
    return canvas.getContext('2d');
  }

  // 抽原始位图 → canvas；抽不到返回 null（调用方走区域重渲染兜底）
  async function extract(page, item) {
    if (!item) return null;
    const lib = window.pdfjsLib || {};
    try {
      if (item.inline && item.data) {
        const canvas = document.createElement('canvas');
        const ctx = drawTo(canvas, item.width || 1, item.height || 1);
        const bytes = item.data;
        const rgba = bytes && bytes.length === (item.width || 0) * (item.height || 0) * 4 ? bytes : null;
        if (rgba) {
          ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), item.width, item.height), 0, 0);
          return canvas;
        }
        return null;
      }
      const obj = await getObj(page, item.objId);
      if (!obj) return null;
      const w = obj.width || 0, h = obj.height || 0;
      if (!w || !h) return null;
      if (obj.bitmap) {
        const canvas = document.createElement('canvas');
        const ctx = drawTo(canvas, w, h);
        ctx.drawImage(obj.bitmap, 0, 0);
        return canvas;
      }
      if (obj.data && obj.data.length) {
        const kind = lib.ImageKind ? lib.ImageKind.RGB_24BPP : 2;
        if (obj.kind === kind) {
          // JPEG 原始字节
          const blob = new Blob([obj.data], { type: 'image/jpeg' });
          const bmp = await createImageBitmap(blob);
          const canvas = document.createElement('canvas');
          const ctx = drawTo(canvas, bmp.width, bmp.height);
          ctx.drawImage(bmp, 0, 0);
          bmp.close && bmp.close();
          return canvas;
        }
        // RGBA 原始像素
        if (obj.data.length === w * h * 4) {
          const canvas = document.createElement('canvas');
          const ctx = drawTo(canvas, w, h);
          ctx.putImageData(new ImageData(new Uint8ClampedArray(obj.data), w, h), 0, 0);
          return canvas;
        }
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  return { collect, findAt, extract, collectFromOpList, bboxOf, mul };
})();

window.PdfImages = PdfImages;
