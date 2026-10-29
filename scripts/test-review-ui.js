'use strict';
/*
 * 综述草稿界面回归（2026-10-29）
 * 造两篇文献 + 三条真实标注 sidecar，打开「综述草稿」：
 *   1. 默认按标签分组，出「## 方法」「## 结论」；
 *   2. 引文与文内引注同时出现，参考文献表在末尾；
 *   3. 切到「按文献」分组，标题换成文献名；
 *   4. 取消「含引文原文」后引用块消失、只剩评论；
 *   5. 统计行给出批注数 / 文献数 / 组数。
 * 运行：node scripts/test-review-ui.js
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-review-'));
  const ud = path.join(tmp, 'ud');
  const annoDir = path.join(ud, 'annotations');
  fs.mkdirSync(annoDir, { recursive: true });
  try {
    const pdf1 = path.join(tmp, 'smith2024.pdf');
    const pdf2 = path.join(tmp, 'zhang2023.pdf');
    const hash = (p) => crypto.createHash('sha1').update(path.resolve(p)).digest('hex').slice(0, 20);
    fs.writeFileSync(path.join(annoDir, hash(pdf1) + '.json'), JSON.stringify({
      path: pdf1, saved: Date.now(), pages: [
        { page: 3, shapes: [{ id: 's1', tool: 'highlight', color: '#ffd400', text: '本地优先意味着数据在用户手里', comment: '这是全文的立论基础' }] },
        { page: 5, shapes: [{ id: 's2', tool: 'highlight', color: '#7bd88f', text: '同步不是必需品', comment: '' }] },
      ],
    }));
    fs.writeFileSync(path.join(annoDir, hash(pdf2) + '.json'), JSON.stringify({
      path: pdf2, saved: Date.now(), pages: [
        { page: 2, shapes: [{ id: 's3', tool: 'underline', color: '#e24b4a', text: '标注是阅读的副产物', comment: '与我的观察一致' }] },
      ],
    }));
    fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify({
      version: 8,
      items: [
        {
          key: 'k1', itemType: 'journalArticle', title: 'Local-first reference managers', year: '2024',
          creators: [{ firstName: 'Jane', lastName: 'Smith', creatorType: 'author' }],
          publication: 'Journal of Digital Libraries', volume: '12', issue: '3', pages: '45-67',
          attachment: { path: pdf1, name: 'smith2024.pdf' },
        },
        {
          key: 'k2', itemType: 'conferencePaper', title: 'Annotation practices in reading tools', year: '2023',
          creators: [{ firstName: 'Wei', lastName: 'Zhang', creatorType: 'author' }],
          publication: 'Proceedings of ReadConf',
          attachment: { path: pdf2, name: 'zhang2023.pdf' },
        },
      ],
      annoMeta: {
        s1: { text: '本地优先意味着数据在用户手里', comment: '这是全文的立论基础', tags: ['方法'], itemKey: 'k1' },
        s2: { text: '同步不是必需品', comment: '', tags: ['方法', '结论'], itemKey: 'k1' },
        s3: { text: '标注是阅读的副产物', comment: '与我的观察一致', tags: ['结论'], itemKey: 'k2' },
      },
    }));

    const probe = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (await fn()) return true; await sleep(80); } return !!(await fn()); };
  const $ = (s) => document.querySelector(s);
  const preview = () => $('#review-preview').value || '';
  const ready = await waitFor(() => window.LibraryUI && LibraryUI.isOpen() && document.querySelectorAll('#lib-grid .lib-card').length >= 2, 12000);
  push('文献库就绪', ready);
  if (!ready) return { checks };

  push('工具栏有综述草稿按钮', !!$('#lib-review'));
  $('#lib-review').click();
  const opened = await waitFor(() => $('#review-modal') && !$('#review-modal').hidden, 5000);
  push('弹窗打开', opened);
  const filled = await waitFor(() => preview().includes('## 方法'), 12000);
  push('默认按标签分组出「方法」', filled, preview().slice(0, 120));
  push('「结论」分组也在', preview().includes('## 结论'));
  push('引文以引用块出现', preview().includes('> 本地优先意味着数据在用户手里'));
  push('有文内引注与页码', /\\[\\d+, p\\. 3\\]/.test(preview()), preview().slice(0, 200));
  push('末尾有参考文献表', preview().includes('## 参考文献'));
  push('统计行给出数量', /3 条批注 · 2 篇文献/.test($('#review-count').textContent), $('#review-count').textContent);

  const g = $('#review-group');
  g.value = 'item';
  g.dispatchEvent(new Event('change'));
  const byItem = await waitFor(() => preview().includes('\\n## Smith，2024'), 8000);
  push('切到按文献分组', byItem, preview().slice(0, 160));
  push('按文献时不再有标签分组', !preview().includes('\\n## 方法\\n'));

  const q = $('#review-quotes');
  q.checked = false;
  q.dispatchEvent(new Event('change'));
  const noQuote = await waitFor(() => !preview().includes('> 本地优先'), 8000);
  push('取消引文后引用块消失', noQuote, preview().slice(0, 160));
  push('评论仍然保留', preview().includes('评论：这是全文的立论基础'));
  push('没有评论的批注被排除', !preview().includes('同步不是必需品'));
  return { checks };
})()`;

    const probeFile = path.join(tmp, 'probe.cjs');
    fs.writeFileSync(probeFile, 'module.exports=' + JSON.stringify(probe));
    const r = runProbe({
      probe: probeFile,
      env: { PDFREADER_LIBRARY: path.join(tmp, 'library.json'), PDFREADER_DATA_DIR: tmp, PDFREADER_NO_AUTO_INDEX: '1' },
      args: ['--user-data-dir=' + ud],
      label: 'review-ui',
      timeout: 240000,
    });
    assert.equal(r.fail, 0);
    code = 0;
  } catch (e) {
    console.error('[review-ui] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
