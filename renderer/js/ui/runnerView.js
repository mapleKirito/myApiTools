/**
 * 批量执行面板
 */

import { qs, on, html, raw } from './dom.js';
import { toastOk, toastErr, toastWarn, openModal } from './feedback.js';
import {
  state,
  bus,
  collections,
  requests,
  requestsUnder,
  allRequestsWithPath,
  childrenOfCollection,
} from '../state.js';
import { escapeHtml, methodColor, formatMs, formatBytes, statusColor, highlightByType, prettyMaybe } from '../helpers.js';
import { runBatch, resultsToCsv, summarizeResults, cancelToken, resetCancel } from '../runner.js';

const bridge = window.bridge;

/** 运行器状态（每个标签页一份） */
const runnerStates = new Map();

export function getRunnerState(tabId) {
  if (!runnerStates.has(tabId)) {
    runnerStates.set(tabId, {
      scope: 'all',
      folderId: null,
      concurrency: state.workspace.settings.concurrency || 5,
      stopOnError: false,
      manualIds: new Set(),
      running: false,
      results: [],
      progress: { done: 0, total: 0 },
      filter: 'all',
    });
  }
  return runnerStates.get(tabId);
}

export function dropRunnerState(tabId) {
  runnerStates.delete(tabId);
}

export function renderRunnerPane(tab) {
  return `
    <div class="runner">
      <div class="runner-toolbar" data-role="runner-toolbar"></div>
      <div class="runner-summary" data-role="runner-summary"></div>
      <div class="runner-results" data-role="runner-results"></div>
    </div>`;
}

export function renderRunnerContent(tab) {
  const pane = qs(`.pane[data-tab="${tab.id}"]`);
  if (!pane) return;
  const rs = getRunnerState(tab.id);

  renderToolbar(pane, tab, rs);
  renderSummary(pane, tab, rs);
  renderResults(pane, tab, rs);
}

/* ---------------------------- 工具栏 ---------------------------- */
function renderToolbar(pane, tab, rs) {
  const host = pane.querySelector('[data-role="runner-toolbar"]');
  const cols = collections();
  const folderOptions = [
    `<option value="">全部请求</option>`,
    ...cols.map((c) => `<option value="${escapeHtml(c.id)}" ${rs.folderId === c.id ? 'selected' : ''}>📁 ${escapeHtml(folderPathName(c.id))}</option>`),
  ].join('');

  host.innerHTML = html`
    <div class="field">
      <span>执行范围</span>
      <select data-runner="scope">
        <option value="all" ${rs.scope === 'all' ? 'selected' : ''}>全部请求</option>
        <option value="folder" ${rs.scope === 'folder' ? 'selected' : ''}>指定文件夹</option>
        <option value="manual" ${rs.scope === 'manual' ? 'selected' : ''}>手动选择</option>
      </select>
    </div>
    ${rs.scope === 'folder' ? raw(`<div class="field"><select data-runner="folder">${folderOptions}</select></div>`) : ''}
    <div class="field">
      <span>并发</span>
      <input type="number" data-runner="concurrency" value="${rs.concurrency}" min="1" max="20" style="width:62px" />
    </div>
    <div class="field">
      <label class="switch"><input type="checkbox" data-runner="stopOnError" ${rs.stopOnError ? 'checked' : ''} /><span>失败即停</span></label>
    </div>
    <span class="grow"></span>
    <button class="btn ${rs.running ? 'danger' : 'primary'}" data-runner="${rs.running ? 'abort' : 'start'}" type="button">
      ${rs.running ? '⏹ 中止' : '▶ 开始执行'}
    </button>
  `;

  if (rs.scope === 'manual') {
    const all = allRequestsWithPath();
    const listHtml = all.length
      ? all
          .map(
            ({ request: r, path }) => `
        <div class="env-item" data-manual="${escapeHtml(r.id)}" style="padding:5px 12px">
          <input type="checkbox" class="checkbox" data-manual-check ${rs.manualIds.has(r.id) ? 'checked' : ''} />
          <span class="method-tag" style="color:${methodColor(r.method)}">${escapeHtml(r.method)}</span>
          <span class="env-name">${escapeHtml(r.name)}</span>
          <span class="text-dim" style="font-size:11px">${escapeHtml(path.join(' / '))}</span>
        </div>`
          )
          .join('')
      : '<div class="tree-empty">还没有任何请求</div>';

    const box = document.createElement('div');
    box.style.cssText = 'flex-basis:100%;max-height:190px;overflow:auto;background:var(--bg);border:1px solid var(--border);border-radius:6px;margin-top:4px';
    box.innerHTML = listHtml;
    host.appendChild(box);
  }
}

function folderPathName(id) {
  const parts = [];
  let cur = collections().find((c) => c.id === id);
  while (cur) {
    parts.unshift(cur.name);
    cur = cur.parentId ? collections().find((c) => c.id === cur.parentId) : null;
  }
  return parts.join(' / ') || '未命名';
}

/* ---------------------------- 汇总 ---------------------------- */
function renderSummary(pane, tab, rs) {
  const host = pane.querySelector('[data-role="runner-summary"]');
  const s = summarizeResults(rs.results);
  const pct = rs.progress.total ? Math.round((rs.progress.done / rs.progress.total) * 100) : 0;

  if (!rs.results.length && !rs.running) {
    host.innerHTML = html`<span class="text-dim">选择范围后点击「开始执行」。请求会在本机逐条发送，不经过任何中转服务。</span>`;
    return;
  }

  host.innerHTML = html`
    <div class="stat"><span class="k">总数</span><span class="v">${s.total}</span></div>
    <div class="stat"><span class="k">成功</span><span class="v text-ok">${s.success}</span></div>
    <div class="stat"><span class="k">失败</span><span class="v ${s.failed ? 'text-err' : ''}">${s.failed}</span></div>
    <div class="stat"><span class="k">平均</span><span class="v">${raw(escapeHtml(formatMs(s.avg)))}</span></div>
    <div class="stat"><span class="k">P95</span><span class="v">${raw(escapeHtml(formatMs(s.p95)))}</span></div>
    <div class="stat"><span class="k">最慢</span><span class="v">${raw(escapeHtml(formatMs(s.max)))}</span></div>
    <div class="progress-track"><div class="progress-bar" style="width:${pct}%"></div></div>
    <span class="text-dim">${rs.progress.done} / ${rs.progress.total}</span>
    <span class="grow"></span>
    <div class="field">
      <select data-runner="filter">
        <option value="all" ${rs.filter === 'all' ? 'selected' : ''}>全部结果</option>
        <option value="failed" ${rs.filter === 'failed' ? 'selected' : ''}>仅失败</option>
        <option value="ok" ${rs.filter === 'ok' ? 'selected' : ''}>仅成功</option>
      </select>
    </div>
    <button class="toolbar-btn" data-runner="export-csv" type="button" ${s.total ? '' : 'disabled'}>导出 CSV</button>
    <button class="toolbar-btn" data-runner="export-json" type="button" ${s.total ? '' : 'disabled'}>导出 JSON</button>
    <button class="toolbar-btn" data-runner="clear" type="button" ${s.total ? '' : 'disabled'}>清空</button>
  `;
}

/* ---------------------------- 结果表 ---------------------------- */
function renderResults(pane, tab, rs) {
  const host = pane.querySelector('[data-role="runner-results"]');
  let list = rs.results;
  if (rs.filter === 'failed') list = list.filter((r) => !r.ok);
  if (rs.filter === 'ok') list = list.filter((r) => r.ok);

  if (!list.length) {
    host.innerHTML = `<div class="placeholder">${rs.results.length ? '当前筛选下没有结果' : '尚无执行结果'}</div>`;
    return;
  }

  host.innerHTML = `
    <table class="results-table">
      <thead><tr>
        <th style="width:44px">#</th>
        <th style="width:66px">方法</th>
        <th>名称</th>
        <th style="width:70px">状态</th>
        <th style="width:86px">耗时</th>
        <th style="width:82px">大小</th>
        <th style="width:70px">结果</th>
      </tr></thead>
      <tbody>
        ${list
          .map(
            (r) => `
          <tr class="${r.ok ? '' : 'failed'}" data-result="${escapeHtml(r.requestId)}" data-index="${r.index}">
            <td class="mono text-dim">${r.index + 1}</td>
            <td><span class="mono" style="color:${methodColor(r.method)};font-weight:700;font-size:11px">${escapeHtml(r.method)}</span></td>
            <td class="name-cell" title="${escapeHtml(r.url)}">
              ${escapeHtml(r.name)}
              <div class="url-cell">${escapeHtml(r.url)}</div>
            </td>
            <td class="mono" style="color:${r.ok ? statusColor(r.status) : 'var(--danger)'};font-weight:700">${r.status || 'ERR'}</td>
            <td class="mono">${escapeHtml(formatMs(r.duration))}</td>
            <td class="mono">${escapeHtml(formatBytes(r.size))}</td>
            <td>${r.ok ? '<span class="text-ok">✓ 通过</span>' : '<span class="text-err">✕ 失败</span>'}</td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>`;
}

/* ---------------------------- 收集待执行请求 ---------------------------- */
function collectItems(rs) {
  if (rs.scope === 'folder' && rs.folderId) {
    return requestsUnder(rs.folderId).map((r) => ({ request: r, path: [folderPathName(rs.folderId)] }));
  }
  if (rs.scope === 'manual') {
    return allRequestsWithPath().filter(({ request }) => rs.manualIds.has(request.id));
  }
  return allRequestsWithPath();
}

/* ==================================================================== *
 * 事件
 * ==================================================================== */
function tabOf(el) {
  const pane = el.closest('.pane');
  return pane ? state.tabs.find((t) => t.id === pane.dataset.tab) : null;
}

export function initRunnerEvents(root) {
  on(root, 'change', '[data-runner="scope"]', (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    const rs = getRunnerState(tab.id);
    rs.scope = el.value;
    if (rs.scope === 'manual' && !rs.manualIds.size) {
      // 默认全选，方便直接运行
      for (const { request } of allRequestsWithPath()) rs.manualIds.add(request.id);
    }
    renderRunnerContent(tab);
  });

  on(root, 'change', '[data-runner="folder"]', (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    getRunnerState(tab.id).folderId = el.value || null;
    renderRunnerContent(tab);
  });

  on(root, 'change', '[data-runner="concurrency"]', (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    const rs = getRunnerState(tab.id);
    rs.concurrency = Math.max(1, Math.min(20, Number(el.value) || 5));
  });

  on(root, 'change', '[data-runner="stopOnError"]', (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    getRunnerState(tab.id).stopOnError = el.checked;
  });

  on(root, 'change', '[data-runner="filter"]', (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    getRunnerState(tab.id).filter = el.value;
    renderResults(qs(`.pane[data-tab="${tab.id}"]`), tab, getRunnerState(tab.id));
  });

  on(root, 'change', '[data-manual-check]', (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    const rs = getRunnerState(tab.id);
    const id = el.closest('[data-manual]').dataset.manual;
    if (el.checked) rs.manualIds.add(id);
    else rs.manualIds.delete(id);
  });

  on(root, 'click', '[data-runner="start"]', (_e, el) => {
    const tab = tabOf(el);
    if (tab) startRun(tab);
  });

  on(root, 'click', '[data-runner="abort"]', () => {
    cancelToken.cancelled = true;
    toastWarn('正在中止…');
  });

  on(root, 'click', '[data-runner="clear"]', (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    const rs = getRunnerState(tab.id);
    rs.results = [];
    rs.progress = { done: 0, total: 0 };
    renderRunnerContent(tab);
  });

  on(root, 'click', '[data-runner="export-csv"]', async (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    const rs = getRunnerState(tab.id);
    const res = await bridge.dialog.save({
      title: '导出执行结果',
      defaultPath: `batch-result-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.csv`,
      content: resultsToCsv(rs.results),
    });
    if (res.ok) toastOk('已导出到 ' + res.path);
  });

  on(root, 'click', '[data-runner="export-json"]', async (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    const rs = getRunnerState(tab.id);
    const payload = {
      exportedAt: new Date().toISOString(),
      environment: (state.workspace.environments.find((e) => e.id === state.workspace.settings.activeEnvId) || {}).name || null,
      summary: summarizeResults(rs.results),
      results: rs.results.map((r) => ({
        index: r.index + 1,
        name: r.name,
        path: r.path,
        method: r.method,
        url: r.url,
        status: r.status,
        ok: r.ok,
        duration: r.duration,
        size: r.size,
        error: r.error ? r.error.message : null,
      })),
    };
    const res = await bridge.dialog.save({
      title: '导出执行结果',
      defaultPath: `batch-result-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`,
      content: JSON.stringify(payload, null, 2),
    });
    if (res.ok) toastOk('已导出到 ' + res.path);
  });

  on(root, 'click', 'tr[data-result]', (_e, el) => {
    const tab = tabOf(el);
    if (!tab) return;
    const rs = getRunnerState(tab.id);
    const idx = Number(el.dataset.index);
    const r = rs.results.find((x) => x.index === idx);
    if (r) showResultDetail(r);
  });
}

/* ---------------------------- 执行 ---------------------------- */
async function startRun(tab) {
  const rs = getRunnerState(tab.id);
  if (rs.running) return;

  const items = collectItems(rs);
  if (!items.length) {
    toastWarn('当前范围内没有可执行的请求');
    return;
  }

  resetCancel();
  rs.running = true;
  rs.results = [];
  rs.progress = { done: 0, total: items.length };
  renderRunnerContent(tab);

  const pane = qs(`.pane[data-tab="${tab.id}"]`);
  const startedAll = Date.now();

  try {
    const results = await runBatch({
      items,
      concurrency: rs.concurrency,
      stopOnError: rs.stopOnError,
      onProgress: (result, done, total) => {
        rs.results.push(result);
        rs.progress = { done, total };
        // 节流重绘，避免高并发下卡顿
        if (done % 3 === 0 || done === total) {
          if (pane.isConnected) {
            renderSummary(pane, tab, rs);
            renderResults(pane, tab, rs);
          }
        }
      },
    });
    rs.results = results.filter(Boolean);
    const s = summarizeResults(rs.results);
    if (cancelToken.cancelled) {
      toastWarn(`已中止。完成 ${s.success + s.failed} / ${items.length} 条`);
    } else if (s.failed) {
      toastWarn(`执行完成：${s.success} 成功，${s.failed} 失败，总耗时 ${formatMs(Date.now() - startedAll)}`, '批量执行结束');
    } else {
      toastOk(`全部 ${s.success} 条通过，总耗时 ${formatMs(Date.now() - startedAll)}`, '批量执行结束');
    }
  } catch (e) {
    toastErr(e.message, '批量执行异常');
  } finally {
    rs.running = false;
    if (pane.isConnected) renderRunnerContent(tab);
  }
}

export async function runRequestsDirect(requestIds) {
  const tab = state.tabs.find((t) => t.type === 'runner');
  const target = tab || (() => {
    bus.emit('action', { action: 'open-runner' });
    return state.tabs.find((t) => t.type === 'runner');
  })();
  if (!target) return;
  const rs = getRunnerState(target.id);
  rs.scope = 'manual';
  rs.manualIds = new Set(requestIds);
  renderRunnerContent(target);
  bus.emit('tabs');
  setTimeout(() => startRun(target), 60);
}

export async function runFolderDirect(collectionId) {
  const tab = state.tabs.find((t) => t.type === 'runner');
  const target = tab || (() => {
    bus.emit('action', { action: 'open-runner' });
    return state.tabs.find((t) => t.type === 'runner');
  })();
  if (!target) return;
  const rs = getRunnerState(target.id);
  rs.scope = 'folder';
  rs.folderId = collectionId;
  renderRunnerContent(target);
  bus.emit('tabs');
  setTimeout(() => startRun(target), 60);
}

/* ---------------------------- 结果详情 ---------------------------- */
function showResultDetail(r) {
  const resp = r.response || {};
  const bodyText = resp.bodyText || '';
  const pretty = (() => {
    try { return JSON.stringify(JSON.parse(bodyText), null, 2); } catch { return bodyText; }
  })();

  openModal({
    title: `${r.method} ${r.name}`,
    wide: true,
    bodyHtml: `
      <div class="response-meta" style="border-radius:8px;border:1px solid var(--border);margin-bottom:12px">
        <span class="meta-chip"><span class="label">状态</span><span class="value" style="color:${r.ok ? statusColor(r.status) : 'var(--danger)'}">${r.status || 'ERR'}</span></span>
        <span class="meta-chip"><span class="label">耗时</span><span class="value">${escapeHtml(formatMs(r.duration))}</span></span>
        <span class="meta-chip"><span class="label">大小</span><span class="value">${escapeHtml(formatBytes(r.size))}</span></span>
      </div>
      <div class="field-block">
        <label class="field-label">请求地址</label>
        <div class="mono" style="word-break:break-all;color:var(--text-2)">${escapeHtml(r.url)}</div>
      </div>
      ${r.error
        ? `<div class="error-box"><div class="err-title">✕ 请求失败</div>
             <div class="err-code">${escapeHtml(r.error.code || '')}</div>
             <div class="err-msg">${escapeHtml(r.error.message || '')}</div>
             ${r.error.hint ? `<div class="err-hint">💡 ${escapeHtml(r.error.hint)}</div>` : ''}</div>`
        : ''}
      ${r.unresolved && r.unresolved.length
        ? `<div class="warn-box">未替换的变量：${escapeHtml(r.unresolved.join(', '))}</div>`
        : ''}
      <div class="field-block">
        <label class="field-label">响应头</label>
        <table class="headers-table">${(resp.headers || [])
          .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
          .join('') || '<tr><td colspan="2" class="text-dim">无</td></tr>'}</table>
      </div>
      <div class="field-block">
        <label class="field-label">响应体</label>
        <pre class="code-block" style="max-height:340px;overflow:auto;background:var(--bg);border:1px solid var(--border);border-radius:6px">${highlightByType(pretty, resp.contentType || '')}</pre>
      </div>`,
    footerHtml: '<button class="btn" data-modal-close>关闭</button>',
  });
}
