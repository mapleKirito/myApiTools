'use strict';

/**
 * 本地 HTTP 执行引擎
 * ---------------------------------------------------------------
 * 在 Electron 主进程（Node 环境）中直接发起请求，浏览器渲染进程无法
 * 绕过的同源策略在这里完全不存在，因此可以调试任意公网 / 内网接口。
 *
 * 只依赖 Node 内置模块，不引入任何三方 HTTP 客户端。
 */

const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const DEFAULT_TIMEOUT = 30000;
const MAX_BODY_BYTES = 100 * 1024 * 1024; // 100MB 保护阈值
const MAX_REDIRECTS = 10;

/** 跳转时是否需要丢弃请求体 / 改写方法（遵循 fetch 与浏览器的通用语义） */
function resolveRedirect(method, status) {
  const m = method.toUpperCase();
  if (status === 303) {
    return { method: 'GET', dropBody: true };
  }
  if (status === 301 || status === 302) {
    if (m === 'POST') return { method: 'GET', dropBody: true };
    return { method: m, dropBody: false };
  }
  if (status === 307 || status === 308) {
    return { method: m, dropBody: false };
  }
  return null;
}

/** 从 Content-Type 中提取 charset */
function parseCharset(contentType) {
  if (!contentType) return 'utf-8';
  const m = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType);
  return m ? m[1].toLowerCase() : 'utf-8';
}

/** 宽松解码：优先按声明字符集，失败则回退 utf-8 */
function decodeText(buffer, contentType) {
  const charset = parseCharset(contentType);
  const alias = { gb2312: 'gbk', gb18030: 'gb18030', utf8: 'utf-8' };
  const enc = alias[charset] || charset;
  try {
    return new TextDecoder(enc, { fatal: false }).decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

/** 判断内容是否属于文本类，用于决定是否给出 bodyText */
function looksTextual(contentType) {
  if (!contentType) return true;
  const ct = contentType.toLowerCase();
  if (ct.startsWith('text/')) return true;
  if (/^application\/(json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|x-ndjson)/.test(ct)) return true;
  if (ct.includes('+json') || ct.includes('+xml')) return true;
  return false;
}

/** 规范化 headers：支持 {k:v} 与 [[k,v]] 两种输入 */
function normalizeHeaders(input) {
  const out = [];
  if (!input) return out;
  if (Array.isArray(input)) {
    for (const item of input) {
      if (Array.isArray(item) && item.length >= 2 && item[0]) {
        out.push([String(item[0]), String(item[1] ?? '')]);
      } else if (item && typeof item === 'object' && item.key) {
        if (item.enabled === false) continue;
        out.push([String(item.key), String(item.value ?? '')]);
      }
    }
  } else if (typeof input === 'object') {
    for (const [k, v] of Object.entries(input)) out.push([k, String(v ?? '')]);
  }
  return out.filter(([k]) => k && !/^(content-length|host)$/i.test(k));
}

/** 合法的 header 名（RFC 7230 token） */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * 清洗 header 值：
 *  1. 剥掉 CR/LF —— 防请求头注入（换行能把后续内容变成新的头甚至新的请求）
 *  2. 非 Latin-1 字符（中文等）转成 UTF-8 原始字节再映射回 Latin-1 字符串，
 *     Node 的 http 模块便会原样写出这些字节 —— 这正是 curl 的行为，
 *     绝大多数服务端按 UTF-8 解码后能拿到正确的值。
 */
function sanitizeHeaderValue(value) {
  let v = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  if (/[^\u0000-\u00ff]/.test(v)) {
    v = Buffer.from(v, 'utf8').toString('latin1');
  }
  return v;
}

function sanitizeHeaderName(name) {
  const n = String(name ?? '').replace(/[\r\n:]/g, '').trim();
  if (!HEADER_NAME_RE.test(n)) {
    throw Object.assign(new Error(`非法的请求头名称：${name}`), { code: 'INVALID_HEADER_NAME' });
  }
  return n;
}

/** 构建 multipart/form-data 请求体 */
function buildMultipart(parts) {
  const boundary = '----MyApiToolsBoundary' + crypto.randomBytes(12).toString('hex');
  const chunks = [];
  for (const p of parts) {
    if (p.enabled === false) continue;
    const name = p.key || '';
    if (!name) continue;
    const type = p.type === 'file' ? 'file' : 'text';
    if (type === 'file') {
      const filePath = p.filePath || p.value || '';
      let buf;
      try {
        buf = fs.readFileSync(filePath);
      } catch (e) {
        throw new Error(`无法读取上传文件 ${filePath}: ${e.message}`);
      }
      const filename = path.basename(filePath);
      chunks.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
        `Content-Type: ${p.contentType || 'application/octet-stream'}\r\n\r\n`
      ));
      chunks.push(buf);
      chunks.push(Buffer.from('\r\n'));
    } else {
      chunks.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${p.value ?? ''}\r\n`
      ));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { buffer: Buffer.concat(chunks), boundary };
}

/** 将请求体描述编译为 Buffer + 需要补充的 Content-Type */
function buildBody(body) {
  if (!body || body.mode === 'none' || body.mode == null) {
    return { buffer: null, contentType: null };
  }
  switch (body.mode) {
    case 'json':
    case 'text':
      return {
        buffer: Buffer.from(String(body.content ?? ''), 'utf8'),
        contentType: body.mode === 'json' ? (body.contentType || 'application/json') : (body.contentType || 'text/plain'),
      };
    case 'xml':
      return { buffer: Buffer.from(String(body.content ?? ''), 'utf8'), contentType: body.contentType || 'application/xml' };
    case 'graphql': {
      let parsed;
      try {
        parsed = JSON.parse(body.content || '{}');
      } catch (e) {
        throw new Error(`GraphQL 请求体不是合法 JSON: ${e.message}`);
      }
      return { buffer: Buffer.from(JSON.stringify(parsed), 'utf8'), contentType: 'application/json' };
    }
    case 'form-urlencoded': {
      const sp = new URLSearchParams();
      for (const f of body.fields || []) {
        if (f.enabled === false || !f.key) continue;
        sp.append(f.key, f.value ?? '');
      }
      return { buffer: Buffer.from(sp.toString(), 'utf8'), contentType: 'application/x-www-form-urlencoded' };
    }
    case 'form-data': {
      const { buffer, boundary } = buildMultipart(body.fields || []);
      return { buffer, contentType: `multipart/form-data; boundary=${boundary}` };
    }
    case 'binary': {
      if (body.filePath) {
        return { buffer: fs.readFileSync(body.filePath), contentType: body.contentType || 'application/octet-stream' };
      }
      return {
        buffer: Buffer.from(String(body.content || ''), 'base64'),
        contentType: body.contentType || 'application/octet-stream',
      };
    }
    default:
      return { buffer: Buffer.from(String(body.content ?? ''), 'utf8'), contentType: null };
  }
}

/**
 * 执行一次请求
 * @param {object} req 请求描述
 * @returns {Promise<object>} 统一结构的响应对象（永不抛异常，错误收敛到 error 字段）
 */
async function sendRequest(req = {}) {
  const startedAt = Date.now();
  const timings = {};
  const redirectChain = [];

  let target;
  try {
    target = new URL(String(req.url || '').trim());
  } catch {
    return {
      ok: false,
      error: { code: 'INVALID_URL', message: `无效的请求地址: ${req.url || '(空)'}` },
      duration: Date.now() - startedAt,
    };
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return {
      ok: false,
      error: { code: 'INVALID_PROTOCOL', message: `仅支持 http/https 协议，当前为 ${target.protocol}` },
      duration: Date.now() - startedAt,
    };
  }

  const timeout = Number(req.timeout) > 0 ? Number(req.timeout) : DEFAULT_TIMEOUT;
  const followRedirects = req.followRedirects !== false;
  const maxRedirects = Number.isFinite(req.maxRedirects) ? Number(req.maxRedirects) : MAX_REDIRECTS;
  const verifyTls = req.verifyTls !== false;

  let compiled;
  try {
    compiled = buildBody(req.body);
  } catch (e) {
    return { ok: false, error: { code: 'BODY_ERROR', message: e.message }, duration: Date.now() - startedAt };
  }

  let method = String(req.method || 'GET').toUpperCase();
  let bodyBuffer = compiled.buffer;
  let contentType = compiled.contentType;

  const baseHeaders = normalizeHeaders(req.headers);
  const cookieJar = Array.isArray(req.cookies) ? req.cookies.filter(Boolean) : [];

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await new Promise((resolve) => {
      const isHttps = target.protocol === 'https:';
      const transport = isHttps ? https : http;

      let headers;
      try {
        headers = {};
        for (const [rawK, rawV] of baseHeaders) {
          const key = sanitizeHeaderName(rawK).toLowerCase();
          const val = sanitizeHeaderValue(rawV);
          if (key in headers) {
            // 归并为数组以保留重复头
            headers[key] = [].concat(headers[key], val);
          } else {
            headers[key] = val;
          }
        }
        if (contentType && !('content-type' in headers)) headers['content-type'] = sanitizeHeaderValue(contentType);
        if (bodyBuffer && !('content-length' in headers)) headers['content-length'] = String(bodyBuffer.length);
        if (cookieJar.length && !('cookie' in headers)) headers['cookie'] = sanitizeHeaderValue(cookieJar.join('; '));
        if (!('accept' in headers)) headers['accept'] = '*/*';
        if (!('user-agent' in headers)) headers['user-agent'] = 'MyApiTools/1.0 (Electron)';
        if (!('accept-encoding' in headers)) headers['accept-encoding'] = 'gzip, deflate, br';
      } catch (e) {
        return resolve({
          kind: 'error',
          error: Object.assign(e instanceof Error ? e : new Error(String(e)), {
            code: e.code || 'HEADER_ERROR',
          }),
        });
      }

      const options = {
        method,
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: target.pathname + target.search,
        headers,
        agent: false, // 每次新建连接，保证 DNS/连接耗时统计真实
      };
      if (isHttps && !verifyTls) options.rejectUnauthorized = false;

      const reqStart = Date.now();
      let settled = false;
      const done = (payload) => {
        if (settled) return;
        settled = true;
        resolve(payload);
      };

      let clientReq;
      try {
        clientReq = transport.request(options, (res) => {
        timings.firstByte = Date.now() - reqStart;
        const status = res.statusCode;
        const rawHeaders = res.rawHeaders || [];
        const headerPairs = [];
        for (let i = 0; i < rawHeaders.length; i += 2) headerPairs.push([rawHeaders[i], rawHeaders[i + 1]]);
        const headerMap = {};
        for (const [k, v] of headerPairs) headerMap[k.toLowerCase()] = v;

        // ---- 重定向处理 ----
        if (followRedirects && status >= 300 && status < 400 && headerMap.location) {
          if (attempt >= maxRedirects) {
            res.resume();
            return done({
              kind: 'redirect-overflow',
              message: `超过最大重定向次数 (${maxRedirects})`,
            });
          }
          const nextUrl = new URL(headerMap.location, target);
          redirectChain.push({ status, from: target.toString(), to: nextUrl.toString() });
          const rule = resolveRedirect(method, status);
          if (rule) {
            method = rule.method;
            if (rule.dropBody) {
              bodyBuffer = null;
              contentType = null;
            }
          }
          // 跨域跳转时剥离认证头，避免凭据泄漏
          if (nextUrl.origin !== target.origin) {
            for (let i = baseHeaders.length - 1; i >= 0; i--) {
              if (/^(authorization|cookie)/i.test(baseHeaders[i][0])) baseHeaders.splice(i, 1);
            }
          }
          target = nextUrl;
          res.resume();
          return done({ kind: 'redirect' });
        }

        const chunks = [];
        let size = 0;
        let overflow = false;
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_BODY_BYTES) {
            overflow = true;
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          timings.total = Date.now() - reqStart;
          if (overflow) {
            return done({
              kind: 'ok',
              status,
              statusText: res.statusMessage,
              httpVersion: res.httpVersion,
              headerPairs,
              headerMap,
              buffer: Buffer.alloc(0),
              size,
              warning: `响应体超过 ${MAX_BODY_BYTES / 1024 / 1024}MB，已截断丢弃`,
            });
          }
          done({
            kind: 'ok',
            status,
            statusText: res.statusMessage,
            httpVersion: res.httpVersion,
            headerPairs,
            headerMap,
            buffer: Buffer.concat(chunks),
            size,
          });
        });
        res.on('error', (err) => done({ kind: 'error', error: err }));
      });

      clientReq.on('socket', (socket) => {
        const t0 = reqStart;
        socket.on('lookup', () => { timings.dns = Date.now() - t0; });
        socket.on('connect', () => { timings.connect = Date.now() - t0; });
        socket.on('secureConnect', () => { timings.tls = Date.now() - t0; });
      });

      clientReq.on('error', (err) => done({ kind: 'error', error: err }));

      clientReq.setTimeout(timeout, () => {
        const err = new Error(`请求超时（${timeout}ms）`);
        err.code = 'ETIMEDOUT_CUSTOM';
        clientReq.destroy(err);
      });

      if (bodyBuffer) clientReq.write(bodyBuffer);
      clientReq.end();
      } catch (e) {
        // 构建请求或写出时同步抛错（非法头、巨量头、编码问题等）
        done({
          kind: 'error',
          error: Object.assign(e instanceof Error ? e : new Error(String(e)), {
            code: e.code || 'REQUEST_BUILD_FAILED',
          }),
        });
      }
    });

    if (result.kind === 'redirect') {
      attempt += 1;
      continue;
    }

    // ---- 错误收敛 ----
    if (result.kind === 'error' || result.kind === 'redirect-overflow') {
      const err = result.error || new Error(result.message);
      return {
        ok: false,
        error: {
          code: err.code || 'REQUEST_FAILED',
          message: err.message || '请求失败',
          hint: explainNetworkError(err),
        },
        duration: Date.now() - startedAt,
        timings,
        redirects: redirectChain,
      };
    }

    // ---- 解压 ----
    let body = result.buffer;
    const encoding = (result.headerMap['content-encoding'] || '').toLowerCase();
    try {
      if (encoding.includes('gzip')) body = zlib.gunzipSync(body);
      else if (encoding.includes('deflate')) body = zlib.inflateSync(body);
      else if (encoding.includes('br')) body = zlib.brotliDecompressSync(body);
    } catch {
      /* 解压失败则保留原始字节 */
    }

    const ct = result.headerMap['content-type'] || '';
    const textual = looksTextual(ct);
    const timingsOut = { ...timings };
    timingsOut.total = Date.now() - startedAt;

    const payload = {
      ok: result.status >= 200 && result.status < 400,
      status: result.status,
      statusText: result.statusText,
      httpVersion: result.httpVersion,
      httpVersionShort: String(result.httpVersion || '').replace(/^HTTP\//i, '').split('.')[0] + '',
      headers: result.headerPairs,
      size: body.length,
      rawSize: result.size,
      contentType: ct,
      textual,
      duration: Date.now() - startedAt,
      timings: timingsOut,
      redirects: redirectChain,
      url: target.toString(),
      error: null,
    };
    if (result.warning) payload.warning = result.warning;

    if (textual) {
      payload.bodyText = decodeText(body, ct);
    } else {
      payload.bodyBase64 = body.toString('base64');
      payload.bodyText = `[二进制内容 ${body.length} 字节，类型 ${ct || 'unknown'}]`;
    }
    return payload;
  }
}

/** 把 Node 的底层网络错误翻译成人话 */
function explainNetworkError(err) {
  const code = err.code || '';
  const map = {
    ENOTFOUND: '域名解析失败，请检查主机名或本机 DNS / hosts 配置。',
    ECONNREFUSED: '目标端口拒绝连接，服务可能未启动或端口写错。',
    ECONNRESET: '连接被对端重置，可能是服务端异常或中间网络中断。',
    ETIMEDOUT_CUSTOM: '已超过设定的超时时间，可在请求设置里调大超时。',
    ETIMEDOUT: 'TCP 连接超时，目标不可达或被防火墙拦截。',
    EHOSTUNREACH: '主机不可达，检查网络或代理设置。',
    ENETUNREACH: '网络不可达，检查本机网络连接。',
    EPROTO: 'TLS 协议错误，可能是明文端口被当作 HTTPS 访问，或反之。',
    DEPTH_ZERO_SELF_SIGNED_CERT: '服务端使用自签名证书，可在请求设置中关闭「校验证书」。',
    SELF_SIGNED_CERT_IN_CHAIN: '证书链中存在自签名证书，可关闭「校验证书」后重试。',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: '证书无法验证，可关闭「校验证书」后重试。',
    CERT_HAS_EXPIRED: '服务端证书已过期。',
    ERR_TLS_CERT_ALTNAME_INVALID: '证书域名与访问域名不匹配，可关闭「校验证书」后重试。',
  };
  return map[code] || '';
}

module.exports = { sendRequest, MAX_BODY_BYTES };
