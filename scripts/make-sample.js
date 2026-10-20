// 生成一个最小但结构合法的 3 页 PDF，用于冒烟测试（无外部依赖）。
const fs = require('fs');
const path = require('path');

const PAGES = 3;

const objects = []; // 索引 0 对应对象号 1
function reserve() { objects.push(null); return objects.length; }
function set(id, str) { objects[id - 1] = str; }

// 预留 1=Catalog, 2=Pages, 3=Font
const catalogId = reserve(); // 1
const pagesId = reserve();   // 2
const fontId = reserve();    // 3

// 分配页对象与内容流对象编号
const pageIds = [];
const contentIds = [];
for (let i = 0; i < PAGES; i++) pageIds.push(reserve());
for (let i = 0; i < PAGES; i++) contentIds.push(reserve());

set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
set(fontId, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);
const kids = pageIds.map((id) => `${id} 0 R`).join(' ');
set(pagesId, `<< /Type /Pages /Kids [${kids}] /Count ${PAGES} >>`);

for (let i = 0; i < PAGES; i++) {
  set(pageIds[i],
    `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] ` +
    `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentIds[i]} 0 R >>`);
  const stream = `BT /F1 24 Tf 72 720 Td (Sample page ${i + 1} of ${PAGES} - PDF Reader smoke test) Tj ET\n`;
  set(contentIds[i],
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`);
}

// 序列化，记录每个对象字节偏移
let pdf = '%PDF-1.4\n';
const offsets = [];
for (let i = 0; i < objects.length; i++) {
  offsets.push(Buffer.byteLength(pdf, 'latin1'));
  pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
}
const xrefStart = Buffer.byteLength(pdf, 'latin1');
pdf += `xref\n0 ${objects.length + 1}\n`;
pdf += '0000000000 65535 f \n';
for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n';
pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

const out = path.join(__dirname, '..', 'assets', 'sample.pdf');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.from(pdf, 'latin1'));
console.log(`[make-sample] 写入 ${out}  (${Buffer.byteLength(pdf, 'latin1')} bytes, ${PAGES} 页)`);
