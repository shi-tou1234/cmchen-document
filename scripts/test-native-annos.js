'use strict';
/*
 * PDF 原生批注导入回归（v29）。
 *
 * 用 pdf-lib 造一份真的带 /Annots 的 PDF（不是 mock）：高亮 / 下划线 / 波浪线 /
 * 删除线 / 便签 / 文字框 / 两笔手绘 / 方框 / 直线，外加一条第一版不支持的 Circle。
 * 然后跑真实 Electron 探针：导入 → 断言映射与原文提取 → 再导入一次验证去重 →
 * 落盘 → 导出带下划线的副本。
 *
 * 运行：node scripts/test-native-annos.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { PDFDocument, PDFName, PDFHexString, degrees } = require('pdf-lib');
const { runProbe } = require('./probe-runner');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-native-annos-'));
const FIX = path.join(tmp, 'native-annos.pdf');
const UDD = path.join(tmp, 'ud');
const DATA = path.join(tmp, 'data');
fs.mkdirSync(UDD, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });

function hash(p) { return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); }

// 读 PDF 附件。pdf-lib 只负责写，读回来用 PDF.js（与渲染层同一条路径）。
// PDF.js 的 legacy 构建在 Node 里会尝试 polyfill canvas 并打两条无害警告，这里临时静音。
async function readAttachments(file) {
  const realLog = console.log;
  let pdfjs;
  try {
    console.log = () => {};
    pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  } finally {
    console.log = realLog;
  }
  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  try { return await doc.getAttachments(); } finally { try { await doc.destroy(); } catch (_) {} }
}

async function makeFixture(file) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont('Helvetica');
  page.drawText('Native highlight target sentence.', { x: 72, y: 700, size: 14, font });
  page.drawText('Underlined words here.', { x: 72, y: 660, size: 14, font });
  page.drawText('Squiggly words here.', { x: 72, y: 620, size: 14, font });
  page.drawText('Strikeout words here.', { x: 72, y: 580, size: 14, font });

  const ctx = doc.context;
  const mk = (fields) => {
    const d = ctx.obj({});
    for (const [k, v] of Object.entries(fields)) d.set(PDFName.of(k), v);
    d.set(PDFName.of('Type'), PDFName.of('Annot'));
    d.set(PDFName.of('F'), ctx.obj(4));
    d.set(PDFName.of('P'), page.ref);
    return ctx.register(d);
  };
  const quad = (y1, y2) => ctx.obj([72, y2, 300, y2, 72, y1, 300, y1]);
  const refs = [
    mk({
      Subtype: PDFName.of('Highlight'), Rect: ctx.obj([72, 696, 300, 716]), QuadPoints: quad(696, 716),
      C: ctx.obj([1, 0.85, 0.2]), Contents: PDFHexString.fromText('native comment'),
      T: PDFHexString.fromText('Alice'), NM: PDFHexString.fromText('hl-1'),
    }),
    mk({
      Subtype: PDFName.of('Underline'), Rect: ctx.obj([72, 656, 300, 676]), QuadPoints: quad(656, 676),
      C: ctx.obj([0.2, 0.5, 1]), Contents: PDFHexString.fromText('underline comment'),
      T: PDFHexString.fromText('Bob'), NM: PDFHexString.fromText('ul-1'),
    }),
    mk({
      Subtype: PDFName.of('Squiggly'), Rect: ctx.obj([72, 616, 300, 636]), QuadPoints: quad(616, 636),
      C: ctx.obj([0.9, 0.3, 0.2]), NM: PDFHexString.fromText('sq-1'),
    }),
    mk({
      Subtype: PDFName.of('StrikeOut'), Rect: ctx.obj([72, 576, 300, 596]), QuadPoints: quad(576, 596),
      C: ctx.obj([0.8, 0.1, 0.1]), NM: PDFHexString.fromText('so-1'),
    }),
    mk({
      Subtype: PDFName.of('Text'), Rect: ctx.obj([320, 688, 342, 710]),
      Contents: PDFHexString.fromText('sticky note'), T: PDFHexString.fromText('Carol'),
      NM: PDFHexString.fromText('tx-1'),
    }),
    mk({
      Subtype: PDFName.of('FreeText'), Rect: ctx.obj([320, 620, 460, 650]),
      Contents: PDFHexString.fromText('free text native'), T: PDFHexString.fromText('Dan'),
      NM: PDFHexString.fromText('ft-1'),
    }),
    mk({
      Subtype: PDFName.of('Ink'), Rect: ctx.obj([72, 520, 260, 560]),
      InkList: ctx.obj([[72, 530, 120, 550, 180, 525]]), C: ctx.obj([0.9, 0.2, 0.2]),
      BS: ctx.obj({ W: 3 }), NM: PDFHexString.fromText('ink-1'),
    }),
    mk({
      Subtype: PDFName.of('Ink'), Rect: ctx.obj([72, 500, 260, 540]),
      InkList: ctx.obj([[200, 505, 240, 535]]), C: ctx.obj([0.2, 0.6, 0.3]),
      BS: ctx.obj({ W: 2 }), NM: PDFHexString.fromText('ink-2'),
    }),
    mk({
      Subtype: PDFName.of('Square'), Rect: ctx.obj([330, 520, 470, 570]),
      C: ctx.obj([0.4, 0.4, 0.4]), BS: ctx.obj({ W: 2 }), NM: PDFHexString.fromText('sq-2'),
    }),
    mk({
      Subtype: PDFName.of('Line'), Rect: ctx.obj([330, 470, 470, 500]), L: ctx.obj([330, 475, 470, 495]),
      C: ctx.obj([0.1, 0.1, 0.6]), BS: ctx.obj({ W: 2 }), NM: PDFHexString.fromText('ln-1'),
    }),
    // 第一版不支持：应计入 skipped，而不是静默丢掉
    mk({
      Subtype: PDFName.of('Circle'), Rect: ctx.obj([330, 400, 470, 450]),
      C: ctx.obj([0.5, 0.5, 0.5]), NM: PDFHexString.fromText('ci-1'),
    }),
  ];
  page.node.set(PDFName.of('Annots'), ctx.obj(refs));

  // 第二页：旋转 90° + 非零 CropBox，验证导入走 viewport 而不是手写三角函数
  const p2 = doc.addPage([595, 842]);
  p2.setRotation(degrees(90));
  p2.setCropBox(20, 20, 555, 802);
  p2.drawText('Rotated target sentence.', { x: 200, y: 400, size: 14, font });
  const d2 = ctx.obj({});
  d2.set(PDFName.of('Type'), PDFName.of('Annot'));
  d2.set(PDFName.of('Subtype'), PDFName.of('Highlight'));
  d2.set(PDFName.of('Rect'), ctx.obj([198, 396, 360, 416]));
  d2.set(PDFName.of('QuadPoints'), ctx.obj([198, 416, 360, 416, 198, 396, 360, 396]));
  d2.set(PDFName.of('C'), ctx.obj([1, 0.9, 0.3]));
  d2.set(PDFName.of('Contents'), PDFHexString.fromText('rotated comment'));
  d2.set(PDFName.of('F'), ctx.obj(4));
  d2.set(PDFName.of('P'), p2.ref);
  p2.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(d2)]));

  fs.writeFileSync(file, await doc.save());
}

(async () => {
  await makeFixture(FIX);
  const beforeHash = hash(FIX);
  const OUT = path.join(tmp, 'exported-with-natives.pdf');
  let r;
  try {
    r = runProbe({
      probePath: path.join(__dirname, 'probe-native-annos.js'),
      inject: { __OUTPDF__: JSON.stringify(OUT.replace(/\\/g, '/')) },
      tmpDir: tmp,
      env: {
        PDFREADER_PROBE_PDF: FIX,
        PDFREADER_DATA_DIR: DATA,
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + UDD],
      label: 'native-annos',
      timeout: 180000,
    });
  } catch (e) {
    console.error('[native-annos] ERROR', e && e.message ? e.message : e);
    process.exit(3);
  }

  let extra = 0, failed = 0;
  const ok = (name, cond, detail) => {
    if (cond) { extra++; console.log('  ok   ' + name); }
    else { failed++; console.log('  FAIL ' + name + (detail === undefined ? '' : '  <- ' + detail)); }
  };
  const res = r.res || {};
  ok('原 PDF 未被写入', hash(FIX) === beforeHash);
  ok('导出副本已生成', !!res.outPath && fs.existsSync(res.outPath), JSON.stringify({ ok: res.exportOk, error: res.exportError, skipped: res.exportSkipped }));
  ok('导出未跳过任何标注', res.exportOk && res.exportSkipped === 0, JSON.stringify({ ok: res.exportOk, skipped: res.exportSkipped, reasons: res.exportReasons }));

  // ---------- 副本里的内嵌数据 ----------
  if (res.outPath && fs.existsSync(res.outPath)) {
    // pdf-lib 只写不读，读回来用 PDF.js（和渲染层同一条路径，顺带证明它认得这份附件）
    const atts = await readAttachments(res.outPath);
    const hit = atts['trove-annotations.json'];
    ok('副本里带 trove-annotations.json', !!hit, Object.keys(atts).join(','));
    if (hit) {
      const data = JSON.parse(Buffer.from(hit.content).toString('utf8'));
      ok('内嵌数据可解析', !!data && Array.isArray(data.pages), Object.prototype.toString.call(data));
      const shapes = (data.pages || []).flatMap((p) => p.shapes || []);
      ok('内嵌数据条数与导出条数一致', shapes.length === 11, shapes.length);
      ok('内嵌数据保留稳定 id', shapes.every((s) => !!s.id), shapes.filter((s) => !s.id).length);
      ok('内嵌数据保留子类型', shapes.some((s) => s.kind === 'underline'));
      ok('内嵌数据记了来源路径', typeof data.sourcePath === 'string');
    }

    // ---------- 打开副本 → 恢复 ----------
    let r2 = null;
    try {
      r2 = runProbe({
        probe: path.join(__dirname, 'probe-anno-restore.js'),
        inject: {},
        tmpDir: tmp,
        env: {
          PDFREADER_PROBE_PDF: res.outPath,
          PDFREADER_DATA_DIR: path.join(tmp, 'data2'),
          PDFREADER_NO_AUTO_INDEX: '1',
        },
        args: ['--user-data-dir=' + path.join(tmp, 'ud2')],
        label: 'anno-restore',
        timeout: 180000,
      });
    } catch (e) {
      failed++;
      console.log('  FAIL 恢复探针抛错  <- ' + (e && e.message ? e.message : e));
    }
    if (r2) {
      ok('恢复探针全部通过', r2.fail === 0, (r2.fail || 0) + ' 项失败');
      const rr = r2.res || {};
      ok('恢复来源标记为 embedded', rr.source === 'embedded', rr.source);
      ok('恢复条数为 11', rr.added === 11, rr.added);
    }
  }

  console.log('[native-annos] ' + (r.fail + failed ? 'FAIL (' + (r.fail + failed) + ')' : 'PASS (' + (r.total + extra) + ')'));
  fs.rmSync(tmp, { recursive: true, force: true });
  if (r.fail + failed) process.exit(1);
})();
