/**
 * 同步引擎
 * ---------------------------------------------------------------
 * 远端只负责「保存 + 分发请求配置」，这里做的是纯数据对齐：
 *   1. 把本地脏实体推上去（后写覆盖）
 *   2. 从上次水位之后增量拉取远端变更
 *   3. 冲突以服务端版本为准并回报提示
 *
 * 账号相关的编排也在这里（登录框本身在 ui/authModal.js）：
 *   · 配了服务地址但没凭证 → 弹登录/注册框，登录成功再继续同步
 *   · 服务端回 401/403 → 清掉本机失效凭证，弹框重新登录
 *   · 换账号登录 → 先让用户决定本机配置怎么处理，再重置水位
 */

import {
  state,
  bus,
  dirtyEntities,
  allSyncEntities,
  applyRemoteEntity,
  clearDirty,
  setSyncState,
  saveNow,
  reloadWorkspace,
} from './state.js';
import { toast, toastErr, toastOk, toastWarn } from './ui/feedback.js';
import { openAuthModal, confirmLocalClaim } from './ui/authModal.js';
import { debounce, formatRelative } from './helpers.js';

const bridge = window.bridge;

export const syncCfg = () => state.workspace.settings.sync;
export const isConfigured = () => {
  const s = syncCfg();
  return !!(s.serverUrl && s.token);
};

/* ------------------------------ 状态广播 ------------------------------ */
export function setStatus(kind, message = '') {
  bus.emit('sync-status', { kind, message });
}

/* ------------------------------ 连接与账号 ------------------------------ */
export async function testServer(serverUrl) {
  return bridge.sync.health(serverUrl);
}

/** 清掉本机登录凭证，但保留服务地址与账号记录，方便用户直接重登 */
export function clearToken() {
  setSyncState({ token: '' });
  saveNow();
}

/**
 * 退出登录：先尽力通知服务端吊销令牌（不可达也不阻塞），再清当前账号的本地凭证，
 * 并把工作区切回「本机（local）」profile。账号 profile 的数据保留在它自己的目录，
 * 以便再次登录时直接切回，不会丢内容。
 */
export async function signOut({ notifyServer = true } = {}) {
  const s = syncCfg();
  if (notifyServer && s.serverUrl && s.token) {
    await bridge.sync.logout({ serverUrl: s.serverUrl, token: s.token }).catch(() => null);
  }
  const { workspace } = await bridge.profile.logout();
  reloadWorkspace(workspace);
  setStatus('off', '未连接');
  toastOk('已退出登录，已切回本机工作区', '同步账号');
  bus.emit('change');
}

/* ------------------------------ 登录编排 ------------------------------ */
let authFlow = null;
let authLostNotified = false;

/** 同一个时刻只允许存在一个登录框，避免连点/自动同步弹出多个 */
export async function ensureAuth(reason = 'missing') {
  if (authFlow) return authFlow;
  const s = syncCfg();
  authFlow = (async () => {
    const res = await openAuthModal({
      serverUrl: s.serverUrl,
      email: s.email,
      deviceName: s.deviceName,
      reason,
    });
    if (!res) return null;
    return adoptLogin(res);
  })();
  try {
    return await authFlow;
  } finally {
    authFlow = null;
  }
}

/**
 * 登录/注册成功后编排工作区归属。
 *
 * 多用户模型下，每个账号是一个独立的 profile 目录，互相隔离，因此不再需要
 * 「保留/清空本机」的二选一。唯一需要用户拍板的场景是「本地未登录内容 → 全新用户」：
 *   本机没有该账号的 profile 记录，且服务端也没有任何数据 —— 说明这是一个新用户。
 *   这时弹 confirmLocalClaim，让用户主动决定把 local 这份内容认领给新账号（local 清空、
 *   内容归新账号并上传），还是保留 local、新账号从空开始。
 * 其余情况（本机已有该账号 profile / 远端已有数据的新设备）直接切到对应 profile 并同步。
 *
 * @returns {Promise<null | {switched:boolean, choice:'keep'|'clear'|null, email:string, mode:string}>}
 */
async function adoptLogin(res) {
  const serverUrl = res.serverUrl;
  const email = String(res.email || '').trim();
  const token = res.token;
  const mode = res.mode; // 'login' | 'register'

  // 本机是否已有该账号的 profile
  const profiles = await bridge.profile.list();
  const hasProfile = profiles.some(
    (p) => p.kind === 'account' && p.email === email && p.serverUrl === serverUrl
  );

  // 分辨「全新用户」：本地无记录 且 远端也无数据
  let isNewUser = !hasProfile;
  if (isNewUser) {
    let remoteEmpty = false;
    if (mode === 'register') {
      remoteEmpty = true; // 刚注册，服务端必然为空
    } else {
      // login 但本机无 profile：探测远端是否真的空（一次 since:0 的拉取）
      try {
        const probe = await bridge.sync.pull({ cfg: { serverUrl, token }, since: 0 });
        remoteEmpty = probe.ok && ((probe.data.entities || []).length === 0) && !probe.data.hasMore;
      } catch {
        remoteEmpty = false;
      }
    }
    isNewUser = remoteEmpty;
  }

  if (isNewUser) {
    // 只有「当前激活的就是本机（local）工作区、且本机有内容」时才谈得上「把本机内容
    // 归属给新账号」。已经登录某账号 A 再切到新账号 B 时，A 的内容在它自己的 profile
    // 里，绝不参与这次归属，直接切到 B 的空 profile 即可 —— 否则会误把 A 的内容当成
    // local 内容弹归属框，甚至把 A 的内容「丢」掉（切走后不再可见）。
    const activeIsLocal = (profiles.find((p) => p.active) || {}).kind === 'local';
    const localContent = activeIsLocal
      ? (state.workspace.collections.filter((c) => !c.deleted).length +
         state.workspace.requests.filter((r) => !r.deleted).length +
         state.workspace.environments.filter((e) => !e.deleted).length)
      : 0;

    // 当前不是本机工作区、或本机没有任何可认领内容 → 直接按新账号登录
    // （账号 profile 从空开始），不弹提示，也不动本机工作区
    if (!activeIsLocal || localContent === 0) {
      const { workspace } = await bridge.profile.switch({ serverUrl, email });
      reloadWorkspace(workspace);
      setSyncState({
        serverUrl, email, token, enabled: true, accountKey: email, lastRev: 0, lastSyncAt: 0,
      });
      toastOk(
        mode === 'register' ? `注册成功，已登录 ${email}` : `已登录 ${email}`,
        '同步账号'
      );
      bus.emit('change');
      return { switched: false, choice: null, email, mode };
    }

    const claim = await confirmLocalClaim({
      email,
      serverUrl,
      collections: state.workspace.collections.filter((c) => !c.deleted).length,
      requests: state.workspace.requests.filter((r) => !r.deleted).length,
      environments: state.workspace.environments.filter((e) => !e.deleted).length,
    });
    if (claim === null) {
      toastWarn('已取消登录，本机配置未做任何改动', '登录取消');
      return null;
    }
    // 把 local 这份内容认领给新账号（或保留 local、账号从空开始），并切到账号 profile
    const { workspace } = await bridge.profile.claimLocal({ serverUrl, email, claim: !!claim });
    reloadWorkspace(workspace);
    setSyncState({
      serverUrl, email, token, enabled: true, accountKey: email, lastRev: 0, lastSyncAt: 0,
    });
    toastOk(
      mode === 'register' ? `注册成功，已登录 ${email}` : `已登录 ${email}`,
      '同步账号'
    );
    bus.emit('change');
    // 认领 → 上传；不认领 → 拉取（远端为空，结果仍空）
    return { switched: true, choice: claim ? 'keep' : 'clear', email, mode };
  }

  // 非全新用户：切到对应 profile（本机已有则直接切，否则按 serverUrl+email 新建空 profile）并同步
  const { workspace } = await bridge.profile.switch({ serverUrl, email });
  reloadWorkspace(workspace);
  setSyncState({
    serverUrl, email, token, enabled: true, accountKey: email, lastRev: 0, lastSyncAt: 0,
  });
  toastOk(`已登录 ${email}`, '同步账号');
  bus.emit('change');
  return { switched: false, choice: null, email, mode };
}

/** 登录失效只用提示一次，避免静默自动同步每次都弹 */
function notifyAuthLost(reason) {
  if (authLostNotified) return;
  authLostNotified = true;
  const msg = reason === 'disabled'
    ? '该账号已被服务端管理员禁用，同步已暂停'
    : '登录已失效，同步已暂停';
  toastWarn(`${msg}。点右上角「同步」按钮可重新登录。`, '需要重新登录');
}

/** 启动时校验一次本地令牌是否还有效，避免状态栏一直显示「已登录」 */
async function probeToken() {
  const s = syncCfg();
  if (!s.serverUrl || !s.token) return;
  const res = await bridge.sync.me({ serverUrl: s.serverUrl, token: s.token });
  if (res.ok) return;
  if (res.status === 401 || res.status === 403) {
    const reason = res.code === 'ACCOUNT_DISABLED' ? 'disabled' : 'expired';
    clearToken();
    setStatus('auth', reason === 'disabled' ? '账号被禁用' : '登录已失效');
    notifyAuthLost(reason);
  }
  // 其它错误（比如服务没开）不改变登录状态，交给同步流程报错
}

/* ------------------------------ 同步主流程 ------------------------------ */
let running = false;

/**
 * @param {'both'|'push'|'pull'|'pushAll'} mode
 *   both    双向（默认）：先推本地改动，再拉远端增量
 *   push    只上传本地改动
 *   pull    只下载远端（增量）
 *   pushAll 全量上传本地（首次迁移 / 换账号时把本机配置带过去）
 * @param {object} opts { silent, forcePull }
 */
export async function syncNow(mode = 'both', opts = {}) {
  const { silent = false, forcePull = false } = opts;
  const s = syncCfg();

  if (!s.serverUrl) {
    if (!silent) toastWarn('尚未配置同步服务地址', '无法同步');
    setStatus('off', '未连接');
    return { ok: false, reason: 'no-server' };
  }

  /* ---------- 没有凭证：先登录，登录完接着同步 ---------- */
  if (!s.token) {
    setStatus('auth', '待登录同步账号');
    // 静默自动同步不抢焦点，只把状态点亮，等用户主动触发
    if (silent) return { ok: false, reason: 'auth-required' };

    const auth = await ensureAuth('missing');
    if (!auth) return { ok: false, reason: 'auth-cancelled' };
    return syncAfterAuth(auth, mode, { silent });
  }

  if (running) {
    if (!silent) toastWarn('上一次同步还在进行中');
    return { ok: false, reason: 'busy' };
  }

  const result = await runSync(mode, { silent, forcePull });

  /* ---------- 凭证失效：清掉本机凭证并重新登录 ---------- */
  if (result.reason === 'auth-required') {
    if (silent) {
      notifyAuthLost(result.authReason);
      return result;
    }
    const auth = await ensureAuth(result.authReason || 'expired');
    if (!auth) return result;
    return syncAfterAuth(auth, mode, { silent });
  }

  return result;
}

/**
 * 登录成功后接着同步。
 * 「换了账号」的情况下水位已被清零，本机数据的处理方式取决于用户在
 * 归属确认框里的选择：
 *   · 清空本机 → 只拉取新账号的云端配置（forcePull，从 0 号水位重来）
 *   · 保留本机 → 全量上传，把本机内容一并带到新账号名下
 * @param {null | {switched:boolean, choice:'keep'|'clear'|null}} auth
 */
export function syncAfterAuth(auth, mode = 'both', opts = {}) {
  if (!auth) return Promise.resolve({ ok: false, reason: 'auth-cancelled' });
  const switched = !!auth.switched;
  const cleared = switched && auth.choice === 'clear';
  const nextMode = switched ? (cleared ? 'pull' : 'pushAll') : mode;
  return syncNow(nextMode, { ...opts, forcePull: cleared });
}

/** 真正的同步动作（不含账号编排），保证 running 标志在任何路径下都能复位 */
async function runSync(mode, { silent, forcePull }) {
  const s = syncCfg();
  running = true;
  state.syncing = true;
  setStatus('syncing', '同步中…');
  bus.emit('sync-state');

  const cfg = { serverUrl: s.serverUrl, token: s.token };
  let pushed = 0;
  let pulled = 0;
  let changed = 0;
  let conflictCount = 0;

  try {
    /* ---------- 上传 ---------- */
    if (mode === 'both' || mode === 'push' || mode === 'pushAll') {
      const entities = mode === 'pushAll' ? allSyncEntities() : dirtyEntities();
      if (entities.length) {
        const res = await bridge.sync.push({ cfg, entities, clientRev: s.lastRev });
        if (!res.ok) throw withStatus(res);
        pushed = res.data.applied || 0;
        const conflicts = res.data.conflicts || [];
        conflictCount = conflicts.length;
        for (const c of conflicts) {
          applyRemoteEntity(
            { kind: c.kind, id: c.id, updatedAt: c.serverUpdatedAt, deleted: c.serverDeleted, data: c.serverData },
            { force: true }
          );
        }
        if (conflicts.length) changed += conflicts.length;
        clearDirty(entities.map((e) => `${e.kind}:${e.id}`));
      }
    }

    /* ---------- 下载 ---------- */
    if (mode === 'both' || mode === 'pull' || mode === 'pushAll') {
      const force = forcePull || mode === 'pull';
      let rev = mode === 'pull' && forcePull ? 0 : s.lastRev || 0;
      for (let guard = 0; guard < 200; guard++) {
        const res = await bridge.sync.pull({ cfg, since: rev });
        if (!res.ok) throw withStatus(res);
        const list = res.data.entities || [];
        for (const ent of list) {
          pulled += 1;
          if (applyRemoteEntity(ent, { force })) changed += 1;
        }
        rev = res.data.rev ?? rev;
        if (!res.data.hasMore || list.length === 0) break;
      }
      setSyncState({ lastRev: rev, lastSyncAt: Date.now() });
    }

    setStatus('ok', '已同步 ' + formatRelative(Date.now()));
    if (!silent) {
      const bits = [];
      if (pushed) bits.push(`上传 ${pushed} 项`);
      if (pulled) bits.push(`拉取 ${pulled} 项`);
      if (!bits.length) bits.push('数据已是最新');
      if (conflictCount) {
        toastWarn(`${bits.join('，')}。其中 ${conflictCount} 项与其它设备冲突，已采用远端版本。`, '同步完成');
      } else {
        toastOk(bits.join('，'), '同步完成');
      }
    }
    bus.emit('change');
    return { ok: true, pushed, pulled, changed, conflicts: conflictCount };
  } catch (e) {
    const status = e.status || 0;
    const code = e.code || null;

    if (status === 401 || status === 403) {
      const authReason = code === 'ACCOUNT_DISABLED' ? 'disabled' : code === 'AUTH_EXPIRED' ? 'expired' : 'invalid';
      clearToken();
      setStatus('auth', authReason === 'disabled' ? '账号被禁用' : '登录已失效');
      return { ok: false, reason: 'auth-required', authReason, error: e.message };
    }

    const msg = e.message || String(e);
    setStatus('error', '同步失败');
    if (!silent) toastErr(msg, '同步失败');
    return { ok: false, error: msg };
  } finally {
    running = false;
    state.syncing = false;
    bus.emit('sync-state');
  }
}

/** IPC 返回体是摊平的错误对象，这里还原成一个带 status/code 的 Error */
function withStatus(res) {
  const err = new Error(res.message || '同步失败');
  err.status = res.status || 0;
  err.code = res.code || null;
  return err;
}

/* ------------------------------ 自动同步 ------------------------------ */
const autoSync = debounce(() => {
  const s = syncCfg();
  // 没登录时不在这里弹框：静默同步只把状态点亮，交互交给用户主动触发
  if (!s.enabled || !s.autoSync || !s.token || !s.serverUrl) return;
  syncNow('both', { silent: true });
}, 5000);

export function initSyncEngine() {
  bus.on('dirty', () => autoSync());

  const s = syncCfg();
  if (!s.serverUrl) {
    setStatus('off', '未连接');
    return;
  }
  if (!s.token) {
    setStatus('auth', '待登录同步账号');
    return;
  }

  setStatus('ok', s.lastSyncAt ? '已同步 ' + formatRelative(s.lastSyncAt) : '已登录');
  // 启动时轻量校验一次凭证，避免状态栏显示着「已登录」其实早已失效
  probeToken();
  if (s.enabled && s.autoSync) {
    setTimeout(() => syncNow('both', { silent: true }), 1500);
  }
}
