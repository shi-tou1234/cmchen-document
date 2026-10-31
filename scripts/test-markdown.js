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
  check('公式占位带源码', Md.render('$E=mc^2$').indexOf('<span class="md-math" data-md-math="E=mc^2">$E=mc^2$</span>') >= 0, Md.render('$E=mc^2$'));
  check('行内 $$ 标记块级', Md.render('前 $$x+y$$ 后').indexOf('data-md-display="1"') >= 0, Md.render('前 $$x+y$$ 后'));
  check('块级公式原样', (() => { const h = Md.render('$$\na^2+b^2\n$$');
    return h.indexOf('md-math-block" data-md-math="') >= 0 && h.indexOf('a^2+b^2') >= 0; })(), Md.render('$$\na^2+b^2\n$$'));
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

// ---------- B2. 图片宽度（笔记内缩放） ----------
// 宽度写在 URL 末尾的 #w=NNN：必须能渲染成样式、能被 fromHtml 原样读回，
// 否则「改个宽度、存一次盘就变回原尺寸」——比没有这个功能还糟。
{
  const w = Md.render('![封面](snapshots/a.png#w=420)');
  check('渲染：宽度进 data-md-w', w.indexOf('data-md-w="420"') >= 0, w);
  check('渲染：宽度进 style', w.indexOf('width:420px') >= 0 && w.indexOf('max-width:100%') >= 0, w);
  check('渲染：URL 里的 #w= 被剥掉', w.indexOf('data-md-img="snapshots/a.png"') >= 0, w);
  const remote = Md.render('![封面](https://x.y/a.png#w=300)');
  check('渲染：远程图也认宽度', remote.indexOf('src="https://x.y/a.png"') >= 0 && remote.indexOf('data-md-w="300"') >= 0, remote);
  check('渲染：没有宽度时干净不变', Md.render('![封面](snapshots/a.png)').indexOf('data-md-w') < 0,
    Md.render('![封面](snapshots/a.png)'));

  check('回读：data-md-w', Md.fromHtml('<img class="md-img" data-md-img="snapshots/a.png" alt="图" data-md-w="420" />')
    .indexOf('![图](snapshots/a.png#w=420)') >= 0,
    Md.fromHtml('<img class="md-img" data-md-img="snapshots/a.png" alt="图" data-md-w="420" />'));
  check('回读：退到 width 属性', Md.fromHtml('<img src="https://x.y/a.png" width="220" />')
    .indexOf('#w=220') >= 0, Md.fromHtml('<img src="https://x.y/a.png" width="220" />'));
  check('回读：退到 style', Md.fromHtml('<img class="md-img" data-md-img="s/a.png" style="width: 260px;" />')
    .indexOf('#w=260') >= 0, Md.fromHtml('<img class="md-img" data-md-img="s/a.png" style="width: 260px;" />'));
  check('回读：不带标记时不引入旧标记', Md.fromHtml('<img class="md-img" data-md-img="snapshots/a.png#w=10" />')
    .indexOf('#w=10') < 0, Md.fromHtml('<img class="md-img" data-md-img="snapshots/a.png#w=10" />'));

  // 往返稳定：渲染 → 回读 → 再渲染，宽度必须还是 420（不是 4200、也不是幂次放大）
  const once = Md.fromHtml('<img class="md-img" data-md-img="s/a.png" data-md-w="420" />');
  const twice = Md.fromHtml(Md.render(once));
  check('往返稳定：fromHtml(render(fromHtml)) 不变', once === twice, { once, twice });
  const html = Md.render('![图](snapshots/a.png#w=420)');
  check('往返稳定：render(fromHtml(render)) 宽度一致', Md.fromHtml(html).indexOf('#w=420') >= 0, Md.fromHtml(html));

  check('超大值收敛到上限', Md.render('![x](a.png#w=99999)').indexOf('width:2400px') >= 0, Md.render('![x](a.png#w=99999)'));
  check('过小值收敛到下限', Md.render('![x](a.png#w=1)').indexOf('width:40px') >= 0, Md.render('![x](a.png#w=1)'));
  check('非法的 #w 不报错也不生效', Md.render('![x](a.png#w=abc)').indexOf('data-md-w') < 0, Md.render('![x](a.png#w=abc)'));
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

// ---------- D. 图片语法：渲染与扫描必须同一口径（R-v1.6c-01） ----------
{
  const doc = '前言\n\n![first](a.png "R&D")\n\n![second](b.png)\n';
  const html = Md.render(doc);
  const imgs = html.match(/<img[^>]*>/g) || [];
  check('标题含 & 的图片能渲染', imgs.length === 2, imgs.length + ' / ' + html.slice(0, 120));
  check('标题含 & 的图片 alt 正确', imgs[0] && imgs[0].indexOf('alt="first"') > 0, imgs[0]);
  check('扫描与渲染数一致', Md.scanImages(doc, { skipCode: true }).length === imgs.length,
    Md.scanImages(doc, { skipCode: true }).length + ' vs ' + imgs.length);
  check('扫描顺序与渲染一致', (Md.scanImages(doc, { skipCode: true }).map((x) => x.base).join(',')) === 'a.png,b.png',
    Md.scanImages(doc, { skipCode: true }).map((x) => x.base).join(','));

  // 标题里有 < > 也不能把 HTML 结构写坏
  const tricky = Md.render('![x](a.png "标题 & < >")');
  check('标题里的尖括号不破坏结构', (tricky.match(/<img[^>]*>/g) || []).length === 1, tricky);
  check('标题不会被当正文输出', tricky.indexOf('&lt;') < 0 || tricky.indexOf('<img') >= 0, tricky);

  // 代码块 / 行内代码里的示例图：两边都不算
  const withCode = '![real](r.png)\n\n```\n![fake](f.png)\n```\n\n`![inline](i.png)`\n';
  const cImgs = (Md.render(withCode).match(/<img[^>]*>/g) || []);
  check('代码里的示例图不渲染', cImgs.length === 1, cImgs.length);
  check('代码里的示例图也不计入扫描', Md.scanImages(withCode, { skipCode: true }).length === 1,
    Md.scanImages(withCode, { skipCode: true }).length);

  // 行内渲染（表格单元格等）走同一条路
  const inlineHtml = Md.inline('见 ![i](s/a.png "A&B") 结束');
  check('行内图片带标题也能渲染', /<img[^>]*data-md-img="s\/a\.png"/.test(inlineHtml), inlineHtml);

  // 同一张图在正文与脚注各引用一次：两处必须各有各的源码位置（R-v1.6e-03）
  const dup = '[^1]: 脚注 ![same](s/a.png#w=120)\n\n正文 ![same](s/a.png#w=320)\n\n看[^1]。\n';
  const dupHtml = Md.render(dup);
  const srcs = (dupHtml.match(/data-md-img-src="(\d+)"/g) || []).map((x) => +x.match(/\d+/)[0]);
  check('同 URL 两处引用都带源码位置', srcs.length === 2, srcs.join(','));
  check('两处位置不同', srcs.length === 2 && srcs[0] !== srcs[1], srcs.join(','));
  const scanDup = Md.scanImages(dup, { skipCode: true }).map((x) => x.start).sort((a, b) => a - b);
  check('位置与源码扫描对得上', srcs.slice().sort((a, b) => a - b).join(',') === scanDup.join(','),
    srcs.join(',') + ' vs ' + scanDup.join(','));
  check('两处宽度各自保留', dupHtml.indexOf('width="120"') >= 0 && dupHtml.indexOf('width="320"') >= 0);

  // 表格单元格里的图片也要有源码位置（脚注写在表格之前时最容易错位，R-v1.6f-03）
  const tbl = '[^1]: 脚注 ![f](s/f.png)\n\n| 列 |\n| --- |\n| ![cell](s/c.png) |\n\n看[^1]。\n';
  const tblHtml = Md.render(tbl);
  const tblSrcs = (tblHtml.match(/data-md-img-src="(\d+)"/g) || []).map((x) => +x.match(/\d+/)[0]);
  check('表格图也带源码位置', tblSrcs.length === 2, tblSrcs.join(','));
  check('表格图与脚注图位置不同', tblSrcs.length === 2 && tblSrcs[0] !== tblSrcs[1], tblSrcs.join(','));
  const cellSrc = tblSrcs.find((n) => tbl.slice(n).indexOf('![cell]') === 0);
  check('表格图的位置真的指向那张图', typeof cellSrc === 'number', JSON.stringify(tblSrcs));

  // 单元格里转义竖线 `\|` 在图片之前时，位置不能少算一个字符（R-v1.6g-01）
  const esc = '| 列 |\n| --- |\n| before \\| ![a](s/a.png) |\n';
  const escHtml = Md.render(esc);
  const escSrc = (escHtml.match(/data-md-img-src="(\d+)"/) || [])[1];
  check('转义竖线后仍有源码位置', !!escSrc, escHtml.match(/<img[^>]*>/g));
  check('位置指向真正的图片', escSrc && esc.slice(+escSrc).indexOf('![a]') === 0,
    escSrc ? JSON.stringify(esc.slice(+escSrc, +escSrc + 12)) : 'none');
  check('单元格里的 \\| 渲染成竖线', escHtml.indexOf('before | <img') >= 0, escHtml.match(/<td>[\s\S]*?<\/td>/));
  check('正文里的 \\| 也渲染成竖线', Md.render('a \\| b').indexOf('a | b') >= 0, Md.render('a \\| b'));
}

console.log('[markdown] ' + (fail ? 'FAIL (' + fail + '/' + total + ')' : 'PASS (' + total + ')'));
process.exit(fail ? 2 : 0);
