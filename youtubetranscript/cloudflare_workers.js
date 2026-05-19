/**
 * Cloudflare Worker: YouTube iOS 雙語字幕 (V49 - 環境變量 + 強制對齊版)
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
  return s && /^(?:\d{1,2}:)?\d{1,2}:\d{2}$/.test(s.trim());
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
// 翻譯引擎 V49 (GAS 代理 + 強制對齊)
// ================================================================

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchTimeout(url, opts = {}, ms = 15000) { 
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

let globalCircuitBroken = false;
let consecutiveErrors = 0;

async function translateBatch(texts, targetLang, batchIndex, gasUrl) {
  if (!texts.length) return [];
  const clean = texts.map(t => (t || '').replace(/\n/g, ' ').trim());
  
  if (globalCircuitBroken) {
    return clean;
  }

  try {
    const payload = {
      texts: clean,
      targetLang: targetLang
    };

    const r = await fetchTimeout(gasUrl, { 
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' }, 
      body: JSON.stringify(payload)
    }, 15000); 

    if (!r.ok) {
      console.warn(`[GAS] 批次 ${batchIndex} 攔截 HTTP ${r.status}`);
      consecutiveErrors++;
      if (consecutiveErrors >= 3) {
        console.error("🚨 觸發全局熔斷！");
        globalCircuitBroken = true;
      }
      return clean;
    }

    const data = await r.json();
    
    if (data.error) {
      throw new Error(data.error);
    }

    consecutiveErrors = 0;
    globalCircuitBroken = false;
    
    const translatedArray = data.translations || [];
    
    if (translatedArray.length === clean.length) {
      console.log(`[GAS] ✅ 批次 ${batchIndex} 翻譯成功`);
      return translatedArray;
    } else {
      console.warn(`[GAS] 批次 ${batchIndex} 長度不符 (預期 ${clean.length}, 實際 ${translatedArray.length})，安全降級`);
      return clean;
    }

  } catch (e) {
    console.warn(`[GAS] 批次 ${batchIndex} 失敗: ${e.message}`);
    return clean;
  }
}

async function translateAll(segments, targetLang, gasUrl) {
  if (!segments || !segments.length) return { translations: [], successCount: 0 };
  
  globalCircuitBroken = false;
  consecutiveErrors = 0;

  const BS = 80; 
  const CC = 3;  
  const MAX_WORKER_TIME = 28000; 

  const batches = [];
  for (let i = 0; i < segments.length; i += BS) batches.push(segments.slice(i, i + BS));
  
  console.log(`共 ${segments.length} 段，分 ${batches.length} 批 (GAS 代理, BS=${BS}, CC=${CC})`);
  const t0 = Date.now();
  const results = new Array(batches.length);
  let index = 0;

  async function runner() {
    while (index < batches.length) {
      if (Date.now() - t0 > MAX_WORKER_TIME) {
        console.error("⏳ 觸發全局超時守護！到達 28 秒紅線，中止剩餘。");
        while (index < batches.length) {
          results[index] = batches[index].map(s => s.origText.replace(/\n/g, ' ').trim());
          index++;
        }
        break;
      }

      const i = index++;
      if (i > 0 && !globalCircuitBroken) {
        await sleep(200); 
      }
      results[i] = await translateBatch(batches[i].map(s => s.origText), targetLang, i, gasUrl);
    }
  }

  const workers = Array(Math.min(CC, batches.length)).fill(0).map(() => runner());
  await Promise.all(workers);

  const all = results.flat();
  const ok = all.filter((t, i) => t && t !== (segments[i]?.origText || '').replace(/\n/g, ' ').trim()).length;
  console.log(`翻譯完成，總耗時 ${Date.now() - t0}ms，有效 ${ok}/${segments.length}`);
  return { translations: all, successCount: ok };
}

async function processAndInjectSubtitles(obj, targetLang, gasUrl) {
  if (!obj || typeof obj !== 'object') return { changed: false, rate: 0 };
  const segments = collectSegmentsGlobally(obj);
  console.log(`字幕段落: ${segments.length}`);
  if (!segments.length) return { changed: false, rate: 0 };
  const { translations, successCount } = await translateAll(segments, targetLang, gasUrl);
  const changed = injectTranslationsGlobally(obj, translations, { idx: 0 });
  return { changed, rate: successCount / segments.length };
}

// ================================================================
// 網路層與快取工具 
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
  if (cached) console.log(`✅ 快取命中: ${cacheKey}`);
  else console.log(`❌ 快取未命中: ${cacheKey}`);
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
    try { await caches.default.put(cacheKey, resp.clone()); console.log('✅ 雙語字幕已快取 24h'); }
    catch (e) { console.warn('快取寫入失敗:', e.message); }
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
  async fetch(request, env) {
    if (request.method === 'GET') {
      const purgeKey = new URL(request.url).searchParams.get('purge');
      if (purgeKey) { await caches.default.delete(purgeKey); return new Response('purged: ' + purgeKey); }
      return new Response('Worker V49 (Env Variables + Strict Alignment)');
    }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    try {
      const reqBody = new Uint8Array(await request.arrayBuffer());
      const lang = 'zh-CN';
      
      const tokenStr = extractReqToken(reqBody);
      const cacheKey = `https://yt-sub-cache/v49/${tokenStr || fnv1aHash(reqBody)}/${lang}`;
      
      const earlyHit = await getCachedResponse(cacheKey);
      if (earlyHit) return earlyHit;

      const fwd = new Headers();
      const skip = new Set(['host','accept-encoding','content-length','connection','keep-alive',
        'proxy-authenticate','proxy-authorization','te','trailers','transfer-encoding','upgrade',
        'cf-connecting-ip','cf-ray','cf-ew-via','cdn-loop','x-forwarded-for','x-forwarded-proto','x-real-ip']);
      for (const [k, v] of request.headers) { if (!skip.has(k.toLowerCase())) fwd.set(k, v); }
      fwd.set('Accept-Encoding', 'gzip, identity');

      // 優先讀取環境變量，若無則使用舊的預設值，避免出錯
      const gasUrl = env.GAS_URL || 'https://script.google.com/macros/s/AKfycbxUfXTjUQX6q1FiVjv5ZsNblPcOCbU_cJVO7BWXhctl1RX6Y5FA8xGvwPLnyVs5A_Q/exec';

      const ytResp = await fetchTimeout(
        'https://youtubei.googleapis.com/youtubei/v1/get_panel',
        { method: 'POST', headers: fwd, body: reqBody },
        10000 
      );

      let bytes = new Uint8Array(await ytResp.arrayBuffer());
      const isGzip = (ytResp.headers.get('content-encoding') || '').includes('gzip');
      if (isGzip) { const d = await gunzip(bytes); if (d) bytes = d; else console.warn('gunzip 失敗'); }

      let parsed;
      try { parsed = pbDecode(bytes); }
      catch (e) { return makeResponse(isGzip ? await gzip(bytes) : bytes, ytResp.status, ytResp.headers, isGzip); }

      const injectResult = await processAndInjectSubtitles(parsed, lang, gasUrl);

      if (!injectResult.changed) {
        return makeResponse(isGzip ? await gzip(bytes) : bytes, ytResp.status, ytResp.headers, isGzip);
      }

      const rebuilt = pbEncode(parsed);
      const final = isGzip ? await gzip(rebuilt) : rebuilt;

      if (injectResult.rate < 0.6) {
        console.log(`⚠️ 成功率 ${(injectResult.rate * 100).toFixed(1)}%，不快取`);
        return makeResponse(final, ytResp.status, ytResp.headers, isGzip);
      }

      return await cacheResponse(cacheKey, final, ytResp.status, ytResp.headers, isGzip);

    } catch (e) {
      console.error(`致命錯誤: ${e.message}`);
      return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
  },
};
