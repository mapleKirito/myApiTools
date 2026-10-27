/**
 * 环境与变量管理面板
 */

import { qs, on, html, raw } from './dom.js';
import { showContextMenu, promptDialog, confirmDialog, toastOk } from './feedback.js';
import {
  state,
  bus,
  environments,
  createEnvironment,
  updateEnvironment,
  removeEnvironment,
  setActiveEnv,
  getEnvironment,
  setGlobals,
} from '../state.js';
import { escapeHtml } from '../helpers.js';
import { DYNAMIC_NAMES } from '../vars.js';

const GLOBALS_ID = '__globals__';

function currentId(tabId) {
  const vs = state.envPanelId;
  if (vs === GLOBALS_ID) return GLOBALS_ID;
  if (vs && getEnvironment(vs)) return vs;
  const active = state.workspace.settings.activeEnvId;
  if (active && getEnvironment(active)) return active;
  const first = environments()[0];
  return first ? first.id : GLOBALS_ID;
}

export function renderEnvPane(tab) {
  return `
    <div class="env-layout">
      <div class="env-list" data-role="env-list"></div>
      <div class="env-detail" data-role="env-detail"></div>
    </div>`;
}

export function renderEnvContent(tab) {
  const pane = qs(`.pane[data-tab="${tab.id}"]`);
  if (!pane) return;
  const listHost = pane.querySelector('[data-role="env-list"]');
  const detailHost = pane.querySelector('[data-role="env-detail"]');
  if (!listHost || !detailHost) return;

  // 关键：把「当前正在编辑哪个环境」落到 state，否则首次进入时
  // state.envPanelId 为空，变量改动会写不进任何环境
  const resolvedId = currentId(tab.id);
  state.envPanelId = resolvedId;

  const activeId = state.workspace.settings.activeEnvId;
  const envs = environments();

  listHost.innerHTML = `
    <div class="sidebar-section-head"><span>环境（${envs.length}）</span>
      <button class="mini-btn" data-env-new type="button">＋ 新建</button></div>
    ${envs
      .map(
        (e) => `
      <div class="env-item ${e.id === currentId(tab.id) ? 'active' : ''}" data-env="${escapeHtml(e.id)}">
        <span class="env-name">${escapeHtml(e.name)}</span>
        ${e.id === activeId ? '<span class="active-badge">当前</span>' : ''}
      </div>`
      )
      .join('')}
    <div class="sidebar-section-head" style="margin-top:10px"><span>其它</span></div>
    <div class="env-item ${currentId(tab.id) === GLOBALS_ID ? 'active' : ''}" data-env="${GLOBALS_ID}">
      <span class="env-name">全局变量</span>
    </div>
    <div class="env-item" data-env-help="1" style="cursor:default">
      <span class="env-name text-dim" style="font-size:11.5px">变量优先级：全局 &lt; 环境</span>
    </div>
    <div style="padding:14px 12px">
      <div class="field-hint" style="line-height:2">
        内置动态变量：<br/>
        ${DYNAMIC_NAMES.slice(0, 8).map((n) => `<span class="mono">${escapeHtml(n)}</span>`).join(' ')}
      </div>
    </div>
  `;

  const id = currentId(tab.id);
  if (id === GLOBALS_ID) {
    detailHost.innerHTML = `
      <div class="env-detail-head">
        <strong>全局变量</strong>
        <span class="field-hint">所有环境共享</span>
        <span class="spacer"></span>
      </div>
      <div class="env-detail-body">
        ${varTable('globals', state.workspace.globals || [])}
      </div>`;
  } else {
    const env = getEnvironment(id);
    if (!env) {
      detailHost.innerHTML = '<div class="placeholder">请选择左侧的环境，或新建一个</div>';
      return;
    }
    const isActive = activeId === env.id;
    detailHost.innerHTML = `
      <div class="env-detail-head">
        <input type="text" data-env-name value="${escapeHtml(env.name)}"
          style="height:28px;padding:0 9px;background:var(--bg-2);border:1px solid var(--border);border-radius:6px;outline:none;width:220px" />
        <span class="spacer"></span>
        ${isActive
          ? '<span class="badge-pill ok">当前使用中</span>'
          : '<button class="btn primary" data-env-activate type="button">设为当前环境</button>'}
        <button class="btn danger" data-env-delete type="button">删除</button>
      </div>
      <div class="env-detail-body">
        ${varTable('env', env.variables || [])}
      </div>`;
  }
}

function varTable(kind, rows) {
  const body = rows
    .map(
      (v, i) => `
    <tr data-idx="${i}">
      <td class="kv-check"><input type="checkbox" class="checkbox" data-var-field="enabled" ${v.enabled === false ? '' : 'checked'} /></td>
      <td><input class="kv-input key-input" data-var-field="key" value="${escapeHtml(v.key || '')}" placeholder="变量名" spellcheck="false" /></td>
      <td><input class="kv-input" type="${v.secret ? 'password' : 'text'}" data-var-field="value" value="${escapeHtml(v.value ?? '')}" placeholder="变量值" spellcheck="false" /></td>
      <td class="kv-del"><button class="row-icon-btn" data-var-secret type="button" title="${v.secret ? '取消保密' : '标记为保密'}">${v.secret ? '🔒' : '🔓'}</button></td>
      <td class="kv-del">${rows.length ? '<button class="row-icon-btn" data-var-del type="button" title="删除">✕</button>' : ''}</td>
    </tr>`
    )
    .join('');

  const ghost = `
    <tr data-idx="${rows.length}">
      <td class="kv-check"><input type="checkbox" class="checkbox" data-var-field="enabled" checked /></td>
      <td><input class="kv-input key-input" data-var-field="key" placeholder="变量名（输入后自动新增）" spellcheck="false" /></td>
      <td><input class="kv-input" data-var-field="value" placeholder="变量值，可引用其它变量" spellcheck="false" /></td>
      <td class="kv-del"></td><td class="kv-del"></td>
    </tr>`;

  return `
    <table class="kv-table" data-var-table="${kind}">
      <thead><tr>
        <th class="kv-check"></th><th>变量名</th><th>值</th><th class="kv-del"></th><th class="kv-del"></th>
      </tr></thead>
      <tbody>${body}${ghost}</tbody>
    </table>
    <div class="field-hint" style="padding:10px 8px">
      在请求里用 <span class="mono">{{变量名}}</span> 引用。标记为保密的值在界面默认打码，但仍会参与同步。
    </div>`;
}

/* ==================================================================== *
 * 事件
 * ==================================================================== */
function tabOf(el) {
  const pane = el.closest('.pane');
  return pane ? state.tabs.find((t) => t.id === pane.dataset.tab) : null;
}

function rowsOf(kind) {
  return kind === 'globals' ? [...(state.workspace.globals || [])] : [...((getEnvironment(state.envPanelId) || {}).variables || [])];
}

function saveRows(kind, rows, tab) {
  if (kind === 'globals') {
    setGlobals(rows);
  } else {
    updateEnvironment(state.envPanelId, { variables: rows }, { silent: true });
  }
}

function readTableContext(el) {
  if (!el) return null;
  const table = el.closest('[data-var-table]');
  if (!table) return null;
  const tr = el.closest('tr');
  return { kind: table.dataset.varTable, table, idx: tr ? Number(tr.dataset.idx) : -1 };
}

export function initEnvEvents(root) {
  on(root, 'click', '[data-env]', (_e, el) => {
    const id = el.dataset.env;
    if (id === '__globals__') state.envPanelId = GLOBALS_ID;
    else state.envPanelId = id;
    const tab = tabOf(el);
    if (tab) renderEnvContent(tab);
  });

  on(root, 'click', '[data-env-new]', async (_e, el) => {
    const name = await promptDialog({ title: '新建环境', label: '环境名称', value: '新环境', placeholder: '如：开发环境 / 测试环境 / 生产环境' });
    if (name == null || !name.trim()) return;
    const env = createEnvironment(name.trim());
    state.envPanelId = env.id;
    const tab = tabOf(el);
    if (tab) renderEnvContent(tab);
    bus.emit('change');
  });

  on(root, 'input', '[data-env-name]', (_e, el) => {
    if (state.envPanelId === GLOBALS_ID) return;
    updateEnvironment(state.envPanelId, { name: el.value }, { silent: true });
  });

  on(root, 'blur', '[data-env-name]', (_e, el) => {
    bus.emit('env-change');
    bus.emit('sidebar');
  }, true);

  on(root, 'click', '[data-env-activate]', () => {
    setActiveEnv(state.envPanelId);
    const pane = qs('.pane.active');
    const tab = state.tabs.find((t) => t.id === (pane && pane.dataset.tab));
    if (tab) renderEnvContent(tab);
    toastOk('已切换当前环境');
  });

  on(root, 'click', '[data-env-delete]', async (_e, el) => {
    const env = getEnvironment(state.envPanelId);
    if (!env) return;
    if (!await confirmDialog({
      title: '删除环境',
      message: `将删除环境「${env.name}」及其中的全部变量。删除会同步到其它设备。`,
      confirmText: '删除',
      danger: true,
    })) return;
    removeEnvironment(env.id);
    state.envPanelId = null;
    const tab = tabOf(el);
    if (tab) renderEnvContent(tab);
    bus.emit('change');
  });

  /* ---------- 变量表 ---------- */
  on(root, 'input', '[data-var-table] [data-var-field="key"], [data-var-table] [data-var-field="value"]', (_e, el) => {
    const ctx = readTableContext(el);
    if (!ctx) return;
    const rows = rowsOf(ctx.kind);
    const field = el.dataset.varField;

    if (ctx.idx >= rows.length) {
      rows.push({ key: '', value: '', enabled: true, secret: false });
      rows[ctx.idx][field] = el.value;
      saveRows(ctx.kind, rows);
      const tab = tabOf(el);
      if (tab) renderEnvContent(tab);
      const next = qs('.pane.active').querySelector(
        `[data-var-table="${ctx.kind}"] tr[data-idx="${ctx.idx}"] [data-var-field="${field}"]`
      );
      if (next) {
        next.focus();
        try { next.setSelectionRange(next.value.length, next.value.length); } catch { /* ignore */ }
      }
      return;
    }

    rows[ctx.idx] = { ...rows[ctx.idx], [field]: el.value };
    saveRows(ctx.kind, rows);
  });

  on(root, 'change', '[data-var-table] [data-var-field="enabled"]', (_e, el) => {
    const ctx = readTableContext(el);
    if (!ctx) return;
    const rows = rowsOf(ctx.kind);
    if (!rows[ctx.idx]) return;
    rows[ctx.idx] = { ...rows[ctx.idx], enabled: el.checked };
    saveRows(ctx.kind, rows);
  });

  on(root, 'click', '[data-var-secret]', (_e, el) => {
    const ctx = readTableContext(el);
    if (!ctx) return;
    const rows = rowsOf(ctx.kind);
    if (!rows[ctx.idx]) return;
    rows[ctx.idx] = { ...rows[ctx.idx], secret: !rows[ctx.idx].secret };
    saveRows(ctx.kind, rows);
    const tab = tabOf(el);
    if (tab) renderEnvContent(tab);
  });

  on(root, 'click', '[data-var-del]', (_e, el) => {
    const ctx = readTableContext(el);
    if (!ctx) return;
    const rows = rowsOf(ctx.kind);
    rows.splice(ctx.idx, 1);
    saveRows(ctx.kind, rows);
    const tab = tabOf(el);
    if (tab) renderEnvContent(tab);
  });

  on(root, 'contextmenu', '[data-var-table]', (e, el) => {
    const ctx = readTableContext(el.closest('tr') || el);
    if (!ctx) return;
    showContextMenu(e, [
      {
        label: '粘贴 .env 文本',
        icon: '{ }',
        action: async () => {
          const text = await navigator.clipboard.readText().catch(() => '');
          if (!text) return;
          const rows = rowsOf(ctx.kind);
          for (const line of String(text).split(/\r?\n/)) {
            const t = line.trim();
            if (!t || t.startsWith('#')) continue;
            const i = t.indexOf('=');
            if (i < 0) continue;
            const key = t.slice(0, i).replace(/^export\s+/, '').trim();
            let value = t.slice(i + 1).trim();
            if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
            const exist = rows.findIndex((r) => r.key === key);
            if (exist >= 0) rows[exist] = { ...rows[exist], value };
            else rows.push({ key, value, enabled: true, secret: /pass|secret|token|key/i.test(key) });
          }
          saveRows(ctx.kind, rows);
          const tab = tabOf(el);
          if (tab) renderEnvContent(tab);
          toastOk('已导入变量');
        },
      },
      {
        label: '复制全部变量（.env 格式）',
        icon: '⧉',
        action: async () => {
          const text = rowsOf(ctx.kind)
            .filter((r) => r.key)
            .map((r) => `${r.key}=${r.value ?? ''}`)
            .join('\n');
          const bridge = window.bridge;
          await bridge.clipboard.write(text);
          toastOk('已复制');
        },
      },
    ]);
  });
}

export { GLOBALS_ID };
