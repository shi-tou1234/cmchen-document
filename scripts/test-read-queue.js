'use strict';
/*
 * 阅读队列 + 笔记旧标题回归（2026-10-29）
 *   Electron 侧：
 *     1. 侧栏出现「阅读队列」，计数只算待读 / 在读；
 *     2. 点队列只显示这两类，顺序是在读优先、其余按入库时间；
 *     3. 卡片带状态徽标；
 *     4. 详情面板的状态按钮点一下即时落库，标为已读后条目立刻离开队列；
 *     5. 附件区有「从文件补全题录」，批量栏有「标为待读 / 标为已读」；
 *     6. 笔记改名后，[[旧标题]] 仍然能跳到这条笔记（别名解析）。
 * 运行：node scripts/test-read-queue.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-queue-'));
  const ud = path.join(tmp, 'ud');
  fs.mkdirSync(ud);
  try {
    fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify({
      version: 8,
      items: [
        { key: 'k1', itemType: 'journalArticle', title: '待读论文', year: '2024', created: 100, readStatus: 'todo', attachment: { path: 'C:/x/a.pdf', name: 'a.pdf' } },
        { key: 'k2', itemType: 'journalArticle', title: '在读论文', year: '2023', created: 200, readStatus: 'reading', attachment: { path: 'C:/x/b.pdf', name: 'b.pdf' } },
        { key: 'k3', itemType: 'book', title: '已读图书', created: 300, readStatus: 'done' },
        { key: 'k4', itemType: 'note', title: '新标题', notes: [{ id: 'n1', title: '', text: '正文' }], aliases: ['旧标题', '旧名字2'] },
        { key: 'k5', itemType: 'note', title: '引用者', notes: [{ id: 'n2', title: '', text: '参见 [[旧名字2]] 这一条。' }] },
        { key: 'k6', itemType: 'note', title: '旧标题', notes: [{ id: 'n3', title: '', text: '我占用了这个旧标题。' }] },
        { key: 'k7', itemType: 'note', title: '抢名引用者', notes: [{ id: 'n4', title: '', text: '参见 [[旧标题]] 这一条。' }] },
      ],
      noteAliases: { k4: ['旧标题', '旧名字2'] },
    }));

    const probe = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (await fn()) return true; await sleep(60); } return !!(await fn()); };
  const $ = (s) => document.querySelector(s);
  const cards = () => Array.from(document.querySelectorAll('#lib-grid .lib-card'));
  const titles = () => cards().map((c) => c.querySelector('.lctitle').textContent.trim());

  const ready = await waitFor(() => window.LibraryUI && LibraryUI.isOpen() && cards().length >= 4, 12000);
  push('文献库就绪', ready, cards().length);
  if (!ready) return { checks };

  const q = $('[data-scope="queue"]');
  push('侧栏有阅读队列', !!q);
  push('队列计数只算待读/在读', !!q && /2/.test(q.textContent), q && q.textContent);

  q.click();
  await waitFor(() => titles().length === 2, 5000);
  push('队列只显示 2 条', titles().length === 2, titles().join('|'));
  push('在读排在待读前面', titles()[0] === '在读论文', titles().join('|'));
  push('已读不在队列里', !titles().includes('已读图书'), titles().join('|'));

  const c1 = $('.lib-card[data-key="k1"]');
  push('待读卡片有 todo 徽标', !!(c1 && c1.querySelector('.lc-status.todo')));
  const c2 = $('.lib-card[data-key="k2"]');
  push('在读卡片有 reading 徽标', !!(c2 && c2.querySelector('.lc-status.reading')));

  c1.click();
  const detailOpen = await waitFor(() => !$('#lib-detail').hidden, 5000);
  push('点卡片打开详情', detailOpen);
  const rs = $('#ld-readstatus');
  push('详情有阅读状态按钮', !!(rs && rs.querySelectorAll('[data-read-status]').length >= 3), rs && rs.textContent);
  push('当前状态高亮待读', !!(rs && rs.querySelector('[data-read-status="todo"].active')));

  rs.querySelector('[data-read-status="done"]').click();
  await waitFor(() => titles().length === 1, 6000);
  push('标为已读后离开队列', titles().length === 1 && !titles().includes('待读论文'), titles().join('|'));
  push('侧栏计数同步为 1', /1/.test($('[data-scope="queue"]').textContent), $('[data-scope="queue"]').textContent);

  $('[data-scope="all"]').click();
  await waitFor(() => titles().length >= 5, 5000);
  $('.lib-card[data-key="k1"]').click();
  await waitFor(() => !$('#lib-detail').hidden, 5000);
  $('#ld-readstatus').querySelector('[data-read-status="todo"]').click();
  await sleep(600);
  push('可以从已读改回待读', !!$('[data-scope="queue"]') && /2/.test($('[data-scope="queue"]').textContent), $('[data-scope="queue"]').textContent);

  push('附件区有「从文件补全题录」', !!$('[data-ld-identify]'));
  push('批量栏有待读按钮', !!$('#lib-bulk-todo'));
  push('批量栏有已读按钮', !!$('#lib-bulk-done'));

  // 笔记旧标题：k4 现标题「新标题」，别名「旧名字2」与「旧标题」；k6 占用了「旧标题」。
  // k5 引 [[旧名字2]]（别名可用），k7 引 [[旧标题]]（已被占用）。
  $('[data-open-note="k5"]').click();
  await waitFor(() => !$('#note-view').hidden, 6000);
  await sleep(500);
  const wl = $('#nv-preview').querySelector('[data-wikilink="旧名字2"]');
  push('预览里有旧名字链接', !!wl);
  if (wl) {
    wl.click();
    await waitFor(() => $('#nv-title').value === '新标题', 5000);
    push('旧标题没被占用时，别名仍可跳转', $('#nv-title').value === '新标题', $('#nv-title').value);
  }
  await sleep(600);
  const bl = $('#nv-preview').querySelector('.nv-backlinks');
  push('反链区列出真正引用本条的笔记', !!(bl && bl.querySelector('[data-bl-open="k5"]')), bl && bl.textContent);
  push('被占用的旧标题不算本条反链', !(bl && bl.querySelector('[data-bl-open="k7"]')), bl && bl.textContent);

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  await waitFor(() => $('#note-view').hidden, 5000);
  $('[data-open-note="k7"]').click();
  await waitFor(() => !$('#note-view').hidden, 6000);
  await sleep(500);
  const wl2 = $('#nv-preview').querySelector('[data-wikilink="旧标题"]');
  push('占用者的名字也能被链接', !!wl2);
  if (wl2) {
    wl2.click();
    await waitFor(() => $('#nv-title').value === '旧标题', 5000);
    push('点被占用的旧标题跳到占用者', $('#nv-title').value === '旧标题', $('#nv-title').value);
  }
  return { checks };
})()`;

    const probeFile = path.join(tmp, 'probe.cjs');
    fs.writeFileSync(probeFile, 'module.exports=' + JSON.stringify(probe));
    const r = runProbe({
      probe: probeFile,
      env: { PDFREADER_LIBRARY: path.join(tmp, 'library.json'), PDFREADER_DATA_DIR: tmp, PDFREADER_NO_AUTO_INDEX: '1' },
      args: ['--user-data-dir=' + ud],
      label: 'read-queue',
      timeout: 240000,
    });
    assert.equal(r.fail, 0);
    code = 0;
  } catch (e) {
    console.error('[read-queue] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
