/**
 * 通用工具
 */

let seq = 0;
export function uid(prefix = 'id') {
  seq = (seq + 1) % 100000;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

export function debounce(fn, wait = 300) {
  let timer = null;
  const wrapped = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
  wrapped.flush = (...args) => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      fn(...args);
    }
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return wrapped;
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(v < 10240 ? 2 : 1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(2)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatMs(ms) {
  const v = Number(ms) || 0;
  if (v < 1000) return `${v} ms`;
  return `${(v / 1000).toFixed(2)} s`;
}

export function formatTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function formatRelative(ts) {
  if (!ts) return '从未';
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 7 * 86400000) return `${Math.floor(diff / 86400000)} 天前`;
  return formatTime(ts).slice(0, 10);
}

/* ------------------------- HTTP 方法配色 ------------------------- */
export const METHOD_COLORS = {
  GET: '#4ade80',
  POST: '#fbbf24',
  PUT: '#60a5fa',
  PATCH: '#c084fc',
  DELETE: '#f87171',
  HEAD: '#94a3b8',
  OPTIONS: '#22d3ee',
  TRACE: '#94a3b8',
  CONNECT: '#94a3b8',
};

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export const methodColor = (m) => METHOD_COLORS[String(m || 'GET').toUpperCase()] || '#94a3b8';

/** 状态码语气色 */
export function statusTone(status) {
  const s = Number(status);
  if (!s) return 'err';
  if (s >= 200 && s < 300) return 'ok';
  if (s >= 300 && s < 400) return 'warn';
  if (s >= 400 && s < 500) return 'err';
  return 'err';
}

export function statusColor(status) {
  const s = Number(status);
  if (!s) return '#f87171';
  if (s < 300) return '#4ade80';
  if (s < 400) return '#fbbf24';
  if (s < 500) return '#fb923c';
  return '#f87171';
}

/* ------------------------- 语法高亮 ------------------------- */
/** JSON 高亮：逐 token 转义后再拼装，避免注入与二次解析 */
export function highlightJson(text) {
  const src = String(text ?? '');
  const out = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],])/g;
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push(escapeHtml(src.slice(last, m.index)));
    const [full, str, colon, num, kw, brace] = m;
    if (str !== undefined) {
      const isKey = !!colon;
      out.push(`<span class="tk-${isKey ? 'key' : 'str'}">${escapeHtml(str)}</span>`);
      if (colon) out.push(escapeHtml(colon));
    } else if (num !== undefined) {
      out.push(`<span class="tk-num">${escapeHtml(num)}</span>`);
    } else if (kw !== undefined) {
      out.push(`<span class="tk-kw">${escapeHtml(kw)}</span>`);
    } else if (brace !== undefined) {
      out.push(`<span class="tk-brace">${escapeHtml(brace)}</span>`);
    }
    last = m.index + full.length;
  }
  if (last < src.length) out.push(escapeHtml(src.slice(last)));
  return out.join('');
}

/** XML / HTML 高亮 */
export function highlightXml(text) {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="tk-comment">$1</span>')
    .replace(/(&lt;\/?)([\w:.-]+)/g, '$1<span class="tk-tag">$2</span>')
    .replace(/([\w:.-]+)=(&quot;.*?&quot;|'.*?')/g, '<span class="tk-attr">$1</span>=<span class="tk-str">$2</span>');
}

/** 依据内容类型自动选择高亮方式 */
export function highlightByType(text, contentType = '') {
  const ct = String(contentType).toLowerCase();
  if (ct.includes('json') || /^[\s]*[[{]/.test(text)) {
    try {
      JSON.parse(text);
      return highlightJson(text);
    } catch {
      return highlightJson(text);
    }
  }
  if (ct.includes('xml') || ct.includes('html') || /^\s*<[?!]?[a-zA-Z]/.test(text)) {
    return highlightXml(text);
  }
  return escapeHtml(text);
}

/** 尝试美化 JSON，失败则原样返回 */
export function prettyMaybe(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** 粗略估算 JSON 美化是否值得（大文本不自动美化） */
export function shouldAutoPretty(text, maxBytes = 512 * 1024) {
  return String(text).length <= maxBytes;
}

/** 把表单态的一行行 {key,value,enabled} 转成 [{key,value}] */
export function enabledRows(rows) {
  return (rows || []).filter((r) => r.enabled !== false && String(r.key || '').trim() !== '');
}

/** 生成简短摘要，用于历史记录标题 */
export function summarize(obj, len = 60) {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  if (!s) return '';
  return s.length > len ? s.slice(0, len) + '…' : s;
}
