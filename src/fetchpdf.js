'use strict';
/*
 * 抓取 PDF 全文（v9；v1.6 补多源聚合与机构代理）。不加依赖，就用 Node 的 http/https：
 *
 *   1. arXiv   → https://arxiv.org/pdf/<id>（最稳，无需任何配置）
 *   2. 开放获取 → Unpaywall（需联系邮箱）/ OpenAlex / Semantic Scholar / Europe PMC
 *                四路并行查，谁先给出 PDF 直链就用谁的
 *   3. DOI / 直链 → doi.org 或条目自己的 url；配了机构代理时再试代理版
 *   4. OpenURL → 配了链接解析器（SFX / Alma / 360Link）时作为最后一站
 *
 * 安全与稳健：只走 http/https；重定向最多 5 次；超时 40s；最大 80MB；
 * 先写 .part 再改名，中途失败不留半截文件；校验前 5 个字节必须是 %PDF-。
 *
 * 纯 Node 模块，可在测试里用本地 HTTP 服务替换 endpoints。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/124.0 Safari/537.36 Trove/1.1 (+local pdf reader)';
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 40000;
const MAX_BYTES = 80 * 1024 * 1024;

const ENDPOINTS = {
  arxivPdf: (id) => 'https://arxiv.org/pdf/' + String(id || '').replace(/^\/+/, ''),
  unpaywall: (doi, email) => 'https://api.unpaywall.org/v2/' + encodeURIComponent(doi) + '?email=' + encodeURIComponent(email),
  doiResolver: (doi) => 'https://doi.org/' + String(doi || ''),
  openalex: (doi) => 'https://api.openalex.org/works/doi:' + encodeURIComponent(doi),
  semanticscholar: (doi) => 'https://api.semanticscholar.org/graph/v1/paper/DOI:'
    + encodeURIComponent(doi) + '?fields=openAccessPdf,title,externalIds',
  europepmc: (doi) => 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query='
    + encodeURIComponent('DOI:"' + doi + '"') + '&format=json&resultType=core',
};

/*
 * 机构代理（EZproxy 一类）。只支持两种真实存在的写法，其余当没配置：
 *   1) 前缀式：https://www-proxy.univ.edu/login?url=   → 前缀 + encodeURIComponent(目标)
 *   2) 域名式：doi-org.proxy.univ.edu                  → doi.org/10.x 变成 doi-org.proxy.univ.edu/10.x
 * 域名式把主机名里的 . 换成 -，这是 EZproxy 的既定规则；不要「聪明」地保留点号，
 * 那样拼出来的域名根本不存在。
 */
function applyProxy(url, prefix) {
  const target = String(url || '');
  const p = String(prefix || '').trim();
  if (!p || !/^https?:\/\//i.test(target)) return '';
  let u;
  try { u = new URL(target); } catch (_) { return ''; }
  if (/^https?:\/\//i.test(p)) {
    if (/[?&](url|qurl)=$/i.test(p)) return p + encodeURIComponent(target);
    return p + (p.indexOf('?') >= 0 ? '&' : '?') + 'url=' + encodeURIComponent(target);
  }
  const suffix = p.replace(/^\.+/, '');
  if (!/^[a-z0-9.-]+$/i.test(suffix)) return '';
  const host = u.host.replace(/:/g, '-').replace(/\./g, '-');
  return u.protocol + '//' + host + '.' + suffix + u.pathname + u.search + u.hash;
}

// OpenURL 0.1 的 ContextObject：机构链接解析器（SFX / Alma / 360Link）靠它找到全文。
// 拼不全没关系，缺的字段不写；写错的字段会让解析器返回空结果，所以只放有把握的几个。
function openUrlFor(base, info) {
  const b = String(base || '').trim();
  if (!/^https?:\/\//i.test(b)) return '';
  const i = info || {};
  const kv = [
    ['ctx_ver', 'Z39.88-2004'],
    ['rfr_id', 'info:sid/trove'],
    ['rft_val_fmt', 'info:ofi/fmt:kev:mtx:journal'],
  ];
  const add = (k, v) => { const s = String(v == null ? '' : v).trim(); if (s) kv.push([k, s]); };
  add('rft.genre', 'article');
  add('rft.atitle', i.title);
  add('rft.jtitle', i.publication);
  add('rft.date', (String(i.year || '').match(/\d{4}/) || [''])[0]);
  add('rft.volume', i.volume);
  add('rft.issue', i.issue);
  const pages = String(i.pages || '');
  add('rft.pages', pages);
  const sp = /^\s*([A-Za-z]?\d+)\s*[-–—]/.exec(pages);
  if (sp) add('rft.spage', sp[1]);
  const doi = String(i.doi || '').trim();
  if (doi) add('rft_id', 'info:doi/' + doi);
  const qs = kv.map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  return b + (b.indexOf('?') >= 0 ? '&' : '?') + qs;
}

// 一次 GET，手动跟重定向。resolveWithFullResponse 的极简版
function request(urlStr, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    let hops = 0;
    const go = (target) => {
      let u;
      try { u = new URL(target); } catch (_) { return reject(new Error('链接不合法：' + target)); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return reject(new Error('只支持 http/https 链接'));
      }
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.get(u, {
        headers: {
          'User-Agent': UA,
          Accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.5',
        },
        timeout: o.timeout || TIMEOUT_MS,
      }, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          hops++;
          if (hops > MAX_REDIRECTS) return reject(new Error('重定向次数过多'));
          return go(new URL(res.headers.location, u).toString());
        }
        if (status !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + status + '（' + (u.hostname || '') + '）'));
        }
        const len = Number(res.headers['content-length'] || 0);
        if (len && len > MAX_BYTES) {
          res.resume();
          return reject(new Error('文件太大（' + Math.round(len / 1048576) + 'MB）'));
        }
        const chunks = [];
        let got = 0;
        res.on('data', (c) => {
          got += c.length;
          if (got > MAX_BYTES) {
            try { req.destroy(); } catch (_) {}
            return reject(new Error('文件超过 80MB 上限'));
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({
          status, headers: res.headers, body: Buffer.concat(chunks), finalUrl: u.toString(),
        }));
        res.on('error', reject);
      });
      req.on('timeout', () => { try { req.destroy(); } catch (_) {} reject(new Error('请求超时')); });
      req.on('error', reject);
    };
    go(urlStr);
  });
}

function isPdfBuffer(buf) {
  if (!buf || buf.length < 5) return false;
  // 允许 BOM / 前导空白，但标准 PDF 就是 %PDF-
  return buf.slice(0, 5).toString('latin1') === '%PDF-';
}

// 下载到 destPath（先 .part 再改名）。返回 { ok, path, bytes } 或 { ok:false, error }
// 约定：网络层错误也走返回值，不往外抛（调用方只需判断 ok）
async function downloadPdf(urlStr, destPath, opts) {
  let res;
  try {
    res = await request(urlStr, opts);
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
  if (!isPdfBuffer(res.body)) {
    const ct = String(res.headers['content-type'] || '');
    return {
      ok: false,
      error: /text\/html/i.test(ct) || /<html/i.test(res.body.slice(0, 400).toString('utf8'))
        ? '这个链接打开的是网页，不是 PDF（可能需要机构登录）'
        : '下载到的东西不是 PDF',
      finalUrl: res.finalUrl,
    };
  }
  const part = destPath + '.part';
  try {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(part, res.body);
    if (fs.existsSync(destPath)) { try { fs.unlinkSync(destPath); } catch (_) {} }
    fs.renameSync(part, destPath);
  } catch (err) {
    try { fs.unlinkSync(part); } catch (_) {}
    return { ok: false, error: '保存失败：' + (err && err.message ? err.message : err) };
  }
  return { ok: true, path: destPath, bytes: res.body.length, finalUrl: res.finalUrl };
}

// 从各路开放获取索引里挑一个 PDF 直链。全部失败就返回空数组，不抛。
// 四路并行（Unpaywall / OpenAlex / Semantic Scholar / Europe PMC）：
// 串行的话最坏要等四个超时，用户会以为卡死；并行只等最慢的那一路。
async function oaCandidates(info, ep) {
  const i = info || {};
  const doi = String(i.doi || '').trim();
  if (!doi) return [];
  const email = String(i.email || '').trim();
  const tasks = [];

  const pick = (source, fn) => tasks.push((async () => {
    try {
      const r = await request(fn(), { timeout: 12000 });
      const j = JSON.parse(r.body.toString('utf8'));
      return { source, url: pickPdfUrl(source, j) };
    } catch (_) { return { source, url: '' }; }
  })());

  if (email) {
    tasks.push((async () => {
      try {
        const r = await request(ep.unpaywall(doi, email), { timeout: 12000 });
        const j = JSON.parse(r.body.toString('utf8'));
        const list = [j && j.best_oa_location].concat(Array.isArray(j && j.oa_locations) ? j.oa_locations : []);
        for (const loc of list) {
          if (!loc) continue;
          const u = loc.url_for_pdf || loc.url;
          if (u) return { source: 'unpaywall', url: u, note: loc.host_type || '' };
        }
      } catch (_) { /* 查不到不算错误 */ }
      return { source: 'unpaywall', url: '' };
    })());
  }
  pick('openalex', () => ep.openalex(doi));
  pick('semanticscholar', () => ep.semanticscholar(doi));
  pick('europepmc', () => ep.europepmc(doi));

  const rows = await Promise.all(tasks);
  // 顺序固定：Unpaywall 的 best_oa_location 最准，其后是 OpenAlex / S2 / Europe PMC。
  // 注意不能用 `rank[x] || 9`——unpaywall 的序号就是 0，会被 0 当成「没有」而排到最后。
  const rank = { unpaywall: 0, openalex: 1, semanticscholar: 2, europepmc: 3 };
  const at = (src) => (Object.prototype.hasOwnProperty.call(rank, src) ? rank[src] : 9);
  return rows.filter((r) => r && r.url).sort((a, b) => at(a.source) - at(b.source));
}

function pickPdfUrl(source, j) {
  if (!j) return '';
  if (source === 'openalex') {
    const loc = j.best_oa_location
      || (Array.isArray(j.locations) ? j.locations.find((x) => x && x.pdf_url) : null);
    return (loc && (loc.pdf_url || loc.landing_page_url)) || '';
  }
  if (source === 'semanticscholar') {
    return (j.openAccessPdf && j.openAccessPdf.url) || '';
  }
  if (source === 'europepmc') {
    const list = (((j.resultList || {}).result || [])[0] || {}).fullTextUrlList;
    const urls = (list && list.fullTextUrl) || [];
    const pdf = urls.find((x) => x && /pdf/i.test(x.documentStyle || '') && x.url);
    const any = pdf || urls.find((x) => x && x.url && /^(OA|F)$/i.test(x.availabilityCode || ''));
    return (any && any.url) || '';
  }
  return '';
}

// 解析出「该去哪个 URL 拿 PDF」。返回 { candidates: [{url, source, note}] }
// info: { doi, arxivId, url, email, title, publication, year, volume, issue, pages,
//         proxy（机构代理前缀）, openurl（链接解析器基址） }
async function resolveCandidates(info, endpoints) {
  const ep = Object.assign({}, ENDPOINTS, endpoints || {});
  const i = info || {};
  const out = [];
  const seen = new Set();
  const push = (url, source, note) => {
    const u = String(url || '').trim();
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push({ url: u, source, note: note || '' });
  };

  const arxivId = i.arxivId || arxivIdFromUrl(i.url);
  if (arxivId) push(ep.arxivPdf(arxivId), 'arxiv');

  for (const c of await oaCandidates(i, ep)) push(c.url, c.source, c.note);

  if (i.url && /^https?:\/\//i.test(i.url)) push(i.url, 'direct');
  if (i.doi) push(ep.doiResolver(i.doi), 'doi');
  // 代理版排在最后：开放获取能直连就先直连，别让代理白跑一趟；
  // 反过来（代理优先）会让本来能下的 PDF 绕一圈登录页。
  if (i.proxy) {
    if (i.doi) push(applyProxy(ep.doiResolver(i.doi), i.proxy), 'proxy');
    if (i.url) push(applyProxy(i.url, i.proxy), 'proxy');
  }
  if (i.openurl) push(openUrlFor(i.openurl, i), 'openurl');
  return out;
}

function arxivIdFromUrl(u) {
  const s = String(u || '');
  const m = /arxiv\.org\/(?:abs|pdf)\/([a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i.exec(s);
  if (m) return m[1];
  const m2 = /arxiv[:.\s/]*(\d{4}\.\d{4,5})(?:v\d+)?/i.exec(s);
  if (m2) return m2[1];
  // 裸 id（用户直接粘「2401.12345v2」或「hep-th/9901001」）
  const bare = s.trim();
  const m3 = /^(\d{4}\.\d{4,5})(?:v\d+)?$/.exec(bare);
  if (m3) return m3[1];
  const m4 = /^([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i.exec(bare);
  return m4 ? m4[1] : '';
}

/*
 * 只把「看着就是 PDF」的链接当成可优先直连的地址。
 * 条目里的 url 经常是文章落地页（HTML），慢的时候要几十秒才返回；把它当直链
 * 会让 OA 已经拿到的 PDF 干等（R-v1.6b-03）。落地页仍然会试，只是排在 OA 之后。
 */
function looksLikePdf(url) {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return false;
  try {
    const p = new URL(u).pathname;
    if (/\.pdf$/i.test(p)) return true;
    if (/\/(pdf|download|fulltext|full-text|bitstream)\//i.test(p)) return true;
  } catch (_) { return false; }
  return /arxiv\.org\/pdf\//i.test(u);
}

// 依次尝试候选链接，第一个成功的就是它。返回 { ok, path, source, bytes, tried }
//
// v1.6：已知的直链（arXiv / 条目自己的 URL）先跑，开放获取查询在后台同时进行。
// 以前要等四路 OA 全部返回才开始下载，最坏白等 12 秒——而 arXiv 和直链根本不需要等。
// 顺序仍是「越可能成功的越靠前」：arXiv 最稳，其次条目自己的链接，最后才是
// 后台查出来的 OA 副本与 DOI / 代理 / 解析器。
async function fetchToFile(info, destPath, opts) {
  const o = opts || {};
  const ep = Object.assign({}, ENDPOINTS, o.endpoints || {});
  const i = info || {};
  const arxivId = i.arxivId || arxivIdFromUrl(i.url);

  const known = [];
  if (arxivId) known.push({ url: ep.arxivPdf(arxivId), source: 'arxiv' });
  const directUrl = (i.url && /^https?:\/\//i.test(i.url)) ? i.url : '';
  // 只有「看着就是 PDF」的才抢先跑；落地页留给 OA 之后的正常顺序
  if (directUrl && looksLikePdf(directUrl)) known.push({ url: directUrl, source: 'direct' });

  if (!known.length && !directUrl && !i.doi && !i.openurl) {
    return { ok: false, error: '这条文献没有 DOI / arXiv / 链接，先在详情里补上其中一个', tried: [] };
  }

  // 先发出去，别 await：没有 DOI 时它会立刻返回空数组，有 DOI 时这几秒正好用来下载
  const oaPromise = oaCandidates(i, ep).catch(() => []);
  const tried = [];
  const triedUrls = new Set();
  const attempt = async (c) => {
    triedUrls.add(c.url);
    try {
      const r = await downloadPdf(c.url, destPath, { timeout: o.timeout });
      if (r.ok) return { ok: true, path: r.path, source: c.source, bytes: r.bytes, tried };
      tried.push({ source: c.source, url: c.url, error: r.error });
    } catch (err) {
      tried.push({ source: c.source, url: c.url, error: String(err && err.message ? err.message : err) });
    }
    return null;
  };

  for (const c of known) {
    const hit = await attempt(c);
    if (hit) return hit;
  }

  // 已知直链都不行，再收 OA 的结果（这时它多半已经查完了）
  const rest = [];
  for (const c of await oaPromise) rest.push(c);
  if (directUrl) rest.push({ url: directUrl, source: 'direct' });
  if (i.doi) rest.push({ url: ep.doiResolver(i.doi), source: 'doi' });
  if (i.proxy) {
    if (i.doi) rest.push({ url: applyProxy(ep.doiResolver(i.doi), i.proxy), source: 'proxy' });
    if (i.url) rest.push({ url: applyProxy(i.url, i.proxy), source: 'proxy' });
  }
  if (i.openurl) rest.push({ url: openUrlFor(i.openurl, i), source: 'openurl' });

  for (const c of rest) {
    if (!c || !c.url || triedUrls.has(c.url)) continue;
    const hit = await attempt(c);
    if (hit) return hit;
  }

  const first = tried[0] || {};
  return {
    ok: false,
    error: '没抓到 PDF：' + (first.error || '所有来源都失败'),
    tried,
  };
}

module.exports = {
  request, downloadPdf, resolveCandidates, fetchToFile, arxivIdFromUrl, isPdfBuffer,
  applyProxy, openUrlFor, pickPdfUrl, oaCandidates, looksLikePdf,
  ENDPOINTS, MAX_BYTES,
};
