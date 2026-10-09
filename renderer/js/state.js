/**
 * 应用状态与本地持久化
 * ---------------------------------------------------------------
 * 单一内存状态树 + 防抖落盘。任何改动都走 commit()，保证：
 *   1. 打上 updatedAt（同步用）
 *   2. 记录脏标记（决定同步时推送哪些实体）
 *   3. 触发 UI 重绘
 */

import { uid, clone, debounce } from './helpers.js';

const bridge = window.bridge;

/* ----------------------------- 事件总线 ----------------------------- */
const listeners = new Map();
export const bus = {
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  },
  emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (e) {
        console.error(`[bus:${event}]`, e);
      }
    }
  },
};

/* ----------------------------- 状态 ----------------------------- */
export const state = {
  workspace: null,
  dirty: new Set(), // `${kind}:${id}`
  tabs: [], // [{id, type:'request'|'runner'|'environments'|'history'|'settings', refId}]
  activeTabId: null,
  expanded: new Set(), // 侧栏展开的文件夹
  sidebarTab: 'collections',
  envPanelId: null,
  syncing: false,
  syncMessage: '',
  lastResponseByTab: new Map(),
};

export const SETTINGS_DEFAULTS = {
  timeout: 30000,
  followRedirects: true,
  verifyTls: true,
  maxRedirects: 10,
  historyLimit: 300,
  concurrency: 5,
  sendOnEnter: true,
  prettyByDefault: true,
  activeEnvId: null,
  sync: {
    enabled: false,
    serverUrl: '',
    token: '',
    email: '',
    // 本机现有配置「归属」哪个账号。切换账号时靠它判断要不要提示用户，
    // 避免把 A 账号的配置悄悄推到 B 账号名下。
    accountKey: '',
    lastRev: 0,
    lastSyncAt: 0,
    autoSync: true,
    deviceName: '',
  },
  // 客户端更新的本机偏好。与同步数据无关，不参与同步。
  update: {
    enabled: true,
    channel: 'stable',
    // 用户点了「跳过此版本」的版本号；下次启动不再为它弹窗
    ignoredVersion: '',
    lastCheckAt: 0,
    lastKnownVersion: '',
  },
};

/* ----------------------------- 初始化 ----------------------------- */
export async function initState() {
  const ws = await bridge.store.load();
  return reloadWorkspace(ws);
}

/**
 * 用一份新加载的工作区替换内存中的工作区（首次启动 / 切换 profile 后调用）。
 * 重置与具体数据绑定的会话态（展开集合、脏标记、打开的标签页），再触发 UI 重绘。
 */
export function reloadWorkspace(ws) {
  state.workspace = ws;
  state.workspace.settings = { ...SETTINGS_DEFAULTS, ...(ws.settings || {}) };
  state.workspace.settings.sync = { ...SETTINGS_DEFAULTS.sync, ...((ws.settings || {}).sync || {}) };
  state.workspace.settings.update = { ...SETTINGS_DEFAULTS.update, ...((ws.settings || {}).update || {}) };

  // 清理历史遗留的脏引用
  state.expanded = new Set();
  for (const c of state.workspace.collections) state.expanded.add(c.id);

  // 切换 profile 后旧标签页 id 已无意义，整体清空回到欢迎态
  state.dirty.clear();
  state.tabs = [];
  state.activeTabId = null;

  if (!state.workspace.settings.sync.deviceName) {
    state.workspace.settings.sync.deviceName = defaultDeviceName();
    scheduleSave();
  }
  bus.emit('change');
  bus.emit('tabs');
  return state.workspace;
}

function defaultDeviceName() {
  const p = (navigator.platform || navigator.userAgent || '').includes('Win') ? 'Windows' : '设备';
  return `${p}-${Math.random().toString(36).slice(2, 6)}`;
}

/* ----------------------------- 持久化 ----------------------------- */
const scheduleSave = debounce(() => {
  const ws = state.workspace;
  bridge.store
    .patch({
      collections: ws.collections,
      requests: ws.requests,
      environments: ws.environments,
      globals: ws.globals,
      history: ws.history,
      settings: ws.settings,
    })
    .catch((e) => bus.emit('toast', { type: 'error', message: '本地保存失败：' + e.message }));
}, 350);

export function saveNow() {
  scheduleSave.flush();
}

/* ----------------------------- 变更提交 ----------------------------- */
/**
 * @param {object} opts
 *   opts.kind  实体类别，用于同步脏标记
 *   opts.ids   变更到的实体 id
 *   opts.silent 是否跳过 UI 重绘
 *   opts.noSync 是否不参与同步（如历史记录）
 */
export function commit(opts = {}) {
  const { kind, ids = [], silent = false, noSync = false } = opts;
  const now = Date.now();
  if (kind === 'collection' || kind === 'request' || kind === 'environment') {
    const list = state.workspace[kind === 'collection' ? 'collections' : kind === 'request' ? 'requests' : 'environments'];
    for (const id of ids) {
      const item = list.find((x) => x.id === id);
      if (item) item.updatedAt = now;
    }
  } else if (kind === 'globals') {
    state.workspace.globalsUpdatedAt = now;
  }
  if (!noSync) {
    for (const id of ids) state.dirty.add(`${kind}:${id}`);
    if (kind === 'globals') state.dirty.add('globals:globals');
  }
  scheduleSave();
  if (!silent) bus.emit('change');
  // 自动同步由 sync.js 订阅这个事件
  if (!noSync) bus.emit('dirty', { kind, ids });
}

/* ----------------------------- 实体读取 ----------------------------- */
const alive = (x) => x && !x.deleted;

export function collections() {
  return state.workspace.collections.filter(alive);
}
export function requests() {
  return state.workspace.requests.filter(alive);
}
export function environments() {
  return state.workspace.environments.filter(alive);
}

export function getRequest(id) {
  return state.workspace.requests.find((r) => r.id === id && alive(r)) || null;
}
export function getCollection(id) {
  return state.workspace.collections.find((c) => c.id === id && alive(c)) || null;
}
export function getEnvironment(id) {
  return state.workspace.environments.find((e) => e.id === id && alive(e)) || null;
}

/** 直接子级：文件夹（含请求），按 sort 排序 */
export function childrenOfCollection(collectionId) {
  const cols = collections().filter((c) => (c.parentId || null) === (collectionId || null));
  const reqs = requests().filter((r) => (r.collectionId || null) === (collectionId || null));
  return { collections: sortBy(cols), requests: sortBy(reqs) };
}

function sortBy(arr) {
  return [...arr].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || String(a.name).localeCompare(String(b.name)));
}

/** 某个文件夹（含所有后代）下的全部请求 */
export function requestsUnder(collectionId) {
  const out = [];
  const walk = (cid) => {
    const { collections: sub, requests: rs } = childrenOfCollection(cid);
    out.push(...rs);
    for (const s of sub) walk(s.id);
  };
  walk(collectionId);
  return out;
}

/** 全部请求扁平列表（含每个请求所属文件夹名称链） */
export function allRequestsWithPath() {
  const out = [];
  const walk = (cid, prefix) => {
    const { collections: sub, requests: rs } = childrenOfCollection(cid);
    for (const r of rs) out.push({ request: r, path: prefix });
    for (const s of sub) walk(s.id, [...prefix, s.name]);
  };
  walk(null, []);
  return out;
}

function nextSort(collectionId) {
  const { collections: cols, requests: reqs } = childrenOfCollection(collectionId);
  const all = [...cols, ...reqs].map((x) => x.sort ?? 0);
  return all.length ? Math.max(...all) + 1 : 0;
}

/* ----------------------------- 集合 / 请求 CRUD ----------------------------- */
export function createCollection(parentId = null, name = '新建文件夹') {
  const item = {
    id: uid('col'),
    name,
    parentId: parentId || null,
    sort: nextSort(parentId),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    deleted: false,
  };
  state.workspace.collections.push(item);
  if (parentId) state.expanded.add(parentId);
  commit({ kind: 'collection', ids: [item.id] });
  return item;
}

export function createRequest(collectionId = null, patch = {}) {
  const item = {
    id: uid('req'),
    name: patch.name || '新建请求',
    collectionId: collectionId || null,
    sort: nextSort(collectionId),
    method: patch.method || 'GET',
    url: patch.url || '',
    params: patch.params || [],
    headers: patch.headers || [],
    body: patch.body || { mode: 'none', content: '', fields: [], contentType: '' },
    auth: patch.auth || { type: 'none' },
    options: patch.options || { timeout: null, followRedirects: true, verifyTls: true },
    description: patch.description || '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    deleted: false,
  };
  state.workspace.requests.push(item);
  if (collectionId) state.expanded.add(collectionId);
  commit({ kind: 'request', ids: [item.id] });
  return item;
}

export function updateRequest(id, patch, { silent = false } = {}) {
  const item = getRequest(id);
  if (!item) return null;
  Object.assign(item, patch);
  commit({ kind: 'request', ids: [id], silent });
  return item;
}

export function updateCollection(id, patch) {
  const item = getCollection(id);
  if (!item) return null;
  Object.assign(item, patch);
  commit({ kind: 'collection', ids: [id] });
  return item;
}

export function updateEnvironment(id, patch, { silent = false } = {}) {
  const item = getEnvironment(id);
  if (!item) return null;
  Object.assign(item, patch);
  commit({ kind: 'environment', ids: [id], silent });
  return item;
}

/** 软删除，保留记录以便同步到其它设备 */
export function removeRequest(id) {
  const item = getRequest(id);
  if (!item) return;
  item.deleted = true;
  item.updatedAt = Date.now();
  state.workspace.requests = state.workspace.requests.filter((r) => !(r.deleted && Date.now() - r.updatedAt > 90 * 86400000));
  commit({ kind: 'request', ids: [id] });
}

export function removeCollection(id) {
  const item = getCollection(id);
  if (!item) return;
  const ids = [id];
  // 递归软删子文件夹与请求
  const walk = (cid) => {
    const { collections: sub, requests: rs } = childrenOfCollection(cid);
    for (const s of sub) {
      s.deleted = true;
      s.updatedAt = Date.now();
      ids.push(s.id);
      walk(s.id);
    }
    for (const r of rs) {
      r.deleted = true;
      r.updatedAt = Date.now();
      ids.push(r.id);
    }
  };
  walk(id);
  item.deleted = true;
  item.updatedAt = Date.now();
  commit({ kind: 'collection', ids });
  bus.emit('sync-dirty-requests', ids);
}

/** 复制请求（生成新 id，名称加后缀） */
export function duplicateRequest(id) {
  const src = getRequest(id);
  if (!src) return null;
  const copy = clone(src);
  copy.id = uid('req');
  copy.name = src.name + ' 副本';
  copy.createdAt = Date.now();
  copy.updatedAt = Date.now();
  copy.sort = nextSort(src.collectionId);
  state.workspace.requests.push(copy);
  commit({ kind: 'request', ids: [copy.id] });
  return copy;
}

/* ----------------------------- 移动 / 排序 ----------------------------- */
export function moveRequest(id, toCollectionId, beforeId = null) {
  const item = getRequest(id);
  if (!item) return;
  item.collectionId = toCollectionId || null;
  const siblings = requests().filter((r) => r.id !== id && (r.collectionId || null) === (toCollectionId || null));
  const ordered = beforeId ? insertBefore(siblings, beforeId, item) : [...siblings, item];
  ordered.forEach((r, i) => {
    r.sort = i;
  });
  if (toCollectionId) state.expanded.add(toCollectionId);
  commit({ kind: 'request', ids: [id, ...ordered.map((r) => r.id)] });
}

export function moveCollection(id, toParentId, beforeId = null) {
  const item = getCollection(id);
  if (!item) return;
  if (toParentId === id || isDescendant(id, toParentId)) return; // 禁止移入自身或后代
  item.parentId = toParentId || null;
  const siblings = collections().filter((c) => c.id !== id && (c.parentId || null) === (toParentId || null));
  const ordered = beforeId ? insertBefore(siblings, beforeId, item) : [...siblings, item];
  ordered.forEach((c, i) => {
    c.sort = i;
  });
  if (toParentId) state.expanded.add(toParentId);
  commit({ kind: 'collection', ids: [id, ...ordered.map((c) => c.id)] });
}

function insertBefore(arr, beforeId, item) {
  const idx = arr.findIndex((x) => x.id === beforeId);
  if (idx < 0) return [...arr, item];
  const next = [...arr];
  next.splice(idx, 0, item);
  return next;
}

function isDescendant(ancestorId, maybeChildId) {
  let cur = getCollection(maybeChildId);
  while (cur) {
    if (cur.parentId === ancestorId) return true;
    cur = cur.parentId ? getCollection(cur.parentId) : null;
  }
  return false;
}

/* ----------------------------- 环境 ----------------------------- */
export function createEnvironment(name = '新环境', variables = []) {
  const item = { id: uid('env'), name, variables, createdAt: Date.now(), updatedAt: Date.now(), deleted: false };
  state.workspace.environments.push(item);
  commit({ kind: 'environment', ids: [item.id] });
  return item;
}

export function removeEnvironment(id) {
  const item = getEnvironment(id);
  if (!item) return;
  item.deleted = true;
  item.updatedAt = Date.now();
  if (state.workspace.settings.activeEnvId === id) {
    state.workspace.settings.activeEnvId = null;
    commit({ kind: 'environment', ids: [id] });
  } else {
    commit({ kind: 'environment', ids: [id] });
  }
}

export function setActiveEnv(id) {
  state.workspace.settings.activeEnvId = id || null;
  scheduleSave();
  bus.emit('change');
  bus.emit('env-change');
}

export function getActiveEnv() {
  const id = state.workspace.settings.activeEnvId;
  return id ? getEnvironment(id) : null;
}

/* ----------------------------- 全局变量 ----------------------------- */
export function setGlobals(rows) {
  state.workspace.globals = rows;
  commit({ kind: 'globals', ids: ['globals'] });
}

/* ----------------------------- 设置 ----------------------------- */
/**
 * 局部更新设置。
 * sync 必须当成「子对象」来合并：直接 `{...settings, ...patch}` 会把整个
 * settings.sync 换成 patch.sync，于是渲染层每改一个同步字段（比如往服务地址
 * 输入框里敲一个字）都会顺手把 token / email / accountKey / autoSync 抹掉。
 */
export function updateSettings(patch) {
  const next = { ...state.workspace.settings, ...patch };
  if (patch.sync) {
    next.sync = { ...state.workspace.settings.sync, ...patch.sync };
  }
  state.workspace.settings = next;
  scheduleSave();
  bus.emit('change');
}

/* ----------------------------- 历史 ----------------------------- */
export function pushHistory(entry) {
  const limit = state.workspace.settings.historyLimit || 300;
  state.workspace.history.unshift({ id: uid('hist'), at: Date.now(), ...entry });
  if (state.workspace.history.length > limit) {
    state.workspace.history.length = limit;
  }
  commit({ kind: 'history', noSync: true });
}

export function clearHistory() {
  state.workspace.history = [];
  commit({ kind: 'history', noSync: true });
}

/* ----------------------------- 标签页 ----------------------------- */
export function openTab(tab) {
  const existing = state.tabs.find((t) => t.type === tab.type && t.refId === tab.refId);
  if (existing) {
    state.activeTabId = existing.id;
  } else {
    const item = { id: uid('tab'), ...tab };
    state.tabs.push(item);
    state.activeTabId = item.id;
  }
  bus.emit('tabs');
}

export function closeTab(tabId) {
  const idx = state.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return;
  state.tabs.splice(idx, 1);
  state.lastResponseByTab.delete(tabId);
  if (state.activeTabId === tabId) {
    const next = state.tabs[idx] || state.tabs[idx - 1] || state.tabs[state.tabs.length - 1];
    state.activeTabId = next ? next.id : null;
  }
  bus.emit('tabs');
}

export function activateTab(tabId) {
  state.activeTabId = tabId;
  bus.emit('tabs');
}

export function activeTab() {
  return state.tabs.find((t) => t.id === state.activeTabId) || null;
}

/* ----------------------------- 同步实体快照 ----------------------------- */
export function dirtyEntities() {
  const out = [];
  for (const key of state.dirty) {
    const [kind, id] = key.split(':');
    out.push(serializeEntity(kind, id));
  }
  return out.filter(Boolean);
}

export function allSyncEntities() {
  const out = [];
  for (const c of state.workspace.collections) out.push(serializeEntity('collection', c.id));
  for (const r of state.workspace.requests) out.push(serializeEntity('request', r.id));
  for (const e of state.workspace.environments) out.push(serializeEntity('environment', e.id));
  out.push(serializeEntity('globals', 'globals'));
  return out.filter(Boolean);
}

export function serializeEntity(kind, id) {
  const ws = state.workspace;
  if (kind === 'globals') {
    return {
      kind,
      id: 'globals',
      updatedAt: ws.globalsUpdatedAt || 0,
      deleted: false,
      data: clone(ws.globals || []),
    };
  }
  const list = kind === 'collection' ? ws.collections : kind === 'request' ? ws.requests : ws.environments;
  const item = list.find((x) => x.id === id);
  if (!item) return null;
  const { deleted, updatedAt } = item;
  return {
    kind,
    id,
    updatedAt: updatedAt || 0,
    deleted: !!deleted,
    data: deleted ? null : clone(item),
  };
}

/** 把远端拉回来的实体并入本地（默认后写覆盖；force 时以远端为准） */
export function applyRemoteEntity(ent, { force = false } = {}) {
  const { kind, id, updatedAt, deleted, data } = ent;
  if (kind === 'globals') {
    if (force || (state.workspace.globalsUpdatedAt || 0) < updatedAt) {
      state.workspace.globals = data || [];
      state.workspace.globalsUpdatedAt = updatedAt;
      return true;
    }
    return false;
  }
  const listKey = kind === 'collection' ? 'collections' : kind === 'request' ? 'requests' : 'environments';
  const list = state.workspace[listKey];
  const idx = list.findIndex((x) => x.id === id);
  if (idx < 0) {
    if (deleted) return false;
    list.push({ ...data, id, deleted: false, updatedAt });
    if (kind === 'collection') state.expanded.add(id);
    return true;
  }
  if (!force && (list[idx].updatedAt || 0) >= updatedAt) return false;
  if (deleted) {
    list[idx].deleted = true;
    list[idx].updatedAt = updatedAt;
  } else {
    list[idx] = { ...data, id, deleted: false, updatedAt };
  }
  return true;
}

export function clearDirty(keys) {
  for (const k of keys) state.dirty.delete(k);
}

/**
 * 清空本机全部可同步配置。
 * 用于「切换账号时选择清空本机」：本地数据必须真正清掉，
 * 否则残留的脏标记会把上一个账号的内容推到新账号名下。
 */
export function clearWorkspaceData() {
  const ws = state.workspace;
  ws.collections = [];
  ws.requests = [];
  ws.environments = [];
  ws.globals = [];
  ws.globalsUpdatedAt = 0;
  ws.settings.activeEnvId = null;
  state.dirty.clear();
  state.expanded.clear();
  state.tabs = state.tabs.filter((t) => t.type === 'settings' || t.type === 'environments');
  if (state.activeTabId && !state.tabs.some((t) => t.id === state.activeTabId)) {
    state.activeTabId = state.tabs.length ? state.tabs[0].id : null;
  }
  saveNow();
  bus.emit('change');
  bus.emit('tabs');
}

/** 推送成功后，服务端 rev 水位落盘 */
export function setSyncState({ lastRev, lastSyncAt, token, email, serverUrl, enabled, accountKey }) {
  const s = state.workspace.settings.sync;
  if (lastRev !== undefined) s.lastRev = lastRev;
  if (lastSyncAt !== undefined) s.lastSyncAt = lastSyncAt;
  if (token !== undefined) s.token = token;
  if (email !== undefined) s.email = email;
  if (serverUrl !== undefined) s.serverUrl = serverUrl;
  if (enabled !== undefined) s.enabled = enabled;
  if (accountKey !== undefined) s.accountKey = accountKey;
  scheduleSave();
  bus.emit('sync-state');
}
