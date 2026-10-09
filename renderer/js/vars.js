/**
 * 变量解析
 * ---------------------------------------------------------------
 * 优先级（低 → 高）：全局变量 < 当前环境变量 < 请求级变量
 * 语法：{{name}}；内置动态变量以 $ 开头，每次发送时重新生成。
 */

import { state, getActiveEnv } from './state.js';

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;
const MAX_DEPTH = 8;

/* ------------------------- 内置动态变量 ------------------------- */
/** UTF-8 安全的 Base64（不用已废弃的 unescape） */
function base64Utf8(str) {
  const bytes = new TextEncoder().encode(String(str));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

function formatDate(d, fmt) {
  const map = {
    YYYY: d.getFullYear(),
    MM: pad(d.getMonth() + 1),
    DD: pad(d.getDate()),
    HH: pad(d.getHours()),
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds()),
    SSS: pad(d.getMilliseconds(), 3),
  };
  return fmt.replace(/YYYY|MM|DD|HH|mm|ss|SSS/g, (k) => map[k]);
}

const DYNAMIC = {
  $timestamp: () => String(Date.now()),
  $timestampSec: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $uuid: () =>
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    }),
  $randomInt: () => String(Math.floor(Math.random() * 1000000)),
  $randomFloat: () => Math.random().toFixed(6),
  $randomBoolean: () => (Math.random() < 0.5 ? 'true' : 'false'),
  $randomString: (len = 12) => {
    // 注意括号：`i < Number(len) || 12` 会被解析成 `(i < Number(len)) || 12`，
    // 条件恒真导致死循环，必须写成 `i < (Number(len) || 12)`
    const n = Math.max(1, Math.min(Number(len) || 12, 4096));
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let s = '';
    for (let i = 0; i < n; i++) s += chars[(Math.random() * chars.length) | 0];
    return s;
  },
  $datetime: (fmt = 'YYYY-MM-DD HH:mm:ss') => formatDate(new Date(), fmt.replace(/^['"]|['"]$/g, '')),
};

export const DYNAMIC_NAMES = Object.keys(DYNAMIC).map((k) => '{{' + k + '}}');

const DYNAMIC_RE = /\{\{\s*(\$[A-Za-z]+)((?:\s+[^{}]*?)?)\s*\}\}/g;

/* ------------------------- 变量表 ------------------------- */
export function buildVariableMap(requestVars = []) {
  const map = new Map();
  for (const g of state.workspace.globals || []) {
    if (g.enabled === false || !g.key) continue;
    map.set(String(g.key), String(g.value ?? ''));
  }
  const env = getActiveEnv();
  if (env) {
    for (const v of env.variables || []) {
      if (v.enabled === false || !v.key) continue;
      map.set(String(v.key), String(v.value ?? ''));
    }
  }
  for (const v of requestVars || []) {
    if (v.enabled === false || !v.key) continue;
    map.set(String(v.key), String(v.value ?? ''));
  }
  return map;
}

/** 展开动态变量 */
function expandDynamic(input) {
  if (typeof input !== 'string' || input.indexOf('{{$') < 0) return input;
  return input.replace(DYNAMIC_RE, (full, name, argRaw) => {
    const fn = DYNAMIC[name];
    if (!fn) return full;
    const arg = argRaw ? argRaw.trim() : '';
    try {
      return fn(arg);
    } catch {
      return full;
    }
  });
}

/**
 * 解析单个字符串里的变量
 * @returns {{value:string, unresolved:string[]}}
 */
export function resolveString(input, map, depth = 0) {
  const unresolved = [];
  if (typeof input !== 'string' || input.indexOf('{{') < 0) {
    return { value: typeof input === 'string' ? input : String(input ?? ''), unresolved };
  }
  if (depth > MAX_DEPTH) return { value: input, unresolved };

  let changed = false;
  const value = input.replace(PLACEHOLDER, (full, rawName) => {
    const name = rawName.trim();
    if (name.startsWith('$')) return full; // 动态变量稍后统一处理
    const parts = name.split('.');
    if (map.has(name)) {
      changed = true;
      return map.get(name);
    }
    // 支持 {{env.xxx}} 这类别名写法
    if (parts.length === 2 && parts[0] === 'env' && map.has(parts[1])) {
      changed = true;
      return map.get(parts[1]);
    }
    if (!unresolved.includes(name)) unresolved.push(name);
    return full;
  });

  const result = expandDynamic(value);
  if (changed && /\{\{[^{}]*\}\}/.test(result)) {
    const again = resolveString(result, map, depth + 1);
    return { value: again.value, unresolved: dedupe([...unresolved, ...again.unresolved]) };
  }
  return { value: result, unresolved };
}

function dedupe(arr) {
  return [...new Set(arr)];
}

/** 对任意嵌套结构做变量替换 */
export function resolveDeep(input, map, depth = 0) {
  const unresolved = [];
  const walk = (v) => {
    if (typeof v === 'string') {
      const r = resolveString(v, map, depth);
      unresolved.push(...r.unresolved);
      return r.value;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  const value = walk(input);
  return { value, unresolved: dedupe(unresolved) };
}

/* ------------------------- 请求编译 ------------------------- */
/**
 * 把一个配置态的 request 编译成可直接交给主进程执行的描述对象
 * @param {object} request 集合中的请求配置
 * @returns {{descriptor:object, unresolved:string[], resolvedUrl:string, preview:object}}
 */
export function compileRequest(request) {
  if (!request) throw new Error('请求不存在');
  const map = buildVariableMap(request.variables || []);
  const unresolved = [];

  const collect = (r) => unresolved.push(...r.unresolved);

  // ---- URL + 查询参数 ----
  const urlRes = resolveString(request.url || '', map);
  collect(urlRes);
  let finalUrl = urlRes.value.trim();
  if (finalUrl && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(finalUrl)) {
    // 没有协议时补上 http://，方便直接贴 127.0.0.1:8080/xxx
    finalUrl = 'http://' + finalUrl.replace(/^\/+/, '');
  }

  const params = [];
  for (const p of request.params || []) {
    if (p.enabled === false || !String(p.key || '').trim()) continue;
    const k = resolveString(String(p.key), map);
    const v = resolveString(String(p.value ?? ''), map);
    collect(k);
    collect(v);
    params.push({ key: k.value, value: v.value });
  }

  // ---- Headers ----
  const headers = [];
  for (const h of request.headers || []) {
    if (h.enabled === false || !String(h.key || '').trim()) continue;
    const k = resolveString(String(h.key), map);
    const v = resolveString(String(h.value ?? ''), map);
    collect(k);
    collect(v);
    headers.push([k.value, v.value]);
  }

  // ---- Auth ----
  const auth = request.auth || { type: 'none' };
  const hasHeader = (name) => headers.some(([k]) => k.toLowerCase() === name.toLowerCase());
  if (auth.type === 'bearer' && auth.token) {
    const t = resolveString(auth.token, map);
    collect(t);
    if (!hasHeader('authorization')) headers.push(['Authorization', `Bearer ${t.value}`]);
  } else if (auth.type === 'basic') {
    const u = resolveString(auth.username || '', map);
    const p = resolveString(auth.password || '', map);
    collect(u);
    collect(p);
    if (!hasHeader('authorization')) {
      headers.push(['Authorization', 'Basic ' + base64Utf8(`${u.value}:${p.value}`)]);
    }
  } else if (auth.type === 'apikey' && auth.key) {
    const k = resolveString(auth.key, map);
    const v = resolveString(auth.value || '', map);
    collect(k);
    collect(v);
    if ((auth.in || 'header') === 'header') {
      if (!hasHeader(k.value)) headers.push([k.value, v.value]);
    } else {
      params.push({ key: k.value, value: v.value });
    }
  }

  // ---- Body ----
  const bodyIn = request.body || { mode: 'none' };
  const body = { mode: bodyIn.mode || 'none' };
  if (bodyIn.mode === 'json' || bodyIn.mode === 'text' || bodyIn.mode === 'xml' || bodyIn.mode === 'graphql') {
    const r = resolveString(bodyIn.content || '', map);
    collect(r);
    body.content = r.value;
    if (bodyIn.contentType) body.contentType = bodyIn.contentType;
  } else if (bodyIn.mode === 'form-urlencoded' || bodyIn.mode === 'form-data') {
    body.fields = (bodyIn.fields || [])
      .filter((f) => f.enabled !== false && String(f.key || '').trim())
      .map((f) => {
        if (f.type === 'file') {
          return { key: f.key, type: 'file', filePath: f.filePath || '', contentType: f.contentType || '' };
        }
        const k = resolveString(String(f.key), map);
        const v = resolveString(String(f.value ?? ''), map);
        collect(k);
        collect(v);
        return { key: k.value, value: v.value, type: 'text' };
      });
  } else if (bodyIn.mode === 'binary') {
    body.filePath = bodyIn.filePath || '';
    body.contentType = bodyIn.contentType || 'application/octet-stream';
    body.content = bodyIn.content || '';
  }

  // ---- 拼装最终 URL ----
  const settings = state.workspace.settings;
  const opts = request.options || {};
  let url;
  try {
    url = new URL(finalUrl);
  } catch {
    throw new Error(`请求地址无法解析：${finalUrl || '(空)'}`);
  }
  for (const p of params) url.searchParams.append(p.key, p.value);

  const descriptor = {
    method: (request.method || 'GET').toUpperCase(),
    url: url.toString(),
    headers,
    body,
    timeout: opts.timeout || settings.timeout || 30000,
    followRedirects: opts.followRedirects !== undefined ? opts.followRedirects : settings.followRedirects,
    verifyTls: opts.verifyTls !== undefined ? opts.verifyTls : settings.verifyTls,
    maxRedirects: settings.maxRedirects,
  };

  return {
    descriptor,
    unresolved: dedupe(unresolved),
    resolvedUrl: url.toString(),
    preview: { url: url.toString(), headers: Object.fromEntries(headers), body },
  };
}

/**
 * 只解析 URL，用于界面上的实时预览（不抛异常）
 * URL 规范化会把未替换的 {{ }} 转义成 %7B%7B，预览时还原回花括号更易读；
 * 真正发出的地址仍以 compileRequest().descriptor.url 为准（保持转义后的真实形态）。
 */
export function previewUrl(request) {
  if (!request) return '';
  try {
    return compileRequest(request).resolvedUrl.replace(/%7B%7B/gi, '{{').replace(/%7D%7D/gi, '}}');
  } catch {
    return request.url || '';
  }
}

/** 列出当前所有可用变量，供自动补全使用 */
export function availableVariables() {
  const rows = [];
  const env = getActiveEnv();
  for (const g of state.workspace.globals || []) {
    if (g.key) rows.push({ name: g.key, value: g.value, from: '全局' });
  }
  if (env) {
    for (const v of env.variables || []) {
      if (v.key) rows.push({ name: v.key, value: v.value, from: env.name });
    }
  }
  for (const d of DYNAMIC_NAMES) rows.push({ name: d.slice(2, -2), value: '动态生成', from: '内置' });
  return rows;
}
