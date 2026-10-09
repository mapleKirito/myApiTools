/**
 * 应用入口：布局、标签页、顶栏、快捷键、导入导出
 */

import { qs, qsa, on, html, raw } from './ui/dom.js';
import { toast, toastOk, toastErr, toastWarn, showContextMenu, promptDialog, confirmDialog, openModal, closeContextMenu } from './ui/feedback.js';
import {
  state,
  bus,
  initState,
  saveNow,
  activeTab,
  openTab,
  closeTab,
  activateTab,
  collections,
  requests,
  environments,
  getRequest,
  setActiveEnv,
  commit,
} from './state.js';
import { escapeHtml, methodColor, methodColor as mc, formatRelative, clone, uid } from './helpers.js';
import { sendFromTab, renderRequestPane, renderRequestSubtabs, renderRequestBody, initRequestEvents } from './ui/requestView.js';
import { dropViewState, getViewState } from './ui/responseView.js';
import { renderSidebar, initSidebar, searchRequests } from './ui/sidebar.js';
import { renderEnvPane, renderEnvContent, initEnvEvents } from './ui/envView.js';
import { renderRunnerPane, renderRunnerContent, initRunnerEvents, getRunnerState, runRequestsDirect, runFolderDirect } from './ui/runnerView.js';
import { renderSettingsPane, renderSettingsContent, initSettingsEvents } from './ui/settingsView.js';
import { importFromText, toPostmanCollection, toCurl } from './importers.js';
import { initSyncEngine, syncNow, syncCfg, setStatus } from './sync.js';
import { initUpdate, scheduleStartupCheck, checkForUpdate, updateState } from './update.js';

const bridge = window.bridge;

/* ==================================================================== *
 * 标签页
 * ==================================================================== */
const TAB_META = {
  request: (tab) => {
    const r = getRequest(tab.refId);
    return { title: r ? r.name : '已删除的请求', method: r ? r.method : '' };
  },
  runner: () => ({ title: '批量执行' }),
  environments: () => ({ title: '环境与变量' }),
  settings: () => ({ title: '设置' }),
};

function renderTabbar() {
  const host = qs('#tabbar');
  if (!state.tabs.length) {
    host.innerHTML = '';
    return;
  }
  host.innerHTML = state.tabs
    .map((tab) => {
      const meta = (TAB_META[tab.type] || (() => ({ title: tab.type })))(tab);
      const isActive = tab.id === state.activeTabId;
      return `
        <div class="tab ${isActive ? 'active' : ''}" data-tab-id="${escapeHtml(tab.id)}" title="${escapeHtml(meta.title)}">
          ${meta.method ? `<span class="method-tag" style="color:${mc(meta.method)}">${escapeHtml(meta.method)}</span>` : ''}
          <span class="tab-title">${escapeHtml(meta.title)}</span>
          <span class="tab-close" data-tab-close="${escapeHtml(tab.id)}" title="关闭">✕</span>
        </div>`;
    })
    .join('');
}

/* ==================================================================== *
 * 面板
 * ==================================================================== */
const paneRendered = new Set();

function paneEl(tabId) {
  return qs(`#panes .pane[data-tab="${tabId}"]`);
}

function syncPaneElements() {
  const host = qs('#panes');
  // 欢迎页是直接塞进 #panes 的裸 .empty-state（没有 .pane 包裹），下面的清理只认 .pane，
  // 所以必须在这里先把非面板的子节点摘掉 —— 否则它会一直留在面板上方，
  // 把真正的面板（设置页尤其明显）整个挤到下面去。
  for (const node of [...host.children]) {
    if (!node.classList.contains('pane')) node.remove();
  }
  for (const el of qsa('.pane', host)) {
    if (!state.tabs.find((t) => t.id === el.dataset.tab)) {
      dropViewState(el.dataset.tab);
      paneRendered.delete(el.dataset.tab);
      el.remove();
    }
  }
  for (const tab of state.tabs) {
    if (!paneEl(tab.id)) {
      const div = document.createElement('div');
      div.className = 'pane';
      div.dataset.tab = tab.id;
      host.appendChild(div);
    }
  }
  for (const el of qsa('.pane', host)) {
    el.classList.toggle('active', el.dataset.tab === state.activeTabId);
  }
}

function paneMarkup(tab) {
  switch (tab.type) {
    case 'request':
      return renderRequestPane(tab);
    case 'runner':
      return renderRunnerPane(tab);
    case 'environments':
      return renderEnvPane(tab);
    case 'settings':
      return renderSettingsPane(tab);
    default:
      return '<div class="empty-state">未知面板</div>';
  }
}

function refreshPane(tabId, { force = false } = {}) {
  const tab = state.tabs.find((t) => t.id === tabId);
  const el = paneEl(tabId);
  if (!tab || !el) return;
  const key = `${tab.type}:${tab.refId || ''}`;
  if (force || !paneRendered.has(tabId) || el.dataset.key !== key) {
    el.innerHTML = paneMarkup(tab);
    el.dataset.key = key;
    paneRendered.add(tabId);
    afterPaneMount(tab);
    return;
  }
  // 已渲染过 → 只做轻量刷新
  if (tab.type === 'request') {
    const req = getRequest(tab.refId);
    if (!req) {
      el.innerHTML = paneMarkup(tab);
      paneRendered.add(tabId);
      return;
    }
    const nameInput = el.querySelector('[data-role="req-name"]');
    const urlInput = el.querySelector('[data-role="url"]');
    const methodSel = el.querySelector('[data-role="method"]');
    if (nameInput && document.activeElement !== nameInput) nameInput.value = req.name;
    if (urlInput && document.activeElement !== urlInput) urlInput.value = req.url;
    if (methodSel && document.activeElement !== methodSel) {
      methodSel.value = req.method;
      methodSel.style.color = methodColor(req.method);
    }
    renderRequestSubtabs(tab);
  } else if (tab.type === 'environments') {
    renderEnvContent(tab);
  } else if (tab.type === 'runner') {
    renderRunnerContent(tab);
  } else if (tab.type === 'settings') {
    // 设置页不自动刷新，避免打断输入
  }
}

function afterPaneMount(tab) {
  if (tab.type === 'request') {
    renderRequestSubtabs(tab);
    renderRequestBody(tab);
  } else if (tab.type === 'environments') {
    renderEnvContent(tab);
  } else if (tab.type === 'runner') {
    renderRunnerContent(tab);
  } else if (tab.type === 'settings') {
    renderSettingsContent(tab);
  }
}

function renderPanes({ force = false } = {}) {
  syncPaneElements();
  if (!state.tabs.length) {
    qs('#panes').innerHTML = emptyWelcome();
    paneRendered.clear();
    return;
  }
  // activeTabId 可能因为标签关闭而失效，兜底到第一个
  if (!state.tabs.some((t) => t.id === state.activeTabId)) {
    state.activeTabId = state.tabs[0].id;
    for (const el of qsa('#panes .pane')) el.classList.toggle('active', el.dataset.tab === state.activeTabId);
  }
  const el = paneEl(state.activeTabId);
  if (el) {
    if (!el.innerHTML) force = true;
    refreshPane(state.activeTabId, { force });
  }
}

function emptyWelcome() {
  return `
    <div class="empty-state">
      <div>
        <div class="big">MyApiTools</div>
        <div style="line-height:2.1;max-width:560px">
          请求在本机直接发送，不受浏览器跨域限制，可以调试任意公网 / 内网接口。<br />
          远端服务只保存「怎么调」的配置，方便多设备同步。<br /><br />
          <kbd>Ctrl</kbd> + <kbd>N</kbd> 新建请求 ·
          <kbd>Ctrl</kbd> + <kbd>Enter</kbd> 发送 ·
          <kbd>Ctrl</kbd> + <kbd>K</kbd> 搜索 ·
          <kbd>Ctrl</kbd> + <kbd>I</kbd> 导入
        </div>
        <div class="btn-row" style="justify-content:center;margin-top:22px">
          <button class="btn primary" data-welcome="new" type="button">新建请求</button>
          <button class="btn" data-welcome="demo" type="button">插入示例集合</button>
          <button class="btn" data-welcome="import" type="button">从 cURL / Postman 导入</button>
        </div>
      </div>
    </div>`;
}

/* ---------- 示例数据 ---------- */
function seedDemo() {
  const stateMod = window.__stateMod;
  const ts = Date.now();
  const stamp = (o) => ({ createdAt: ts, updatedAt: ts, deleted: false, ...o });

  const root = stateMod.createCollection(null, '示例集合');
  const env = stateMod.createEnvironment('示例环境', [
    { key: 'host', value: 'https://httpbin.org', enabled: true, secret: false },
    { key: 'token', value: 'demo-token-123', enabled: true, secret: true },
  ]);
  setActiveEnv(env.id);

  const mk = (patch) => stateMod.createRequest(patch.collectionId, patch);

  mk({
    collectionId: root.id,
    name: '带变量的 GET',
    method: 'GET',
    url: '{{host}}/get',
    params: [
      { key: 'page', value: '1', enabled: true },
      { key: 'keyword', value: '中文关键词', enabled: true },
    ],
    headers: [{ key: 'Authorization', value: 'Bearer {{token}}', enabled: true }],
  });

  mk({
    collectionId: root.id,
    name: 'POST JSON',
    method: 'POST',
    url: '{{host}}/post',
    headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
    body: {
      mode: 'json',
      content: '{\n  "name": "测试用户",\n  "traceId": "{{$uuid}}",\n  "ts": {{$timestamp}}\n}',
      fields: [],
      contentType: 'application/json',
    },
  });

  mk({
    collectionId: root.id,
    name: '表单上传',
    method: 'POST',
    url: '{{host}}/post',
    body: {
      mode: 'form-urlencoded',
      content: '',
      fields: [
        { key: 'username', value: 'demo', enabled: true, type: 'text' },
        { key: 'remark', value: '表单编码示例', enabled: true, type: 'text' },
      ],
      contentType: '',
    },
  });

  mk({ collectionId: root.id, name: '故意 404', method: 'GET', url: '{{host}}/status/404' });
  mk({ collectionId: root.id, name: '慢接口（2 秒）', method: 'GET', url: '{{host}}/delay/2' });

  renderSidebar();
  renderPanes({ force: true });
  refreshTopbar();
  toastOk('示例集合已创建，可直接点「发送」试一下；也可以对「示例集合」右键批量执行', '已插入示例');
}

/* ==================================================================== *
 * 顶栏
 * ==================================================================== */
function refreshTopbar() {
  const env = environments().find((e) => e.id === state.workspace.settings.activeEnvId);
  const btn = qs('#env-picker');
  const label = qs('#env-picker-label');
  if (btn && label) {
    btn.classList.toggle('no-env', !env);
    label.textContent = env ? env.name : '未选择环境';
    btn.title = env
      ? `当前环境：${env.name}（${(env.variables || []).filter((v) => v.key).length} 个变量）`
      : '未选择环境，点击切换';
  }

  const sy = syncCfg();
  const dot = qs('#sync-dot');
  const slabel = qs('#sync-label');
  if (dot && slabel) {
    const connected = !!(sy.token && sy.serverUrl);
    const pending = !!sy.serverUrl && !sy.token;
    slabel.textContent = connected
      ? (sy.enabled ? '自动同步' : '已登录')
      : pending ? '待登录' : '未连接';
    const cls = state.syncing ? 'syncing' : connected ? 'ok' : pending ? 'auth' : 'off';
    dot.className = 'sync-dot ' + cls;
  }

  const stEnv = qs('#status-env');
  const stSync = qs('#status-sync');
  if (stEnv) {
    stEnv.textContent = env ? `环境：${env.name}` : '未选择环境';
    stEnv.className = 'status-item clickable';
  }
  if (stSync) {
    stSync.textContent = sy.token
      ? `上次同步：${formatRelative(sy.lastSyncAt)}`
      : sy.serverUrl ? '同步待登录（点击登录）' : '同步未连接';
    stSync.className = 'status-item clickable';
    stSync.title = sy.token
      ? `账号 ${sy.email || ''} · ${sy.serverUrl}`
      : sy.serverUrl ? '已配置服务地址但未登录，点击登录同步账号' : '尚未配置同步服务';
  }

  // 有新版本时在设置入口上点一个小红点，用户不去设置页也能看到
  const updDot = qs('#update-dot');
  if (updDot) {
    const hasNew = updateState.status === 'available'
      || updateState.status === 'downloading'
      || updateState.status === 'downloaded';
    updDot.hidden = !hasNew;
    const btnSettings = qs('#btn-settings');
    if (btnSettings) {
      btnSettings.title = updDot.hidden
        ? '设置'
        : `设置（发现新版本 v${updateState.latest ? updateState.latest.version : ''}）`;
    }
  }
}

function showEnvMenu(e) {
  const envs = environments();
  const activeId = state.workspace.settings.activeEnvId;
  const items = [
    {
      label: '切换环境',
      header: true,
    },
    ...envs.map((env) => ({
      label: (env.id === activeId ? '● ' : '　') + env.name,
      icon: '',
      action: () => {
        setActiveEnv(env.id);
        toastOk(`已切换到环境「${env.name}」`);
      },
    })),
    ...(activeId
      ? [{ label: '　取消环境（仅用全局变量）', icon: '', action: () => setActiveEnv(null) }]
      : []),
    { separator: true },
    { label: '管理环境与变量…', icon: '⚙', action: () => openTab({ type: 'environments' }) },
    { label: '新建环境…', icon: '＋', action: () => quickNewEnv() },
  ];
  showContextMenu(e, items);
}

async function quickNewEnv() {
  const name = await promptDialog({ title: '新建环境', label: '环境名称', value: '新环境' });
  if (name == null || !name.trim()) return;
  const { createEnvironment } = await import('./state.js');
  const env = createEnvironment(name.trim());
  setActiveEnv(env.id);
  openTab({ type: 'environments' });
  toastOk(`已创建并切换到「${env.name}」`);
}

/* ---------- 搜索 ---------- */
function initSearch() {
  const input = qs('#global-search');
  const panel = qs('#search-results');
  let items = [];
  let cursor = -1;

  const hide = () => {
    panel.hidden = true;
    panel.innerHTML = '';
    cursor = -1;
  };

  const render = () => {
    if (!items.length) {
      panel.innerHTML = '<div class="search-empty">没有匹配的请求</div>';
      panel.hidden = false;
      return;
    }
    panel.innerHTML = items
      .map(
        (it, i) => `
      <div class="search-item ${i === cursor ? 'active' : ''}" data-search-idx="${i}">
        <span class="method-tag" style="color:${methodColor(it.request.method)}">${escapeHtml(it.request.method)}</span>
        <span class="name">${escapeHtml(it.request.name)}</span>
        <span class="path">${escapeHtml(it.path.join(' / '))}</span>
      </div>`
      )
      .join('');
    panel.hidden = false;
  };

  const pick = (idx) => {
    const it = items[idx];
    if (!it) return;
    openTab({ type: 'request', refId: it.request.id });
    input.value = '';
    hide();
  };

  input.addEventListener('input', () => {
    items = searchRequests(input.value);
    cursor = -1;
    if (!input.value.trim()) return hide();
    render();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      cursor = Math.min(cursor + 1, items.length - 1);
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      cursor = Math.max(cursor - 1, 0);
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(cursor >= 0 ? cursor : 0);
    } else if (e.key === 'Escape') {
      input.value = '';
      hide();
      input.blur();
    }
  });

  input.addEventListener('blur', () => setTimeout(hide, 150));

  panel.addEventListener('mousedown', (e) => {
    const node = e.target.closest('[data-search-idx]');
    if (node) pick(Number(node.dataset.searchIdx));
  });
}

/* ==================================================================== *
 * 导入 / 导出
 * ==================================================================== */
async function showImportDialog() {
  openModal({
    title: '导入配置',
    wide: true,
    bodyHtml: `
      <div class="field-hint" style="margin-bottom:12px">
        支持 <b>cURL 命令</b>、<b>Postman Collection v2.x</b>、<b>OpenAPI 3 / Swagger 2</b>，
        以及本工具导出的 JSON 备份。粘贴内容后点「解析预览」。
      </div>
      <div class="btn-row" style="margin-bottom:10px">
        <button class="btn" data-import="file" type="button">从文件读取…</button>
        <button class="btn" data-import="parse" type="button">解析预览</button>
      </div>
      <textarea data-import="text" placeholder="在此粘贴 cURL / Postman / OpenAPI 内容…" style="min-height:220px"></textarea>
      <div data-import="preview" style="margin-top:12px"></div>`,
    footerHtml: `
      <button class="btn" data-modal-close>取消</button>
      <button class="btn primary" data-import="confirm" type="button" disabled>导入</button>`,
    onMount(root, close) {
      const ta = root.querySelector('[data-import="text"]');
      const preview = root.querySelector('[data-import="preview"]');
      const confirmBtn = root.querySelector('[data-import="confirm"]');
      let parsed = null;

      root.querySelector('[data-import="file"]').onclick = async () => {
        const res = await bridge.dialog.open({
          title: '选择要导入的文件',
          filters: [{ name: '配置/API 文件', extensions: ['json', 'txt', 'yaml', 'yml', 'sh', 'curl'] }, { name: '所有文件', extensions: ['*'] }],
        });
        if (!res.ok) return;
        const read = await bridge.fs.readText(res.path);
        if (read.ok) {
          ta.value = read.text;
          preview.innerHTML = '<div class="text-ok" style="font-size:12px">已读取文件，点「解析预览」继续</div>';
          confirmBtn.disabled = true;
          parsed = null;
        }
      };

      root.querySelector('[data-import="parse"]').onclick = () => {
        preview.innerHTML = '';
        confirmBtn.disabled = true;
        parsed = null;
        try {
          const result = importFromText(ta.value);
          parsed = result;
          if (result.raw) {
            preview.innerHTML = `<div class="field-hint">识别到 <b>${escapeHtml(result.format)}</b>，导入将<b>整体替换</b>当前配置。</div>`;
            confirmBtn.textContent = '整体恢复';
            confirmBtn.disabled = false;
            return;
          }
          preview.innerHTML = `
            <div class="card" style="margin:0">
              <div style="font-size:13px;margin-bottom:8px">识别格式：<b>${escapeHtml(result.format)}</b> · ${escapeHtml(result.name)}</div>
              <div class="field-hint">
                ${result.collections.length} 个文件夹 · ${result.requests.length} 个请求
              </div>
              <div style="max-height:180px;overflow:auto;margin-top:10px;border-top:1px solid var(--border);padding-top:8px">
                ${result.requests.slice(0, 60).map((r) => `
                  <div style="display:flex;gap:8px;align-items:center;padding:2px 0">
                    <span class="method-tag" style="color:${methodColor(r.method)}">${escapeHtml(r.method)}</span>
                    <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(r.name)}</span>
                    <span class="mono text-dim" style="font-size:11px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(r.url)}</span>
                  </div>`).join('')}
                ${result.requests.length > 60 ? `<div class="text-dim" style="font-size:11px;padding-top:6px">…还有 ${result.requests.length - 60} 个</div>` : ''}
              </div>
            </div>`;
          confirmBtn.textContent = '导入';
          confirmBtn.disabled = false;
        } catch (e) {
          preview.innerHTML = `<div class="error-box" style="margin:0"><div class="err-title">✕ 解析失败</div><div class="err-msg">${escapeHtml(e.message)}</div></div>`;
        }
      };

      confirmBtn.onclick = async () => {
        if (!parsed) return;
        if (parsed.raw) {
          if (!await confirmDialog({
            title: '整体恢复',
            message: '将用该备份覆盖当前全部本地配置，操作不可撤销。确定继续？',
            confirmText: '覆盖恢复',
            danger: true,
          })) return;
          try {
            await bridge.store.importJSON(ta.value);
            toastOk('恢复成功，正在重新载入…');
            setTimeout(() => window.location.reload(), 700);
          } catch (e) {
            toastErr(e.message, '恢复失败');
          }
          return;
        }
        applyImport(parsed);
        close();
      };
    },
  });
}

function applyImport(result) {
  const ws = state.workspace;
  const ts = Date.now();

  // 顶层包一层，避免和已有内容混在一起
  const rootName = `导入 · ${result.name || result.format}`;
  const rootCol = {
    id: uid('col'),
    name: rootName,
    parentId: null,
    sort: 0,
    createdAt: ts,
    updatedAt: ts,
    deleted: false,
  };

  const idMap = new Map();
  const newCols = [];
  const newReqs = [];

  for (const c of result.collections) {
    const newId = uid('col');
    idMap.set(c.id, newId);
    newCols.push({
      id: newId,
      name: c.name || '文件夹',
      parentId: c.parentId ? idMap.get(c.parentId) || rootCol.id : rootCol.id,
      sort: c.sort ?? 0,
      createdAt: ts,
      updatedAt: ts,
      deleted: false,
    });
  }

  for (const r of result.requests) {
    newReqs.push({
      id: uid('req'),
      name: r.name || '未命名请求',
      collectionId: r.collectionId ? idMap.get(r.collectionId) || rootCol.id : rootCol.id,
      sort: r.sort ?? 0,
      method: r.method || 'GET',
      url: r.url || '',
      params: r.params || [],
      headers: r.headers || [],
      body: r.body || { mode: 'none', content: '', fields: [], contentType: '' },
      auth: r.auth || { type: 'none' },
      options: r.options || { timeout: null, followRedirects: true, verifyTls: true },
      description: r.description || '',
      variables: r.variables || [],
      createdAt: ts,
      updatedAt: ts,
      deleted: false,
    });
  }

  ws.collections.push(rootCol, ...newCols);
  ws.requests.push(...newReqs);
  state.expanded.add(rootCol.id);

  commit({ kind: 'collection', ids: [rootCol.id, ...newCols.map((c) => c.id)] });
  commit({ kind: 'request', ids: newReqs.map((r) => r.id) });

  renderSidebar();
  toastOk(`已导入 ${newCols.length} 个文件夹、${newReqs.length} 个请求`, '导入完成');
}

async function showExportDialog() {
  const reqs = requests();
  openModal({
    title: '导出配置',
    wide: true,
    bodyHtml: `
      <div class="field-hint" style="margin-bottom:12px">选择导出范围与格式。</div>
      <div class="field-block">
        <label class="field-label">范围</label>
        <select data-export="scope" style="width:100%;height:32px;background:var(--bg-2);border:1px solid var(--border);border-radius:6px;padding:0 8px">
          <option value="all">全部请求（${reqs.length} 个）</option>
          ${collections().map((c) => `<option value="col:${escapeHtml(c.id)}">📁 ${escapeHtml(c.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field-block">
        <label class="field-label">格式</label>
        <select data-export="format" style="width:100%;height:32px;background:var(--bg-2);border:1px solid var(--border);border-radius:6px;padding:0 8px">
          <option value="postman">Postman Collection v2.1（.json）</option>
          <option value="myapi">MyApiTools 完整备份（.json）</option>
        </select>
      </div>
      <div class="field-hint">导出内容只包含请求配置，不含任何响应数据或历史记录。</div>`,
    footerHtml: `
      <button class="btn" data-modal-close>取消</button>
      <button class="btn primary" data-export="go" type="button">导出</button>`,
    onMount(root, close) {
      root.querySelector('[data-export="go"]').onclick = async () => {
        const scope = root.querySelector('[data-export="scope"]').value;
        const format = root.querySelector('[data-export="format"]').value;

        if (format === 'myapi') {
          const json = await bridge.store.exportJSON();
          const res = await bridge.dialog.save({
            title: '导出完整备份',
            defaultPath: `myapitools-backup-${new Date().toISOString().slice(0, 10)}.json`,
            content: json,
          });
          if (res.ok) {
            toastOk('已导出到 ' + res.path);
            close();
          }
          return;
        }

        let cols = collections();
        let reqs2 = requests();
        let name = 'MyApiTools 导出';
        if (scope.startsWith('col:')) {
          const cid = scope.slice(4);
          const collectIds = new Set([cid]);
          const walk = (id) => {
            for (const c of collections().filter((x) => x.parentId === id)) {
              collectIds.add(c.id);
              walk(c.id);
            }
          };
          walk(cid);
          cols = cols.filter((c) => collectIds.has(c.id));
          reqs2 = reqs2.filter((r) => collectIds.has(r.collectionId));
          name = (collections().find((c) => c.id === cid) || {}).name || name;
        }

        const json = toPostmanCollection(name, cols, reqs2);
        const res = await bridge.dialog.save({
          title: '导出 Postman Collection',
          defaultPath: `${name.replace(/[\\/:*?"<>|]/g, '_')}.postman_collection.json`,
          content: json,
        });
        if (res.ok) {
          toastOk('已导出到 ' + res.path);
          close();
        }
      };
    },
  });
}

/* ==================================================================== *
 * 快捷键
 * ==================================================================== */
function initShortcuts() {
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '') ||
      (document.activeElement && document.activeElement.isContentEditable);

    if (mod && e.key === 'Enter') {
      e.preventDefault();
      const tab = activeTab();
      if (tab && tab.type === 'request') sendFromTab(tab.id);
      return;
    }
    if (mod && e.key.toLowerCase() === 'n' && !e.shiftKey) {
      e.preventDefault();
      const req = (window.__createRequest)(null);
      openTab({ type: 'request', refId: req.id });
      return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      (window.__createCollection)(null);
      return;
    }
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      qs('#global-search').focus();
      return;
    }
    if (mod && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      showImportDialog();
      return;
    }
    if (mod && e.key.toLowerCase() === 'e' && !e.shiftKey) {
      e.preventDefault();
      showExportDialog();
      return;
    }
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveNow();
      toastOk('配置已保存到本地');
      return;
    }
    if (mod && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      if (state.activeTabId) closeTab(state.activeTabId);
      return;
    }
    if (mod && e.key === 'Tab') {
      e.preventDefault();
      const idx = state.tabs.findIndex((t) => t.id === state.activeTabId);
      if (state.tabs.length < 2) return;
      const next = e.shiftKey ? (idx - 1 + state.tabs.length) % state.tabs.length : (idx + 1) % state.tabs.length;
      activateTab(state.tabs[next].id);
      return;
    }
    if (e.key === 'Escape' && !inField) {
      closeContextMenu();
    }
  });
}

/* ==================================================================== *
 * 侧栏宽度拖动
 * ==================================================================== */
function initSplitter() {
  const splitter = qs('#splitter');
  let dragging = false;
  const move = (e) => {
    if (!dragging) return;
    const w = Math.max(200, Math.min(e.clientX, window.innerWidth - 460));
    document.documentElement.style.setProperty('--sidebar-w', w + 'px');
  };
  const up = () => {
    dragging = false;
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
  };
  splitter.addEventListener('mousedown', (e) => {
    dragging = true;
    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    e.preventDefault();
  });
}

/* ==================================================================== *
 * 启动
 * ==================================================================== */
async function boot() {
  await initState();

  // 供快捷键与欢迎页调用
  const stateMod = await import('./state.js');
  window.__stateMod = stateMod;
  window.__createRequest = (cid) => stateMod.createRequest(cid);
  window.__createCollection = (pid) => {
    const col = stateMod.createCollection(pid);
    renderSidebar();
    return col;
  };

  const info = await bridge.info();
  qs('#status-store').textContent = '工作区：' + (info.activeProfileName || '本机');
  qs('#status-store').title = info.dataFile;

  /* ---------- 初次渲染 ---------- */
  renderSidebar();
  renderTabbar();
  renderPanes({ force: true });
  refreshTopbar();

  /* ---------- 侧栏标签切换 ---------- */
  qsa('.stab').forEach((btn) => {
    btn.addEventListener('click', () => {
      qsa('.stab').forEach((b) => b.classList.toggle('active', b === btn));
      state.sidebarTab = btn.dataset.tab;
      renderSidebar();
    });
  });

  qs('#btn-new-request').onclick = () => {
    const req = stateMod.createRequest(null);
    state.sidebarTab = 'collections';
    qsa('.stab').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'collections'));
    renderSidebar();
    openTab({ type: 'request', refId: req.id });
  };
  qs('#btn-new-folder').onclick = () => {
    stateMod.createCollection(null);
    state.sidebarTab = 'collections';
    qsa('.stab').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'collections'));
    renderSidebar();
  };

  qs('#btn-runner').onclick = () => openTab({ type: 'runner' });
  qs('#btn-settings').onclick = () => openTab({ type: 'settings' });
  qs('#btn-sync').onclick = (e) => {
    const sy = syncCfg();
    if (!sy.serverUrl) {
      // 还没填服务地址：先去设置页把地址填上
      openTab({ type: 'settings' });
      return;
    }
    if (!sy.token) {
      // 已配地址但缺登录凭证：直接发起一次同步，缺凭证会自动弹出登录 / 注册框
      syncNow('both');
      return;
    }
    showContextMenu(e, [
      { label: `已连接 ${sy.email || ''}`, header: true },
      { label: '立即同步', icon: '⟳', action: () => syncNow('both') },
      { label: '全量上传（覆盖远端）', icon: '↑', action: () => syncNow('pushAll') },
      { label: '全量下载（覆盖本机）', icon: '↓', action: () => syncNow('pull', { forcePull: true }) },
    ]);
  };
  qs('#env-picker').onclick = (e) => showEnvMenu(e);
  qs('#status-env').onclick = (e) => showEnvMenu(e);
  qs('#status-sync').onclick = () => {
    const sy = syncCfg();
    if (!sy.serverUrl) return openTab({ type: 'settings' });
    // 未登录时点状态栏 = 发起同步 → 弹出登录框，比只跳设置页更直接
    if (!sy.token) return void syncNow('both');
    openTab({ type: 'settings' });
  };

  /* ---------- 欢迎页按钮 ---------- */
  on(qs('#panes'), 'click', '[data-welcome]', (_e, el) => {
    const act = el.dataset.welcome;
    if (act === 'new') {
      const req = stateMod.createRequest(null);
      renderSidebar();
      openTab({ type: 'request', refId: req.id });
    } else if (act === 'demo') {
      seedDemo();
    } else if (act === 'import') {
      showImportDialog();
    }
  });

  /* ---------- 标签栏交互 ---------- */
  const tabbar = qs('#tabbar');
  on(tabbar, 'click', '[data-tab-close]', (e, el) => {
    e.stopPropagation();
    closeTab(el.dataset.tabClose);
  });
  on(tabbar, 'click', '.tab[data-tab-id]', (_e, el) => activateTab(el.dataset.tabId));
  on(tabbar, 'contextmenu', '.tab[data-tab-id]', (e, el) => {
    const id = el.dataset.tabId;
    showContextMenu(e, [
      { label: '关闭', icon: '✕', action: () => closeTab(id) },
      { label: '关闭其它标签', icon: '⊘', action: () => {
        for (const t of [...state.tabs]) if (t.id !== id) closeTab(t.id);
      } },
      { label: '关闭全部', icon: '⊘', action: () => {
        for (const t of [...state.tabs]) closeTab(t.id);
      } },
    ]);
  });

  /* ---------- 全局事件委托 ---------- */
  const appRoot = qs('#app');
  initSidebar();
  initRequestEvents(appRoot);
  initEnvEvents(appRoot);
  initRunnerEvents(appRoot);
  initSettingsEvents(appRoot);
  initSearch();
  initShortcuts();
  initSplitter();

  // 防止浏览器默认右键
  appRoot.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('input, textarea')) e.preventDefault();
  });

  /* ---------- 状态订阅 ---------- */
  bus.on('tabs', () => {
    renderTabbar();
    renderPanes();
    renderSidebar();
  });

  bus.on('change', () => {
    renderTabbar();
    renderSidebar();
    refreshTopbar();
    const tab = activeTab();
    if (tab && (tab.type === 'request' || tab.type === 'environments' || tab.type === 'runner')) {
      const el = paneEl(tab.id);
      if (el && el.innerHTML) {
        if (tab.type === 'request') renderRequestSubtabs(tab);
        else if (tab.type === 'environments') renderEnvContent(tab);
        else if (tab.type === 'runner' && !getRunnerState(tab.id).running) renderRunnerContent(tab);
      }
    }
  });

  bus.on('env-change', () => {
    refreshTopbar();
    renderSidebar();
    const tab = activeTab();
    if (tab && tab.type === 'environments') renderEnvContent(tab);
  });

  bus.on('sync-state', refreshTopbar);
  bus.on('update-state', refreshTopbar);

  bus.on('sync-status', ({ kind, message }) => {
    const dot = qs('#sync-dot');
    const label = qs('#sync-label');
    if (dot) {
      const cls = kind === 'ok' ? 'ok'
        : kind === 'syncing' ? 'syncing'
        : kind === 'error' ? 'error'
        : kind === 'auth' ? 'auth'
        : 'off';
      dot.className = 'sync-dot ' + cls;
    }
    if (label && message) label.textContent = message;
  });

  bus.on('toast', ({ type, message, title }) => toast(message, type, title || ''));
  bus.on('sync-dirty-requests', () => renderSidebar());

  bus.on('action', async (payload) => {
    switch (payload.action) {
      case 'import':
        showImportDialog();
        break;
      case 'export':
        showExportDialog();
        break;
      case 'sync-now':
        syncNow('both');
        break;
      case 'check-update':
        checkForUpdate({ silent: false });
        break;
      case 'run-folder':
        runFolderDirect(payload.collectionId);
        break;
      case 'run-requests':
        runRequestsDirect(payload.requestIds);
        break;
      case 'open-runner':
        if (!state.tabs.find((t) => t.type === 'runner')) openTab({ type: 'runner' });
        break;
      case 'send-request': {
        const tab = state.tabs.find((t) => t.type === 'request' && t.refId === payload.requestId);
        if (tab) {
          activateTab(tab.id);
          setTimeout(() => sendFromTab(tab.id), 60);
        } else {
          openTab({ type: 'request', refId: payload.requestId });
          setTimeout(() => {
            const t = state.tabs.find((x) => x.type === 'request' && x.refId === payload.requestId);
            if (t) sendFromTab(t.id);
          }, 80);
        }
        break;
      }
      case 'focus-url': {
        const tab = state.tabs.find((t) => t.type === 'request' && t.refId === payload.requestId);
        if (tab) {
          setTimeout(() => {
            const input = paneEl(tab.id) && paneEl(tab.id).querySelector('[data-role="url"]');
            if (input) input.focus();
          }, 80);
        }
        break;
      }
      case 'duplicate-to-new-tab':
        break;
      default:
        break;
    }
  });

  // 主进程菜单
  bridge.onMenu((payload) => bus.emit('action', payload));

  // 关闭前落盘
  window.addEventListener('beforeunload', () => saveNow());

  initSyncEngine();
  // 更新检查要已登录才发请求，所以放在同步引擎之后；
  // scheduleStartupCheck 自己会再确认一次登录状态，并延迟几秒避开首屏
  initUpdate();
  scheduleStartupCheck();

  qs('#status-left').textContent = `就绪 · ${collections().length} 个文件夹 · ${requests().length} 个请求`;
  setTimeout(() => {
    qs('#status-left').textContent = `请求默认超时 ${state.workspace.settings.timeout}ms · 点「设置」可调整`;
  }, 4000);
}

boot().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<div style="padding:40px;font-family:monospace;color:#f87171">
    <h2>启动失败</h2><pre>${escapeHtml(e.stack || e.message)}</pre></div>`;
});
