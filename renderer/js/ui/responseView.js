/**
 * 响应查看面板：状态 / 耗时 / 大小 / 响应体 / 响应头 / 时间线
 */

import { qs, html, raw } from './dom.js';
import { state } from '../state.js';
import {
  escapeHtml,
  formatBytes,
  formatMs,
  highlightByType,
  highlightJson,
  prettyMaybe,
  statusColor,
  shouldAutoPretty,
} from '../helpers.js';
import { toastOk, toastErr } from './feedback.js';

const bridge = window.bridge;

/* ------------------------- 每个标签页的视图状态 ------------------------- */
const viewStates = new Map();

export function getViewState(tabId) {
  if (!viewStates.has(tabId)) {
    viewStates.set(tabId, {
      reqSubtab: 'params',
      respSubtab: 'body',
      response: null,
      sending: false,
      pretty: true,
      configHeight: null,
    });
  }
  return viewStates.get(tabId);
}

export function resetResponse(tabId) {
  const vs = getViewState(tabId);
  vs.response = null;
}

export function dropViewState(tabId) {
  viewStates.delete(tabId);
}

/* ------------------------- 渲染 ------------------------- */
export function renderResponse(tab) {
  const pane = qs(`.pane[data-tab="${tab.id}"]`);
  if (!pane) return;
  const vs = getViewState(tab.id);
  const metaHost = pane.querySelector('[data-role="resp-meta"]');
  const bodyHost = pane.querySelector('[data-role="resp-body"]');
  const toolbarHost = pane.querySelector('[data-role="resp-subtabs"]');
  if (!metaHost || !bodyHost) return;

  const result = vs.response;
  if (!result) {
    metaHost.innerHTML = '';
    bodyHost.innerHTML = '<div class="placeholder">填写地址并点击「发送」查看响应<br/><span style="font-size:11px">快捷键 Ctrl + Enter</span></div>';
    return;
  }

  const resp = result.response || {};
  const descriptor = result.descriptor || {};

  /* ---------- 顶部工具栏 ---------- */
  if (toolbarHost) {
    const hasBody = !!resp.bodyText;
    toolbarHost.innerHTML = `
      <button class="subtab ${vs.respSubtab === 'body' ? 'active' : ''}" data-resp-tab="body" type="button">响应体</button>
      <button class="subtab ${vs.respSubtab === 'headers' ? 'active' : ''}" data-resp-tab="headers" type="button">响应头${resp.headers && resp.headers.length ? `<span class="badge">${resp.headers.length}</span>` : ''}</button>
      <button class="subtab ${vs.respSubtab === 'timing' ? 'active' : ''}" data-resp-tab="timing" type="button">耗时</button>
      <button class="subtab ${vs.respSubtab === 'raw' ? 'active' : ''}" data-resp-tab="raw" type="button">原始</button>
      <span style="flex:1"></span>
      <button class="toolbar-btn" data-resp-act="copy-curl" type="button" title="复制等价的 cURL 命令">复制 cURL</button>
      ${hasBody ? '<button class="toolbar-btn" data-resp-act="copy-body" type="button">复制响应</button>' : ''}
      ${hasBody ? '<button class="toolbar-btn" data-resp-act="save-body" type="button">保存…</button>' : ''}
      ${resp.url ? '<button class="toolbar-btn" data-resp-act="open-url" type="button">浏览器打开</button>' : ''}
    `;
  }

  /* ---------- 元信息条 ---------- */
  const chips = [];
  if (resp.error) {
    chips.push(`<span class="meta-chip"><span class="value" style="color:var(--danger)">请求失败</span></span>`);
    chips.push(`<span class="meta-chip"><span class="label">代码</span><span class="value" style="color:var(--danger)">${escapeHtml(resp.error.code || '-')}</span></span>`);
  } else {
    chips.push(`<span class="meta-chip"><span class="label">状态</span><span class="value" style="color:${statusColor(resp.status)}">${resp.status} ${escapeHtml(resp.statusText || '')}</span></span>`);
    chips.push(`<span class="meta-chip"><span class="label">耗时</span><span class="value">${escapeHtml(formatMs(resp.duration))}</span></span>`);
    chips.push(`<span class="meta-chip"><span class="label">大小</span><span class="value">${escapeHtml(formatBytes(resp.size))}</span></span>`);
    if (resp.contentType) {
      chips.push(`<span class="meta-chip"><span class="label">类型</span><span class="value">${escapeHtml(String(resp.contentType).split(';')[0])}</span></span>`);
    }
    if (resp.redirects && resp.redirects.length) {
      chips.push(`<span class="meta-chip"><span class="label">重定向</span><span class="value" style="color:var(--warn)">${resp.redirects.length} 次</span></span>`);
    }
  }
  if (result.unresolved && result.unresolved.length) {
    chips.push(`<span class="meta-chip"><span class="value" style="color:var(--warn)">⚠ 未替换变量：${escapeHtml(result.unresolved.join(', '))}</span></span>`);
  }
  metaHost.innerHTML = chips.join('') + '<span class="spacer"></span>';
  const h = pane.querySelector('[data-role="config"]');
  if (vs.configHeight && h && !h.style.height) {
    h.style.maxHeight = vs.configHeight + 'px';
  }

  /* ---------- 主体 ---------- */
  if (vs.respSubtab === 'headers') {
    bodyHost.innerHTML = renderHeaders(resp);
  } else if (vs.respSubtab === 'timing') {
    bodyHost.innerHTML = renderTiming(resp, descriptor);
  } else if (vs.respSubtab === 'raw') {
    bodyHost.innerHTML = renderRaw(resp);
  } else {
    bodyHost.innerHTML = renderBody(resp, vs);
  }
}

function renderHeaders(resp) {
  if (resp.error) return renderError(resp);
  const rows = (resp.headers || [])
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
    .join('');
  const setCookies = (resp.headers || []).filter(([k]) => k.toLowerCase() === 'set-cookie');
  return `
    ${setCookies.length ? renderCookies(setCookies) : ''}
    <table class="headers-table">${rows || '<tr><td colspan="2" style="color:var(--text-3)">无响应头</td></tr>'}</table>`;
}

function renderCookies(setCookies) {
  const items = setCookies
    .map(([, v]) => {
      const [pair, ...attrs] = String(v).split(';');
      const i = pair.indexOf('=');
      const name = i < 0 ? pair : pair.slice(0, i);
      const val = i < 0 ? '' : pair.slice(i + 1);
      return `<tr><td>${escapeHtml(name.trim())}</td><td>${escapeHtml(val.trim())} <span class="text-dim" style="font-size:11px">${escapeHtml(attrs.join('; ').trim())}</span></td></tr>`;
    })
    .join('');
  return `
    <div style="padding:10px 12px 4px;color:var(--text-2);font-size:12px">响应下发的 Cookie</div>
    <table class="headers-table">${items}</table>
    <div style="height:12px"></div>`;
}

function renderTiming(resp, descriptor) {
  if (resp.error) return renderError(resp);
  const t = resp.timings || {};
  const rows = [
    ['DNS 解析', t.dns],
    ['TCP 连接', t.connect],
    ['TLS 握手', t.tls],
    ['等待首字节', t.firstByte],
    ['内容传输', t.total !== undefined && t.firstByte !== undefined ? Math.max(0, t.total - t.firstByte) : undefined],
    ['总耗时', t.total],
  ].filter(([, v]) => v !== undefined && v !== null);

  const max = Math.max(...rows.map(([, v]) => v), 1);
  const body = rows
    .map(([label, v]) => `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:9px">
        <span style="width:96px;color:var(--text-2);font-size:12px">${escapeHtml(label)}</span>
        <div style="flex:1;height:16px;background:var(--bg-2);border-radius:3px;overflow:hidden;max-width:420px">
          <div style="height:100%;width:${Math.max(2, (v / max) * 100)}%;background:linear-gradient(90deg,var(--accent),var(--purple));border-radius:3px"></div>
        </div>
        <span class="mono" style="width:78px;text-align:right;font-size:12px">${escapeHtml(formatMs(v))}</span>
      </div>`)
    .join('');

  return `
    <div style="padding:14px 16px">
      ${body || '<div class="text-dim">无耗时数据</div>'}
      <div class="field-hint" style="margin-top:16px">
        实际请求地址：<span class="mono">${escapeHtml(resp.url || descriptor.url || '')}</span>
      </div>
      ${resp.redirects && resp.redirects.length
        ? `<div class="field-hint" style="margin-top:10px">重定向链路：<br/>${resp.redirects
            .map((r) => `<span class="mono">${r.status} → ${escapeHtml(r.to)}</span>`)
            .join('<br/>')}</div>`
        : ''}
      ${resp.timings && resp.timings.dns === undefined
        ? '<div class="field-hint" style="margin-top:6px">本次复用了已有连接，因此没有 DNS / 连接耗时</div>'
        : ''}
    </div>`;
}

function renderRaw(resp) {
  if (resp.error) return renderError(resp);
  const head = [`HTTP/1.1 ${resp.status} ${resp.statusText || ''}`];
  for (const [k, v] of resp.headers || []) head.push(`${k}: ${v}`);
  const text = `${head.join('\n')}\n\n${resp.bodyText || ''}`;
  return `<pre class="code-block">${escapeHtml(text)}</pre>`;
}

function renderBody(resp, vs) {
  if (resp.error) return renderError(resp);
  if (!resp.bodyText) {
    return `<div class="placeholder">响应体为空（${escapeHtml(formatBytes(resp.size || 0))}）</div>`;
  }

  let text = resp.bodyText;
  const isJson = _isJson(resp);
  if (isJson && vs.pretty && shouldAutoPretty(text)) {
    text = prettyMaybe(text);
  }

  let content;
  if (resp.textual === false) {
    content = escapeHtml(text);
  } else {
    content = highlightByType(text, resp.contentType || '');
  }

  const warn = resp.warning
    ? `<div class="warn-box">${escapeHtml(resp.warning)}</div>`
    : '';

  return `${warn}<pre class="code-block">${content}</pre>`;
}

function _isJson(resp) {
  const ct = String(resp.contentType || '').toLowerCase();
  if (ct.includes('json')) return true;
  const t = (resp.bodyText || '').trim();
  return (t.startsWith('{') || t.startsWith('[')) && t.length < 8 * 1024 * 1024;
}

function renderError(resp) {
  const e = resp.error || {};
  return `
    <div class="error-box">
      <div class="err-title">✕ 请求未能完成</div>
      <div class="err-code">错误代码：${escapeHtml(e.code || 'UNKNOWN')}${resp.duration ? ` · 耗时 ${escapeHtml(formatMs(resp.duration))}` : ''}</div>
      <div class="err-msg">${escapeHtml(e.message || '未知错误')}</div>
      ${e.hint ? `<div class="err-hint">💡 ${escapeHtml(e.hint)}</div>` : ''}
    </div>`;
}

/* ------------------------- 清空某个标签页的响应 ------------------------- */
export function clearResponseFor(tabId) {
  const vs = viewStates.get(tabId);
  if (vs) vs.response = null;
}
