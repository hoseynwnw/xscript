/**
 * Cloudflare Worker: YouTube iOS 双语字幕注入 (终极修复版)
 *
 * 修复内容：
 * 1. 剔除所有 Hop-by-Hop 头部，解决 HTTP 规范导致的 400 错误。
 * 2. 增加 Body 十六进制指纹日志，用于判断二进制数据是否损坏。
 * 3. 强制使用 Uint8Array 传输 body，确保 Protobuf 数据完整性。
 * QX  ^https:\/\/youtubei\.googleapis\.com\/youtubei\/v1\/get_panel url https://rapid-frog-f311.hoseynwn.workers.dev/
 */

// ==================== Protobuf 工具集 ====================

function readVarint(data, pos) {
  let result = 0;
  let shift = 0;
  while (pos < data.length) {
    const byte = data[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result >>> 0, pos };
    shift += 7;
    if (shift > 35) return { value: 0, pos };
  }
  return { value: 0, pos };
}

function writeVarint(value) {
  const bytes = [];
  let v = value >>> 0;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return new Uint8Array(bytes);
}

function encodeTag(fieldNumber, wireType) {
  return writeVarint((fieldNumber << 3) | wireType);
}

const WT_VARINT = 0;
const WT_64BIT = 1;
const WT_LEN = 2;
const WT_32BIT = 5;

function parseProtobuf(data) {
  const result = {};
  let pos = 0;
  while (pos < data.length) {
    const tagRes = readVarint(data, pos);
    if (tagRes.pos === pos) break;
    pos = tagRes.pos;
    const tag = tagRes.value;
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;
    const key = String(fieldNum);
    if (wireType === WT_VARINT) {
      const val = readVarint(data, pos);
      pos = val.pos;
      storeField(result, key, val.value);
    } else if (wireType === WT_64BIT) {
      if (pos + 8 > data.length) break;
      const val = new DataView(
        data.buffer,
        data.byteOffset + pos,
        8,
      ).getBigUint64(0, true);
      pos += 8;
      storeField(result, key, Number(val));
    } else if (wireType === WT_LEN) {
      const lenRes = readVarint(data, pos);
      pos = lenRes.pos;
      const len = lenRes.value;
      if (pos + len > data.length) break;
      const sub = data.slice(pos, pos + len);
      pos += len;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(sub);
        if (isPrintable(text)) {
          storeField(result, key, text);
        } else {
          const nested = parseProtobuf(sub);
          storeField(
            result,
            key,
            Object.keys(nested).length > 0 ? nested : Array.from(sub),
          );
        }
      } catch {
        const nested = parseProtobuf(sub);
        storeField(
          result,
          key,
          Object.keys(nested).length > 0 ? nested : Array.from(sub),
        );
      }
    } else if (wireType === WT_32BIT) {
      if (pos + 4 > data.length) break;
      const val = new DataView(data.buffer, data.byteOffset + pos, 4).getUint32(
        0,
        true,
      );
      pos += 4;
      storeField(result, key, val);
    } else {
      break;
    }
  }
  return result;
}

function storeField(obj, key, value) {
  if (key in obj) {
    const existing = obj[key];
    obj[key] = Array.isArray(existing)
      ? [...existing, value]
      : [existing, value];
  } else {
    obj[key] = value;
  }
}

function isPrintable(text) {
  if (!text) return false;
  let printable = 0;
  for (const c of text) {
    const code = c.charCodeAt(0);
    if (
      (code >= 32 && code <= 126) ||
      code === 10 ||
      code === 13 ||
      code === 9 ||
      code > 255
    ) {
      printable++;
    }
  }
  return printable / text.length > 0.7;
}

function encodeProtobuf(obj) {
  const parts = [];
  for (const [key, value] of Object.entries(obj)) {
    const fieldNumber = parseInt(key);
    if (isNaN(fieldNumber)) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (typeof v === "number" && Number.isInteger(v)) {
        parts.push(encodeTag(fieldNumber, WT_VARINT));
        parts.push(writeVarint(v));
      } else if (typeof v === "string") {
        const encoded = new TextEncoder().encode(v);
        parts.push(encodeTag(fieldNumber, WT_LEN));
        parts.push(writeVarint(encoded.length));
        parts.push(encoded);
      } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        const sub = encodeProtobuf(v);
        parts.push(encodeTag(fieldNumber, WT_LEN));
        parts.push(writeVarint(sub.length));
        parts.push(sub);
      } else if (Array.isArray(v)) {
        const raw = new Uint8Array(v);
        parts.push(encodeTag(fieldNumber, WT_LEN));
        parts.push(writeVarint(raw.length));
        parts.push(raw);
      }
    }
  }
  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

// ==================== 业务逻辑 ====================

function findTranscripts(obj) {
  const results = [];
  function walk(o) {
    if (typeof o !== "object" || o === null) return;
    if (Array.isArray(o)) {
      for (const item of o) walk(item);
      return;
    }
    let textVal = null,
      timestamp = null;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v !== "string") continue;
      if (k === "1" && v.length > 10) {
        const alphaRatio =
          [...v].filter((c) => /[a-zA-Z ]/.test(c)).length / v.length;
        if (alphaRatio > 0.7) textVal = v;
      } else if (k === "5" && v.includes(":") && v.length <= 6) {
        timestamp = v;
      }
    }
    if (textVal && timestamp) results.push({ text: textVal, node: o });
    for (const v of Object.values(o)) walk(v);
  }
  walk(obj);
  return results;
}

async function translateBatch(texts, targetLang = "zh-CN") {
  if (texts.length === 0) return [];
  const sep = "|||";
  const combined = texts.join(sep);
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${targetLang}&dt=t&q=${encodeURIComponent(combined)}`;
  try {
    const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!resp.ok) return texts.map(() => "");
    const data = await resp.json();
    let translated = "";
    if (data && data[0]) {
      for (const pair of data[0]) if (pair[0]) translated += pair[0];
    }
    const parts = translated.split("|||").map((s) => s.trim());
    while (parts.length < texts.length) parts.push("");
    return parts.slice(0, texts.length);
  } catch (e) {
    return texts.map(() => "");
  }
}

async function translateAll(segments) {
  const batches = [];
  let current = [],
    currentLen = 0;
  for (const seg of segments) {
    if (currentLen + seg.text.length > 4000 && current.length > 0) {
      batches.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(seg);
    currentLen += seg.text.length + 3;
  }
  if (current.length > 0) batches.push(current);
  const allTranslations = [];
  for (let i = 0; i < batches.length; i++) {
    if (i > 0 && i % 5 === 0) await new Promise((r) => setTimeout(r, 1100));
    const translations = await translateBatch(batches[i].map((s) => s.text));
    allTranslations.push(...translations);
  }
  return allTranslations;
}

async function gzipDecompress(data) {
  try {
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    writer.write(data);
    writer.close();
    const reader = ds.readable.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const totalLen = chunks.reduce((s, c) => s + c.length, 0);
    const result = new Uint8Array(totalLen);
    let off = 0;
    for (const chunk of chunks) {
      result.set(chunk, off);
      off += chunk.length;
    }
    return result;
  } catch {
    return null;
  }
}

// ==================== 主程序 ====================

export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") return new Response("Running");
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });

    try {
      const requestBuffer = await request.arrayBuffer();
      const requestBody = new Uint8Array(requestBuffer);

      // 调试日志：记录长度和前10字节指纹
      const fingerprint = Array.from(requestBody.slice(0, 10))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
      console.log(
        `Body Size: ${requestBody.byteLength}, Fingerprint: ${fingerprint}`,
      );

      const fwdHeaders = new Headers();
      for (const [key, value] of request.headers.entries()) {
        const lk = key.toLowerCase();
        const forbidden = [
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
        ];
        if (forbidden.includes(lk)) continue;
        fwdHeaders.set(key, value);
      }
      fwdHeaders.set("Accept-Encoding", "gzip, identity");

      const youtubeResp = await fetch(
        "https://youtubei.googleapis.com/youtubei/v1/get_panel",
        {
          method: "POST",
          headers: fwdHeaders,
          body: requestBody,
        },
      );

      console.log(`YouTube Status: ${youtubeResp.status}`);

      let responseBytes = new Uint8Array(await youtubeResp.arrayBuffer());
      if (
        (youtubeResp.headers.get("content-encoding") || "").includes("gzip")
      ) {
        const dec = await gzipDecompress(responseBytes);
        if (dec) responseBytes = dec;
      }

      const parsed = parseProtobuf(responseBytes);
      const segments = findTranscripts(parsed);
      if (segments.length === 0) {
        return new Response(responseBytes, {
          status: youtubeResp.status,
          headers: buildResponseHeaders(
            youtubeResp.headers,
            responseBytes.length,
          ),
        });
      }

      const translations = await translateAll(segments);
      for (let i = 0; i < segments.length; i++) {
        const zh = translations[i];
        if (zh && segments[i].node) {
          segments[i].node["1"] = `${segments[i].node["1"]}\n【中】${zh}`;
        }
      }

      const reencoded = encodeProtobuf(parsed);
      return new Response(reencoded, {
        status: youtubeResp.status,
        headers: buildResponseHeaders(youtubeResp.headers, reencoded.length),
      });
    } catch (e) {
      console.error(`Error: ${e.message}`);
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
      });
    }
  },
};

function buildResponseHeaders(originalHeaders, bodyLength) {
  const headers = new Headers();
  const keep = [
    "content-type",
    "cache-control",
    "vary",
    "alt-svc",
    "x-content-type-options",
  ];
  for (const h of keep) {
    const v = originalHeaders.get(h);
    if (v) headers.set(h, v);
  }
  headers.set("content-length", String(bodyLength));
  headers.set("content-type", "application/x-protobuf");
  return headers;
}
