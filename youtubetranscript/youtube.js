/**
 * Cloudflare Worker: YouTube iOS 双语字幕 (V26 跨章节无死角版)
 * 核心升级：废除大数组锁定逻辑。采用全树递归提取，完美支持多章节长视频，彻底解决翻译中断问题！
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

// ================================================================
// 全树无死角采集与注入逻辑
// ================================================================

function extractTimeAndText(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const f1 = obj['1'], f5 = obj['5'];
  if (!Array.isArray(f1) && !Array.isArray(f5)) {
    const t1 = tryStr(f1), t5 = tryStr(f5);
    if (t1 && t5 && /\d:\d/.test(t5)) return { time: t5, text: t1 };
  }
  return null; // 不再递归深入，仅判断当前节点
}

function hackTextAndLength(obj, newText, oldText) {
  if (!obj || typeof obj !== 'object') return;
  const f1 = obj['1'], f5 = obj['5'];
  
  if (!Array.isArray(f1) && !Array.isArray(f5)) {
    const t1 = tryStr(f1), t5 = tryStr(f5);
    if (t1 && t5 && /\d:\d/.test(t5)) {
      if (newText !== null) {
        obj['1'] = { t: 'string', v: newText };
        
        const f7 = obj['7'];
        if (f7 && !Array.isArray(f7) && f7.t === 'varint' && f7.v > 0) {
          const oldBytes = ENC.encode(oldText || t1);
          const newBytes = ENC.encode(newText);
          const diff = newBytes.length - oldBytes.length;
          if (diff > 0) obj['7'] = { t: 'varint', v: f7.v + diff };
        }
      }
      obj.__dirty = true;
    }
  }
}

// 第一遍全树递归：搜刮每一个角落的字幕
function collectSegmentsGlobally(obj, segments = []) {
  if (!obj || typeof obj !== 'object') return segments;
  
  // 检查当前节点是不是字幕节点
  const extracted = extractTimeAndText(obj);
  if (extracted) {
    segments.push({ origText: extracted.text, origTime: extracted.time });
  }

  // 无论是不是，都继续往下找
  for (const val of Object.values(obj)) {
    for (const item of (Array.isArray(val) ? val : [val])) {
      if (item && item.t === 'msg') {
        collectSegmentsGlobally(item.v, segments);
      }
    }
  }
  return segments;
}

// 第二遍全树递归：按照翻译数组的顺序依次填坑
function injectTranslationsGlobally(obj, translations, state = { idx: 0 }) {
  if (!obj || typeof obj !== 'object') return false;
  let changed = false;

  const extracted = extractTimeAndText(obj);
  if (extracted) {
    // 找到了坑，填进去！
    let zh = translations[state.idx];
    if (!zh || zh === extracted.text) zh = `【受限】${extracted.text.slice(0, 10)}...`;
    
    // 【采用你最完美的排版：回车 + 全角缩进】
    const combinedText = `${extracted.text}\n\u3000${zh}`;
    
    hackTextAndLength(obj, combinedText, extracted.text);
    obj.__dirty = true;
    state.idx++;
    return true; // 这个节点改过了，不用往它的子节点找字幕了
  }

  // 如果当前节点不是坑，去子节点找
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

async function processAndInjectSubtitles(obj, targetLang = 'zh-CN') {
  if (!obj || typeof obj !== 'object') return { changed: false, rate: 0 };

  console.log(`[DEBUG] 🎯 开始全树无死角搜刮字幕...`);
  const segments = collectSegmentsGlobally(obj);
  
  if (segments.length === 0) {
    console.log(`[DEBUG] ❌ 未找到任何字幕。`);
    return { changed: false, rate: 0 };
  }

  console.log(`[DEBUG] 🎯 共搜刮到 ${segments.length} 句字幕，准备翻译...`);
  const { translations, successCount } = await translateAll(segments, targetLang);
  const rate = successCount / segments.length;

  console.log(`[DEBUG] 🎯 开始全树无死角注入翻译...`);
  const state = { idx: 0 };
  const changed = injectTranslationsGlobally(obj, translations, state);

  console.log(`[DEBUG] ✅ 注入完成！共填入 ${state.idx} 句。`);
  return { changed: changed, rate: rate };
}

// ================================================================
// 网络请求与防封翻译核心
// ================================================================

function fnv1aHash(buffer) {
  let h = 2166136261;
  for (let i = 0; i < buffer.length; i++) { h ^= buffer[i]; h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24); h = h >>> 0; }
  return h.toString(16);
}

function extractReqToken(reqBody) {
  const marker = new Uint8Array([80, 65, 109, 111, 100, 101, 114, 110, 95, 116, 114, 97, 110, 115, 99, 114, 105, 112, 116, 95, 118, 105, 101, 119]); 
  for (let i = 0; i <= reqBody.length - marker.length; i++) {
    let match = true;
    for (let j = 0; j < marker.length; j++) { if (reqBody[i + j] !== marker[j]) { match = false; break; } }
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

async function asyncPool(concurrency, tasks, taskFn) {
  const results = new Array(tasks.length);
  let index = 0;
  async function runner() { while (index < tasks.length) { const i = index++; results[i] = await taskFn(tasks[i], i); } }
  await Promise.all(Array(Math.min(concurrency, tasks.length)).fill(0).map(() => runner()));
  return results;
}

async function fetchTimeout(url, opts = {}, ms = 8000, retries = 1) {
  let lastError;
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r;
    } catch (e) {
      clearTimeout(t); lastError = e;
      if (i < retries) await new Promise(r => setTimeout(r, 300));
    }
  }
  throw lastError;
}

async function translateBatch(texts, targetLang = 'zh-CN') {
  if (!texts.length) return [];
  const clean = texts.map(t => (t || '').replace(/\n/g, ' ').trim());
  const body = `q=${encodeURIComponent(clean.map((t, i) => `${i + 1}. ${t}`).join('\n'))}`;
  try {
    const r = await fetchTimeout(
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t`,
      { method: 'POST', headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/x-www-form-urlencoded' }, body },
      8000, 1
    );
    const data = await r.json();
    let out = '';
    if (data?.[0]) for (const p of data[0]) { if (p[0]) out += p[0]; }
    const map = {};
    const RE = /(\d+)\.\s*([\s\S]*?)(?=\n\d+\.|$)/g;
    let m;
    while ((m = RE.exec(out)) !== null) {
      const i = parseInt(m[1]) - 1, t = m[2].trim();
      if (i >= 0 && i < texts.length && t) map[i] = t;
    }
    return clean.map((orig, i) => map[i] || orig);
  } catch (e) { return clean; }
}

async function translateAll(segments, targetLang = 'zh-CN') {
  if (!segments || segments.length === 0) return { translations: [], successCount: 0 };
  const BS = 20, CC = 2;
  const batches = [];
  for (let i = 0; i < segments.length; i += BS) batches.push(segments.slice(i, i + BS));
  
  const results = await asyncPool(CC, batches, async (b) => {
    return await translateBatch(b.map(s => s.origText), targetLang);
  });
  
  const all = results.flat();
  const ok = all.filter((t, i) => t && t !== (segments[i]?.origText || '').replace(/\n/g, ' ').trim()).length;
  return { translations: all, successCount: ok };
}

async function getCachedResponse(cacheKey) {
  const cached = await caches.default.match(cacheKey);
  if (cached) console.log(`✅ 缓存命中: ${cacheKey}`);
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
    try { await caches.default.put(cacheKey, resp.clone()); } catch (e) {}
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

// ================================================================
// 压缩 / 解压
// ================================================================

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
  } catch (e) { return data; }
}

// ================================================================
// 主入口
// ================================================================

export default {
  async fetch(request) {
    if (request.method === 'GET') {
      const purgeKey = new URL(request.url).searchParams.get('purge');
      if (purgeKey) { await caches.default.delete(purgeKey); return new Response('purged: ' + purgeKey); }
      return new Response('Worker is Running V26 (Cross-Chapter Global Scan)');
    }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    try {
      const reqBody = new Uint8Array(await request.arrayBuffer());
      const lang = 'zh-CN';
      
      const tokenStr = extractReqToken(reqBody);
      const reqId = tokenStr || fnv1aHash(reqBody);
      const cacheKey = `https://yt-sub-cache/v26/global/${reqId}/${lang}`;
      
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
        15000, 0
      );

      let bytes = new Uint8Array(await ytResp.arrayBuffer());
      const isGzip = (ytResp.headers.get('content-encoding') || '').includes('gzip');
      if (isGzip) { const d = await gunzip(bytes); if (d) bytes = d; }

      let parsed;
      try { parsed = pbDecode(bytes); }
      catch (e) { return makeResponse(isGzip ? await gzip(bytes) : bytes, ytResp.status, ytResp.headers, isGzip); }

      const injectResult = await processAndInjectSubtitles(parsed, lang);

      const rebuilt = pbEncode(parsed);
      const final = isGzip ? await gzip(rebuilt) : rebuilt;

      if (injectResult.changed && injectResult.rate >= 0.7) {
        console.log(`[DEBUG] ✅ 允许写入缓存`);
        await cacheResponse(cacheKey, final, ytResp.status, ytResp.headers, isGzip);
      }

      return makeResponse(final, ytResp.status, ytResp.headers, isGzip);

    } catch (e) {
      console.error(`致命错误: ${e.message}\n${e.stack || ''}`);
      return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
  },
};
