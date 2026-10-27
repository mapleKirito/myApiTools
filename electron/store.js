'use strict';

/**
 * 本地数据仓（分区存储 + 项目隔离）
 * ---------------------------------------------------------------
 * 一个 profile 目录（本机 / 某个同步账号）下可以存在多个「项目」，每个项目
 * 拥有独立的集合、请求、环境、全局变量与历史记录；同步账号、更新渠道等
 * 本机偏好仍然属于 profile，所有项目共享。
 *
 * 存储形态：
 *   <profileDir>/projects.json          全部项目（含各自的数据）
 *   <profileDir>/meta.json              { version, updatedAt, activeProjectId, settings }
 *
 * 兼容旧数据：升级前 profile 目录里直接放的是 collections.json / requests.json
 * 等分区文件，没有 projects.json。首次加载会把它们整体包进默认项目
 * （prj_default），之后只写 projects.json，旧分区文件原样留在那里作为兜底。
 *
 * 主进程持有唯一写入口，渲染进程只能通过 IPC 读写，避免并发写坏文件。
 * 备份策略沿用旧实现：每次 load() 把上一次会话的最终状态快照到 backup/，
 * 日常 flush 只做 tmp+rename 原子替换。
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PROJECT_ID = 'prj_default';
const DEFAULT_PROJECT_NAME = '默认项目';

const PARTITION_FILES = {
  projects: 'projects.json',
  collections: 'collections.json',
  requests: 'requests.json',
  environments: 'environments.json',
  globals: 'globals.json',
  history: 'history.json',
  meta: 'meta.json',
};
const LEGACY_DATA_KEYS = ['collections', 'requests', 'environments', 'globals', 'history'];
const PARTITION_KEYS = Object.keys(PARTITION_FILES);
const SNAPSHOT_KEEP = 5;

const EMPTY_WORKSPACE = () => ({
  version: 1,
  activeProjectId: DEFAULT_PROJECT_ID,
  projects: [],
  collections: [],
  requests: [],
  environments: [],
  globals: [],
  globalsUpdatedAt: 0,
  history: [],
  settings: {
    timeout: 30000,
    followRedirects: true,
    verifyTls: true,
    maxRedirects: 10,
    historyLimit: 300,
    concurrency: 5,
    theme: 'dark',
    activeEnvId: null,
    sync: {
      enabled: false,
      serverUrl: '',
      token: '',
      email: '',
      lastRev: 0,
      lastSyncAt: 0,
      autoSync: true,
      deviceName: '',
      accountKey: '',
    },
    update: {
      channel: 'stable',
      ignoredVersion: '',
      lastCheckAt: 0,
      lastKnownVersion: '',
    },
  },
  updatedAt: Date.now(),
});

/** 新建一个空项目记录 */
function createProjectRecord(id, name) {
  const now = Date.now();
  return {
    id: id || 'prj_' + Math.random().toString(36).slice(2, 10),
    name: name || '新项目',
    createdAt: now,
    updatedAt: now,
    deleted: false,
    collections: [],
    requests: [],
    environments: [],
    globals: [],
    globalsUpdatedAt: 0,
    history: [],
    activeEnvId: null,
    // 项目级服务注册，跨环境共享
    serviceUrls: [
      { id: 'svc_default', name: '默认', url: '', isDefault: true },
    ],
  };
}

/** 单个项目结构补全：保证老数据 / 导入数据里缺的字段都有默认值 */
function normalizeProject(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const base = createProjectRecord(raw.id, raw.name);
  const out = { ...base, ...raw };
  out.id = String(raw.id || base.id);
  out.name = String(raw.name || base.name);
  out.createdAt = Number(raw.createdAt) || base.createdAt;
  out.updatedAt = Number(raw.updatedAt) || out.createdAt;
  out.deleted = !!raw.deleted;
  for (const key of LEGACY_DATA_KEYS) {
    out[key] = Array.isArray(raw[key]) ? raw[key] : [];
  }
  out.globalsUpdatedAt = Number(raw.globalsUpdatedAt) || 0;
  out.activeEnvId = raw.activeEnvId === undefined ? null : raw.activeEnvId || null;
  return out;
}

/** 项目列表去重 + 结构补全 */
function normalizeProjects(list) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== 'object') continue;
    const p = normalizeProject(item);
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

/**
 * 保证工作区至少有一个项目，并把当前激活项目的数据挂到工作区顶层。
 * 渲染进程 / 旧版代码都按 workspace.collections 这类顶层字段访问数据，
 * 这里让顶层数组与项目记录共享同一个数组引用，改一处即两处同时生效。
 */
function ensureProjects(data) {
  if (!Array.isArray(data.projects) || !data.projects.length) {
    const p = createProjectRecord(DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME);
    for (const key of LEGACY_DATA_KEYS) {
      p[key] = Array.isArray(data[key]) ? data[key] : [];
    }
    p.globalsUpdatedAt = Number(data.globalsUpdatedAt) || 0;
    p.activeEnvId = data.settings && data.settings.activeEnvId ? data.settings.activeEnvId : null;
    data.projects = [p];
  }
  if (!data.projects.some((p) => p.id === data.activeProjectId && !p.deleted)) {
    const first = data.projects.find((p) => !p.deleted) || data.projects[0];
    data.activeProjectId = first.id;
  }
  const active = data.projects.find((p) => p.id === data.activeProjectId) || data.projects[0];
  for (const key of LEGACY_DATA_KEYS) {
    if (!Array.isArray(active[key])) active[key] = [];
    data[key] = active[key];
  }
  data.globalsUpdatedAt = Number(active.globalsUpdatedAt) || 0;
  data.settings.activeEnvId = active.activeEnvId || null;
  return active;
}

class WorkspaceStore {
  constructor(dir) {
    this.dir = dir;
    this.data = null;
    this.dirty = new Set(); // 待落盘的分区 key
    this.writeTimer = null;
    this.backupDir = path.join(dir, 'backup');
  }

  partitionPath(key) {
    return path.join(this.dir, PARTITION_FILES[key]);
  }

  /** 读取工作区；没有 projects.json 时把旧分区数据迁移进默认项目 */
  load() {
    if (this.data) return this.data;
    fs.mkdirSync(this.dir, { recursive: true });

    // 兼容更旧的单文件 workspace.json
    const legacy = path.join(this.dir, 'workspace.json');
    if (fs.existsSync(legacy) && !fs.existsSync(this.partitionPath('meta'))) {
      try {
        const parsed = JSON.parse(fs.readFileSync(legacy, 'utf8'));
        this.data = this.migrate(parsed);
        this.dirty = new Set(['projects', 'meta']);
        this.flush();
        try { fs.renameSync(legacy, legacy + '.imported-' + Date.now()); } catch { /* ignore */ }
      } catch (e) {
        // 旧文件损坏：留档后当作空工作区
        try { fs.renameSync(legacy, legacy + '.corrupt-' + Date.now()); } catch { /* ignore */ }
      }
    }

    if (!this.data) {
      const data = EMPTY_WORKSPACE();
      const snap = this._readSnapshot();
      let needFlush = false;

      /* ---------- meta：设置与激活项目 ---------- */
      const metaFile = this.partitionPath('meta');
      if (fs.existsSync(metaFile)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
          data.version = parsed.version || 1;
          data.updatedAt = parsed.updatedAt || Date.now();
          data.activeProjectId = parsed.activeProjectId || DEFAULT_PROJECT_ID;
          data.settings = { ...EMPTY_WORKSPACE().settings, ...(parsed.settings || {}) };
          data.settings.sync = {
            ...EMPTY_WORKSPACE().settings.sync,
            ...((parsed.settings || {}).sync || {}),
          };
          data.settings.update = {
            ...EMPTY_WORKSPACE().settings.update,
            ...((parsed.settings || {}).update || {}),
          };
        } catch (e) {
          console.error('[store] meta 读取失败，尝试快照恢复:', e.message);
          if (snap && snap.settings) {
            data.settings = snap.settings;
            data.activeProjectId = snap.activeProjectId || DEFAULT_PROJECT_ID;
          }
        }
      }

      /* ---------- projects：新格式；没有则从旧分区迁移 ---------- */
      const projectsFile = this.partitionPath('projects');
      let projects = null;
      if (fs.existsSync(projectsFile)) {
        try {
          projects = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
        } catch (e) {
          console.error('[store] projects 读取失败，尝试旧分区迁移:', e.message);
          if (snap && Array.isArray(snap.projects)) projects = snap.projects;
        }
      }

      if (Array.isArray(projects) && projects.length) {
        data.projects = normalizeProjects(projects);
      } else {
        // 旧数据：profile 目录下的顶层分区文件，整体收进默认项目
        for (const key of LEGACY_DATA_KEYS) {
          const file = this.partitionPath(key);
          if (!fs.existsSync(file)) continue;
          try {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
            data[key] = Array.isArray(parsed) ? parsed : [];
          } catch (e) {
            console.error(`[store] 旧分区 ${key} 读取失败:`, e.message);
            if (snap && Array.isArray(snap[key])) data[key] = snap[key];
          }
        }
        data.projects = [];
        data.activeProjectId = DEFAULT_PROJECT_ID;
        needFlush = true;
      }

      this.data = data;
      ensureProjects(this.data);
      if (needFlush) {
        this.dirty.add('projects');
        this.dirty.add('meta');
        this.flush();
      }
    }

    // 上一次会话的最终状态快照（仅用于极端损坏恢复，不是每次 flush 都做）
    this._writeSnapshot();
    return this.data;
  }

  /** 结构补全，保证老版本文件 / 备份能被新版本读取 */
  migrate(input) {
    const base = EMPTY_WORKSPACE();
    if (!input || typeof input !== 'object') return base;
    const out = { ...base, ...input };
    out.settings = { ...base.settings, ...(input.settings || {}) };
    out.settings.sync = { ...base.settings.sync, ...((input.settings || {}).sync || {}) };
    out.settings.update = { ...base.settings.update, ...((input.settings || {}).update || {}) };

    if (Array.isArray(input.projects) && input.projects.length) {
      out.projects = normalizeProjects(input.projects);
    } else {
      // 旧备份没有 projects 字段：整体包进默认项目
      const p = createProjectRecord(DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME);
      for (const key of LEGACY_DATA_KEYS) {
        p[key] = Array.isArray(input[key]) ? input[key] : [];
      }
      p.globalsUpdatedAt = Number(input.globalsUpdatedAt) || 0;
      p.activeEnvId = out.settings.activeEnvId || null;
      out.projects = [p];
    }
    out.activeProjectId = input.activeProjectId || out.projects[0].id;
    ensureProjects(out);
    return out;
  }

  /** 整体替换（导入备份 / 账号认领） */
  replace(next) {
    this.data = this.migrate(next);
    this.data.updatedAt = Date.now();
    this.dirty = new Set(['projects', 'meta']);
    this.scheduleFlush();
    return { ok: true, updatedAt: this.data.updatedAt, activeProjectId: this.data.activeProjectId };
  }

  /**
   * 合并式写入。
   *   · settings / activeProjectId → meta.json
   *   · collections 等顶层数组 → 当前项目（随后整体写 projects.json）
   *   · projects 数组 → 全量项目（切换 / 新建项目时用）
   */
  patch(partial) {
    const data = this.load();
    const input = partial && typeof partial === 'object' ? partial : {};

    /* 先落项目结构：后面写 settings / 顶层数组时必须作用在「新的」活动项目上 */
    if (Array.isArray(input.projects)) {
      data.projects = normalizeProjects(input.projects);
      this.dirty.add('projects');
    }
    if (input.activeProjectId !== undefined
      && data.projects.some((p) => p.id === input.activeProjectId && !p.deleted)) {
      data.activeProjectId = input.activeProjectId;
    }
    ensureProjects(data);
    this.dirty.add('meta');

    for (const key of Object.keys(input)) {
      if (key === 'projects' || key === 'activeProjectId') continue;
      if (key === 'settings') {
        data.settings = { ...data.settings, ...(input.settings || {}) };
        data.settings.sync = { ...data.settings.sync, ...((input.settings || {}).sync || {}) };
        data.settings.update = { ...data.settings.update, ...((input.settings || {}).update || {}) };
        if (input.settings && input.settings.activeEnvId !== undefined) {
          const active = ensureProjects(data);
          active.activeEnvId = input.settings.activeEnvId || null;
          this.dirty.add('projects');
        }
        this.dirty.add('meta');
      } else if (key === 'version' || key === 'updatedAt') {
        data[key] = input[key];
        this.dirty.add('meta');
      } else if (LEGACY_DATA_KEYS.includes(key) && Array.isArray(input[key])) {
        const active = ensureProjects(data);
        active[key] = input[key];
        data[key] = input[key];
        this.dirty.add('projects');
      }
    }
    data.updatedAt = Date.now();
    this.dirty.add('meta');
    this.scheduleFlush();
    return { ok: true, updatedAt: data.updatedAt, activeProjectId: data.activeProjectId };
  }

  scheduleFlush() {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (!this.data || this.dirty.size === 0) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      for (const key of this.dirty) {
        const payload = key === 'meta'
          ? {
              version: this.data.version,
              updatedAt: this.data.updatedAt,
              activeProjectId: this.data.activeProjectId,
              settings: this.data.settings,
            }
          : key === 'projects'
            ? this.data.projects
            : this.data[key];
        const tmp = this.partitionPath(key) + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
        fs.renameSync(tmp, this.partitionPath(key));
      }
      this.dirty.clear();
    } catch (e) {
      console.error('[store] 写入失败:', e.message);
    }
  }

  /** 导出为可移植的 JSON 字符串（包含全部项目） */
  exportJSON() {
    return JSON.stringify(this.snapshot(), null, 2);
  }

  snapshot() {
    const data = this.load();
    return {
      version: data.version,
      updatedAt: data.updatedAt,
      activeProjectId: data.activeProjectId,
      projects: data.projects,
      settings: data.settings,
    };
  }

  /* ----------------------------- 快照备份 ----------------------------- */
  _writeSnapshot() {
    try {
      fs.mkdirSync(this.backupDir, { recursive: true });
      const file = path.join(this.backupDir, `snapshot-${Date.now()}.json`);
      fs.writeFileSync(file, JSON.stringify(this.data), 'utf8');
      const files = fs.readdirSync(this.backupDir)
        .filter((f) => f.startsWith('snapshot-') && f.endsWith('.json'))
        .map((f) => ({ f, t: Number(f.slice('snapshot-'.length, -'.json'.length)) }))
        .filter((x) => !Number.isNaN(x.t))
        .sort((a, b) => b.t - a.t);
      for (const x of files.slice(SNAPSHOT_KEEP)) {
        try { fs.rmSync(path.join(this.backupDir, x.f), { force: true }); } catch { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
  }

  _readSnapshot() {
    try {
      const files = fs.readdirSync(this.backupDir)
        .filter((f) => f.startsWith('snapshot-') && f.endsWith('.json'))
        .map((f) => ({ f, t: Number(f.slice('snapshot-'.length, -'.json'.length)) }))
        .filter((x) => !Number.isNaN(x.t))
        .sort((a, b) => b.t - a.t);
      if (!files.length) return null;
      return JSON.parse(fs.readFileSync(path.join(this.backupDir, files[0].f), 'utf8'));
    } catch { return null; }
  }
}

module.exports = {
  WorkspaceStore,
  EMPTY_WORKSPACE,
  PARTITION_KEYS,
  DEFAULT_PROJECT_ID,
  DEFAULT_PROJECT_NAME,
};
