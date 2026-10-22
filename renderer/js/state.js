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

/** 兼容旧数据的默认项目 id：服务端的历史实体没有项目前缀，都归它 */
export const DEFAULT_PROJECT_ID = 'prj_default';

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
  dirty: new Set(), // `${projectId}:${kind}:${id}`
  dirtyProjects: new Set(), // 需要整项目回传主进程的 id（切换 / 新建 / 同步写入非活跃项目）
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
  // 用户是否曾经显式保存过更新渠道。只有「从未保存过」时，才按构建版本套用默认渠道，
  // 这样既让 -dev 包开箱即走 dev 频道，又不会覆盖用户后来手动改过的选择。
  const hadChannel = !!(ws && ws.settings && ws.settings.update && ws.settings.update.channel);
  reloadWorkspace(ws);
  if (!hadChannel) {
    try {
      const info = await bridge.info();
      if (info && /-dev/i.test(String(info.version || ''))) {
        state.workspace.settings.update.channel = 'dev';
        scheduleSave();
      }
    } catch {
      /* 取不到运行版本就保持 stable 默认，不影响启动 */
    }
  }
  return state.workspace;
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

  // 保证至少有一个项目，并让顶层数据指向当前项目
  ensureProjects(state.workspace);

  // 清理历史遗留的脏引用
  state.expanded = new Set();
  for (const c of state.workspace.collections) state.expanded.add(c.id);

  // 切换 profile 后旧标签页 id 已无意义，整体清空回到欢迎态
  state.dirty.clear();
  state.dirtyProjects.clear();
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

/* ----------------------------- 项目 ----------------------------- */
const PROJECT_DATA_KEYS = ['collections', 'requests', 'environments', 'globals', 'history'];

function normalizeProject(p) {
  if (!p || typeof p !== 'object') return null;
  const now = Date.now();
  const out = {
    id: String(p.id || uid('prj')),
    name: String(p.name || '新项目'),
    createdAt: Number(p.createdAt) || now,
    updatedAt: Number(p.updatedAt) || now,
    deleted: !!p.deleted,
    globalsUpdatedAt: Number(p.globalsUpdatedAt) || 0,
    activeEnvId: p.activeEnvId || null,
  };
  for (const key of PROJECT_DATA_KEYS) out[key] = Array.isArray(p[key]) ? p[key] : [];
  return out;
}

/**
 * 保证工作区有项目列表，并让顶层数据数组与当前项目共享同一个引用。
 * 旧版本工作区（或旧备份）没有 projects 字段时，会把现有数据整体收进默认项目。
 */
export function ensureProjects(ws = state.workspace) {
  if (!ws) return null;
  let list = Array.isArray(ws.projects) ? ws.projects.filter(Boolean) : [];
  // 只有结构缺失（老数据 / 导入数据）才重建；正常情况保留原有对象，
  // 避免每次调用都换掉项目对象，让外部持有的引用变成脏数据。
  if (list.length && list.some((p) => !p.id || !PROJECT_DATA_KEYS.every((k) => Array.isArray(p[k])))) {
    const seen = new Set();
    const rebuilt = [];
    for (const raw of list) {
      const p = normalizeProject(raw);
      if (!p || seen.has(p.id)) continue;
      seen.add(p.id);
      rebuilt.push(p);
    }
    list = rebuilt;
  }
  if (!list.length) {
    list.push(normalizeProject({
      id: DEFAULT_PROJECT_ID,
      name: '默认项目',
      collections: ws.collections,
      requests: ws.requests,
      environments: ws.environments,
      globals: ws.globals,
      globalsUpdatedAt: ws.globalsUpdatedAt,
      history: ws.history,
      activeEnvId: ws.settings && ws.settings.activeEnvId,
    }));
  }
  ws.projects = list;

  let active = list.find((p) => p.id === ws.activeProjectId && !p.deleted);
  if (!active) {
    active = list.find((p) => !p.deleted) || list[0];
    ws.activeProjectId = active.id;
  }
  for (const key of PROJECT_DATA_KEYS) ws[key] = active[key];
  ws.globalsUpdatedAt = active.globalsUpdatedAt || 0;
  ws.settings.activeEnvId = active.activeEnvId || null;
  return active;
}

/** 全部未删除项目 */
export function projectsList() {
  return (state.workspace.projects || []).filter((p) => !p.deleted);
}

/** 当前激活项目 */
export function activeProject() {
  return (state.workspace.projects || []).find((p) => p.id === state.workspace.activeProjectId) || null;
}

/**
 * 切换项目：当前项目的数据早已与项目记录共享引用，无需搬运；
 * 只需换掉顶层引用、重置会话态（标签页 / 展开 / 脏标记）并落盘。
 */
export function switchProject(id) {
  const cur = ensureProjects(state.workspace);
  const target = (state.workspace.projects || []).find((p) => p.id === id && !p.deleted);
  if (!target) return null;
  if (cur) {
    cur.activeEnvId = state.workspace.settings.activeEnvId || null;
    state.dirtyProjects.add(cur.id);
  }
  state.workspace.activeProjectId = target.id;
  for (const key of PROJECT_DATA_KEYS) state.workspace[key] = target[key];
  state.workspace.globalsUpdatedAt = target.globalsUpdatedAt || 0;
  state.workspace.settings.activeEnvId = target.activeEnvId || null;

  state.expanded = new Set(target.collections.map((c) => c.id));
  // 脏标记不清：key 里已经带项目前缀，未同步的改动切回来仍能推送
  state.tabs = [];
  state.activeTabId = null;
  state.envPanelId = null;
  state.lastResponseByTab.clear();
  state.dirtyProjects.add(target.id);

  scheduleSave();
  bus.emit('change');
  bus.emit('tabs');
  bus.emit('project-change');
  return target;
}

/** 新建一个空项目并立即切换过去 */
export function createProject(name = '新项目') {
  const now = Date.now();
  const project = normalizeProject({
    id: uid('prj'),
    name: String(name || '新项目').trim() || '新项目',
    createdAt: now,
    updatedAt: now,
  });
  state.workspace.projects.push(project);
  state.dirtyProjects.add(project.id);
  switchProject(project.id);
  // 切换后再打脏标记，否则会被切换流程覆盖掉，新项目元数据同步不出去
  commit({ kind: 'project', ids: [project.id] });
  return project;
}

/* ----------------------------- 持久化 ----------------------------- */
const scheduleSave = debounce(() => {
  const ws = state.workspace;
  const patch = {
    collections: ws.collections,
    requests: ws.requests,
    environments: ws.environments,
    globals: ws.globals,
    history: ws.history,
    settings: ws.settings,
    activeProjectId: ws.activeProjectId,
  };
  // 切换 / 新建项目、或同步写入非活跃项目时，需要把完整项目列表回传主进程
  if (state.dirtyProjects.size) {
    patch.projects = ws.projects;
    state.dirtyProjects.clear();
  }
  bridge.store
    .patch(patch)
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
  const project = activeProject();
  const projectId = project ? project.id : state.workspace.activeProjectId;

  if (kind === 'collection' || kind === 'request' || kind === 'environment') {
    const list = state.workspace[kind === 'collection' ? 'collections' : kind === 'request' ? 'requests' : 'environments'];
    for (const id of ids) {
      const item = list.find((x) => x.id === id);
      if (item) item.updatedAt = now;
    }
  } else if (kind === 'globals') {
    state.workspace.globalsUpdatedAt = now;
    if (project) project.globalsUpdatedAt = now;
  } else if (kind === 'project') {
    for (const id of ids) {
      const p = state.workspace.projects.find((x) => x.id === id);
      if (p) p.updatedAt = now;
    }
    state.dirtyProjects.add(ids[0] || projectId);
  }

  if (!noSync) {
    const dirtyProjectId = kind === 'project' ? (ids[0] || projectId) : projectId;
    for (const id of ids) state.dirty.add(`${dirtyProjectId}:${kind}:${id}`);
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
  // 就地删除，不能整体替换数组：顶层数组与项目记录共享引用
  const keep = state.workspace.requests.filter((r) => !(r.deleted && Date.now() - r.updatedAt > 90 * 86400000));
  state.workspace.requests.length = 0;
  state.workspace.requests.push(...keep);
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
    const project = activeProject();
    if (project) {
      project.activeEnvId = null;
      state.dirtyProjects.add(project.id);
    }
  }
  commit({ kind: 'environment', ids: [id] });
}

export function setActiveEnv(id) {
  state.workspace.settings.activeEnvId = id || null;
  const project = activeProject();
  if (project) {
    project.activeEnvId = id || null;
    state.dirtyProjects.add(project.id);
  }
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
  // 就地替换内容，保持与当前项目 globals 的共享引用
  const list = state.workspace.globals;
  list.length = 0;
  list.push(...(Array.isArray(rows) ? rows : []));
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
  // update 与 sync 一样是子对象：直接整块替换会把 enabled/ignoredVersion 等抹掉，
  // 所以这里也要按子对象合并。
  if (patch.update) {
    next.update = { ...state.workspace.settings.update, ...patch.update };
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
  state.workspace.history.length = 0;
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
/**
 * 同步实体的 kind 里带项目命名空间：`<projectId>::<kind>`。
 * 默认项目（prj_default）沿用不带前缀的旧格式，保证升级前已经上传到
 * 服务端的实体仍然能正常拉回来；其余项目全部加前缀，避免多个项目的
 * 同名 kind 在同一个账号下互相覆盖。
 */
const DATA_LIST_KEY = {
  collection: 'collections',
  request: 'requests',
  environment: 'environments',
};

function projectPrefix(projectId) {
  return projectId && projectId !== DEFAULT_PROJECT_ID ? `${projectId}::` : '';
}

export function splitSyncKind(kind) {
  const s = String(kind || '');
  const idx = s.indexOf('::');
  if (idx < 0) return { projectId: DEFAULT_PROJECT_ID, kind: s };
  return { projectId: s.slice(0, idx), kind: s.slice(idx + 2) };
}

function findProject(projectId) {
  return (state.workspace.projects || []).find((p) => p.id === projectId) || null;
}

export function dirtyEntities() {
  const out = [];
  for (const key of state.dirty) {
    const i1 = key.indexOf(':');
    const i2 = key.indexOf(':', i1 + 1);
    if (i1 < 0 || i2 < 0) continue;
    const projectId = key.slice(0, i1);
    const kind = key.slice(i1 + 1, i2);
    const id = key.slice(i2 + 1);
    const ent = serializeEntity(kind, id, projectId);
    if (ent) out.push({ ...ent, _key: key });
  }
  return out;
}

export function allSyncEntities() {
  const out = [];
  // 全量推送也带上脏 key，推送成功后 sync.js 才能把这些脏标记一起清掉
  const push = (kind, id, project) => {
    const ent = serializeEntity(kind, id, project.id);
    if (ent) out.push({ ...ent, _key: `${project.id}:${kind}:${id}` });
  };
  for (const p of state.workspace.projects || []) {
    if (!p) continue;
    push('project', p.id, p);
    if (p.deleted) continue;
    for (const c of p.collections || []) push('collection', c.id, p);
    for (const r of p.requests || []) push('request', r.id, p);
    for (const e of p.environments || []) push('environment', e.id, p);
    push('globals', 'globals', p);
  }
  return out;
}

export function serializeEntity(kind, id, projectId = state.workspace.activeProjectId) {
  if (kind === 'project') {
    const p = findProject(id);
    if (!p) return null;
    return {
      kind: 'project',
      id,
      updatedAt: p.updatedAt || 0,
      deleted: !!p.deleted,
      data: p.deleted ? null : { id: p.id, name: p.name, createdAt: p.createdAt },
    };
  }
  const p = findProject(projectId) || activeProject();
  if (!p) return null;
  if (kind === 'globals') {
    return {
      kind: projectPrefix(p.id) + 'globals',
      id: 'globals',
      updatedAt: p.globalsUpdatedAt || 0,
      deleted: false,
      data: clone(p.globals || []),
    };
  }
  const listKey = DATA_LIST_KEY[kind];
  if (!listKey) return null;
  const item = (p[listKey] || []).find((x) => x.id === id);
  if (!item) return null;
  const { deleted, updatedAt } = item;
  return {
    kind: projectPrefix(p.id) + kind,
    id,
    updatedAt: updatedAt || 0,
    deleted: !!deleted,
    data: deleted ? null : clone(item),
  };
}

/** 把远端拉回来的实体并入本地（默认后写覆盖；force 时以远端为准） */
export function applyRemoteEntity(ent, { force = false } = {}) {
  const { id, updatedAt = 0, deleted } = ent;
  // 项目元数据的 kind 固定是 'project'，项目 id 就在实体 id 上，不参与命名空间拆分
  const { projectId, kind } = ent.kind === 'project'
    ? { projectId: id, kind: 'project' }
    : splitSyncKind(ent.kind);

  /* ---------- 项目元数据 ---------- */
  if (kind === 'project') {
    const meta = ent.data || {};
    let project = findProject(projectId);
    if (!project) {
      if (deleted) return false;
      project = normalizeProject({
        id: projectId,
        name: meta.name || '未命名项目',
        createdAt: meta.createdAt,
      });
      state.workspace.projects.push(project);
      state.dirtyProjects.add(projectId);
      return true;
    }
    if (!force && (project.updatedAt || 0) >= updatedAt) return false;
    if (deleted) {
      project.deleted = true;
      // 当前项目被其它设备删除：回退到一个可用项目
      if (project.id === state.workspace.activeProjectId) ensureProjects(state.workspace);
    } else {
      project.name = meta.name || project.name;
      project.createdAt = meta.createdAt || project.createdAt;
    }
    project.updatedAt = updatedAt;
    state.dirtyProjects.add(projectId);
    return true;
  }

  /* ---------- 项目数据 ---------- */
  let project = findProject(projectId);
  if (!project) {
    // 项目元数据可能还没拉回来，先建占位项目；后续 project 实体会补上名称
    project = normalizeProject({ id: projectId, name: '未命名项目' });
    state.workspace.projects.push(project);
    state.dirtyProjects.add(projectId);
  }

  if (kind === 'globals') {
    if (force || (project.globalsUpdatedAt || 0) < updatedAt) {
      project.globals = ent.data || [];
      project.globalsUpdatedAt = updatedAt;
      if (project.id === state.workspace.activeProjectId) {
        state.workspace.globals = project.globals;
        state.workspace.globalsUpdatedAt = updatedAt;
      }
      state.dirtyProjects.add(project.id);
      return true;
    }
    return false;
  }

  const listKey = DATA_LIST_KEY[kind];
  if (!listKey) return false;
  const list = project[listKey] || (project[listKey] = []);
  const idx = list.findIndex((x) => x.id === id);
  if (idx < 0) {
    if (deleted) return false;
    list.push({ ...(ent.data || {}), id, deleted: false, updatedAt });
    if (kind === 'collection' && project.id === state.workspace.activeProjectId) state.expanded.add(id);
  } else if (!force && (list[idx].updatedAt || 0) >= updatedAt) {
    return false;
  } else if (deleted) {
    list[idx].deleted = true;
    list[idx].updatedAt = updatedAt;
  } else {
    list[idx] = { ...(ent.data || {}), id, deleted: false, updatedAt };
  }
  if (project.id !== state.workspace.activeProjectId) state.dirtyProjects.add(project.id);
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
  const project = activeProject();
  if (project) {
    for (const key of PROJECT_DATA_KEYS) {
      if (!Array.isArray(project[key])) project[key] = [];
      project[key].length = 0;
      ws[key] = project[key];
    }
    project.globalsUpdatedAt = 0;
    project.activeEnvId = null;
    state.dirtyProjects.add(project.id);
  } else {
    for (const key of PROJECT_DATA_KEYS) ws[key].length = 0;
  }
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
