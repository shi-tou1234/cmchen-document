'use strict';
/*
 * 抓取 PDF 全文（v9）。报告里差距最大的一项：之前只有 DOI / arXiv 的元数据，
 * 拿不到正文。这里不加依赖，就用 Node 的 http/https 做三件事：
 *
 *   1. arXiv  → https://arxiv.org/pdf/<id>（最稳，无需任何配置）
 *   2. DOI    → Unpaywall 查开放获取链接（需要设置里填一个联系邮箱，
 *                Unpaywall 的礼貌要求；没填就跳过这一步）
 *   3. 直接 URL / doi.org 兜底 → 下载后按魔数校验，不是真 PDF 就报错
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
};

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

// 解析出「该去哪个 URL 拿 PDF」。返回 { candidates: [{url, source, note}] }
// info: { doi, arxivId, url, email }
async function resolveCandidates(info, endpoints) {
  const ep = Object.assign({}, ENDPOINTS, endpoints || {});
  const i = info || {};
  const out = [];
  const arxivId = i.arxivId || arxivIdFromUrl(i.url);
  if (arxivId) out.push({ url: ep.arxivPdf(arxivId), source: 'arxiv' });

  const email = String(i.email || '').trim();
  if (i.doi && email) {
    // Unpaywall：查开放获取副本。查不到不算错误，继续往下试
    try {
      const r = await request(ep.unpaywall(i.doi, email), { timeout: 15000 });
      const j = JSON.parse(r.body.toString('utf8'));
      const best = j && j.best_oa_location;
      const list = [best].concat(Array.isArray(j && j.oa_locations) ? j.oa_locations : []);
      const seen = new Set();
      for (const loc of list) {
        if (!loc) continue;
        const u = loc.url_for_pdf || loc.url;
        if (!u || seen.has(u)) continue;
        seen.add(u);
        out.push({ url: u, source: 'unpaywall', note: loc.host_type || '' });
        break;
      }
    } catch (_) { /* 网络问题就跳过，不让整个流程失败 */ }
  }

  if (i.url && /^https?:\/\//i.test(i.url)) out.push({ url: i.url, source: 'direct' });
  if (i.doi) out.push({ url: ep.doiResolver(i.doi), source: 'doi' });
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

// 依次尝试候选链接，第一个成功的就是它。返回 { ok, path, source, bytes, tried }
async function fetchToFile(info, destPath, opts) {
  const o = opts || {};
  const candidates = await resolveCandidates(info, o.endpoints);
  if (!candidates.length) {
    return { ok: false, error: '这条文献没有 DOI / arXiv / 链接，先在详情里补上其中一个', tried: [] };
  }
  const tried = [];
  for (const c of candidates) {
    try {
      const r = await downloadPdf(c.url, destPath, { timeout: o.timeout });
      if (r.ok) return { ok: true, path: r.path, source: c.source, bytes: r.bytes, tried };
      tried.push({ source: c.source, url: c.url, error: r.error });
    } catch (err) {
      tried.push({ source: c.source, url: c.url, error: String(err && err.message ? err.message : err) });
    }
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
  ENDPOINTS, MAX_BYTES,
};
