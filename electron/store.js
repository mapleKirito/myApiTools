'use strict';

/**
 * 本地数据仓（分区存储）
 * ---------------------------------------------------------------
 * 工作区被拆成多个 JSON 文件落地在 profile 目录下，每次只重写发生变化的
 * 分区，避免「改一个请求就整文件重写」带来的 I/O 放大。主进程持有唯一写
 * 入口，渲染进程只能通过 IPC 读写，避免并发写坏文件。
 *
 * 分区文件（均位于 profile 目录内）：
 *   collections.json / requests.json / environments.json
 *   globals.json      / history.json      / meta.json
 * 其中 meta.json 存 { version, updatedAt, settings }。
 *
 * 备份策略：不再每次 flush 都整文件拷贝（旧实现每次 flush 都 copyFile 整份再
 * 写 tmp+rename，文件稍大就主线程卡顿）。改为在每次 load() 时把「上一次会话的
 * 最终状态」快照到 backup/snapshot-<ts>.json（保留最近 N 份），仅用于极端损坏
 * 恢复；日常 flush 只做分区文件的 tmp+rename 原子替换。
 */

const fs = require('node:fs');
const path = require('node:path');

const PARTITION_FILES = {
  collections: 'collections.json',
  requests: 'requests.json',
  environments: 'environments.json',
  globals: 'globals.json',
  history: 'history.json',
  meta: 'meta.json',
};
const PARTITION_KEYS = Object.keys(PARTITION_FILES);
const SNAPSHOT_KEEP = 5;

const EMPTY_WORKSPACE = () => ({
  version: 1,
  collections: [],
  requests: [],
  environments: [],
  globals: [],
  history: [],
  settings: {
    timeout: 30000,
    followRedirects: true,
    verifyTls: true,
    maxRedirects: 10,
    historyLimit: 300,
    concurrency: 5,
    theme: 'dark',
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

  /** 读取工作区；profile 目录下无分区文件时尝试兼容旧单文件 workspace.json */
  load() {
    if (this.data) return this.data;
    fs.mkdirSync(this.dir, { recursive: true });

    // 兼容旧版：profile 目录下若存在单文件 workspace.json，则拆分导入
    const legacy = path.join(this.dir, 'workspace.json');
    if (fs.existsSync(legacy) && !fs.existsSync(this.partitionPath('meta'))) {
      try {
        const parsed = JSON.parse(fs.readFileSync(legacy, 'utf8'));
        this.data = this.migrate(parsed);
        this.dirty = new Set(PARTITION_KEYS);
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
      for (const key of PARTITION_KEYS) {
        const file = this.partitionPath(key);
        if (!fs.existsSync(file)) continue;
        try {
          const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (key === 'meta') {
            data.version = parsed.version || 1;
            data.updatedAt = parsed.updatedAt || Date.now();
            data.settings = { ...EMPTY_WORKSPACE().settings, ...(parsed.settings || {}) };
            data.settings.sync = {
              ...EMPTY_WORKSPACE().settings.sync,
              ...((parsed.settings || {}).sync || {}),
            };
            data.settings.update = {
              ...EMPTY_WORKSPACE().settings.update,
              ...((parsed.settings || {}).update || {}),
            };
          } else {
            data[key] = Array.isArray(parsed) ? parsed : [];
          }
        } catch (e) {
          // 单分区损坏：尽量从上一次会话快照恢复该分区，否则按空处理
          console.error(`[store] 分区 ${key} 读取失败，尝试快照恢复:`, e.message);
          if (snap) {
            if (key === 'meta') {
              data.version = snap.version || 1;
              data.updatedAt = snap.updatedAt || Date.now();
              data.settings = snap.settings || data.settings;
            } else if (Array.isArray(snap[key])) {
              data[key] = snap[key];
            }
          }
        }
      }
      this.data = data;
    }

    // 上一次会话的最终状态快照（仅用于极端损坏恢复，不是每次 flush 都做）
    this._writeSnapshot();
    return this.data;
  }

  /** 结构补全，保证老版本文件能被新版本读取 */
  migrate(input) {
    const base = EMPTY_WORKSPACE();
    if (!input || typeof input !== 'object') return base;
    const out = { ...base, ...input };
    for (const key of ['collections', 'requests', 'environments', 'globals', 'history']) {
      if (!Array.isArray(out[key])) out[key] = [];
    }
    out.settings = { ...base.settings, ...(input.settings || {}) };
    out.settings.sync = { ...base.settings.sync, ...((input.settings || {}).sync || {}) };
    out.settings.update = { ...base.settings.update, ...((input.settings || {}).update || {}) };
    return out;
  }

  /** 整体替换（渲染进程每次改动后回传全量快照） */
  replace(next) {
    this.data = this.migrate(next);
    this.data.updatedAt = Date.now();
    this.dirty = new Set(PARTITION_KEYS);
    this.scheduleFlush();
    return { ok: true, updatedAt: this.data.updatedAt };
  }

  /** 合并式写入，只覆盖指定分区，避免整体覆盖带来的竞态 */
  patch(partial) {
    const data = this.load();
    for (const key of Object.keys(partial || {})) {
      if (key === 'settings') {
        data.settings = { ...data.settings, ...(partial.settings || {}) };
        data.settings.sync = { ...data.settings.sync, ...((partial.settings || {}).sync || {}) };
        data.settings.update = { ...data.settings.update, ...((partial.settings || {}).update || {}) };
        this.dirty.add('meta');
      } else if (key === 'version' || key === 'updatedAt') {
        data[key] = partial[key];
        this.dirty.add('meta');
      } else if (Array.isArray(partial[key])) {
        data[key] = partial[key];
        this.dirty.add(key);
      }
    }
    data.updatedAt = Date.now();
    this.dirty.add('meta');
    this.scheduleFlush();
    return { ok: true, updatedAt: data.updatedAt };
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
          ? { version: this.data.version, updatedAt: this.data.updatedAt, settings: this.data.settings }
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

  /** 导出为可移植的 JSON 字符串（导入/导出功能用，保持旧的单文件结构） */
  exportJSON() {
    return JSON.stringify(this.load(), null, 2);
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

module.exports = { WorkspaceStore, EMPTY_WORKSPACE, PARTITION_KEYS };
