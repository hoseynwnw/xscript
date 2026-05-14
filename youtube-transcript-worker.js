/**
 * Cloudflare Worker: YouTube iOS 双语字幕注入 (终极点击无损版 V3)
 * 
 * 修复内容：
 * 1. 引入 ProtoField 强类型包装器，保证非文本字段的 WireType 原生属性不被破坏。
 * 2. 完美修复：点击字幕段落无法跳转至指定时间进度的问题。
 * 3. 彻底杜绝 Protobuf 数据结构因 Float32/Int64 隐式转换导致的崩溃。
 */

// ==================== Protobuf 工具集 (重构) ====================

const WT_VARINT = 0;
const WT_64BIT = 1;
const WT_LEN = 2;
const WT_32BIT = 5;

// 用于原样保存原始类型的包装器
class ProtoField {
  constructor(wireType, value) {
    this.wireType = wireType;
    this.value = value;
  }
}

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

    let parsedField;

    if (wireType === WT_VARINT) {
      const val = readVarint(data, pos);
      pos = val.pos;
      parsedField = new ProtoField(wireType, val.value);
    } else if (wireType === WT_64BIT) {
      if (pos + 8 > data.length) break;
      // 不再擅自转码，直接切片保留底层二进制
      parsedField = new ProtoField(wireType, data.slice(pos, pos + 8));
      pos += 8;
    } else if (wireType === WT_LEN) {
      const lenRes = readVarint(data, pos);
      pos = lenRes.pos;
      const len = lenRes.value;
      if (pos + len > data.length) break;
      const sub = data.slice(pos, pos + len);
      pos += len;
      
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(sub);
        if (isPrintable(text)) {
          parsedField = new ProtoField(wireType, text);
        } else {
          const nested = parseProtobuf(sub);
          parsedField = new ProtoField(wireType, Object.keys(nested).length > 0 ? nested : sub);
        }
      } catch {
        const nested = parseProtobuf(sub);
        parsedField = new ProtoField(wireType, Object.keys(nested).length > 0 ? nested : sub);
      }
    } else if (wireType === WT_32BIT) {
      if (pos + 4 > data.length) break;
      // 保留底层 Float/Int32 二进制
      parsedField = new ProtoField(wireType, data.slice(pos, pos + 4));
      pos += 4;
    } else {
      break;
    }

    if (parsedField) {
      storeField(result, key, parsedField);
    }
  }
  return result;
}

function storeField(obj, key, value) {
  if (key in obj) {
    const existing = obj[key];
    obj[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
  } else {
    obj[key] = value;
  }
}

function isPrintable(text) {
  if (!text) return false;
  let printable = 0;
  for (const c of text) {
    const code = c.charCodeAt(0);
    if ((code >= 32 && code <= 126) || code === 10 || code === 13 || code === 9 || code > 255) {
      printable++;
    }
  }
  return printable / text.length > 0.7;
}

function encodeProtobuf(obj) {
  const parts = [];
  for (const [key, field] of Object.entries(obj)) {
    const fieldNumber = parseInt(key);
    if (isNaN(fieldNumber)) continue;
    
    const fields = Array.isArray(field) ? field : [field];
    for (const f of fields) {
      if (!(f instanceof ProtoField)) continue;
      
      parts.push(encodeTag(fieldNumber, f.wireType));
      
      if (f.wireType === WT_VARINT) {
        parts.push(writeVarint(f.value));
      } else if (f.wireType === WT_64BIT || f.wireType === WT_32BIT) {
        parts.push(f.value); // 完美还原二进制点击参数
      } else if (f.wireType === WT_LEN) {
        if (typeof f.value === 'string') {
          const encoded = new TextEncoder().encode(f.value);
          parts.push(writeVarint(encoded.length));
          parts.push(encoded);
        } else if (f.value instanceof Uint8Array) {
          parts.push(writeVarint(f.value.length));
          parts.push(f.value);
        } else if (typeof f.value === 'object' && f.value !== null) {
          const sub = encodeProtobuf(f.value);
          parts.push(writeVarint(sub.length));
          parts.push(sub);
        }
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
    if (!o || typeof o !== 'object') return;
    
    if (Array.isArray(o)) {
      for (const item of o) walk(item);
      return;
    }

    if (o instanceof ProtoField) {
      if (typeof o.value === 'object' && !(o.value instanceof Uint8Array)) {
        walk(o.value);
      }
      return;
    }

    let textVal = null, timestamp = null, textNode = null;
    
    for (const [k, fieldWrapper] of Object.entries(o)) {
      if (!fieldWrapper) continue;
      const fields = Array.isArray(fieldWrapper) ? fieldWrapper : [fieldWrapper];
      
      for (const f of fields) {
        if (!(f instanceof ProtoField)) continue;
        
        if (k === '1' && typeof f.value === 'string' && f.value.trim().length > 0) {
          textVal = f.value;
          textNode = f; // 取得底层节点引用
        } else if (k === '5' && typeof f.value === 'string' && f.value.includes(':') && f.value.length <= 8) {
          timestamp = f.value;
        }
        
        walk(f.value);
      }
    }
    
    if (textVal && timestamp && textNode) {
      results.push({ text: textVal, node: textNode });
    }
  }
  walk(obj);
  return results;
}

async function translateBatch(texts, targetLang = 'zh-CN') {
  if (texts.length === 0) return [];
  const cleanTexts = texts.map(t => t.replace(/\n/g, ' ')); 
  const combined = cleanTexts.join('\n');
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t`;
  
  try {
    const resp = await fetch(url, { 
      method: 'POST',
      headers: { 
        'User-Agent': 'Mozilla/5.0',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: `q=${encodeURIComponent(combined)}`
    });
    
    if (!resp.ok) return texts.map(() => '');
    const data = await resp.json();
    let translated = '';
    if (data && data[0]) {
      for (const pair of data[0]) {
        if (pair[0]) translated += pair[0];
      }
    }
    
    const parts = translated.split('\n').map(s => s.trim());
    while (parts.length < texts.length) parts.push('');
    return parts.slice(0, texts.length);
  } catch (e) {
    return texts.map(() => '');
  }
}

async function translateAll(segments) {
  const batches = [];
  let current = [];
  for (const seg of segments) {
    current.push(seg);
    if (current.length >= 50) {
      batches.push(current);
      current = [];
    }
  }
  if (current.length > 0) batches.push(current);
  
  const allTranslations = [];
  for (let i = 0; i < batches.length; i++) {
    const translations = await translateBatch(batches[i].map(s => s.text));
    allTranslations.push(...translations);
  }
  return allTranslations;
}

async function gzipDecompress(data) {
  try {
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(data); writer.close();
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
    for (const chunk of chunks) { result.set(chunk, off); off += chunk.length; }
    return result;
  } catch { return null; }
}

// ==================== 主程序 ====================

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'GET') return new Response('Worker is Running');
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    try {
      const requestBuffer = await request.arrayBuffer();
      const requestBody = new Uint8Array(requestBuffer);

      const fwdHeaders = new Headers();
      for (const [key, value] of request.headers.entries()) {
        const lk = key.toLowerCase();
        const forbidden = [
          'host', 'accept-encoding', 'content-length', 'connection', 
          'keep-alive', 'proxy-authenticate', 'proxy-authorization', 
          'te', 'trailers', 'transfer-encoding', 'upgrade',
          'cf-connecting-ip', 'cf-ray', 'cf-ew-via', 'cdn-loop', 
          'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip'
        ];
        if (forbidden.includes(lk)) continue;
        fwdHeaders.set(key, value);
      }
      fwdHeaders.set('Accept-Encoding', 'gzip, identity');

      const youtubeResp = await fetch('https://youtubei.googleapis.com/youtubei/v1/get_panel', {
        method: 'POST',
        headers: fwdHeaders,
        body: requestBody,
      });

      let responseBytes = new Uint8Array(await youtubeResp.arrayBuffer());
      if ((youtubeResp.headers.get('content-encoding') || '').includes('gzip')) {
        const dec = await gzipDecompress(responseBytes);
        if (dec) responseBytes = dec;
      }

      const parsed = parseProtobuf(responseBytes);
      const segments = findTranscripts(parsed);
      
      if (segments.length === 0) {
        return new Response(responseBytes, {
          status: youtubeResp.status,
          headers: buildResponseHeaders(youtubeResp.headers, responseBytes.length),
        });
      }

      const translations = await translateAll(segments);
      for (let i = 0; i < segments.length; i++) {
        const zh = translations[i];
        if (zh && segments[i].node) {
          // 修改 ProtoField 包装器内的真实值
          segments[i].node.value = `${segments[i].node.value}\n【中】${zh}`;
        }
      }

      const reencoded = encodeProtobuf(parsed);
      return new Response(reencoded, {
        status: youtubeResp.status,
        headers: buildResponseHeaders(youtubeResp.headers, reencoded.length),
      });

    } catch (e) {
      console.error(`Worker Error: ${e.message}`);
      return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
  },
};

function buildResponseHeaders(originalHeaders, bodyLength) {
  const headers = new Headers();
  const keep = ['content-type', 'cache-control', 'vary', 'alt-svc', 'x-content-type-options'];
  for (const h of keep) {
    const v = originalHeaders.get(h);
    if (v) headers.set(h, v);
  }
  headers.set('content-length', String(bodyLength));
  headers.set('content-type', 'application/x-protobuf');
  return headers;
}
