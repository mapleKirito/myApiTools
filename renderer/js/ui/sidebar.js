/**
 * 侧栏：集合目录树 + 历史记录
 */

import { qs, on, html, raw } from './dom.js';
import { showContextMenu, promptDialog, confirmDialog, toast, toastOk, toastErr } from './feedback.js';
import {
  state,
  bus,
  childrenOfCollection,
  collections,
  requests,
  requestsUnder,
  createCollection,
  createRequest,
  updateCollection,
  updateRequest,
  removeCollection,
  removeRequest,
  duplicateRequest,
  moveRequest,
  moveCollection,
  openTab,
  pushHistory,
  clearHistory,
  getRequest,
  getCollection,
} from '../state.js';
import {
  methodColor,
  formatRelative,
  escapeHtml,
  statusColor,
  formatMs,
  formatBytes,
} from '../helpers.js';
import { sendOne } from '../runner.js';
import { toCurl } from '../importers.js';

const bridge = window.bridge;

let dragPayload = null;

/* ==================================================================== *
 * 渲染入口
 * ==================================================================== */
export function renderSidebar() {
  const root = qs('#sidebar-body');
  if (!root) return;
  if (state.sidebarTab === 'history') renderHistory(root);
  else renderTree(root);
}

/* ==================================================================== *
 * 目录树
 * ==================================================================== */
function renderTree(root) {
  const activeReqId = activeRequestId();
  if (!collections().length && !requests().length) {
    root.innerHTML = html`
      <div class="tree-empty">
        还没有任何请求<br />
        点击上方 <b>＋ 请求</b> 开始，<br />或从 cURL / Postman / OpenAPI 导入
      </div>`;
    return;
  }
  root.innerHTML = html`<div class="tree-root">${raw(renderLevel(null, activeReqId, 0))}</div>`;
}

function activeRequestId() {
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  return tab && tab.type === 'request' ? tab.refId : null;
}

function renderLevel(parentId, activeReqId, depth) {
  const { collections: cols, requests: reqs } = childrenOfCollection(parentId);
  const rows = [];
  for (const c of cols) rows.push(renderFolder(c, activeReqId, depth));
  for (const r of reqs) rows.push(renderRequestRow(r, activeReqId));
  return rows.join('');
}

function renderFolder(col, activeReqId, depth) {
  const open = state.expanded.has(col.id);
  const { collections: sub, requests: subReq } = childrenOfCollection(col.id);
  const total = requestsUnder(col.id).length;
  return `
    <div class="tree-node" data-col="${escapeHtml(col.id)}">
      <div class="tree-row" data-col="${escapeHtml(col.id)}" draggable="true" title="${escapeHtml(col.name)}">
        <span class="tree-arrow ${open ? 'open' : ''}">▶</span>
        <span class="tree-icon">${open ? '📂' : '📁'}</span>
        <span class="tree-name">${escapeHtml(col.name)}</span>
        <span class="tree-count">${total || ''}</span>
      </div>
      ${open
        ? `<div class="tree-children">${renderLevel(col.id, activeReqId, depth + 1)}</div>`
        : ''}
    </div>`;
}

function renderRequestRow(r, activeReqId) {
  const selected = r.id === activeReqId;
  return `
    <div class="tree-node" data-req="${escapeHtml(r.id)}">
      <div class="tree-row ${selected ? 'selected' : ''}" data-req="${escapeHtml(r.id)}" draggable="true" title="${escapeHtml(r.name)}">
        <span class="tree-arrow leaf">▶</span>
        <span class="method-tag" style="color:${methodColor(r.method)}">${escapeHtml(r.method)}</span>
        <span class="tree-name">${escapeHtml(r.name)}</span>
      </div>
    </div>`;
}

/* ==================================================================== *
 * 历史
 * ==================================================================== */
function renderHistory(root) {
  const list = state.workspace.history || [];
  if (!list.length) {
    root.innerHTML = html`
      <div class="tree-empty">
        暂无历史记录<br />每次发送请求都会记录在这里（仅本地）
      </div>`;
    return;
  }
  root.innerHTML = html`
    <div class="sidebar-section-head">
      <span>最近 ${list.length} 条</span>
      <button class="mini-btn ghost" data-act="clear-history" type="button">清空</button>
    </div>
    ${raw(list.slice(0, 300).map(renderHistoryRow).join(''))}
  `;
}

function renderHistoryRow(h) {
  const color = h.ok ? statusColor(h.status) : '#f87171';
  return `
    <div class="history-item" data-hist="${escapeHtml(h.id)}" title="${escapeHtml(h.url)}">
      <span class="method-tag" style="color:${methodColor(h.method)}">${escapeHtml(h.method)}</span>
      <div class="h-main">
        <div class="h-url">${escapeHtml(h.url)}</div>
        <div class="h-sub">
          <span>${escapeHtml(h.name || '未命名')}</span>
          <span>${escapeHtml(formatRelative(h.at))}</span>
          <span>${escapeHtml(formatMs(h.duration))}</span>
          <span>${escapeHtml(formatBytes(h.size))}</span>
        </div>
      </div>
      <span class="history-status" style="color:${color}">${h.status || 'ERR'}</span>
    </div>`;
}

/* ==================================================================== *
 * 事件绑定（只绑一次，用委托）
 * ==================================================================== */
export function initSidebar() {
  const root = qs('#sidebar-body');

  /* ---- 点击 ---- */
  on(root, 'click', '[data-act="clear-history"]', async () => {
    if (await confirmDialog({ title: '清空历史', message: '将删除本地全部请求历史记录，此操作不可撤销。', confirmText: '清空', danger: true })) {
      clearHistory();
      toastOk('历史记录已清空');
    }
  });

  on(root, 'click', '.history-item', (_e, el) => {
    const h = (state.workspace.history || []).find((x) => x.id === el.dataset.hist);
    if (!h) return;
    restoreFromHistory(h);
  });

  on(root, 'click', '.tree-row[data-col]', (_e, el) => {
    const id = el.dataset.col;
    if (state.expanded.has(id)) state.expanded.delete(id);
    else state.expanded.add(id);
    renderSidebar();
  });

  on(root, 'click', '.tree-row[data-req]', (_e, el) => {
    openTab({ type: 'request', refId: el.dataset.req });
  });

  /* ---- 双击重命名 ---- */
  on(root, 'dblclick', '.tree-row', (_e, el) => renameByRow(el));

  /* ---- 右键 ---- */
  on(root, 'contextmenu', '.tree-row[data-col]', (e, el) => {
    const col = getCollection(el.dataset.col);
    if (col) folderMenu(e, col);
  });
  on(root, 'contextmenu', '.tree-row[data-req]', (e, el) => {
    const req = getRequest(el.dataset.req);
    if (req) requestMenu(e, req);
  });
  on(root, 'contextmenu', '.tree-root, .tree-empty', (e) => {
    if (e.target.closest('.tree-row')) return;
    blankMenu(e);
  });

  /* ---- 拖拽 ---- */
  on(root, 'dragstart', '.tree-row', (e, el) => {
    const isFolder = !!el.dataset.col;
    dragPayload = isFolder ? { type: 'collection', id: el.dataset.col } : { type: 'request', id: el.dataset.req };
    el.classList.add('dragging');
    try {
      e.dataTransfer.setData('text/plain', dragPayload.id);
      e.dataTransfer.effectAllowed = 'move';
    } catch { /* ignore */ }
  });

  on(root, 'dragend', '.tree-row', (_e, el) => {
    el.classList.remove('dragging');
    dragPayload = null;
    [...root.querySelectorAll('.drag-over')].forEach((n) => n.classList.remove('drag-over'));
  });

  on(root, 'dragover', '.tree-row', (e, el) => {
    if (!dragPayload) return;
    e.preventDefault();
    if (wouldCycle(dragPayload, el)) return;
    el.classList.add('drag-over');
  });

  on(root, 'dragleave', '.tree-row', (_e, el) => el.classList.remove('drag-over'));

  on(root, 'drop', '.tree-row', (e, el) => {
    e.preventDefault();
    el.classList.remove('drag-over');
    if (!dragPayload) return;
    performDrop(dragPayload, el);
    dragPayload = null;
  });

  // 拖到空白处 = 移到根
  on(root, 'dragover', '.tree-root', (e) => {
    if (!dragPayload) return;
    e.preventDefault();
  });
  on(root, 'drop', '.tree-root', (e) => {
    if (e.target.closest('.tree-row')) return;
    e.preventDefault();
    if (!dragPayload) return;
    if (dragPayload.type === 'collection') moveCollection(dragPayload.id, null, null);
    else moveRequest(dragPayload.id, null, null);
    dragPayload = null;
  });

  /* ---- 右键/拖放 期间屏蔽浏览器默认菜单 ---- */
  root.addEventListener('contextmenu', (e) => e.preventDefault());
}

function wouldCycle(payload, targetEl) {
  if (payload.type !== 'collection') return false;
  const targetId = targetEl.dataset.col;
  if (!targetId) return false;
  if (targetId === payload.id) return true;
  // 目标是否是 payload 的后代
  let cur = getCollection(targetId);
  while (cur) {
    if (cur.parentId === payload.id) return true;
    cur = cur.parentId ? getCollection(cur.parentId) : null;
  }
  return false;
}

function performDrop(payload, targetEl) {
  const targetColId = targetEl.dataset.col;
  const targetReqId = targetEl.dataset.req;

  // 拖到请求行上 → 视作放进该请求所在文件夹，插到它前面
  if (targetReqId) {
    const target = getRequest(targetReqId);
    if (!target) return;
    if (payload.type === 'request') {
      if (payload.id === targetReqId) return;
      moveRequest(payload.id, target.collectionId, targetReqId);
    } else {
      moveCollection(payload.id, target.collectionId, null);
    }
    renderSidebar();
    return;
  }

  // 拖到文件夹行上 → 放进该文件夹
  if (targetColId) {
    if (payload.type === 'collection') {
      if (payload.id === targetColId) return;
      moveCollection(payload.id, targetColId, null);
    } else {
      moveRequest(payload.id, targetColId, null);
    }
    state.expanded.add(targetColId);
    renderSidebar();
  }
}

/* ==================================================================== *
 * 右键菜单
 * ==================================================================== */
function blankMenu(e) {
  showContextMenu(e, [
    { label: '新建请求', icon: '＋', shortcut: 'Ctrl+N', action: () => quickNewRequest(null) },
    { label: '新建文件夹', icon: '📁', action: () => { createCollection(null); } },
    { separator: true },
    { label: '导入配置…', icon: '⭳', shortcut: 'Ctrl+I', action: () => bus.emit('action', { action: 'import' }) },
  ]);
}

function folderMenu(e, col) {
  showContextMenu(e, [
    { label: '新建请求', icon: '＋', action: () => quickNewRequest(col.id) },
    { label: '新建子文件夹', icon: '📁', action: () => { createCollection(col.id); state.expanded.add(col.id); renderSidebar(); } },
    { separator: true },
    {
      label: '批量执行此文件夹',
      icon: '▶',
      action: () => bus.emit('action', { action: 'run-folder', collectionId: col.id }),
    },
    { separator: true },
    { label: '重命名', icon: '✎', action: () => renameFolder(col) },
    {
      label: '复制名称',
      icon: '⧉',
      action: async () => {
        await bridge.clipboard.write(col.name);
        toastOk('已复制到剪贴板');
      },
    },
    { separator: true },
    { label: '删除文件夹', icon: '🗑', danger: true, action: () => deleteFolder(col) },
  ]);
}

function requestMenu(e, req) {
  showContextMenu(e, [
    { label: '打开', icon: '↗', action: () => openTab({ type: 'request', refId: req.id }) },
    { label: '发送', icon: '▶', shortcut: 'Ctrl+Enter', action: () => bus.emit('action', { action: 'send-request', requestId: req.id }) },
    { separator: true },
    { label: '重命名', icon: '✎', action: () => renameRequest(req) },
    { label: '创建副本', icon: '⧉', action: () => { duplicateRequest(req.id); renderSidebar(); } },
    {
      label: '复制为 cURL',
      icon: '⧉',
      action: async () => {
        await bridge.clipboard.write(toCurl(req));
        toastOk('cURL 命令已复制到剪贴板');
      },
    },
    { separator: true },
    {
      label: '单独批量执行',
      icon: '▶',
      action: () => bus.emit('action', { action: 'run-requests', requestIds: [req.id] }),
    },
    { separator: true },
    { label: '删除请求', icon: '🗑', danger: true, action: () => deleteRequest(req) },
  ]);
}

/* ==================================================================== *
 * 操作实现
 * ==================================================================== */
async function quickNewRequest(collectionId) {
  const req = createRequest(collectionId);
  openTab({ type: 'request', refId: req.id });
  bus.emit('action', { action: 'focus-url', requestId: req.id });
}

async function renameByRow(el) {
  if (el.dataset.col) {
    const col = getCollection(el.dataset.col);
    if (col) await renameFolder(col);
  } else if (el.dataset.req) {
    const req = getRequest(el.dataset.req);
    if (req) await renameRequest(req);
  }
}

async function renameFolder(col) {
  const name = await promptDialog({ title: '重命名文件夹', value: col.name, okText: '保存' });
  if (name == null || !name.trim()) return;
  updateCollection(col.id, { name: name.trim() });
  renderSidebar();
}

async function renameRequest(req) {
  const name = await promptDialog({ title: '重命名请求', value: req.name, okText: '保存' });
  if (name == null || !name.trim()) return;
  updateRequest(req.id, { name: name.trim() });
  bus.emit('tabs');
  renderSidebar();
}

async function deleteFolder(col) {
  const total = requestsUnder(col.id).length;
  const msg = total
    ? `将删除文件夹「${col.name}」及其中的 ${total} 个请求。\n删除会同步到其它设备。`
    : `将删除空文件夹「${col.name}」。`;
  if (!await confirmDialog({ title: '删除文件夹', message: msg, confirmText: '删除', danger: true })) return;
  removeCollection(col.id);
  renderSidebar();
  bus.emit('tabs');
  toastOk('已删除');
}

async function deleteRequest(req) {
  if (!await confirmDialog({
    title: '删除请求',
    message: `将删除「${req.name}」。删除会同步到其它设备。`,
    confirmText: '删除',
    danger: true,
  })) return;
  removeRequest(req.id);
  renderSidebar();
  bus.emit('tabs');
  toastOk('已删除');
}

/** 从历史记录恢复出一条新请求 */
function restoreFromHistory(h) {
  const snap = h.requestSnapshot || {};
  const req = createRequest(null, {
    name: `${h.name || '历史'} (恢复)`,
    method: snap.method || h.method,
    url: snap.url || h.url,
    params: snap.params || [],
    headers: snap.headers || [],
    body: snap.body || { mode: 'none', content: '', fields: [], contentType: '' },
    auth: snap.auth || { type: 'none' },
    options: snap.options || { timeout: null, followRedirects: true, verifyTls: true },
  });
  openTab({ type: 'request', refId: req.id });
  renderSidebar();
  toastOk('已从历史恢复为新的请求');
}

/* ==================================================================== *
 * 搜索
 * ==================================================================== */
export function searchRequests(keyword) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return [];
  const out = [];
  const walk = (cid, prefix) => {
    const { collections: sub, requests: rs } = childrenOfCollection(cid);
    for (const r of rs) {
      const hay = `${r.name} ${r.method} ${r.url}`.toLowerCase();
      if (hay.includes(kw)) out.push({ request: r, path: prefix });
    }
    for (const s of sub) walk(s.id, [...prefix, s.name]);
  };
  walk(null, []);
  return out.slice(0, 60);
}
