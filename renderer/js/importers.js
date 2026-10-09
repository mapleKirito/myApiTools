/**
 * 导入 / 导出
 * ---------------------------------------------------------------
 * 支持：cURL 命令、Postman Collection v2.x、OpenAPI 3 / Swagger 2
 * 导出：Postman Collection v2.1、cURL
 */

import { uid, clone } from './helpers.js';

/* ==================================================================== *
 * cURL 解析
 * ==================================================================== */

/** 按 shell 规则切词，正确处理单双引号与转义 */
function tokenizeCurl(input) {
  const text = String(input).replace(/\\\r?\n/g, ' ').trim();
  const tokens = [];
  let cur = '';
  let quote = null;
  let started = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < text.length) {
        const next = text[++i];
        cur += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || cur) {
        tokens.push(cur);
        cur = '';
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (cur || started) tokens.push(cur);
  return tokens;
}

/** 解析 name=value 形式（用于 -H / -F / -d） */
function splitKeyValue(raw, sep = '=') {
  const idx = raw.indexOf(sep);
  if (idx < 0) return [raw, ''];
  return [raw.slice(0, idx), raw.slice(idx + sep.length)];
}

/** 解析浏览器 DevTools 复制出来的 "Copy as cURL" */
export function parseCurl(curlText) {
  const tokens = tokenizeCurl(curlText);
  if (tokens[0] && /curl/i.test(tokens[0])) tokens.shift();

  const out = {
    method: '',
    url: '',
    headers: [],
    params: [],
    body: { mode: 'none', content: '', fields: [], contentType: '' },
    auth: { type: 'none' },
    options: {},
  };
  let dataParts = [];
  let formParts = [];
  let urlencodedParts = [];
  let isHead = false;

  const need = (i) => tokens[i + 1] ?? '';

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const val = need(i);

    if (t === '-X' || t === '--request') { out.method = val.toUpperCase(); i++; continue; }
    if (t === '-H' || t === '--header') {
      const [k, v] = splitKeyValue(val, ':');
      if (k) out.headers.push({ key: k.trim(), value: v.trim(), enabled: true, description: '' });
      i++;
      continue;
    }
    if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary' || t === '--data-ascii') {
      dataParts.push(val);
      i++;
      continue;
    }
    if (t === '--data-urlencode') {
      urlencodedParts.push(val);
      i++;
      continue;
    }
    if (t === '-F' || t === '--form') {
      const [k, v] = splitKeyValue(val, '=');
      const isFile = /^@/.test(v);
      formParts.push({
        key: k,
        value: isFile ? '' : v,
        filePath: isFile ? v.slice(1) : '',
        type: isFile ? 'file' : 'text',
        enabled: true,
      });
      i++;
      continue;
    }
    if (t === '-u' || t === '--user') {
      const [u, p] = splitKeyValue(val, ':');
      out.auth = { type: 'basic', username: u, password: p };
      i++;
      continue;
    }
    if (t === '-b' || t === '--cookie') {
      const idx = out.headers.findIndex((h) => h.key.toLowerCase() === 'cookie');
      if (idx >= 0) out.headers[idx].value += '; ' + val;
      else out.headers.push({ key: 'Cookie', value: val, enabled: true, description: '' });
      i++;
      continue;
    }
    if (t === '-A' || t === '--user-agent') {
      out.headers.push({ key: 'User-Agent', value: val, enabled: true, description: '' });
      i++;
      continue;
    }
    if (t === '-e' || t === '--referer') {
      out.headers.push({ key: 'Referer', value: val, enabled: true, description: '' });
      i++;
      continue;
    }
    if (t === '-k' || t === '--insecure') { out.options.verifyTls = false; continue; }
    if (t === '-L' || t === '--location') { out.options.followRedirects = true; continue; }
    if (t === '-I' || t === '--head') { isHead = true; continue; }
    if (t === '--compressed' || t === '--silent' || t === '-s' || t === '-v' || t === '--verbose'
      || t === '-i' || t === '--include' || t === '--no-buffer' || t === '-N') continue;
    if (t === '--max-time' || t === '-m') {
      const sec = Number(val);
      if (sec > 0) out.options.timeout = Math.round(sec * 1000);
      i++;
      continue;
    }
    if (t === '--connect-timeout') { i++; continue; }
    if (t === '-o' || t === '--output') { i++; continue; }
    if (t === '--url') { out.url = val; i++; continue; }

    if (!t.startsWith('-') && !out.url) out.url = t;
  }

  // 请求体形态判定
  if (formParts.length) {
    out.body = { mode: 'form-data', content: '', fields: formParts, contentType: '' };
  } else if (urlencodedParts.length) {
    out.body = {
      mode: 'form-urlencoded',
      content: '',
      fields: urlencodedParts.map((p) => {
        const [k, v] = splitKeyValue(p, '=');
        return { key: k, value: v, enabled: true, type: 'text' };
      }),
      contentType: '',
    };
  } else if (dataParts.length) {
    const joined = dataParts.join('&');
    const ctHeader = out.headers.find((h) => h.key.toLowerCase() === 'content-type');
    const ct = ctHeader ? ctHeader.value.toLowerCase() : '';
    let mode = 'text';
    if (ct.includes('json') || /^\s*[[{]/.test(joined)) {
      mode = 'json';
    } else if (ct.includes('x-www-form-urlencoded')) {
      mode = 'form-urlencoded';
    } else if (ct.includes('xml')) {
      mode = 'xml';
    }
    if (mode === 'form-urlencoded') {
      out.body = {
        mode,
        content: '',
        fields: joined.split('&').filter(Boolean).map((pair) => {
          const [k, v] = splitKeyValue(pair, '=');
          return { key: decodeURIComponent(k), value: decodeURIComponent(v), enabled: true, type: 'text' };
        }),
        contentType: '',
      };
    } else {
      let content = joined;
      if (mode === 'json') {
        try { content = JSON.stringify(JSON.parse(joined), null, 2); } catch { /* 保留原文 */ }
      }
      out.body = { mode, content, fields: [], contentType: '' };
    }
  }

  if (!out.method) {
    if (isHead) out.method = 'HEAD';
    else if (out.body.mode !== 'none') out.method = 'POST';
    else out.method = 'GET';
  }

  // 拆出 query 参数
  if (out.url) {
    const raw = out.url.replace(/^['"]|['"]$/g, '');
    const qi = raw.indexOf('?');
    if (qi >= 0) {
      const base = raw.slice(0, qi);
      const qs = raw.slice(qi + 1);
      out.url = base;
      for (const pair of qs.split('&')) {
        if (!pair) continue;
        const [k, v] = splitKeyValue(pair, '=');
        out.params.push({ key: decodeURIComponent(k), value: decodeURIComponent(v), enabled: true, description: '' });
      }
    }
  }

  return out;
}

/* ==================================================================== *
 * Postman Collection v2.1
 * ==================================================================== */
function pmAuth(auth) {
  if (!auth || auth.type === 'noauth') return { type: 'none' };
  const pick = (arr, key) => {
    const item = (arr || []).find((x) => x.key === key);
    return item ? item.value : '';
  };
  if (auth.type === 'bearer') return { type: 'bearer', token: pick(auth.bearer, 'token') };
  if (auth.type === 'basic') {
    return { type: 'basic', username: pick(auth.basic, 'username'), password: pick(auth.basic, 'password') };
  }
  if (auth.type === 'apikey') {
    return {
      type: 'apikey',
      key: pick(auth.apikey, 'key'),
      value: pick(auth.apikey, 'value'),
      in: pick(auth.apikey, 'in') || 'header',
    };
  }
  return { type: 'none' };
}

function pmBody(body) {
  if (!body || body.mode === 'none' || !body.mode) return { mode: 'none', content: '', fields: [], contentType: '' };
  if (body.mode === 'raw') {
    const lang = body.options && body.options.raw ? body.options.raw.language : '';
    const raw = body.raw || '';
    let mode = 'text';
    if (lang === 'json' || /^\s*[[{]/.test(raw)) mode = 'json';
    else if (lang === 'xml' || /^\s*</.test(raw)) mode = 'xml';
    let content = raw;
    if (mode === 'json') {
      try { content = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* 保持原样 */ }
    }
    return { mode, content, fields: [], contentType: '' };
  }
  if (body.mode === 'urlencoded') {
    return {
      mode: 'form-urlencoded',
      content: '',
      fields: (body.urlencoded || []).map((f) => ({ key: f.key, value: f.value ?? '', enabled: !f.disabled, type: 'text' })),
      contentType: '',
    };
  }
  if (body.mode === 'formdata') {
    return {
      mode: 'form-data',
      content: '',
      fields: (body.formdata || []).map((f) => ({
        key: f.key,
        value: f.type === 'file' ? '' : (f.value ?? ''),
        filePath: f.type === 'file' ? String(Array.isArray(f.src) ? f.src[0] : f.src || '') : '',
        type: f.type === 'file' ? 'file' : 'text',
        enabled: !f.disabled,
      })),
      contentType: '',
    };
  }
  if (body.mode === 'graphql') {
    return {
      mode: 'graphql',
      content: JSON.stringify({ query: (body.graphql && body.graphql.query) || '', variables: (body.graphql && body.graphql.variables) || {} }, null, 2),
      fields: [],
      contentType: '',
    };
  }
  if (body.mode === 'file') {
    return { mode: 'binary', content: '', fields: [], contentType: '', filePath: (body.file && body.file.src) || '' };
  }
  return { mode: 'none', content: '', fields: [], contentType: '' };
}

function pmUrl(url) {
  if (!url) return { raw: '', params: [] };
  if (typeof url === 'string') {
    const qi = url.indexOf('?');
    if (qi < 0) return { raw: url, params: [] };
    return {
      raw: url.slice(0, qi),
      params: url.slice(qi + 1).split('&').filter(Boolean).map((p) => {
        const [k, v] = splitKeyValue(p, '=');
        return { key: decodeURIComponent(k), value: decodeURIComponent(v), enabled: true, description: '' };
      }),
    };
  }
  const params = (url.query || []).map((q) => ({
    key: q.key,
    value: q.value ?? '',
    enabled: !q.disabled,
    description: q.description || '',
  }));
  let raw = url.raw || '';
  const qi = raw.indexOf('?');
  if (qi >= 0) raw = raw.slice(0, qi);
  if (!raw && url.host) {
    raw = [url.protocol ? url.protocol + '://' : '', Array.isArray(url.host) ? url.host.join('.') : url.host, url.path ? '/' + (Array.isArray(url.path) ? url.path.join('/') : url.path) : ''].join('');
  }
  return { raw, params };
}

function pmRequest(item) {
  const r = item.request || {};
  const { raw, params } = pmUrl(r.url);
  const headers = (r.header || []).map((h) => ({
    key: h.key,
    value: h.value ?? '',
    enabled: !h.disabled,
    description: h.description || '',
  }));
  return {
    name: item.name || '未命名请求',
    method: (r.method || 'GET').toUpperCase(),
    url: raw,
    params,
    headers,
    body: pmBody(r.body),
    auth: pmAuth(r.auth),
    options: { timeout: null, followRedirects: true, verifyTls: true },
    description: typeof r.description === 'string' ? r.description : (item.description || ''),
    variables: (item.variable || []).map((v) => ({ key: v.key, value: v.value ?? '', enabled: !v.disabled, secret: v.type === 'secret' })),
  };
}

export function parsePostman(json) {
  const out = { name: 'Postman 导入', collections: [], requests: [] };

  const walk = (items, parentId) => {
    for (const item of items || []) {
      if (Array.isArray(item.item)) {
        const col = { id: uid('col'), name: item.name || '文件夹', parentId: parentId || null, sort: 0, deleted: false };
        out.collections.push(col);
        walk(item.item, col.id);
      } else {
        out.requests.push({ ...pmRequest(item), collectionId: parentId || null, sort: 0 });
      }
    }
  };

  if (Array.isArray(json.item)) {
    out.name = (json.info && json.info.name) || out.name;
    walk(json.item, null);
  } else if (Array.isArray(json.collection && json.collection.item)) {
    // Postman v1 兼容
    out.name = (json.collection.info && json.collection.info.name) || out.name;
    walk(json.collection.item, null);
  } else {
    throw new Error('不是有效的 Postman Collection（缺少 item 数组）');
  }
  return out;
}

/* ==================================================================== *
 * OpenAPI 3 / Swagger 2
 * ==================================================================== */
function oaResolveRef(root, node) {
  if (!node || !node.$ref) return node;
  const parts = String(node.$ref).replace(/^#\//, '').split('/');
  let cur = root;
  for (const p of parts) cur = cur && cur[p];
  return cur || node;
}

export function parseOpenApi(json) {
  const out = { name: (json.info && json.info.title) || 'OpenAPI 导入', collections: [], requests: [] };
  if (!json.paths) throw new Error('不是有效的 OpenAPI / Swagger 文档（缺少 paths）');

  let baseUrl = '';
  if (Array.isArray(json.servers) && json.servers.length) {
    baseUrl = json.servers[0].url || '';
  } else if (json.host) {
    const scheme = (json.schemes && json.schemes[0]) || 'http';
    baseUrl = `${scheme}://${json.host}${json.basePath || ''}`;
  }
  baseUrl = String(baseUrl).replace(/\/+$/, '');

  // 每个 tag 一个文件夹
  const folderByTag = new Map();
  const folderFor = (tag) => {
    const key = tag || '默认分组';
    if (folderByTag.has(key)) return folderByTag.get(key).id;
    const col = { id: uid('col'), name: key, parentId: null, sort: folderByTag.size, deleted: false };
    out.collections.push(col);
    folderByTag.set(key, col);
    return col.id;
  };

  for (const [rawPath, pathItem] of Object.entries(json.paths || {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const sharedParams = pathItem.parameters || [];
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      const op = pathItem[method];
      if (!op) continue;

      const params = [];
      const headers = [];
      let bodyContent = '';
      let bodyMode = 'none';
      let contentTypeHeader = '';

      for (const raw of [...sharedParams, ...(op.parameters || [])]) {
        const p = oaResolveRef(json, raw);
        if (!p || !p.name) continue;
        if (p.in === 'query') {
          const hasDefault = p.schema && p.schema.default !== undefined;
          params.push({
            key: p.name,
            value: hasDefault ? String(p.schema.default) : '',
            // 必填、或文档里给了默认值的参数默认启用，其余留空不勾选，
            // 避免导入后 URL 被一堆空参数污染
            enabled: !!p.required || hasDefault,
            description: p.description || '',
          });
        } else if (p.in === 'header') {
          headers.push({ key: p.name, value: '', enabled: !!p.required, description: p.description || '' });
        } else if (p.in === 'path') {
          // 路径参数先留占位，等填变量时替换
          params.push({ key: p.name, value: '', enabled: false, description: (p.description || '') + '（路径参数）' });
        }
      }

      const rb = oaResolveRef(json, op.requestBody);
      if (rb && rb.content) {
        const ct = Object.keys(rb.content)[0];
        if (ct) {
          contentTypeHeader = ct;
          const media = rb.content[ct];
          if (ct.includes('json')) {
            bodyMode = 'json';
            const example = media.example !== undefined ? media.example : (media.schema && media.schema.example);
            bodyContent = JSON.stringify(example !== undefined ? example : sampleFromSchema(json, media.schema), null, 2);
          } else if (ct.includes('x-www-form-urlencoded')) {
            bodyMode = 'form-urlencoded';
            bodyContent = JSON.stringify({ __fields: schemaProps(json, media.schema) });
          } else if (ct.includes('xml')) {
            bodyMode = 'xml';
            bodyContent = media.example ? String(media.example) : '';
          } else {
            bodyMode = 'text';
            bodyContent = media.example ? String(media.example) : '';
          }
        }
      } else if (op.consumes && op.consumes.length && method !== 'get' && method !== 'head') {
        // Swagger 2 的 body 参数
        const bodyParam = (op.parameters || []).map((x) => oaResolveRef(json, x)).find((x) => x && x.in === 'body');
        if (bodyParam) {
          bodyMode = 'json';
          bodyContent = JSON.stringify(sampleFromSchema(json, bodyParam.schema), null, 2);
        }
      }

      let body = { mode: bodyMode, content: bodyContent, fields: [], contentType: contentTypeHeader };
      if (bodyMode === 'form-urlencoded') {
        body = {
          mode: 'form-urlencoded',
          content: '',
          contentType: '',
          fields: JSON.parse(bodyContent).__fields.map((f) => ({ key: f.key, value: f.value, enabled: true, type: 'text' })),
        };
      }
      if (contentTypeHeader && body.mode !== 'none' && body.mode !== 'form-urlencoded') {
        headers.push({ key: 'Content-Type', value: contentTypeHeader, enabled: true, description: '' });
      }

      const tag = (op.tags && op.tags[0]) || '默认分组';
      out.requests.push({
        name: op.summary || op.operationId || `${method.toUpperCase()} ${rawPath}`,
        collectionId: folderFor(tag),
        method: method.toUpperCase(),
        url: baseUrl + rawPath,
        params,
        headers,
        body,
        auth: { type: 'none' },
        options: { timeout: null, followRedirects: true, verifyTls: true },
        description: op.description || '',
        sort: 0,
        variables: [],
      });
    }
  }
  return out;
}

function schemaProps(root, schema) {
  const s = oaResolveRef(root, schema);
  if (!s || !s.properties) return [];
  return Object.entries(s.properties).map(([k, v]) => {
    const p = oaResolveRef(root, v);
    return { key: k, value: p && p.example !== undefined ? String(p.example) : '', enabled: true };
  });
}

/** 依据 schema 生成示例对象 */
function sampleFromSchema(root, schema, depth = 0) {
  const s = oaResolveRef(root, schema);
  if (!s || depth > 5) return {};
  if (s.example !== undefined) return s.example;
  if (s.type === 'array') return [sampleFromSchema(root, s.items, depth + 1)];
  if (s.type === 'object' || s.properties) {
    const out = {};
    for (const [k, v] of Object.entries(s.properties || {})) out[k] = sampleFromSchema(root, v, depth + 1);
    return out;
  }
  if (s.type === 'integer' || s.type === 'number') return 0;
  if (s.type === 'boolean') return false;
  if (s.enum && s.enum.length) return s.enum[0];
  return '';
}

/* ==================================================================== *
 * 统一入口
 * ==================================================================== */
/**
 * 自动识别文本格式并解析
 * @returns {{format:string, name:string, collections:Array, requests:Array}}
 */
export function importFromText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('内容为空');

  if (/^curl\b/i.test(trimmed) || /\bcurl\s+-/i.test(trimmed)) {
    const req = parseCurl(trimmed);
    return {
      format: 'cURL',
      name: '从 cURL 导入',
      collections: [],
      requests: [{ id: uid('req'), name: 'cURL 导入', collectionId: null, sort: 0, ...req }],
    };
  }

  let json;
  try {
    json = JSON.parse(trimmed);
  } catch (e) {
    throw new Error('无法识别的内容格式：既不是 cURL 命令，也不是合法 JSON');
  }

  if (json.info && (json.item || (json.collection && json.collection.item))) {
    return { format: 'Postman Collection', ...parsePostman(json) };
  }
  if (json.paths && (json.openapi || json.swagger || true)) {
    if (!json.openapi && !json.swagger && !json.info) {
      throw new Error('看起来是 JSON，但缺少 OpenAPI/Swagger 版本标记');
    }
    return { format: json.openapi ? `OpenAPI ${json.openapi}` : `Swagger ${json.swagger || ''}`, ...parseOpenApi(json) };
  }
  // 自有格式：完整工作区备份
  if (json.version && (json.collections || json.requests)) {
    return { format: 'MyApiTools 工作区', raw: json, collections: [], requests: [] };
  }
  throw new Error('无法识别的内容格式（支持 cURL、Postman Collection、OpenAPI 3 / Swagger 2）');
}

/* ==================================================================== *
 * 导出
 * ==================================================================== */
const toPairs = (rows) => (rows || []).map((r) => ({ key: r.key, value: r.value ?? '', disabled: r.enabled === false }));

export function toPostmanCollection(name, collections, requests) {
  const byParent = (pid) => {
    const cols = collections.filter((c) => (c.parentId || null) === (pid || null));
    const reqs = requests.filter((r) => (r.collectionId || null) === (pid || null));
    return [
      ...cols.map((c) => ({ name: c.name, item: byParent(c.id) })),
      ...reqs.map((r) => ({
        name: r.name,
        request: {
          method: r.method,
          header: toPairs(r.headers),
          url: {
            raw: r.url,
            query: toPairs(r.params).filter((q) => q.key),
          },
          body: (() => {
            const b = r.body || { mode: 'none' };
            if (b.mode === 'json' || b.mode === 'text' || b.mode === 'xml') {
              return { mode: 'raw', raw: b.content || '', options: { raw: { language: b.mode === 'json' ? 'json' : b.mode } } };
            }
            if (b.mode === 'form-urlencoded') return { mode: 'urlencoded', urlencoded: toPairs(b.fields) };
            if (b.mode === 'form-data') {
              return {
                mode: 'formdata',
                formdata: (b.fields || []).map((f) => ({
                  key: f.key,
                  value: f.type === 'file' ? undefined : f.value,
                  type: f.type === 'file' ? 'file' : 'text',
                  src: f.type === 'file' ? f.filePath : undefined,
                  disabled: f.enabled === false,
                })),
              };
            }
            return { mode: 'none' };
          })(),
          auth: (() => {
            const a = r.auth || { type: 'none' };
            if (a.type === 'bearer') return { type: 'bearer', bearer: [{ key: 'token', value: a.token || '', type: 'string' }] };
            if (a.type === 'basic') {
              return {
                type: 'basic',
                basic: [
                  { key: 'username', value: a.username || '', type: 'string' },
                  { key: 'password', value: a.password || '', type: 'string' },
                ],
              };
            }
            if (a.type === 'apikey') {
              return {
                type: 'apikey',
                apikey: [
                  { key: 'key', value: a.key || '', type: 'string' },
                  { key: 'value', value: a.value || '', type: 'string' },
                  { key: 'in', value: a.in || 'header', type: 'string' },
                ],
              };
            }
            return { type: 'noauth' };
          })(),
          description: r.description || '',
        },
        response: [],
      })),
    ];
  };

  return JSON.stringify(
    {
      info: {
        _postman_id: uid('pm'),
        name,
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: byParent(null),
    },
    null,
    2
  );
}

/** 生成可粘贴到终端的 cURL 命令 */
export function toCurl(request, resolved = null) {
  const url = resolved ? resolved.url : request.url;
  const parts = [`curl -X ${(request.method || 'GET').toUpperCase()} '${url}'`];
  const headers = resolved ? Object.entries(resolved.headers || {}) : (request.headers || [])
    .filter((h) => h.enabled !== false && h.key)
    .map((h) => [h.key, h.value]);
  for (const [k, v] of headers) {
    parts.push(`  -H '${String(k).replace(/'/g, "'\\''")}: ${String(v).replace(/'/g, "'\\''")}'`);
  }

  const body = request.body || { mode: 'none' };
  if (body.mode === 'json' || body.mode === 'text' || body.mode === 'xml' || body.mode === 'graphql') {
    const content = resolved && resolved.body ? resolved.body.content : body.content;
    if (content) parts.push(`  -d '${String(content).replace(/'/g, "'\\''")}'`);
  } else if (body.mode === 'form-urlencoded') {
    for (const f of body.fields || []) {
      if (f.enabled === false) continue;
      parts.push(`  --data-urlencode '${f.key}=${f.value ?? ''}'`);
    }
  } else if (body.mode === 'form-data') {
    for (const f of body.fields || []) {
      if (f.enabled === false) continue;
      parts.push(f.type === 'file' ? `  -F '${f.key}=@${f.filePath}'` : `  -F '${f.key}=${f.value ?? ''}'`);
    }
  }

  const auth = request.auth || { type: 'none' };
  if (auth.type === 'basic') parts.push(`  -u '${auth.username || ''}:${auth.password || ''}'`);

  const opts = request.options || {};
  if (opts.verifyTls === false) parts.push('  -k');
  if (opts.followRedirects !== false) parts.push('  -L');
  return parts.join(' \\\n');
}
