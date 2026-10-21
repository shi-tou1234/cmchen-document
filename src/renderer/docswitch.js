'use strict';
/*
 * 文档快速切换（v18）：点工具栏的文件名即可在「当前标签 / 最近打开 / 文献库」之间
 * 换一篇，不用先回文献库、再点条目、再回到阅读器。
 */
const DocSwitch = (function () {
  const ID = 'doc-switch';
  let root = null;
  let items = [];
  let query = '';
  let inited = false;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function ensure() {
    if (root) return root;
    root = document.createElement('div');
    root.id = ID;
    root.className = 'dsw';
    root.hidden = true;
    root.innerHTML =
      '<div class="dsw-head">' +
        '<span>切换文档</span>' +
        '<button class="dsw-x" title="关闭">✕</button>' +
      '</div>' +
      '<input class="dsw-search" type="search" placeholder="搜索标题 / 作者 / 文件名" />' +
      '<div class="dsw-list"></div>';
    document.body.appendChild(root);
    root.querySelector('.dsw-x').addEventListener('click', (e) => { e.stopPropagation(); close(); });
    root.querySelector('.dsw-search').addEventListener('input', (e) => {
      query = String(e.target.value || '').trim().toLowerCase();
      render();
    });
    root.querySelector('.dsw-search').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'Enter') {
        const first = root.querySelector('.dsw-row');
        if (first) first.click();
      }
    });
    root.addEventListener('click', (e) => {
      e.stopPropagation();
      // v26：清空最近打开记录
      if (e.target.closest('[data-dsw-clear-recent]')) {
        if (window.pdfBridge && window.pdfBridge.clearRecent) {
          window.pdfBridge.clearRecent().then(() => { items.recent = []; render(); });
        }
        return;
      }
      const row = e.target.closest('.dsw-row');
      if (row) { openRow(row.dataset.kind, row.dataset.id); return; }
    });
    return root;
  }

  function match(text) {
    if (!query) return true;
    return String(text || '').toLowerCase().indexOf(query) >= 0;
  }

  function rowHtml(o) {
    const sub = o.sub ? '<span class="dsw-sub">' + esc(o.sub) + '</span>' : '';
    const pg = o.page ? '<span class="dsw-pg">第 ' + o.page + ' 页</span>' : '';
    return '<button class="dsw-row" data-kind="' + o.kind + '" data-id="' + esc(o.id) + '">' +
      '<span class="dsw-name">' + esc(o.name) + '</span>' + sub + pg + '</button>';
  }

  function render() {
    if (!root) return;
    const host = root.querySelector('.dsw-list');
    let html = '';
    const tabs = (window.App && App.tabs) || [];
    const tabRows = tabs.filter((t) => match(t.fileName) || match(t.filePath));
    if (tabRows.length) {
      html += '<div class="dsw-sec">当前标签</div>';
      html += tabRows.map((t) => rowHtml({
        kind: 'tab', id: t.id, name: t.fileName, sub: '', page: t.page > 0 ? t.page : 0,
      })).join('');
    }
    const recRows = (items.recent || []).filter((r) => match(r.name) || match(r.path));
    if (recRows.length) {
      // v26：原来在「文件 → 最近打开」子菜单里，现在面板上直接清空
      html += '<div class="dsw-sec">最近打开'
        + '<button class="dsw-clear" data-dsw-clear-recent>清空</button></div>';
      html += recRows.map((r) => rowHtml({ kind: 'recent', id: r.path, name: r.name, sub: r.path, page: r.page || 0 })).join('');
    }
    const libRows = (items.library || []).filter((x) => match(x.title) || match((x.creators || []).join(' ')));
    if (libRows.length) {
      html += '<div class="dsw-sec">文献库</div>';
      html += libRows.slice(0, 60).map((x) => rowHtml({
        kind: 'lib', id: x.key, name: x.title || '(无标题)',
        sub: (x.creators || []).join(', ') + (x.year ? ' · ' + x.year : ''),
      })).join('');
    }
    if (!html) html = '<div class="dsw-empty">没有匹配的文档</div>';
    host.innerHTML = html;
  }

  async function load() {
    items = { recent: [], library: [] };
    try {
      if (window.pdfBridge && window.pdfBridge.recentList) items.recent = (await window.pdfBridge.recentList()) || [];
    } catch (_) {}
    try {
      if (window.pdfBridge && window.pdfBridge.lib && window.pdfBridge.lib.summary) {
        const s = await window.pdfBridge.lib.summary();
        items.library = (s && s.items) || [];
      }
    } catch (_) {}
    render();
  }

  async function openRow(kind, id) {
    close();
    try {
      if (kind === 'tab') { window.App && App.switchTab(id); return; }
      if (kind === 'recent') { window.pdfBridge && window.pdfBridge.openPath && window.pdfBridge.openPath(id); return; }
      if (kind === 'lib') {
        const res = await window.pdfBridge.lib.openItem(id, 0);
        if (res && res.ok && typeof window.__libOpen === 'function') window.__libOpen(res);
      }
    } catch (_) {}
  }

  function isOpen() { return !!(root && !root.hidden); }

  function open() {
    ensure();
    root.hidden = false;
    query = '';
    const inp = root.querySelector('.dsw-search');
    if (inp) inp.value = '';
    render();
    load();
    setTimeout(() => { if (inp) inp.focus(); }, 30);
  }

  function close() {
    if (root) root.hidden = true;
  }

  function toggle() {
    if (isOpen()) close();
    else open();
  }

  function init() {
    if (inited) return;
    inited = true;
    const btn = document.getElementById('file-name');
    if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    document.addEventListener('click', () => { if (isOpen()) close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen()) { e.preventDefault(); close(); }
    });
  }

  return { init, open, close, toggle, isOpen };
})();

window.DocSwitch = DocSwitch;
