'use strict';
/*
 * 笔记富文本（像 Word 一样编辑）回归：
 *   A. 纯 Node：richtext.js 的清洗 / 纯文本提取；library 的 html 存取与自动提纯文本。
 *   B. 探针：新建 → 输入 → 加粗 → 自动保存 → 重开会保留格式；旧 Markdown 笔记自动迁移。
 * 运行：node scripts/test-note-richtext.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const RichText = require('../src/richtext.js');

let fail = 0, total = 0;
function check(name, ok, detail) {
  total++;
  if (!ok) { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  <- ' + JSON.stringify(detail) : '')); }
  else console.log('  ok   ' + name);
}

// ---------- A1. 清洗 ----------
{
  check('去掉 <script>', RichText.sanitize('<p>a</p><script>alert(1)</script>').indexOf('<script') < 0,
    RichText.sanitize('<p>a</p><script>alert(1)</script>'));
  check('去掉 onerror 属性', RichText.sanitize('<img src=x onerror="alert(1)">').indexOf('onerror') < 0,
    RichText.sanitize('<img src=x onerror="alert(1)">'));
  check('javascript: 链接改成 #', RichText.sanitize('<a href="javascript:alert(1)">x</a>').indexOf('javascript:') < 0,
    RichText.sanitize('<a href="javascript:alert(1)">x</a>'));
  check('保留白名单标签', /<strong>b<\/strong>/.test(RichText.sanitize('<strong>b</strong>'))
    && /<ul><li>x<\/li><\/ul>/.test(RichText.sanitize('<ul><li>x</li></ul>')));
  check('未知标签被去掉但文字留下', RichText.sanitize('<custom-tag>hello</custom-tag>') === 'hello',
    RichText.sanitize('<custom-tag>hello</custom-tag>'));
  check('style 里的 expression 被去掉',
    RichText.sanitize('<p style="width:expression(alert(1))">x</p>').indexOf('expression') < 0);
  check('iframe 整段删除', RichText.sanitize('<iframe src="x"></iframe><p>ok</p>').indexOf('<iframe') < 0);

  check('toText 提取段落文本', RichText.toText('<p>第一段</p><p>第二段</p>') === '第一段\n第二段',
    RichText.toText('<p>第一段</p><p>第二段</p>'));
  check('toText 处理 br 与列表', RichText.toText('<div>a<br>b</div><ul><li>c</li></ul>') === 'a\nb\nc',
    RichText.toText('<div>a<br>b</div><ul><li>c</li></ul>'));
  check('toText 解码实体', RichText.toText('<p>a &amp; b &lt;c&gt;</p>') === 'a & b <c>',
    RichText.toText('<p>a &amp; b &lt;c&gt;</p>'));
}

// ---------- A2. 数据层 ----------
{
  const lib = require('../src/library.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-rt-'));
  process.env.PDFREADER_LIBRARY = path.join(tmp, 'library.json');
  lib.resetCache();
  const it = lib.addItem({ title: '带富文本笔记的条目' });
  const n = lib.addNote(it.key, { title: 'T', html: '<p><strong>粗</strong> 和普通</p>' });
  check('addNote 存 html', !!(n && n.html && n.html.indexOf('<strong>') >= 0), n && n.html);
  check('addNote 自动提取纯文本', !!(n && n.text === '粗 和普通'), n && n.text);
  lib.updateNote(it.key, n.id, { html: '<h2>标题</h2><p>正文</p>' });
  const sum = lib.summary();
  const note = (sum.items[0].notes || [])[0];
  check('updateNote 更新 html', note.html.indexOf('<h2>') >= 0, note.html);
  check('updateNote 同步 text', note.text === '标题\n正文', note.text);
  lib.updateNote(it.key, n.id, { html: '<p>x</p><script>bad()</script>' });
  check('落库前清洗掉 script', lib.summary().items[0].notes[0].html.indexOf('<script') < 0,
    lib.summary().items[0].notes[0].html);
  lib.resetCache();
  check('重开进程后 html 还在', (lib.summary().items[0].notes[0].html || '').indexOf('<p>') >= 0,
    lib.summary().items[0].notes[0].html);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  delete process.env.PDFREADER_LIBRARY;
}

// ---------- B. 探针 ----------
const { runProbe } = require('./probe-runner');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-rt-'));
  const udd = path.join(tmp, 'ud');
  fs.mkdirSync(udd);
  try {
    const { fail: probeFail } = runProbe({
      probePath: path.join(__dirname, 'probe-note-richtext.js'),
      tmpDir: tmp,
      env: {
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + udd],
      label: 'note-richtext',
      timeout: 240000,
    });
    if (probeFail) fail++;
    total++;
  } catch (e) {
    total++; fail++;
    console.error('  FAIL 探针执行异常', e && e.message ? e.message : e);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('[note-richtext] ' + (fail ? 'FAIL (' + fail + '/' + total + ')' : 'PASS (' + total + ')'));
  process.exit(fail ? 2 : 0);
})();
