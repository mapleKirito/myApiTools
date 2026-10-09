/**
 * 请求编辑面板：方法 / URL / Params / Headers / Body / Auth / 选项
 */

import { qs, qsa, on, html, raw } from './dom.js';
import {
  state,
  bus,
  getRequest,
  updateRequest,
  commit,
  openTab,
} from '../state.js';
import { escapeHtml, methodColor, METHODS, METHOD_COLORS } from '../helpers.js';
import { renderResponse, resetResponse, getViewState } from './responseView.js';
import { sendOne } from '../runner.js';
import { previewUrl, availableVariables } from '../vars.js';
import { toastErr, showContextMenu } from './feedback.js';
import { toCurl } from '../importers.js';

const bridge = window.bridge;

/* ==================================================================== *
 * 面板骨架
 * ==================================================================== */
export function renderRequestPane(tab) {
  const req = getRequest(tab.refId);
  if (!req) {
    return `<div class="empty-state"><div><div class="big">请求已被删除</div></div></div>`;
  }
  const vs = getViewState(tab.id);
  return html`
    <div class="request-top">
      <input class="req-name" data-role="req-name" value="${req.name}" placeholder="请求名称" spellcheck="false" title="请求名称" />
      <select class="method-select" data-role="method" style="color:${raw(methodColor(req.method))}">
        ${raw(METHODS.map((m) => `<option value="${m}" ${m === req.method ? 'selected' : ''}>${m}</option>`).join(''))}
      </select>
      <input class="url-input" data-role="url" value="${req.url}" placeholder="https://api.example.com/users 或 {{host}}/users" spellcheck="false" />
      <button class="send-btn" data-role="send" type="button"><span data-role="send-label">发送</span></button>
    </div>
    <div class="url-preview"><span class="preview-url" data-role="url-preview"></span><span class="unresolved-badge" data-role="unresolved"></span></div>

    <div class="request-split">
      <div class="request-config" data-role="config">
        <div class="subtabs" data-role="req-subtabs"></div>
        <div class="subtab-body" data-role="req-body"></div>
      </div>
      <div class="splitter-h" data-role="split-h" style="height:5px;cursor:row-resize;flex:0 0 auto"></div>
      <div class="request-response">
        <div class="subtabs" data-role="resp-subtabs"></div>
        <div class="response-meta" data-role="resp-meta"></div>
        <div class="res-body" data-role="resp-body"></div>
      </div>
    </div>
  `;
}

const REQ_TABS = [
  { id: 'params', label: 'Params' },
  { id: 'body', label: 'Body' },
  { id: 'headers', label: 'Headers' },
  { id: 'auth', label: 'Auth' },
  { id: 'options', label: '选项' },
];

const RESP_TABS = [
  { id: 'body', label: '响应体' },
  { id: 'headers', label: '响应头' },
  { id: 'timing', label: '耗时' },
  { id: 'raw', label: '原始' },
];

export function subtabState(tabId) {
  const vs = getViewState(tabId);
  if (!vs.reqSubtab) vs.reqSubtab = 'params';
  if (!vs.respSubtab) vs.respSubtab = 'body';
  return vs;
}

/* ==================================================================== *
 * 子标签栏
 * ==================================================================== */
export function renderRequestSubtabs(tab) {
  const req = getRequest(tab.refId);
  const vs = subtabState(tab.id);
  const host = qs(`.pane[data-tab="${tab.id}"] [data-role="req-subtabs"]`);
  if (!req || !host) return;
  const counts = {
    params: (req.params || []).filter((p) => p.enabled !== false && p.key).length,
    headers: (req.headers || []).filter((h) => h.enabled !== false && h.key).length,
    body: req.body && req.body.mode && req.body.mode !== 'none' ? 1 : 0,
    auth: req.auth && req.auth.type && req.auth.type !== 'none' ? 1 : 0,
  };
  qs(`.pane[data-tab="${tab.id}"] [data-role="req-subtabs"]`).innerHTML = REQ_TABS.map((t) => {
    const n = counts[t.id];
    return `<button class="subtab ${vs.reqSubtab === t.id ? 'active' : ''}" data-subtab="${t.id}" type="button">
      ${escapeHtml(t.label)}${n ? `<span class="badge">${n}</span>` : ''}
    </button>`;
  }).join('');
}

export function renderResponseSubtabs(tab) {
  const vs = subtabState(tab.id);
  const hasResp = !!vs.response;
  qs(`.pane[data-tab="${tab.id}"] [data-role="resp-subtabs"]`).innerHTML = RESP_TABS.map(
    (t) => `<button class="subtab ${vs.respSubtab === t.id ? 'active' : ''}" data-resp-tab="${t.id}" type="button" ${hasResp ? '' : 'disabled style="opacity:.45"'}>${escapeHtml(t.label)}</button>`
  ).join('');
}

/* ==================================================================== *
 * 请求配置主体
 * ==================================================================== */
export function renderRequestBody(tab) {
  const req = getRequest(tab.refId);
  const vs = subtabState(tab.id);
  const host = qs(`.pane[data-tab="${tab.id}"] [data-role="req-body"]`);
  if (!host || !req) return;

  let content = '';
  let noPad = false;

  switch (vs.reqSubtab) {
    case 'params':
      content = kvTable('params', req.params, '参数名', '参数值', req);
      noPad = true;
      break;
    case 'headers':
      content = kvTable('headers', req.headers, 'Header 名', 'Header 值', req);
      noPad = true;
      break;
    case 'body':
      content = bodyEditor(req);
      noPad = true;
      break;
    case 'auth':
      content = authEditor(req);
      break;
    case 'options':
      content = optionsEditor(req);
      break;
    default:
      content = '';
  }

  host.classList.toggle('no-pad', noPad);
  host.innerHTML = content;
  updateUrlPreview(tab.id);
}

/* ---------------------------- 键值表 ---------------------------- */
function kvTable(kind, rows, keyPh, valPh, req) {
  const list = rows || [];
  const body = list
    .map((row, i) => kvRow(kind, row, i, keyPh, valPh))
    .join('');
  // 末尾始终留一个空白行，输入即新增
  const ghost = kvRow(kind, { key: '', value: '', enabled: true, isGhost: true }, list.length, keyPh, valPh);
  return `
    <table class="kv-table" data-kv="${kind}">
      <thead>
        <tr>
          <th class="kv-check"></th>
          <th>键</th>
          <th>值</th>
          <th class="kv-del"></th>
        </tr>
      </thead>
      <tbody>${body}${ghost}</tbody>
    </table>
    <div class="field-hint" style="padding:8px 10px">
      ${kind === 'params' ? '发送时会与 URL 中已有的查询参数合并' : '值支持 {{变量}} 占位符'}
      ${req ? ` · 共 ${list.filter((r) => r.enabled !== false && r.key).length} 项生效` : ''}
    </div>`;
}

function kvRow(kind, row, index, keyPh, valPh) {
  const disabled = row.enabled === false;
  return `
    <tr data-idx="${index}">
      <td class="kv-check">
        <input type="checkbox" class="checkbox" data-kv-field="enabled" ${disabled ? '' : 'checked'} />
      </td>
      <td><input class="kv-input key-input ${disabled ? 'dim' : ''}" data-kv-field="key" value="${escapeHtml(row.key || '')}" placeholder="${escapeHtml(keyPh)}" spellcheck="false" /></td>
      <td><input class="kv-input ${disabled ? 'dim' : ''}" data-kv-field="value" value="${escapeHtml(row.value ?? '')}" placeholder="${escapeHtml(valPh)}" spellcheck="false" /></td>
      <td class="kv-del">
        ${row.isGhost ? '' : '<button class="row-icon-btn" data-kv-del type="button" title="删除">✕</button>'}
      </td>
    </tr>`;
}

/* ---------------------------- 请求体 ---------------------------- */
const BODY_MODES = [
  { id: 'none', label: 'none' },
  { id: 'json', label: 'JSON' },
  { id: 'text', label: 'Text' },
  { id: 'xml', label: 'XML' },
  { id: 'form-urlencoded', label: 'form-urlencoded' },
  { id: 'form-data', label: 'form-data' },
  { id: 'graphql', label: 'GraphQL' },
  { id: 'binary', label: 'Binary' },
];

function bodyEditor(req) {
  const b = req.body || { mode: 'none' };
  const mode = b.mode || 'none';
  const seg = BODY_MODES.map(
    (m) => `<button data-body-mode="${m.id}" class="${mode === m.id ? 'active' : ''}" type="button">${escapeHtml(m.label)}</button>`
  ).join('');

  let inner = '';
  if (mode === 'none') {
    inner = `<div style="padding:26px;text-align:center;color:var(--text-3)">该请求不携带请求体</div>`;
  } else if (mode === 'form-urlencoded' || mode === 'form-data') {
    inner = formFieldsTable(mode, b.fields || []);
  } else if (mode === 'binary') {
    inner = `
      <div style="padding:12px">
        <div class="field-hint" style="margin-bottom:8px">选择一个本地文件作为请求体发送</div>
        <div class="btn-row">
          <button class="btn" data-act="pick-binary" type="button">选择文件…</button>
          <span class="mono text-dim" data-role="binary-path">${escapeHtml(b.filePath || '未选择文件')}</span>
        </div>
        <div class="form-row" style="margin-top:12px">
          <label>Content-Type</label>
          <input type="text" data-body-content-type value="${escapeHtml(b.contentType || 'application/octet-stream')}" placeholder="application/octet-stream" />
        </div>
      </div>`;
  } else {
    const langHint = mode === 'json' ? 'JSON' : mode === 'xml' ? 'XML' : mode === 'graphql' ? 'GraphQL' : '纯文本';
    inner = `
      <div class="body-toolbar">
        <span class="field-hint">${escapeHtml(langHint)} · 支持 {{变量}}</span>
        <span class="spacer"></span>
        ${mode === 'json' || mode === 'graphql' ? '<button class="toolbar-btn" data-act="format-body" type="button">格式化</button>' : ''}
        <button class="toolbar-btn" data-act="minify-body" type="button">压缩</button>
      </div>
      <textarea class="code-editor" data-body-content spellcheck="false" placeholder="${escapeHtml(
        mode === 'json' ? '{\n  "key": "value"\n}' : mode === 'graphql' ? '{\n  "query": "query { ... }",\n  "variables": {}\n}' : ''
      )}">${escapeHtml(b.content || '')}</textarea>`;
  }

  return `
    <div class="body-toolbar">
      <div class="seg">${seg}</div>
      <span class="spacer"></span>
      <span class="field-hint">${escapeHtml(bodySizeHint(b))}</span>
    </div>
    ${inner}`;
}

function bodySizeHint(b) {
  const size =
    b.mode === 'form-urlencoded' || b.mode === 'form-data'
      ? (b.fields || []).length
      : (b.content || '').length;
  if (b.mode === 'none') return '';
  if (b.mode === 'form-urlencoded' || b.mode === 'form-data') return `${size} 个字段`;
  return `${size} 字符`;
}

function formFieldsTable(mode, fields) {
  const isFormData = mode === 'form-data';
  const rows = fields
    .map((f, i) => {
      const isFile = f.type === 'file';
      return `
      <tr data-idx="${i}">
        <td class="kv-check"><input type="checkbox" class="checkbox" data-kv-field="enabled" ${f.enabled === false ? '' : 'checked'} /></td>
        <td><input class="kv-input key-input" data-kv-field="key" value="${escapeHtml(f.key || '')}" placeholder="字段名" spellcheck="false" /></td>
        <td>
          ${isFile
            ? `<input class="kv-input" data-kv-field="filePath" value="${escapeHtml(f.filePath || '')}" placeholder="文件路径（可点右侧按钮选择）" spellcheck="false" />`
            : `<input class="kv-input" data-kv-field="value" value="${escapeHtml(f.value ?? '')}" placeholder="字段值" spellcheck="false" />`}
        </td>
        ${isFormData
          ? `<td class="kv-type">
              <select class="kv-select" data-kv-field="type">
                <option value="text" ${isFile ? '' : 'selected'}>文本</option>
                <option value="file" ${isFile ? 'selected' : ''}>文件</option>
              </select>
             </td>
             <td class="kv-del"><button class="row-icon-btn" data-act="pick-file" type="button" title="选择文件">📂</button></td>`
          : '<td class="kv-del"></td>'}
        <td class="kv-del">${fields.length ? '<button class="row-icon-btn" data-kv-del type="button" title="删除">✕</button>' : ''}</td>
      </tr>`;
    })
    .join('');

  const ghost = `
    <tr data-idx="${fields.length}">
      <td class="kv-check"><input type="checkbox" class="checkbox" data-kv-field="enabled" checked /></td>
      <td><input class="kv-input key-input" data-kv-field="key" placeholder="字段名" spellcheck="false" /></td>
      <td><input class="kv-input" data-kv-field="value" placeholder="字段值" spellcheck="false" /></td>
      ${isFormData ? '<td class="kv-type"></td><td class="kv-del"></td>' : '<td class="kv-del"></td>'}
      <td class="kv-del"></td>
    </tr>`;

  return `
    <table class="kv-table" data-kv="${mode}">
      <thead>
        <tr>
          <th class="kv-check"></th>
          <th>字段名</th>
          <th>值</th>
          ${isFormData ? '<th class="kv-type">类型</th><th class="kv-del"></th>' : ''}
          <th class="kv-del"></th>
        </tr>
      </thead>
      <tbody>${rows}${ghost}</tbody>
    </table>`;
}

/* ---------------------------- 认证 ---------------------------- */
const AUTH_TYPES = [
  { id: 'none', label: '无认证' },
  { id: 'bearer', label: 'Bearer Token' },
  { id: 'basic', label: 'Basic Auth' },
  { id: 'apikey', label: 'API Key' },
];

function authEditor(req) {
  const a = req.auth || { type: 'none' };
  const type = a.type || 'none';
  const seg = AUTH_TYPES.map(
    (t) => `<button data-auth-type="${t.id}" class="${type === t.id ? 'active' : ''}" type="button">${escapeHtml(t.label)}</button>`
  ).join('');

  let inner = '';
  if (type === 'none') {
    inner = `<div style="padding:22px;text-align:center;color:var(--text-3)">该请求不携带认证信息</div>`;
  } else if (type === 'bearer') {
    inner = `
      <div class="form-row" style="margin-top:14px">
        <label>Token</label>
        <input type="text" data-auth="token" value="${escapeHtml(a.token || '')}" placeholder="支持 {{token}} 变量" style="flex:1;height:30px;padding:0 10px;background:var(--bg-2);border:1px solid var(--border);border-radius:6px;outline:none" />
      </div>
      <div class="field-hint" style="margin-left:142px">将以 <span class="mono">Authorization: Bearer &lt;token&gt;</span> 发送</div>`;
  } else if (type === 'basic') {
    inner = `
      <div class="form-row" style="margin-top:14px">
        <label>用户名</label>
        <input type="text" data-auth="username" value="${escapeHtml(a.username || '')}" style="flex:1;height:30px;padding:0 10px;background:var(--bg-2);border:1px solid var(--border);border-radius:6px;outline:none" />
      </div>
      <div class="form-row">
        <label>密码</label>
        <input type="text" data-auth="password" value="${escapeHtml(a.password || '')}" style="flex:1;height:30px;padding:0 10px;background:var(--bg-2);border:1px solid var(--border);border-radius:6px;outline:none" />
      </div>
      <div class="field-hint" style="margin-left:142px">将以 Base64 编码后放入 Authorization 头</div>`;
  } else {
    inner = `
      <div class="form-row" style="margin-top:14px">
        <label>Key</label>
        <input type="text" data-auth="key" value="${escapeHtml(a.key || '')}" placeholder="如 X-Api-Key" style="flex:1;height:30px;padding:0 10px;background:var(--bg-2);border:1px solid var(--border);border-radius:6px;outline:none" />
      </div>
      <div class="form-row">
        <label>Value</label>
        <input type="text" data-auth="value" value="${escapeHtml(a.value || '')}" placeholder="支持 {{变量}}" style="flex:1;height:30px;padding:0 10px;background:var(--bg-2);border:1px solid var(--border);border-radius:6px;outline:none" />
      </div>
      <div class="form-row">
        <label>添加到</label>
        <select data-auth="in" style="height:30px;padding:0 8px;background:var(--bg-2);border:1px solid var(--border);border-radius:6px;outline:none">
          <option value="header" ${(a.in || 'header') === 'header' ? 'selected' : ''}>请求头 Header</option>
          <option value="query" ${a.in === 'query' ? 'selected' : ''}>查询参数 Query</option>
        </select>
      </div>`;
  }

  return `
    <div class="body-toolbar"><div class="seg">${seg}</div><span class="spacer"></span>
      <span class="field-hint">认证信息同样参与 {{变量}} 替换</span>
    </div>
    ${inner}`;
}

/* ---------------------------- 请求选项 ---------------------------- */
function optionsEditor(req) {
  const s = state.workspace.settings;
  const o = req.options || {};
  const timeout = o.timeout ? o.timeout : '';
  const follow = o.followRedirects !== false;
  const verify = o.verifyTls !== false;
  return `
    <div style="max-width:640px">
      <div class="form-row">
        <label>超时（毫秒）</label>
        <input type="number" data-opt="timeout" value="${escapeHtml(timeout)}" placeholder="留空则用全局设置 ${s.timeout}" min="0" step="500"
          style="height:30px;padding:0 10px;background:var(--bg-2);border:1px solid var(--border);border-radius:6px;outline:none" />
      </div>
      <div class="form-row">
        <label>跟随重定向</label>
        <label class="switch"><input type="checkbox" data-opt="followRedirects" ${follow ? 'checked' : ''} /><span>最多 ${s.maxRedirects} 跳</span></label>
      </div>
      <div class="form-row">
        <label>校验证书</label>
        <label class="switch"><input type="checkbox" data-opt="verifyTls" ${verify ? 'checked' : ''} /><span>关闭后可访问自签名 HTTPS 服务</span></label>
      </div>
      <div class="field-hint" style="margin-top:18px">
        留空的选项会跟随「设置 → 请求默认值」。这些配置随请求一起同步到其它设备。
      </div>
    </div>`;
}

/* ==================================================================== *
 * URL 预览
 * ==================================================================== */
export function updateUrlPreview(tabId) {
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab || tab.type !== 'request') return;
  const req = getRequest(tab.refId);
  const pane = qs(`.pane[data-tab="${tabId}"]`);
  if (!req || !pane) return;

  const el = pane.querySelector('[data-role="url-preview"]');
  const badge = pane.querySelector('[data-role="unresolved"]');
  if (!el) return;

  const url = previewUrl(req);
  el.textContent = url && url !== 'http://' ? url : '（填写请求地址后可在此预览变量替换结果）';

  try {
    const { unresolved } = (() => {
      // 只在需要时做完整编译
      const mod = req;
      const text = JSON.stringify(mod);
      const found = [...text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)]
        .map((m) => m[1].trim())
        .filter((n) => !n.startsWith('$'));
      const known = new Set(availableVariables().map((v) => v.name));
      return { unresolved: [...new Set(found.filter((n) => !known.has(n) && !known.has(n.replace(/^env\./, ''))))] };
    })();
    badge.textContent = unresolved.length ? `⚠ 未定义变量：${unresolved.join(', ')}` : '';
  } catch {
    badge.textContent = '';
  }
}

/* ==================================================================== *
 * 发送
 * ==================================================================== */
export async function sendFromTab(tabId) {
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab || tab.type !== 'request') return;
  const req = getRequest(tab.refId);
  if (!req) return;
  const vs = subtabState(tabId);
  if (vs.sending) return;

  if (!String(req.url || '').trim()) {
    toastErr('请先填写请求地址');
    const input = qs(`.pane[data-tab="${tabId}"] [data-role="url"]`);
    if (input) input.focus();
    return;
  }

  vs.sending = true;
  setSendButtonState(tabId, true);

  try {
    const result = await sendOne(req);
    vs.response = result;
    renderResponse(tab);
  } catch (e) {
    toastErr(e.message, '发送失败');
    vs.response = {
      descriptor: { method: req.method, url: req.url },
      response: { ok: false, status: 0, error: { code: 'UNKNOWN', message: e.message } },
      unresolved: [],
    };
    renderResponse(tab);
  } finally {
    vs.sending = false;
    setSendButtonState(tabId, false);
  }
}

function setSendButtonState(tabId, sending) {
  const btn = qs(`.pane[data-tab="${tabId}"] [data-role="send"]`);
  if (!btn) return;
  btn.disabled = false;
  btn.innerHTML = sending
    ? '<span class="spinner"></span><span>发送中</span>'
    : '<span>发送</span>';
}

/* ==================================================================== *
 * 事件绑定
 * ==================================================================== */
export function initRequestEvents(delegator) {
  const root = delegator;

  /* ---------- 顶栏输入 ---------- */
  on(root, 'input', '[data-role="req-name"]', (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    updateRequest(tab.refId, { name: el.value }, { silent: true });
  });

  on(root, 'blur', '[data-role="req-name"]', (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    bus.emit('tabs');
    bus.emit('sidebar');
  }, true);

  on(root, 'input', '[data-role="url"]', (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    updateRequest(tab.refId, { url: el.value }, { silent: true });
    updateUrlPreview(tab.id);
  });

  on(root, 'keydown', '[data-role="url"]', (e, el) => {
    if (e.key === 'Enter' && state.workspace.settings.sendOnEnter) {
      e.preventDefault();
      const tab = tabOf(el);
      if (tab) sendFromTab(tab.id);
    }
  });

  on(root, 'change', '[data-role="method"]', (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    updateRequest(tab.refId, { method: el.value });
    el.style.color = methodColor(el.value);
  });

  on(root, 'click', '[data-role="send"]', (_e, el) => {
    const tab = tabOf(el);
    if (tab) sendFromTab(tab.id);
  });

  /* ---------- 子标签切换 ---------- */
  on(root, 'click', '[data-subtab]', (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    subtabState(tab.id).reqSubtab = el.dataset.subtab;
    renderRequestSubtabs(tab);
    renderRequestBody(tab);
  });

  on(root, 'click', '[data-resp-tab]', (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    subtabState(tab.id).respSubtab = el.dataset.respTab;
    renderResponseSubtabs(tab);
    renderResponse(tab);
  });

  /* ---------- 键值表 ---------- */
  bindKvEvents(root);

  /* ---------- Body ---------- */
  on(root, 'click', '[data-body-mode]', (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    const mode = el.dataset.bodyMode;
    const req = getRequest(tab.refId);
    const body = { ...(req.body || {}), mode };
    if (mode === 'form-urlencoded' || mode === 'form-data') {
      if (!Array.isArray(body.fields)) body.fields = [];
    }
    if (!body.content) body.content = '';
    updateRequest(tab.refId, { body }, { silent: true });
    renderRequestBody(tab);
    renderRequestSubtabs(tab);
  });

  on(root, 'input', '[data-body-content]', (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    const req = getRequest(tab.refId);
    updateRequest(tab.refId, { body: { ...req.body, content: el.value } }, { silent: true });
    const hint = el.closest('.subtab-body')?.querySelector('.field-hint:last-of-type');
    if (hint) hint.textContent = `${el.value.length} 字符`;
  });

  on(root, 'input', '[data-body-content-type]', (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    const req = getRequest(tab.refId);
    updateRequest(tab.refId, { body: { ...req.body, contentType: el.value } }, { silent: true });
  });

  on(root, 'click', '[data-act="format-body"]', (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    const req = getRequest(tab.refId);
    const ta = el.closest('.subtab-body').querySelector('[data-body-content]');
    try {
      const formatted = JSON.stringify(JSON.parse(ta.value), null, 2);
      ta.value = formatted;
      updateRequest(tab.refId, { body: { ...req.body, content: formatted } }, { silent: true });
    } catch (e) {
      toastErr('JSON 格式不合法，无法格式化：' + e.message);
    }
  });

  on(root, 'click', '[data-act="minify-body"]', (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    const req = getRequest(tab.refId);
    const ta = el.closest('.subtab-body').querySelector('[data-body-content]');
    try {
      const min = JSON.stringify(JSON.parse(ta.value));
      ta.value = min;
      updateRequest(tab.refId, { body: { ...req.body, content: min } }, { silent: true });
    } catch {
      toastErr('内容不是合法 JSON，无法压缩');
    }
  });

  on(root, 'click', '[data-act="pick-binary"]', async (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    const res = await bridge.dialog.open({ title: '选择请求体文件' });
    if (!res.ok) return;
    const req = getRequest(tab.refId);
    updateRequest(tab.refId, { body: { ...req.body, filePath: res.path } }, { silent: true });
    const label = el.closest('div').querySelector('[data-role="binary-path"]');
    if (label) label.textContent = res.path;
  });

  on(root, 'click', '[data-act="pick-file"]', async (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    const res = await bridge.dialog.open({ title: '选择上传文件' });
    if (!res.ok) return;
    const tr = el.closest('tr');
    const idx = Number(tr.dataset.idx);
    const req = getRequest(tab.refId);
    const fields = [...(req.body.fields || [])];
    if (fields[idx]) {
      fields[idx] = { ...fields[idx], type: 'file', filePath: res.path };
      updateRequest(tab.refId, { body: { ...req.body, fields } }, { silent: true });
      renderRequestBody(tab);
    }
  });

  /* ---------- Auth ---------- */
  on(root, 'click', '[data-auth-type]', (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    const req = getRequest(tab.refId);
    updateRequest(tab.refId, { auth: { ...(req.auth || {}), type: el.dataset.authType } }, { silent: true });
    renderRequestBody(tab);
    renderRequestSubtabs(tab);
  });

  on(root, 'input', '[data-auth]', (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    const req = getRequest(tab.refId);
    updateRequest(tab.refId, { auth: { ...(req.auth || {}), [el.dataset.auth]: el.value } }, { silent: true });
  });

  on(root, 'change', '[data-auth="in"]', (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    const req = getRequest(tab.refId);
    updateRequest(tab.refId, { auth: { ...(req.auth || {}), in: el.value } }, { silent: true });
  });

  /* ---------- 选项 ---------- */
  on(root, 'input', '[data-opt="timeout"]', (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    const req = getRequest(tab.refId);
    updateRequest(tab.refId, { options: { ...(req.options || {}), timeout: Number(el.value) || null } }, { silent: true });
  });

  on(root, 'change', '[data-opt="followRedirects"], [data-opt="verifyTls"]', (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    const req = getRequest(tab.refId);
    updateRequest(tab.refId, { options: { ...(req.options || {}), [el.dataset.opt]: el.checked } }, { silent: true });
  });

  /* ---------- 响应区操作 ---------- */
  initResponseActions(root);

  /* ---------- 配置区高度拖动 ---------- */
  initVSplitter(root);
}

function tabOf(el) {
  const pane = el.closest('.pane');
  if (!pane) return null;
  return state.tabs.find((t) => t.id === pane.dataset.tab) || null;
}

/* ---------------------------- 键值表事件 ---------------------------- */
function bindKvEvents(root) {
  const readRows = (tab) => {
    const req = getRequest(tab.refId);
    return req;
  };

  const syncRows = (tab, kind, rows, { silent = true } = {}) => {
    const req = getRequest(tab.refId);
    if (kind === 'params') updateRequest(tab.refId, { params: rows }, { silent });
    else if (kind === 'headers') updateRequest(tab.refId, { headers: rows }, { silent });
    else updateRequest(tab.refId, { body: { ...req.body, fields: rows } }, { silent });
  };

  on(root, 'input', '[data-kv] [data-kv-field="key"], [data-kv] [data-kv-field="value"], [data-kv] [data-kv-field="filePath"]', (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    const table = el.closest('[data-kv]');
    const kind = table.dataset.kv;
    const tr = el.closest('tr');
    const idx = Number(tr.dataset.idx);
    const field = el.dataset.kvField;
    const req = readRows(tab);

    let rows;
    if (kind === 'params') rows = [...(req.params || [])];
    else if (kind === 'headers') rows = [...(req.headers || [])];
    else rows = [...((req.body || {}).fields || [])];

    // 在末行（幽灵行）输入 → 追加新行
    if (idx >= rows.length) {
      rows.push({ key: '', value: '', enabled: true, type: 'text' });
      // 幽灵行变实体行：重新渲染一次以补齐删除按钮
      rows[idx][field] = el.value;
      syncRows(tab, kind, rows, { silent: true });
      renderRequestBody(tab);
      renderRequestSubtabs(tab);
      const pane = qs(`.pane[data-tab="${tab.id}"]`);
      const next = pane.querySelector(`[data-kv="${kind}"] tr[data-idx="${idx}"] [data-kv-field="${field}"]`);
      if (next) {
        next.focus();
        try { next.setSelectionRange(next.value.length, next.value.length); } catch { /* ignore */ }
      }
      return;
    }

    rows[idx] = { ...rows[idx], [field]: el.value };
    syncRows(tab, kind, rows, { silent: true });
    renderRequestSubtabs(tab);
    updateUrlPreview(tab.id);
  });

  on(root, 'change', '[data-kv] [data-kv-field="enabled"]', (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    const table = el.closest('[data-kv]');
    const kind = table.dataset.kv;
    const idx = Number(el.closest('tr').dataset.idx);
    const req = readRows(tab);
    let rows;
    if (kind === 'params') rows = [...(req.params || [])];
    else if (kind === 'headers') rows = [...(req.headers || [])];
    else rows = [...((req.body || {}).fields || [])];
    if (!rows[idx]) return;
    rows[idx] = { ...rows[idx], enabled: el.checked };
    syncRows(tab, kind, rows, { silent: true });
    renderRequestBody(tab);
    renderRequestSubtabs(tab);
  });

  on(root, 'change', '[data-kv] [data-kv-field="type"]', (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    const idx = Number(el.closest('tr').dataset.idx);
    const req = readRows(tab);
    const fields = [...((req.body || {}).fields || [])];
    if (!fields[idx]) return;
    fields[idx] = { ...fields[idx], type: el.value, value: '', filePath: '' };
    syncRows(tab, 'form-data', fields, { silent: true });
    renderRequestBody(tab);
  });

  on(root, 'click', '[data-kv-del]', (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    const table = el.closest('[data-kv]');
    const kind = table.dataset.kv;
    const idx = Number(el.closest('tr').dataset.idx);
    const req = readRows(tab);
    let rows;
    if (kind === 'params') rows = [...(req.params || [])];
    else if (kind === 'headers') rows = [...(req.headers || [])];
    else rows = [...((req.body || {}).fields || [])];
    rows.splice(idx, 1);
    syncRows(tab, kind, rows, { silent: true });
    renderRequestBody(tab);
    renderRequestSubtabs(tab);
    updateUrlPreview(tab.id);
  });

  /* 键名区右键：粘贴一整段 Header 文本 */
  on(root, 'contextmenu', '[data-kv="headers"] .kv-input', (e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    showContextMenu(e, [
      {
        label: '粘贴 Raw Headers',
        icon: '{ }',
        action: async () => {
          const text = await navigator.clipboard.readText().catch(() => '');
          if (!text) {
            toastErr('无法读取剪贴板，请检查系统权限');
            return;
          }
          applyRawHeaders(tab, text);
        },
      },
      {
        label: '复制全部 Header',
        icon: '⧉',
        action: async () => {
          const req = getRequest(tab.refId);
          const text = (req.headers || []).map((h) => `${h.key}: ${h.value}`).join('\n');
          await bridge.clipboard.write(text);
        },
      },
    ]);
  });

  on(root, 'contextmenu', '[data-kv="params"] .kv-input', (e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    showContextMenu(e, [
      {
        label: '粘贴查询字符串',
        icon: '{ }',
        action: async () => {
          const text = await navigator.clipboard.readText().catch(() => '');
          if (!text) return;
          const req = getRequest(tab.refId);
          const rows = [...(req.params || [])];
          for (const pair of text.replace(/^\?/, '').split('&')) {
            if (!pair) continue;
            const i = pair.indexOf('=');
            rows.push({
              key: decodeURIComponent(i < 0 ? pair : pair.slice(0, i)),
              value: decodeURIComponent(i < 0 ? '' : pair.slice(i + 1)),
              enabled: true,
            });
          }
          updateRequest(tab.refId, { params: rows }, { silent: true });
          renderRequestBody(tab);
          renderRequestSubtabs(tab);
        },
      },
    ]);
  });
}

function applyRawHeaders(tab, text) {
  const req = getRequest(tab.refId);
  const rows = [...(req.headers || [])].filter((h) => h.key);
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const i = trimmed.indexOf(':');
    if (i < 0) continue;
    rows.push({ key: trimmed.slice(0, i).trim(), value: trimmed.slice(i + 1).trim(), enabled: true });
  }
  updateRequest(tab.refId, { headers: rows }, { silent: true });
  renderRequestBody(tab);
  renderRequestSubtabs(tab);
}

/* ---------------------------- 响应区操作 ---------------------------- */
function initResponseActions(root) {
  on(root, 'click', '[data-resp-act]', async (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    const vs = subtabState(tab.id);
    const resp = vs.response && vs.response.response;
    if (!resp) return;
    const act = el.dataset.respAct;

    if (act === 'copy-body') {
      const text = resp.bodyText || '';
      await bridge.clipboard.write(text);
      return;
    }
    if (act === 'save-body') {
      const res = await bridge.dialog.save({
        title: '保存响应内容',
        defaultPath: `response-${Date.now()}.json`,
        content: resp.bodyText || '',
      });
      if (res.ok) bus.emit('toast', { type: 'success', message: '已保存到 ' + res.path });
      return;
    }
    if (act === 'copy-curl') {
      const req = getRequest(tab.refId);
      const resolved = vs.response.descriptor
        ? { url: vs.response.descriptor.url, headers: Object.fromEntries(vs.response.descriptor.headers || []), body: vs.response.descriptor.body }
        : null;
      await bridge.clipboard.write(toCurl(req, resolved));
      return;
    }
    if (act === 'open-url') {
      const url = resp.url || (vs.response.descriptor && vs.response.descriptor.url);
      if (url) bridge.shell.openExternal(url);
      return;
    }
    if (act === 'pretty') {
      vs.pretty = !vs.pretty;
      renderResponse(tab);
      return;
    }
    if (act === 'new-tab') {
      const req = getRequest(tab.refId);
      const copy = JSON.parse(JSON.stringify(req));
      copy.name = req.name + ' 副本';
      copy.id = undefined;
      bus.emit('action', { action: 'duplicate-to-new-tab', requestId: req.id });
    }
  });
}

/* ---------------------------- 上下拖动分隔 ---------------------------- */
function initVSplitter(root) {
  let dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    const pane = qs('.pane.active');
    if (!pane) return;
    const cfg = pane.querySelector('[data-role="config"]');
    const split = pane.querySelector('.request-split');
    if (!cfg || !split) return;
    const rect = split.getBoundingClientRect();
    const h = Math.max(90, Math.min(e.clientY - rect.top, rect.height - 110));
    cfg.style.maxHeight = h + 'px';
    cfg.style.height = h + 'px';
    cfg.style.flex = '0 0 auto';
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };

  on(root, 'mousedown', '[data-role="split-h"]', (e) => {
    dragging = true;
    document.body.style.cursor = 'row-resize';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
}
