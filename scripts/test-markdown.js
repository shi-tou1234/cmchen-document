'use strict';
/*
 * 富文本笔记回归（2026-10-22 报告「笔记」缺口）：Markdown 渲染 + 预览切换。
 *   A. 纯 Node：markdown.js 语法与安全（先转义再拼标签）。
 *   B. 探针：详情面板里写字 → 点预览 → 真的渲染出标题/表格/图片/链接。
 * 运行：node scripts/test-markdown.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Md = require('../src/markdown.js');

let fail = 0, total = 0;
function check(name, ok, detail) {
  total++;
  if (!ok) { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  <- ' + JSON.stringify(detail) : '')); }
  else console.log('  ok   ' + name);
}

// ---------- A. 渲染语法 ----------
{
  check('标题', /<h2 class="md-h">小结<\/h2>/.test(Md.render('## 小结')), Md.render('## 小结'));
  check('粗体/斜体/删除线', /<strong>粗<\/strong>/.test(Md.render('**粗**'))
    && /<em>斜<\/em>/.test(Md.render('*斜*')) && /<del>删<\/del>/.test(Md.render('~~删~~')),
    Md.render('**粗** *斜* ~~删~~'));
  check('行内代码不被强调', Md.render('`a*b*c`').indexOf('<code>a*b*c</code>') >= 0, Md.render('`a*b*c`'));
  check('代码块原样转义', Md.render('```js\nconst a = 1 < 2;\n```').indexOf('1 &lt; 2') >= 0
    && Md.render('```js\nx\n```').indexOf('<pre class="md-pre">') >= 0, Md.render('```js\nconst a = 1 < 2;\n```'));
  check('链接生成可点元素', Md.render('[例子](https://example.org)').indexOf('data-md-link="https://example.org"') >= 0,
    Md.render('[例子](https://example.org)'));
  check('javascript: 链接被降级成纯文本', Md.render('[坏](javascript:alert(1))').indexOf('data-md-link') < 0
    && Md.render('[坏](javascript:alert(1))').indexOf('md-plain-link') >= 0, Md.render('[坏](javascript:alert(1))'));
  check('外链图片直接给 src', Md.render('![图](https://example.org/a.png)').indexOf('src="https://example.org/a.png"') >= 0);
  check('本地图片留 data-md-img 由 IPC 填', Md.render('![图](snapshots/a.png)').indexOf('data-md-img="snapshots/a.png"') >= 0);
  check('表格', /<table class="md-table">[\s\S]*<th>A<\/th>[\s\S]*<td>1<\/td>/.test(Md.render('| A | B |\n|---|---|\n| 1 | 2 |')),
    Md.render('| A | B |\n|---|---|\n| 1 | 2 |'));
  check('引用块', Md.render('> 引用的句子').indexOf('<blockquote class="md-quote">') >= 0);
  check('无序列表', Md.render('- a\n- b').indexOf('<ul class="md-list"><li>a</li><li>b</li></ul>') >= 0, Md.render('- a\n- b'));
  check('有序列表', Md.render('1. a\n2. b').indexOf('<ol class="md-list">') >= 0);
  check('分割线', Md.render('---').indexOf('<hr />') >= 0);
  check('公式原样等宽', Md.render('$E=mc^2$').indexOf('<span class="md-math">$E=mc^2$</span>') >= 0, Md.render('$E=mc^2$'));
  check('块级公式原样', Md.render('$$\na^2+b^2\n$$').indexOf('md-math-block') >= 0, Md.render('$$\na^2+b^2\n$$'));
  // 安全：用户文本绝不能变成标签
  const xss = Md.render('<img src=x onerror="alert(1)"> <script>alert(1)</script>');
  check('HTML 注入被转义', xss.indexOf('<script') < 0 && xss.indexOf('<img src=x') < 0, xss);
  check('表格里的转义竖线留在同一格', Md.render('| A |\n|---|\n| a \\| b |').indexOf('<td>a | b</td>') >= 0,
    Md.render('| A |\n|---|\n| a \\| b |'));
  check('空文本不抛错', Md.render('') === '' && Md.render(null) === '');
  check('plain 摘要去掉标记', Md.plain('## 标题\n\n**粗体**内容 [链接](https://a.b)', 20) === '标题 粗体内容 链接',
    Md.plain('## 标题\n\n**粗体**内容 [链接](https://a.b)', 20));
}

// ---------- B. 探针 ----------
const { runProbe } = require('./probe-runner');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-md-'));
  const udd = path.join(tmp, 'ud');
  fs.mkdirSync(udd);
  try {
    const { fail: probeFail } = runProbe({
      probePath: path.join(__dirname, 'probe-markdown.js'),
      tmpDir: tmp,
      env: {
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + udd],
      label: 'markdown',
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

  console.log('[markdown] ' + (fail ? 'FAIL (' + fail + '/' + total + ')' : 'PASS (' + total + ')'));
  process.exit(fail ? 2 : 0);
})();
