/**
 * Cloudflare Worker: YouTube iOS 双语字幕 (V44 - 纯净高可用 Google 版)
 *
 * 相比 V43 的变更：
 *
 * [P0] 彻底移除 LLM (火山方舟) 和 Baidu 翻译，回归纯免费的 Google 翻译接口，避免商用 API 耗时过长及浪费额度。
 * * [P1] 极致优化 Google 防封锁 (429/403) 机制：
 * - 引入温和并发引擎 (并发数 CC = 2)，绝不瞬间爆发请求。
 * - 提升单批次处理量 (BS = 60)，大幅降低对于超长视频的总 HTTP 请求次数。
 * - 随机打乱策略池：将并发请求分散到 Google 的不同子域名和 Client 通道上，避免单节点触发限流。
 * - 深度指数退避：遇到 429 时休眠 1.5 秒再重试。
 */

function varintSize(v) { v = v >>> 0; let s = 0; do { s++; v >>>= 7; } while (v > 0); return s; }
function writeVarint(buf, offset, value) { let v = value >>> 0; while (v > 0x7f) { buf[offset++] = (v & 0x7f) | 0x80; v >>>= 7; } buf[offset] = v; }

class PbReader {
  constructor(bytes) { this.buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); this.pos = 0; this.len = this.buf.length; }
  eof() { return this.pos >= this.len; }
  uint32() { let r = 0, s = 0; while (this.pos < this.len) { const b = this.buf[this.pos++]; r |= (b & 0x7f) << s; if ((b & 0x80) === 0) return r >>> 0; s += 7; if (s >= 35) { this.pos++; return r >>> 0; } } return 0; }
  bytes() { const len = this.uint32(); if (this.pos + len > this.len) throw new Error('overrun'); const s = this.buf.slice(this.pos, this.pos + len); this.pos += len; return s; }
}

class PbWriter {
  constructor() { this.bufs = []; this.totalLen = 0; }
  _push(b) { const d = b instanceof Uint8Array ? b : new Uint8Array(b); this.bufs.push(d); this.totalLen += d.length; }
  uint32(v) { const buf = new Uint8Array(varintSize(v >>> 0)); writeVarint(buf, 0, v >>> 0); this._push(buf); return this; }
  bytes(data) { const d = data instanceof Uint8Array ? data : new Uint8Array(data); this.uint32(d.length); this._push(d); return this; }
  finish() { const out = new Uint8Array(this.totalLen); let off = 0; for (const b of this.bufs) { out.set(b, off); off += b.length; } return out; }
}

function pbDecode(bytes) {
  const r = new PbReader(bytes); const obj = {};
  while (!r.eof()) {
    let tag; try { tag = r.uint32(); } catch { break; } if (tag === 0) break;
    const fn = tag >>> 3, wt = tag & 0x07, key = String(fn); let val;
    try {
      if (wt === 0) val = { t: 'varint', v: r.uint32() };
      else if (wt === 1) { if (r.pos + 8 > r.len) break; val = { t: 'fixed64', v: r.buf.slice(r.pos, r.pos + 8) }; r.pos += 8; }
      else if (wt === 2) {
        const raw = r.bytes(); let nested = null;
        if (raw.length >= 2) { try { const n = pbDecode(raw); if (Object.keys(n).length > 0) nested = n; } catch {} }
        val = nested ? { t: 'msg', v: nested, raw } : { t: 'raw', v: raw };
      }
      else if (wt === 5) { if (r.pos + 4 > r.len) break; const dv = new DataView(r.buf.buffer, r.buf.byteOffset + r.pos, 4); val = { t: 'fixed32', v: dv.getUint32(0, true) }; r.pos += 4; }
      else break;
    } catch { break; }
    if (key in obj) { const ex = obj[key]; obj[key] = Array.isArray(ex) ? [...ex, val] : [ex, val]; } else obj[key] = val;
  }
  return obj;
}

const ENC = new TextEncoder();
const UTF8 = new TextDecoder('utf-8', { fatal: true });

function pbEncode(obj) {
  const w = new PbWriter();
  for (const [key, fieldVal] of Object.entries(obj)) {
    const fn = parseInt(key); if (isNaN(fn) || fn <= 0) continue;
    const items = Array.isArray(fieldVal) ? fieldVal : [fieldVal];
    for (const val of items) {
      if (!val) continue;
      if (val.t === 'varint') { w.uint32((fn << 3) | 0); w.uint32(val.v); }
      else if (val.t === 'fixed64') { w.uint32((fn << 3) | 1); w._push(val.v); }
      else if (val.t === 'fixed32') { w.uint32((fn << 3) | 5); const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, val.v, true); w._push(b); }
      else if (val.t === 'string') { w.uint32((fn << 3) | 2); w.bytes(ENC.encode(val.v)); }
      else if (val.t === 'msg') {
        if (val.dirty) { w.uint32((fn << 3) | 2); w.bytes(pbEncode(val.v)); }
        else if (val.raw) { w.uint32((fn << 3) | 2); w.bytes(val.raw); }
        else { w.uint32((fn << 3) | 2); w.bytes(pbEncode(val.v)); }
      }
      else if (val.t === 'raw') { w.uint32((fn << 3) | 2); w.bytes(val.v); }
    }
  }
  return w.finish();
}

function tryStr(val) {
  if (!val || Array.isArray(val)) return null;
  if (val.t === 'string') return val.v;
  if (val.t === 'raw') { try { return UTF8.decode(val.v); } catch { return null; } }
  if (val.t === 'msg' && val.raw) { try { return UTF8.decode(val.raw); } catch { return null; } }
  return null;
}

function isTimestamp(s) {
  return s && /^\d{1,2}:\d{2}$/.test(s.trim());
}

function findDeepText(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const f1 = obj['1'];
  if (f1) {
    let str = '';
    if (Array.isArray(f1)) str = f1.map(item => tryStr(item) || '').join('');
    else str = tryStr(f1) || '';
    if (str && !isTimestamp(str) && str.trim().length > 3) return str;
  }
  for (const val of Object.values(obj)) {
    for (const item of (Array.isArray(val) ? val : [val])) {
      if (item && item.t === 'msg') {
        const res = findDeepText(item.v);
        if (res) return res;
      }
    }
  }
  return null;
}

function extractTimeAndText(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const f1 = obj['1'], f5 = obj['5'];
  if (f1 && f5) {
    let t1 = '';
    if (Array.isArray(f1)) t1 = f1.map(item => tryStr(item) || '').join('');
    else t1 = tryStr(f1) || '';
    const t5 = Array.isArray(f5) ? tryStr(f5[0]) : tryStr(f5);
    if (t1 && isTimestamp(t5)) return { time: t5, text: t1, type: 'normal' };
  }
  if (f1 && !f5) {
    const t1 = Array.isArray(f1) ? tryStr(f1[0]) : tryStr(f1);
    if (isTimestamp(t1)) {
      const f2obj = obj['2'];
      if (f2obj) {
        const text = findDeepText(Array.isArray(f2obj) ? { _items: f2obj } : (f2obj.t === 'msg' ? f2obj.v : null));
        if (text) return { time: t1, text, type: 'nested' };
      }
    }
  }
  return null;
}

function adjustField7(obj, appendBytesLength) {
  const f7 = obj['7'];
  if (f7 && !Array.isArray(f7) && f7.t === 'varint' && f7.v > 0) {
    obj['7'] = { t: 'varint', v: f7.v + appendBytesLength };
  }
}

function replaceDeepText(obj, appendStr) {
  if (!obj || typeof obj !== 'object') return false;
  const f1 = obj['1'];
  if (f1) {
    let str = '';
    if (Array.isArray(f1)) str = f1.map(item => tryStr(item) || '').join('');
    else str = tryStr(f1) || '';
    if (str && !isTimestamp(str) && str.trim().length > 3) {
      if (Array.isArray(f1)) f1.push({ t: 'string', v: appendStr });
      else obj['1'] = { t: 'string', v: str + appendStr };
      adjustField7(obj, ENC.encode(appendStr).length);
      obj.__dirty = true;
      return true;
    }
  }
  for (const [key, val] of Object.entries(obj)) {
    if (key === '__dirty') continue;
    for (const item of (Array.isArray(val) ? val : [val])) {
      if (item && item.t === 'msg') {
        if (replaceDeepText(item.v, appendStr)) {
          item.dirty = true; obj.__dirty = true; return true;
        }
      }
    }
  }
  return false;
}

function hackTextAndLength(obj, appendStr, extractedType) {
  if (!obj || typeof obj !== 'object') return;
  if (extractedType === 'normal') {
    const f1 = obj['1'];
    if (f1) {
      if (Array.isArray(f1)) f1.push({ t: 'string', v: appendStr });
      else { const str = tryStr(f1) || ''; obj['1'] = { t: 'string', v: str + appendStr }; }
      adjustField7(obj, ENC.encode(appendStr).length);
      obj.__dirty = true;
    }
  } else if (extractedType === 'nested') {
    const f2 = obj['2'];
    if (f2) {
      const target = Array.isArray(f2) ? f2.find(item => item && item.t === 'msg') : (f2.t === 'msg' ? f2 : null);
      if (target && replaceDeepText(target.v, appendStr)) { target.dirty = true; obj.__dirty = true; }
    }
  }
}

function collectSegmentsGlobally(obj, segments = []) {
  if (!obj || typeof obj !== 'object') return segments;
  const extracted = extractTimeAndText(obj);
  if (extracted) {
    segments.push({ origText: extracted.text, origTime: extracted.time, type: extracted.type });
    return segments;
  }
  for (const val of Object.values(obj)) {
    for (const item of (Array.isArray(val) ? val : [val])) {
      if (item && item.t === 'msg') collectSegmentsGlobally(item.v, segments);
    }
  }
  return segments;
}

function injectTranslationsGlobally(obj, translations, state = { idx: 0 }) {
  if (!obj || typeof obj !== 'object') return false;
  let changed = false;
  const extracted = extractTimeAndText(obj);
  if (extracted) {
    const cleanOrig = extracted.text.replace(/\n/g, ' ').trim();
    let zh = translations[state.idx];

    if (!zh || zh === cleanOrig) {
      zh = `【受限】${cleanOrig.slice(0, 10)}...`;
    }

    const appendStr = `\n\u3000${zh}`;
    hackTextAndLength(obj, appendStr, extracted.type);
    obj.__dirty = true;
    state.idx++;
    return true;
  }
  for (const val of Object.values(obj)) {
    for (const item of (Array.isArray(val) ? val : [val])) {
      if (item && item.t === 'msg') {
        if (injectTranslationsGlobally(item.v, translations, state)) {
          item.dirty = true; obj.__dirty = true; changed = true;
        }
      }
    }
  }
  return changed;
}

// ================================================================
// 翻译引擎 V44 (纯净 Google 版 - 高阶防封机制)
// ================================================================

const UAs = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
];

function getRandomUA() { return UAs[Math.floor(Math.random() * UAs.length)]; }
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 打乱数组顺序 (Fisher-Yates)
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

async function fetchTimeout(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(t);
    return r;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

async function translateBatch(texts, targetLang, batchIndex) {
  if (!texts.length) return [];
  const clean = texts.map(t => (t || '').replace(/\n/g, ' ').trim());
  const bodyText = clean.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const body = `q=${encodeURIComponent(bodyText)}`;
  
  const RE = /(\d+)[\.、:：]\s*([\s\S]*?)(?=\n\d+[\.、:：]|$)/g;
  const parseOutText = (outStr) => {
    const map = {};
    let m;
    while ((m = RE.exec(outStr)) !== null) {
      const i = parseInt(m[1]) - 1, t = m[2].trim();
      if (i >= 0 && i < texts.length && t) map[i] = t;
    }
    return clean.map((orig, i) => map[i] || orig);
  };

  // Google 多线路策略池 (新增 te 扩展通道，增加存活率)
  let strategies = [
    { host: 'translate.googleapis.com', client: 'gtx' },
    { host: 'clients5.google.com', client: 'dict-chrome-ex' },
    { host: 'translate.google.com', client: 'webapp' },
    { host: 'translate.googleapis.com', client: 'te' }
  ];
  
  // 随机打乱策略列表，将并发压力随机分散给 Google 的不同节点，极大降低被判定为恶意请求的概率
  strategies = shuffleArray(strategies);
  
  for (const { host, client } of strategies) {
    try {
      // console.log(`[Google] 批次 ${batchIndex}：尝试调用 ${host} ...`);
      const url = `https://${host}/translate_a/single?client=${client}&sl=auto&tl=${targetLang}&dt=t`;
      const r = await fetchTimeout(url, { 
        method: 'POST', 
        headers: { 
          'User-Agent': getRandomUA(), 
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        }, 
        body 
      }, 8000);

      if (!r.ok) {
        console.warn(`[Google] 批次 ${batchIndex} [${host}] client=${client} 拦截 HTTP ${r.status}`);
        if (r.status === 429 || r.status === 403) {
          // 深度退避：遇到限流，强制休眠 1.5 秒再尝试下一种策略
          await sleep(1500);
        }
        continue;
      }

      const data = await r.json();
      let outStr = '';
      if (data?.[0]) for (const p of data[0]) { if (p[0]) outStr += p[0]; }
      
      console.log(`[Google] ✅ 批次 ${batchIndex} [${host}] 翻译成功`);
      return parseOutText(outStr);

    } catch (e) {
      console.warn(`[Google] 批次 ${batchIndex} [${host}] 失败: ${e.message}`);
    }
  }
  
  console.error(`[Google] ❌ 批次 ${batchIndex} 全部策略均告失败，返回原文`);
  return clean;
}

async function translateAll(segments, targetLang) {
  if (!segments || !segments.length) return { translations: [], successCount: 0 };
  
  // [V44 核心] 增大单次处理量，降低总请求次数。
  const BS = 60; 
  // [V44 核心] 启用温和受控并发，最多同时只有 2 个请求在跑，避免冲垮 Google
  const CC = 2; 

  const batches = [];
  for (let i = 0; i < segments.length; i += BS) batches.push(segments.slice(i, i + BS));
  
  console.log(`共 ${segments.length} 段，分 ${batches.length} 批 (每批 ${BS} 条)，并发数: ${CC}`);
  const t0 = Date.now();
  const results = new Array(batches.length);
  let index = 0;

  // 简单的任务调度器，限制最大并发数为 CC
  async function runner() {
    while (index < batches.length) {
      const i = index++;
      if (i > 0) {
        // 批次之间的基础安全间隔，避免发送过快
        await sleep(500 + Math.random() * 500); 
      }
      results[i] = await translateBatch(batches[i].map(s => s.origText), targetLang, i);
    }
  }

  // 启动有限数量的 runner 并发执行
  const workers = Array(Math.min(CC, batches.length)).fill(0).map(() => runner());
  await Promise.all(workers);

  const all = results.flat();
  const ok = all.filter((t, i) => t && t !== (segments[i]?.origText || '').replace(/\n/g, ' ').trim()).length;
  console.log(`翻译完成，总耗时 ${Date.now() - t0}ms，有效 ${ok}/${segments.length}`);
  return { translations: all, successCount: ok };
}

async function processAndInjectSubtitles(obj, targetLang = 'zh-CN') {
  if (!obj || typeof obj !== 'object') return { changed: false, rate: 0 };
  const segments = collectSegmentsGlobally(obj);
  console.log(`字幕段落: ${segments.length}`);
  if (!segments.length) return { changed: false, rate: 0 };
  const { translations, successCount } = await translateAll(segments, targetLang);
  const changed = injectTranslationsGlobally(obj, translations, { idx: 0 });
  return { changed, rate: successCount / segments.length };
}

// ================================================================
// 网络层与缓存工具 
// ================================================================

function fnv1aHash(buffer) {
  let h = 2166136261;
  for (let i = 0; i < buffer.length; i++) { h ^= buffer[i]; h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24); h = h >>> 0; }
  return h.toString(16);
}

function extractReqToken(reqBody) {
  const marker = new Uint8Array([80, 65, 109, 111, 100, 101, 114, 110, 95, 116, 114, 97, 110, 115, 99, 114, 105, 112, 116, 95, 118, 105, 101, 119]); // "PAmodern_transcript_view"
  for (let i = 0; i <= reqBody.length - marker.length; i++) {
    let match = true;
    for (let j = 0; j < marker.length; j++) {
      if (reqBody[i + j] !== marker[j]) { match = false; break; }
    }
    if (match) {
      const tagIdx = i + marker.length;
      if (reqBody[tagIdx] === 0x1a) {
        const len = reqBody[tagIdx + 1];
        if (len > 0 && len < 128 && tagIdx + 2 + len <= reqBody.length) {
          const idBytes = reqBody.slice(tagIdx + 2, tagIdx + 2 + len);
          let idStr = '';
          for (let b of idBytes) idStr += String.fromCharCode(b);
          return idStr;
        }
      }
    }
  }
  return null;
}

async function getCachedResponse(cacheKey) {
  const cached = await caches.default.match(cacheKey);
  if (cached) console.log(`✅ 缓存命中: ${cacheKey}`);
  else console.log(`❌ 缓存未命中: ${cacheKey}`);
  return cached || null;
}

async function cacheResponse(cacheKey, body, status, origHeaders, isGzip) {
  const h = new Headers();
  for (const k of ['content-type', 'vary', 'alt-svc', 'x-content-type-options']) {
    const v = origHeaders.get(k); if (v) h.set(k, v);
  }
  if (isGzip) h.set('Content-Encoding', 'gzip');
  h.set('Content-Type', 'application/x-protobuf');
  h.set('Content-Length', String(body.length));
  h.set('Cache-Control', 'public, max-age=86400');
  const resp = new Response(body, { status, headers: h });
  if (status >= 200 && status < 400) {
    try { await caches.default.put(cacheKey, resp.clone()); console.log('✅ 双语字幕已缓存 24h'); }
    catch (e) { console.warn('缓存写入失败:', e.message); }
  }
  return resp;
}

function makeResponse(body, status, origHeaders, isGzip) {
  const h = new Headers();
  for (const k of ['content-type', 'vary', 'alt-svc', 'x-content-type-options']) {
    const v = origHeaders.get(k); if (v) h.set(k, v);
  }
  if (isGzip) h.set('Content-Encoding', 'gzip');
  h.set('Content-Type', 'application/x-protobuf');
  h.set('Content-Length', String(body.length));
  return new Response(body, { status, headers: h });
}

async function gunzip(data) {
  try {
    const ds = new DecompressionStream('gzip');
    const w = ds.writable.getWriter(); w.write(data); w.close();
    const chunks = [];
    for (const r = ds.readable.getReader();;) { const { done, value } = await r.read(); if (done) break; chunks.push(value); }
    const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
    let off = 0; for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  } catch { return null; }
}

async function gzip(data) {
  try {
    const cs = new CompressionStream('gzip');
    const w = cs.writable.getWriter(); w.write(data); w.close();
    const chunks = [];
    for (const r = cs.readable.getReader();;) { const { done, value } = await r.read(); if (done) break; chunks.push(value); }
    const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
    let off = 0; for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  } catch { return data; }
}

export default {
  async fetch(request) {
    if (request.method === 'GET') {
      const purgeKey = new URL(request.url).searchParams.get('purge');
      if (purgeKey) { await caches.default.delete(purgeKey); return new Response('purged: ' + purgeKey); }
      return new Response('Worker V44 (Pure Google Translation - Anti-429 Engine)');
    }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    try {
      const reqBody = new Uint8Array(await request.arrayBuffer());
      const lang = 'zh-CN';
      
      const tokenStr = extractReqToken(reqBody);
      const cacheKey = `https://yt-sub-cache/v44/${tokenStr || fnv1aHash(reqBody)}/${lang}`;
      
      const earlyHit = await getCachedResponse(cacheKey);
      if (earlyHit) return earlyHit;

      const fwd = new Headers();
      const skip = new Set(['host','accept-encoding','content-length','connection','keep-alive',
        'proxy-authenticate','proxy-authorization','te','trailers','transfer-encoding','upgrade',
        'cf-connecting-ip','cf-ray','cf-ew-via','cdn-loop','x-forwarded-for','x-forwarded-proto','x-real-ip']);
      for (const [k, v] of request.headers) { if (!skip.has(k.toLowerCase())) fwd.set(k, v); }
      fwd.set('Accept-Encoding', 'gzip, identity');

      const ytResp = await fetchTimeout(
        'https://youtubei.googleapis.com/youtubei/v1/get_panel',
        { method: 'POST', headers: fwd, body: reqBody },
        15000
      );

      let bytes = new Uint8Array(await ytResp.arrayBuffer());
      const isGzip = (ytResp.headers.get('content-encoding') || '').includes('gzip');
      if (isGzip) { const d = await gunzip(bytes); if (d) bytes = d; else console.warn('gunzip 失败'); }

      let parsed;
      try { parsed = pbDecode(bytes); }
      catch (e) { return makeResponse(isGzip ? await gzip(bytes) : bytes, ytResp.status, ytResp.headers, isGzip); }

      // 注意：V44 不再传递 env 参数
      const injectResult = await processAndInjectSubtitles(parsed, lang);

      if (!injectResult.changed) {
        return makeResponse(isGzip ? await gzip(bytes) : bytes, ytResp.status, ytResp.headers, isGzip);
      }

      const rebuilt = pbEncode(parsed);
      const final = isGzip ? await gzip(rebuilt) : rebuilt;

      if (injectResult.rate < 0.6) {
        console.log(`⚠️ 成功率 ${(injectResult.rate * 100).toFixed(1)}%，不缓存`);
        return makeResponse(final, ytResp.status, ytResp.headers, isGzip);
      }

      return await cacheResponse(cacheKey, final, ytResp.status, ytResp.headers, isGzip);

    } catch (e) {
      console.error(`致命错误: ${e.message}`);
      return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
  },
};
