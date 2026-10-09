'use strict';

/**
 * 多用户 profile 管理
 * ---------------------------------------------------------------
 * 工作区按 profile 隔离到不同子目录：
 *   <userData>/profiles.json              { active, profiles: [...] }
 *   <userData>/profiles/local/            未登录（本机）工作区，常驻
 *   <userData>/profiles/acc-<hash>/       某个同步账号的工作区
 *
 * 设计要点：
 *   · 登录 ≠ 覆盖本机数据，而是「切换当前激活的 profile 目录」；local 永远保留。
 *   · 同步/请求/渲染逻辑完全不感知 profile，它们只读写「当前激活的 WorkspaceStore」。
 *   · 切换只在 flush 当前 → 修改 active 指针 → load 目标 这三步发生，单写入口不变。
 *
 * 关于「从未登录 → 新用户」的过渡：这一层只负责把本地内容真正搬进新账号
 * 目录（claimLocalInto），至于「该不该提示用户」，由渲染进程 sync.js 判定后
 * 再决定是否调用本方法，职责不混。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WorkspaceStore, EMPTY_WORKSPACE } = require('./store');

const LOCAL_ID = 'local';

function accountId(serverUrl, email) {
  const key = `${serverUrl || ''}|${email || ''}`.toLowerCase();
  return 'acc-' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
}

class ProfileManager {
  constructor(userData) {
    this.userData = userData;
    this.baseDir = path.join(userData, 'profiles');
    this.metaFile = path.join(userData, 'profiles.json');
    this.stores = new Map(); // id -> WorkspaceStore（懒加载）
    this.meta = { active: LOCAL_ID, profiles: [] };
    this._loadMeta();
    this._migrateLegacy();
  }

  _loadMeta() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.metaFile, 'utf8'));
      if (parsed && typeof parsed === 'object') this.meta = parsed;
    } catch { /* 无元数据则使用默认 */ }
    if (!Array.isArray(this.meta.profiles)) this.meta.profiles = [];
    if (!this.meta.profiles.some((p) => p.id === LOCAL_ID)) {
      this.meta.profiles.unshift({ id: LOCAL_ID, kind: 'local', label: '本机', createdAt: Date.now() });
    }
    this.activeId = this.meta.active || LOCAL_ID;
  }

  _saveMeta() {
    try {
      fs.mkdirSync(this.userData, { recursive: true });
      const tmp = this.metaFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.meta), 'utf8');
      fs.renameSync(tmp, this.metaFile);
    } catch (e) {
      console.error('[profile] 元数据保存失败:', e.message);
    }
  }

  /** 旧版：根目录存在单文件 workspace.json 且还没有 profiles.json → 迁移进 local */
  _migrateLegacy() {
    const legacy = path.join(this.userData, 'workspace.json');
    if (!fs.existsSync(this.metaFile) && fs.existsSync(legacy)) {
      try {
        const localDir = path.join(this.baseDir, LOCAL_ID);
        fs.mkdirSync(localDir, { recursive: true });
        // 直接把旧文件移进 local profile 目录，再由 local store 的 load() 拆分成分区，
        // 避免根目录残留一份已被取代的旧数据
        fs.renameSync(legacy, path.join(localDir, 'workspace.json'));
        this._saveMeta();
      } catch (e) {
        console.error('[profile] 旧数据迁移失败:', e.message);
      }
    }
  }

  profileDir(id) {
    return path.join(this.baseDir, id);
  }

  _store(id) {
    if (!this.stores.has(id)) {
      this.stores.set(id, new WorkspaceStore(this.profileDir(id)));
    }
    return this.stores.get(id);
  }

  _ensureProfile(rec) {
    const existing = this.meta.profiles.find((p) => p.id === rec.id);
    if (!existing) this.meta.profiles.push(rec);
    else Object.assign(existing, rec);
    this._saveMeta();
    return this._store(rec.id);
  }

  getActive() {
    return this._store(this.activeId);
  }

  list() {
    return this.meta.profiles.map((p) => ({
      id: p.id,
      kind: p.kind,
      label: p.label || (p.kind === 'local' ? '本机' : p.email || p.id),
      email: p.email || '',
      serverUrl: p.serverUrl || '',
      active: p.id === this.activeId,
    }));
  }

  /** 切到指定 profile（无则按 serverUrl+email 新建账号 profile 再切） */
  async switchTo(arg) {
    let id = typeof arg === 'string' ? arg : (arg && arg.id);
    if (!id && arg && arg.serverUrl && arg.email) {
      id = accountId(arg.serverUrl, arg.email);
      if (!this.meta.profiles.some((p) => p.id === id)) {
        this._ensureProfile({
          id, kind: 'account', label: arg.email, email: arg.email,
          serverUrl: arg.serverUrl, createdAt: Date.now(),
        });
      }
    }
    if (!this.meta.profiles.some((p) => p.id === id)) throw new Error('未知 profile: ' + id);
    this.getActive().flush();
    this.activeId = id;
    this.meta.active = id;
    this._saveMeta();
    return this.getActive().load();
  }

  /**
   * 把本地内容「认领」给新账号 / 或保留本地、账号从空开始。
   * claim=true ：本地 collections/requests/environments/globals/history/settings 整体搬进
   *              账号 profile，本地清空（local 状态变成空），内容视作新账号内容。
   * claim=false：账号 profile 从空开始，本地原有内容原样保留（仅切到空账号）。
   * @returns {object} 目标（账号）profile 的工作区
   */
  async claimLocalInto({ serverUrl, email, claim }) {
    const id = accountId(serverUrl, email);
    const local = this._store(LOCAL_ID);
    const acc = this._ensureProfile({
      id, kind: 'account', label: email, email, serverUrl, createdAt: Date.now(),
    });
    local.flush();
    const localData = local.data || local.load();

    if (claim) {
      acc.replace(localData);
      acc.flush();
      local.replace(EMPTY_WORKSPACE());
      local.flush();
    } else {
      acc.flush(); // 确保空账号 profile 落盘
    }

    this.activeId = id;
    this.meta.active = id;
    this._saveMeta();
    return acc.load();
  }

  /** 退出登录：清当前账号令牌，切回 local profile（账号 profile 数据保留，便于再登录） */
  async logoutToLocal() {
    const cur = this.getActive();
    cur.flush();
    if (cur.data && cur.data.settings) {
      cur.data.settings.sync = {
        ...cur.data.settings.sync,
        token: '', enabled: false, lastRev: 0, lastSyncAt: 0,
      };
      cur.dirty.add('meta');
      cur.flush();
    }
    this.activeId = LOCAL_ID;
    this.meta.active = LOCAL_ID;
    this._saveMeta();
    return this.getActive().load();
  }
}

module.exports = { ProfileManager, accountId, LOCAL_ID };
