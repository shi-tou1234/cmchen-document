'use strict';
/*
 * 检索可视化条件构建器回归：
 *   Node 侧：query.js 的 buildQuery / parseQueryToRows——字段限定、排除、短语引号、
 *            空行跳过、roundtrip、OR/括号整串保留。
 *   Electron 侧：真实 UI——打开面板回填当前查询、加条件、勾排除、应用后搜索框与
 *            结果联动、清空条件。
 * 运行：node scripts/test-query-builder.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Q = require('../src/query.js');
const { runProbe } = require('./probe-runner');

// ---------- A. Node 纯逻辑 ----------
(function nodePart() {
  assert.equal(Q.buildQuery([{ field: 'title', op: 'contains', value: '机器学习' }]), 'title:机器学习', '单条件');
  assert.equal(
    Q.buildQuery([{ field: 'title', op: 'contains', value: '机器学习' }, { field: 'author', op: 'contains', value: 'J Smith' }, { field: 'tag', op: 'exclude', value: 'survey' }, { field: 'title', op: 'contains', value: '' }]),
    'title:机器学习 AND author:"J Smith" AND -tag:survey', '多条件 AND + 排除 + 空行跳过');
  assert.equal(Q.buildQuery([{ field: 'unknownfield', op: 'contains', value: 'x' }]), 'x', '未知字段降级为全文');
  assert.equal(Q.buildQuery([]), '', '空数组给空串');
  // roundtrip
  const rows = [{ field: 'title', op: 'contains', value: '机器学习' }, { field: 'tag', op: 'exclude', value: 'survey' }];
  assert.deepEqual(Q.parseQueryToRows(Q.buildQuery(rows)), rows, 'roundtrip');
  // 复杂语法整串保留（标记 raw：应用时原样使用，不重新拼装）
  assert.deepEqual(Q.parseQueryToRows('a OR (b AND c)'), [{ field: '', op: 'contains', value: 'a OR (b AND c)', raw: true }], 'OR/括号不拆');
  assert.deepEqual(Q.parseQueryToRows(''), [], '空串给空数组');
  assert.deepEqual(Q.parseQueryToRows('-note:草稿'), [{ field: 'note', op: 'exclude', value: '草稿' }], '排除行');
  // B05：隐式 AND / 别名 / 含引号的值都要能无损往返
  assert.deepEqual(Q.parseQueryToRows('author:Smith year:2024'), [
    { field: 'author', op: 'contains', value: 'Smith' },
    { field: 'year', op: 'contains', value: '2024' },
  ], '隐式 AND 拆行');
  assert.deepEqual(Q.parseQueryToRows('creator:Smith'), [{ field: 'author', op: 'contains', value: 'Smith' }], '字段别名归一');
  const quoted = [{ field: 'note', op: 'contains', value: 'a "quoted" word' }];
  assert.deepEqual(Q.parseQueryToRows(Q.buildQuery(quoted)), quoted, '含引号的值往返');
  const tree = (s) => JSON.stringify(Q.parseQuery(s).tree);
  for (const q of ['author:Smith year:2024', '"machine learning" -survey', 'title:"machine learning" AND -tag:survey']) {
    assert.equal(tree(q), tree(Q.buildQuery(Q.parseQueryToRows(q))), '往返语义等价: ' + q);
  }
  console.log('[query-builder-node] PASS');
})();

// ---------- B. Electron UI ----------
let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-qb-'));
  const ud = path.join(tmp, 'ud');
  fs.mkdirSync(ud);
  try {
    fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify({ version: 8, items: [
      { key: 'a', itemType: 'journalArticle', title: 'Deep Learning Survey', creators: [{ firstName: 'John', lastName: 'Smith', creatorType: 'author' }], year: '2024', tags: ['survey', 'ml'] },
      { key: 'b', itemType: 'journalArticle', title: 'My Network Paper', creators: [{ firstName: 'Lei', lastName: 'Wang', creatorType: 'author' }], year: '2023', tags: ['ml'] },
      { key: 'c', itemType: 'book', title: 'Old Book', year: '1999', tags: [] },
    ] }));
    const probe = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (await fn()) return true; await sleep(60); } return !!(await fn()); };
  const libReady = await waitFor(() => window.LibraryUI && LibraryUI.isOpen() && document.querySelectorAll('#lib-grid .lib-card').length >= 3, 10000);
  push('文献库就绪', libReady);
  push('Query.buildQuery 挂载', !!(window.Query && Query.buildQuery && Query.parseQueryToRows));
  if (!libReady) return { checks };

  const panel = document.getElementById('lib-query-panel');
  // 1) 打开面板：默认一行；字段下拉有「标题」等选项
  document.getElementById('lib-query-btn').click();
  push('面板打开', panel.hidden === false);
  push('默认一行', document.querySelectorAll('#qb-rows .qb-row').length === 1);
  push('字段选项齐全', (document.querySelector('#qb-rows .qb-field') || {}).options && document.querySelector('#qb-rows .qb-field').options.length >= 9);

  // 2) 填一行：标题包含 Network，应用
  let row = document.querySelector('#qb-rows .qb-row');
  row.querySelector('.qb-field').value = 'title';
  row.querySelector('.qb-value').value = 'Network';
  document.getElementById('qb-apply').click();
  await sleep(500);
  push('搜索框生成查询', document.getElementById('lib-search').value === 'title:Network', document.getElementById('lib-search').value);
  push('结果联动', document.querySelectorAll('#lib-grid .lib-card').length === 1, document.querySelectorAll('#lib-grid .lib-card').length);

  // 3) 再开面板：回填当前查询为行；加一行「作者=Smith」AND
  document.getElementById('lib-query-btn').click();
  push('回填当前查询', document.querySelectorAll('#qb-rows .qb-row').length === 1
    && document.querySelector('#qb-rows .qb-row .qb-value').value === 'Network');
  document.getElementById('qb-add').click();
  const rows = document.querySelectorAll('#qb-rows .qb-row');
  rows[1].querySelector('.qb-field').value = 'author';
  rows[1].querySelector('.qb-value').value = 'Smith';
  document.getElementById('qb-apply').click();
  await sleep(500);
  push('两行 AND 查询', document.getElementById('lib-search').value === 'title:Network AND author:Smith', document.getElementById('lib-search').value);
  push('AND 后无结果（作者不同）', document.querySelectorAll('#lib-grid .lib-card').length === 0);

  // 4) 排除：清空重来，标题包含 Paper 且排除标签 ml → b 有 ml 被排除，剩 0 条
  document.getElementById('lib-query-btn').click();
  document.getElementById('qb-clear').click();
  push('清空后一行', document.querySelectorAll('#qb-rows .qb-row').length === 1);
  row = document.querySelector('#qb-rows .qb-row');
  row.querySelector('.qb-field').value = 'title';
  row.querySelector('.qb-value').value = 'Paper';
  document.getElementById('qb-add').click();
  // 注意：querySelectorAll 返回静态列表，qb-clear 重建过 DOM，必须重新查询
  const rows4 = document.querySelectorAll('#qb-rows .qb-row');
  rows4[1].querySelector('.qb-field').value = 'tag';
  rows4[1].querySelector('.qb-not').checked = true;
  rows4[1].querySelector('.qb-value').value = 'ml';
  document.getElementById('qb-apply').click();
  await sleep(500);
  push('排除查询生成', document.getElementById('lib-search').value === 'title:Paper AND -tag:ml', document.getElementById('lib-search').value);
  push('排除后 0 条（b 有 ml）', document.querySelectorAll('#lib-grid .lib-card').length === 0);

  // 5) 清空搜索恢复
  const sb = document.getElementById('lib-search');
  sb.value = ''; sb.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(500);
  push('清空恢复全量', document.querySelectorAll('#lib-grid .lib-card').length === 3);

  // 6) B05：含 OR 的查询打开面板后，应用不能改变查询
  sb.value = 'title:Deep OR title:Old'; sb.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(500);
  document.getElementById('lib-query-btn').click();
  await sleep(150);
  const notice = document.getElementById('qb-notice');
  push('B05 原串行显示提示', !!notice && notice.hidden === false && /原文|原样/.test(notice.textContent), notice && notice.textContent.slice(0, 40));
  push('B05 原串行禁用加条件', document.getElementById('qb-add').disabled === true);
  document.getElementById('qb-apply').click();
  await sleep(500);
  push('B05 应用后查询不变', document.getElementById('lib-search').value === 'title:Deep OR title:Old', document.getElementById('lib-search').value);
  push('B05 OR 结果仍为 2 条', document.querySelectorAll('#lib-grid .lib-card').length === 2, document.querySelectorAll('#lib-grid .lib-card').length);
  return { checks };
})()`;
    const probeFile = path.join(tmp, 'probe.cjs');
    fs.writeFileSync(probeFile, 'module.exports=' + JSON.stringify(probe));
    const r = runProbe({
      probe: probeFile,
      env: { PDFREADER_LIBRARY: path.join(tmp, 'library.json'), PDFREADER_DATA_DIR: tmp, PDFREADER_NO_AUTO_INDEX: '1' },
      args: ['--user-data-dir=' + ud],
      label: 'query-builder',
      timeout: 240000,
    });
    assert.equal(r.fail, 0);
    code = 0;
  } catch (e) {
    console.error('[query-builder] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
