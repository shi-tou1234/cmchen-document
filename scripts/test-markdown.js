'use strict';
/*
 * 富文本笔记回归（2026-10-22 报告「笔记」缺口）：Markdown 渲染 + 预览切换。
 *   A. 纯 Node：markdown.js 语法与安全（先转义再拼标签）。
 *   B. 探针：详情面板里写字 → 点预览 → 真的渲染出标题/表格/图片/链接。
 * 运行：node scripts/test-markdown.js
 */
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
  check('无序列表', Md.render('- a\n- b').indexOf('<ul class="md-list md-ul"><li>a</li><li>b</li></ul>') >= 0, Md.render('- a\n- b'));
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

// 富文本改造后笔记不再走「预览」切换；这里只保留 markdown.js 的语法单测（旧笔记迁移仍用它）
// ---------- B. 博客语法移植（v9.6：对齐 D:/项目/博客站点 后台编辑器） ----------
{
  const tip = Md.render(':::tip\n提示**内容**\n:::');
  check('提示框 :::tip', /class="admonition tip"/.test(tip) && /admonition-title/.test(tip) && /<strong>内容<\/strong>/.test(tip), tip);
  check('提示框五种子类型', ['note', 'important', 'warning', 'caution'].every((t) =>
    new RegExp('class="admonition ' + t + '"').test(Md.render(':::' + t + '\n内容\n:::'))));
  check('自定义标题 :::tip[标题]', Md.render(':::tip[安装步骤]\n内容\n:::').indexOf('>安装步骤</div>') >= 0,
    Md.render(':::tip[安装步骤]\n内容\n:::'));
  const quote = Md.render(':::quote\n内容\n\n<right>—— 出处</right>\n:::');
  check('引用卡片 :::quote + 对齐出处', /class="quote"/.test(quote) && quote.indexOf('q-right') >= 0
    && quote.indexOf('—— 出处') >= 0, quote);
  const der = Md.render(':::derivation\n推导\n:::');
  check('推导容器 :::derivation', /class="admonition derivation"/.test(der) && der.indexOf('推导过程') >= 0, der);
  check('++下划线++', Md.render('++下划++').indexOf('<span class="underline-text">下划</span>') >= 0, Md.render('++下划++'));
  check('!!剧透!!', Md.render('!!模糊!!').indexOf('<span class="spoiler" data-spoiler') >= 0);
  check('==彩虹==', Md.render('==彩虹==').indexOf('<span class="rainbow-text">彩虹</span>') >= 0);
  check('{汉字}(hàn|zì) 拼音', Md.render('{汉字}(hàn|zì)').indexOf('<ruby>汉字<rt>hàn zì</rt></ruby>') >= 0,
    Md.render('{汉字}(hàn|zì)'));
  const fn = Md.render('引用[^1]\n\n[^1]: 说明文字');
  check('脚注引用 + 文末定义', fn.indexOf('data-fnjump="fn-1"') >= 0 && fn.indexOf('id="fn-1"') >= 0
    && fn.indexOf('说明文字') >= 0 && fn.indexOf('md-footnotes') >= 0, fn);
  check('任务列表', Md.render('- [ ] 待办\n- [x] 完成').indexOf('<li class="md-task"><input type="checkbox" disabled') >= 0
    && Md.render('- [x] 完成').indexOf(' checked') >= 0 && Md.render('- [x] 完成').indexOf('md-task-done') >= 0,
    Md.render('- [ ] 待办\n- [x] 完成'));
  const gh = Md.render('::github{repo="user/repo"}');
  check('::github 卡片', gh.indexOf('card-github') >= 0 && gh.indexOf('data-md-link="https://github.com/user/repo"') >= 0
    && gh.indexOf('gc-repo') >= 0, gh);
  const mu = Md.render('::music{id="186016"}');
  check('::music 卡片', mu.indexOf('card-music') >= 0 && mu.indexOf('music.163.com') >= 0, mu);
  check('未闭合 ::: 也不丢内容', Md.render(':::tip\n没有收尾').indexOf('没有收尾') >= 0, Md.render(':::tip\n没有收尾'));
  check('plain 去掉新语法标记', Md.plain(':::tip\n提示\n:::\n==彩虹== [^1] ::github{repo="a/b"}', 40).indexOf(':::') < 0
    && Md.plain('==彩虹==') === '彩虹', Md.plain(':::tip\n提示\n:::\n==彩虹== [^1] ::github{repo="a/b"}'));
}

// ---------- C. 旧富文本笔记 → Markdown（fromHtml 迁移） ----------
{
  const md = Md.fromHtml('<h2>标题</h2><p>段落 <strong>粗</strong><em>斜</em><u>下划</u> <code>代码</code></p>'
    + '<ul><li>项一</li><li>项二</li></ul><blockquote><p>引用</p></blockquote>'
    + '<p><a href="https://x.y">链接</a> <img data-md-img="snapshots/a.png" alt="图"></p>'
    + '<pre><code>const a = 1;</code></pre>');
  check('fromHtml 标题', md.indexOf('## 标题') >= 0, md);
  check('fromHtml 行内样式', md.indexOf('**粗**') >= 0 && md.indexOf('*斜*') >= 0
    && md.indexOf('++下划++') >= 0 && md.indexOf('`代码`') >= 0, md);
  check('fromHtml 列表 / 引用', md.indexOf('- 项一') >= 0 && md.indexOf('> 引用') >= 0, md);
  check('fromHtml 链接图片', md.indexOf('[链接](https://x.y)') >= 0 && md.indexOf('![图](snapshots/a.png)') >= 0, md);
  check('fromHtml 代码块', md.indexOf('```\nconst a = 1;\n```') >= 0, md);
  check('fromHtml 相邻标记隔开', md.indexOf('**粗** *斜*') >= 0, md);
  check('fromHtml 空入空出', Md.fromHtml('') === '' && Md.fromHtml(null) === '');
}

console.log('[markdown] ' + (fail ? 'FAIL (' + fail + '/' + total + ')' : 'PASS (' + total + ')'));
process.exit(fail ? 2 : 0);
