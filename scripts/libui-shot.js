'use strict';
/*
 * 截图探针：打开库 → 选中第一条 → 展开详情面板，供 PDFREADER_PROBE_SHOT 抓图核对布局。
 * 不参与断言；日常回归用 libui-check.js。
 */
module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const cards = () => document.querySelectorAll('#lib-grid .lib-card').length;
  for (let i = 0; i < 60 && !cards(); i++) await sleep(50);
  const btn = $('[data-detail="itA"]') || $('[data-detail]');
  if (btn) btn.click();
  await sleep(350);
  return { ok: true, cards: cards(), detail: !document.getElementById('lib-detail').hidden };
})()`;
