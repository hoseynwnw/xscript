/**
 * Cloudflare Worker: YouTube iOS 双语字幕注入 (V17 终极版)
 *
 * 核心优化：
 * 1. [UI特效] 实现中文字幕在下方以大字号排版的完美视觉效果。
 * 2. [稳定性] (继承V16) LEN 字段一律先尝试嵌套解析，不瞎猜字符串，绝对不损坏原始 protobuf 的任何二进制字段。
 * 3. [缓存精准化] 深入解析 POST Request Body，精准定位 `PAmodern_transcript_view` 后的 Token 字符串（例如 24字节的 Base64），以此作为完美缓存 Key。
 */

// ================================================================
// varint
// ================================================================
function varintSize(v) {
  v = v >>> 0;
  let s = 0;
  do {
    s++;
    v >>>= 7;
  } while (v > 0);
  return s;
}

function writeVarint(buf, offset, value) {
  let v = value >>> 0;
  while (v > 0x7f) {
    buf[offset++] = (v & 0x7f) | 0x80;
    v >>>= 7;
  }
  buf[offset] = v;
}

// ================================================================
// PbReader
// ================================================================
class PbReader {
  constructor(bytes) {
    this.buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.pos = 0;
    this.len = this.buf.length;
  }
  eof() {
    return this.pos >= this.len;
  }
  uint32() {
    let r = 0,
      s = 0;
    while (this.pos < this.len) {
      const b = this.buf[this.pos++];
      r |= (b & 0x7f) << s;
      if ((b & 0x80) === 0) return r >>> 0;
      s += 7;
      if (s >= 35) {
        this.pos++;
        return r >>> 0;
      }
    }
    return 0;
  }
  bytes() {
    const len = this.uint32();
    if (this.pos + len > this.len) throw new Error("overrun");
    const s = this.buf.slice(this.pos, this.pos + len);
    this.pos += len;
    return s;
  }
}

// ================================================================
// PbWriter
// ================================================================
class PbWriter {
  constructor() {
    this.bufs = [];
    this.totalLen = 0;
  }
  _push(b) {
    const d = b instanceof Uint8Array ? b : new Uint8Array(b);
    this.bufs.push(d);
    this.totalLen += d.length;
  }
  uint32(v) {
    const buf = new Uint8Array(varintSize(v >>> 0));
    writeVarint(buf, 0, v >>> 0);
    this._push(buf);
    return this;
  }
  bytes(data) {
    const d = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.uint32(d.length);
    this._push(d);
    return this;
  }
  finish() {
    const out = new Uint8Array(this.totalLen);
    let off = 0;
    for (const b of this.bufs) {
      out.set(b, off);
      off += b.length;
    }
    return out;
  }
}

// ================================================================
// pbDecode / pbEncode
// ================================================================
function pbDecode(bytes) {
  const r = new PbReader(bytes);
  const obj = {};
  while (!r.eof()) {
    let tag;
    try {
      tag = r.uint32();
    } catch {
      break;
    }
    if (tag === 0) break;
    const fn = tag >>> 3;
    const wt = tag & 0x07;
    const key = String(fn);
    let val;
    try {
      if (wt === 0) {
        val = { t: "varint", v: r.uint32() };
      } else if (wt === 1) {
        if (r.pos + 8 > r.len) break;
        val = { t: "fixed64", v: r.buf.slice(r.pos, r.pos + 8) };
        r.pos += 8;
      } else if (wt === 2) {
        const raw = r.bytes();
        let nested = null;
        if (raw.length >= 2) {
          try {
            const n = pbDecode(raw);
            if (Object.keys(n).length > 0) nested = n;
          } catch {}
        }
        val = nested ? { t: "msg", v: nested, raw } : { t: "raw", v: raw };
      } else if (wt === 5) {
        if (r.pos + 4 > r.len) break;
        const dv = new DataView(r.buf.buffer, r.buf.byteOffset + r.pos, 4);
        val = { t: "fixed32", v: dv.getUint32(0, true) };
        r.pos += 4;
      } else {
        break;
      }
    } catch {
      break;
    }

    if (key in obj) {
      const ex = obj[key];
      obj[key] = Array.isArray(ex) ? [...ex, val] : [ex, val];
    } else {
      obj[key] = val;
    }
  }
  return obj;
}

const ENC = new TextEncoder();

function pbEncode(obj) {
  const w = new PbWriter();
  for (const [key, fieldVal] of Object.entries(obj)) {
    const fn = parseInt(key);
    if (isNaN(fn) || fn <= 0) continue;
    const items = Array.isArray(fieldVal) ? fieldVal : [fieldVal];
    for (const val of items) {
      if (!val) continue;
      if (val.t === "varint") {
        w.uint32((fn << 3) | 0);
        w.uint32(val.v);
      } else if (val.t === "fixed64") {
        w.uint32((fn << 3) | 1);
        w._push(val.v);
      } else if (val.t === "fixed32") {
        w.uint32((fn << 3) | 5);
        const b = new Uint8Array(4);
        new DataView(b.buffer).setUint32(0, val.v, true);
        w._push(b);
      } else if (val.t === "string") {
        const encoded = ENC.encode(val.v);
        w.uint32((fn << 3) | 2);
        w.bytes(encoded);
      } else if (val.t === "msg") {
        if (val.dirty) {
          const childBytes = pbEncode(val.v);
          w.uint32((fn << 3) | 2);
          w.bytes(childBytes);
        } else if (val.raw) {
          w.uint32((fn << 3) | 2);
          w.bytes(val.raw);
        } else {
          const childBytes = pbEncode(val.v);
          w.uint32((fn << 3) | 2);
          w.bytes(childBytes);
        }
      } else if (val.t === "raw") {
        w.uint32((fn << 3) | 2);
        w.bytes(val.v);
      }
    }
  }
  return w.finish();
}

// ================================================================
// 字幕识别 + 注入
// ================================================================
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function tryStr(val) {
  if (!val || Array.isArray(val)) return null;
  if (val.t === "string") return val.v;
  if (val.t === "raw") {
    try {
      return UTF8.decode(val.v);
    } catch {
      return null;
    }
  }
  if (val.t === "msg" && val.raw) {
    try {
      return UTF8.decode(val.raw);
    } catch {
      return null;
    }
  }
  return null;
}

function isTimestamp(s) {
  return s && /^\d{1,2}:\d{2}$/.test(s.trim());
}

function collectSegments(obj, result = []) {
  if (!obj || typeof obj !== "object") return result;
  const f1 = obj["1"],
    f5 = obj["5"];
  if (!Array.isArray(f1) && !Array.isArray(f5)) {
    const t1 = tryStr(f1),
      t5 = tryStr(f5);
    if (t1 && t1.trim().length > 0 && isTimestamp(t5)) {
      result.push({ origText: t1 });
      return result;
    }
  }
  for (const val of Object.values(obj)) {
    for (const item of Array.isArray(val) ? val : [val]) {
      if (item && item.t === "msg") collectSegments(item.v, result);
    }
  }
  return result;
}

function findAndInject(obj, translations, idx) {
  if (!obj || typeof obj !== "object") return idx;
  const f1 = obj["1"],
    f5 = obj["5"];
  if (!Array.isArray(f1) && !Array.isArray(f5)) {
    const t1 = tryStr(f1),
      t5 = tryStr(f5);
    if (t1 && t1.trim().length > 0 && isTimestamp(t5)) {
      const zh = translations[idx];
      if (zh && zh.trim() && zh !== t1) {
        // 【UI黑魔法】强行塞入双语文本，但故意不改 field7 长度。
        // 原生 UI 为适应错误的长宽比，会自动将字体按比例缩小，完美实现双语排版！
        const newText = t1 + "\n【中】" + zh;
        const newBytes = ENC.encode(newText);
        const oldBytes = ENC.encode(t1);

        obj["1"] = { t: "string", v: newText };
        const f7 = obj["7"];
        if (f7 && !Array.isArray(f7) && f7.t === "varint" && f7.v > 0) {
          // 只增加新增字节的长度差异，而不是粗暴加上新文本的长度
          obj["7"] = {
            t: "varint",
            v: f7.v + (newBytes.length - oldBytes.length),
          };
        }
        obj.__dirty = true;
      }
      return idx + 1;
    }
  }
  for (const val of Object.values(obj)) {
    for (const item of Array.isArray(val) ? val : [val]) {
      if (item && item.t === "msg") {
        const prevIdx = idx;
        idx = findAndInject(item.v, translations, idx);
        if (idx !== prevIdx || item.v.__dirty) {
          item.dirty = true;
          obj.__dirty = true;
        }
      }
    }
  }
  return idx;
}

// ================================================================
// 工具：提取精准缓存 Key
// ================================================================
function fnv1aHash(buffer) {
  let h = 2166136261;
  for (let i = 0; i < buffer.length; i++) {
    h ^= buffer[i];
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    h = h >>> 0;
  }
  return h.toString(16);
}

// 扫描 Request Body 中的 `PAmodern_transcript_view`，提取紧跟在后面的 Token 字符串
// 例如寻找 \x1a \x18 [24个ASCII字节]
function extractReqToken(reqBody) {
  const marker = new Uint8Array([
    80, 65, 109, 111, 100, 101, 114, 110, 95, 116, 114, 97, 110, 115, 99, 114,
    105, 112, 116, 95, 118, 105, 101, 119,
  ]); // "PAmodern_transcript_view"
  for (let i = 0; i <= reqBody.length - marker.length; i++) {
    let match = true;
    for (let j = 0; j < marker.length; j++) {
      if (reqBody[i + j] !== marker[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      const tagIdx = i + marker.length;
      // 0x1a 代表 Field 3, WireType 2 (Length-delimited)
      if (reqBody[tagIdx] === 0x1a) {
        const len = reqBody[tagIdx + 1];
        // 确保不会越界且是一个合理的长度 (如 24)
        if (len > 0 && len < 128 && tagIdx + 2 + len <= reqBody.length) {
          const idBytes = reqBody.slice(tagIdx + 2, tagIdx + 2 + len);
          let idStr = "";
          for (let b of idBytes) idStr += String.fromCharCode(b);
          return idStr;
        }
      }
    }
  }
  return null;
}

// ================================================================
// 缓存与网络
// ================================================================
async function asyncPool(concurrency, tasks, taskFn) {
  const results = new Array(tasks.length);
  let index = 0;
  async function runner() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await taskFn(tasks[i], i);
    }
  }
  await Promise.all(
    Array(Math.min(concurrency, tasks.length))
      .fill(0)
      .map(() => runner()),
  );
  return results;
}

async function getCachedResponse(cacheKey) {
  const cached = await caches.default.match(cacheKey);
  if (cached) console.log(`✅ 缓存命中: ${cacheKey}`);
  return cached || null;
}

async function cacheResponse(cacheKey, body, status, origHeaders, isGzip) {
  const h = new Headers();
  for (const k of [
    "content-type",
    "vary",
    "alt-svc",
    "x-content-type-options",
  ]) {
    const v = origHeaders.get(k);
    if (v) h.set(k, v);
  }
  if (isGzip) h.set("Content-Encoding", "gzip");
  h.set("Content-Type", "application/x-protobuf");
  h.set("Content-Length", String(body.length));
  h.set("Cache-Control", "public, max-age=86400"); // 缓存 24 小时
  const resp = new Response(body, { status, headers: h });
  if (status >= 200 && status < 400) {
    try {
      await caches.default.put(cacheKey, resp.clone());
      console.log("✅ 双语字幕写入缓存成功");
    } catch (e) {
      console.warn("缓存写入失败:", e.message);
    }
  }
  return resp;
}

function makeResponse(body, status, origHeaders, isGzip) {
  const h = new Headers();
  for (const k of [
    "content-type",
    "vary",
    "alt-svc",
    "x-content-type-options",
  ]) {
    const v = origHeaders.get(k);
    if (v) h.set(k, v);
  }
  if (isGzip) h.set("Content-Encoding", "gzip");
  h.set("Content-Type", "application/x-protobuf");
  h.set("Content-Length", String(body.length));
  return new Response(body, { status, headers: h });
}

async function fetchTimeout(url, opts = {}, ms = 8000, retries = 1) {
  let last;
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok && i < retries) continue;
      return r;
    } catch (e) {
      clearTimeout(t);
      last = e;
      if (i < retries) await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw last || new Error("fetch 失败");
}

// ================================================================
// 翻译
// ================================================================
async function translateBatch(texts, targetLang = "zh-CN") {
  if (!texts.length) return [];
  const clean = texts.map((t) => t.replace(/\n/g, " ").trim());
  const body = `q=${encodeURIComponent(clean.map((t, i) => `${i + 1}. ${t}`).join("\n"))}`;
  try {
    const r = await fetchTimeout(
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t`,
      {
        method: "POST",
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      },
      8000,
      1,
    );
    const data = await r.json();
    let out = "";
    if (data?.[0])
      for (const p of data[0]) {
        if (p[0]) out += p[0];
      }
    const map = {};
    const RE = /(\d+)\.\s*([\s\S]*?)(?=\n\d+\.|$)/g;
    let m;
    while ((m = RE.exec(out)) !== null) {
      const i = parseInt(m[1]) - 1,
        t = m[2].trim();
      if (i >= 0 && i < texts.length && t) map[i] = t;
    }
    return clean.map((orig, i) => map[i] || orig);
  } catch (e) {
    console.error(`翻译失败: ${e.message}`);
    return clean;
  }
}

async function translateAll(segments, targetLang = "zh-CN") {
  const BS = 20,
    CC = 2;
  const batches = [];
  for (let i = 0; i < segments.length; i += BS)
    batches.push(segments.slice(i, i + BS));
  console.log(`共 ${segments.length} 段，分 ${batches.length} 批`);
  const t0 = Date.now();
  const results = await asyncPool(CC, batches, async (b) => {
    return await translateBatch(
      b.map((s) => s.origText),
      targetLang,
    );
  });
  const all = results.flat();
  const ok = all.filter(
    (t, i) =>
      t && t !== (segments[i]?.origText || "").replace(/\n/g, " ").trim(),
  ).length;
  console.log(`翻译完成 ${Date.now() - t0}ms，有效 ${ok}/${segments.length}`);
  return { translations: all, successCount: ok };
}

// ================================================================
// gzip
// ================================================================
async function gunzip(data) {
  try {
    const ds = new DecompressionStream("gzip");
    const w = ds.writable.getWriter();
    w.write(data);
    w.close();
    const chunks = [];
    for (const r = ds.readable.getReader(); ; ) {
      const { done, value } = await r.read();
      if (done) break;
      chunks.push(value);
    }
    const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  } catch {
    return null;
  }
}

async function gzip(data) {
  try {
    const cs = new CompressionStream("gzip");
    const w = cs.writable.getWriter();
    w.write(data);
    w.close();
    const chunks = [];
    for (const r = cs.readable.getReader(); ; ) {
      const { done, value } = await r.read();
      if (done) break;
      chunks.push(value);
    }
    const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  } catch (e) {
    return data;
  }
}

// ================================================================
// 主程序
// ================================================================
export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") {
      const purgeKey = new URL(request.url).searchParams.get("purge");
      if (purgeKey) {
        await caches.default.delete(purgeKey);
        return new Response("purged: " + purgeKey);
      }
      return new Response("Worker is Running v17 (Perfected UI & Token Cache)");
    }
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });

    try {
      const reqBody = new Uint8Array(await request.arrayBuffer());
      const lang = "zh-CN";

      // 解析提取最强缓存Token
      const tokenStr = extractReqToken(reqBody);
      const reqId = tokenStr || fnv1aHash(reqBody); // 如果找不到，兜底使用整个请求体的哈希
      const cacheKey = `https://yt-sub-cache/v4/token/${reqId}/${lang}`;

      console.log(
        `Token提取: ${tokenStr ? "成功" : "失败"} | Cache Key: ${cacheKey}`,
      );

      // 读取缓存（启用缓存功能）
      const earlyHit = await getCachedResponse(cacheKey);
      if (earlyHit) return earlyHit;

      const fwd = new Headers();
      const skip = new Set([
        "host",
        "accept-encoding",
        "content-length",
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailers",
        "transfer-encoding",
        "upgrade",
        "cf-connecting-ip",
        "cf-ray",
        "cf-ew-via",
        "cdn-loop",
        "x-forwarded-for",
        "x-forwarded-proto",
        "x-real-ip",
      ]);
      for (const [k, v] of request.headers) {
        if (!skip.has(k.toLowerCase())) fwd.set(k, v);
      }
      fwd.set("Accept-Encoding", "gzip, identity");

      const ytResp = await fetchTimeout(
        "https://youtubei.googleapis.com/youtubei/v1/get_panel",
        { method: "POST", headers: fwd, body: reqBody },
        15000,
        0,
      );

      let bytes = new Uint8Array(await ytResp.arrayBuffer());
      const isGzip = (ytResp.headers.get("content-encoding") || "").includes(
        "gzip",
      );
      if (isGzip) {
        const d = await gunzip(bytes);
        if (d) bytes = d;
        else console.warn("gunzip 失败");
      }

      let parsed;
      try {
        parsed = pbDecode(bytes);
      } catch (e) {
        return makeResponse(
          isGzip ? await gzip(bytes) : bytes,
          ytResp.status,
          ytResp.headers,
          isGzip,
        );
      }

      const segments = collectSegments(parsed);
      if (!segments.length) {
        return makeResponse(
          isGzip ? await gzip(bytes) : bytes,
          ytResp.status,
          ytResp.headers,
          isGzip,
        );
      }

      const { translations, successCount } = await translateAll(segments, lang);
      const rate = successCount / segments.length;

      findAndInject(parsed, translations, 0);

      const rebuilt = pbEncode(parsed);
      const final = isGzip ? await gzip(rebuilt) : rebuilt;

      if (rate < 0.7) {
        console.log(`⚠️ 成功率 ${(rate * 100).toFixed(1)}%，不缓存`);
        return makeResponse(final, ytResp.status, ytResp.headers, isGzip);
      }

      // 写入缓存并响应
      return await cacheResponse(
        cacheKey,
        final,
        ytResp.status,
        ytResp.headers,
        isGzip,
      );
    } catch (e) {
      console.error(`致命错误: ${e.message}\n${e.stack || ""}`);
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
      });
    }
  },
};
