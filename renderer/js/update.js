/**
 * 客户端更新编排
 * ---------------------------------------------------------------
 * 触发时机只有两个：
 *   · 应用启动后，已连接服务端时静默查一次
 *   · 用户主动点「检查更新」（设置页 / 帮助菜单）
 *
 * 为什么更新检查要登录：服务端的 /api/releases/latest 与安装包下载都要求
 * 同步账号令牌，避免版本号和安装包被随意拉走。没登录时这里直接说明情况，
 * 不发请求，也不去打扰用户。
 *
 * 拿到新版本后交给 ui/updateModal.js 展示：下载 → 唤起系统安装程序。
 * 不做静默替换 —— 没有代码签名证书，硬做只会被系统拦下来。
 */

import { state, bus, saveNow } from './state.js';
import { syncCfg } from './sync.js';
import { toastErr, toastOk, toastWarn } from './ui/feedback.js';
import { openUpdateModal } from './ui/updateModal.js';

const bridge = window.bridge;

export const updateCfg = () => state.workspace.settings.update;

/** 运行时状态（不落盘：进度、错误这类东西重启就该忘掉） */
export const updateState = {
  status: 'idle',   // idle | login-required | checking | uptodate | available | downloading | downloaded | error
  current: '',
  latest: null,
  error: '',
  progress: null,   // { received, total, percent }
  filePath: '',
  size: 0,
  checkedAt: 0,
};

function emit() {
  bus.emit('update-state');
}

let infoCache = null;
/** 当前运行版本（来自仓库根目录 package.json，由 electron-builder 写入；与服务端版本号是两回事） */
export async function appInfo() {
  if (!infoCache) infoCache = await bridge.info();
  return infoCache;
}

/** 当前「有资格检查更新」的账号标识；未登录时为空串 */
function accountKey() {
  const s = syncCfg();
  return s.serverUrl && s.token ? (s.email || s.serverUrl) : '';
}

/** 换了账号，上一次的检查结果就不作数了 */
function resetResult() {
  updateState.latest = null;
  updateState.progress = null;
  updateState.filePath = '';
  updateState.size = 0;
  updateState.error = '';
  updateState.status = 'idle';
}

let lastAccount = null;

/**
 * 启动时把主进程推来的下载进度接过来，
 * 并在「本次运行期间才登录 / 换了账号」时补一次检查 ——
 * 用户很可能是在应用起来之后才去填服务地址、登录的。
 */
export function initUpdate() {
  bridge.update.onProgress((p) => {
    if (updateState.status !== 'downloading') return;
    updateState.progress = p;
    emit();
  });

  // 启动那一刻的账号状态由 scheduleStartupCheck 负责，这里只处理之后的变化
  lastAccount = accountKey();

  bus.on('sync-state', () => {
    emit();
    const key = accountKey();
    if (key === lastAccount) return;
    lastAccount = key;
    if (!key) return;   // 退登：没账号可查，也不需要提示

    resetResult();
    emit();
    setTimeout(() => checkForUpdate({ silent: true }), 1200);
  });
}

let checking = false;
let modalOpen = false;

/**
 * 检查更新
 * @param {{silent?:boolean}} opts silent 时不弹错误提示（启动时的自动检查用）
 */
export async function checkForUpdate({ silent = false } = {}) {
  const s = syncCfg();
  const u = updateCfg();

  if (!s.serverUrl) {
    updateState.status = 'idle';
    emit();
    if (!silent) toastWarn('还没配置同步服务地址，无法检查更新');
    return { ok: false, reason: 'no-server' };
  }
  if (!s.token) {
    updateState.status = 'login-required';
    updateState.error = '检查更新需要先登录同步账号';
    emit();
    if (!silent) toastWarn(updateState.error);
    return { ok: false, reason: 'auth-required' };
  }
  if (checking) return { ok: false, reason: 'busy' };

  checking = true;
  updateState.status = 'checking';
  updateState.error = '';
  emit();

  let res;
  try {
    const info = await appInfo();
    updateState.current = info.version;
    res = await bridge.update.check({
      serverUrl: s.serverUrl,
      token: s.token,
      channel: u.channel || 'stable',
      current: info.version,
    });
  } finally {
    checking = false;
  }

  updateState.checkedAt = Date.now();
  u.lastCheckAt = updateState.checkedAt;

  if (!res || !res.ok) {
    const authIssue = ['AUTH_REQUIRED', 'AUTH_INVALID', 'AUTH_EXPIRED', 'ACCOUNT_DISABLED']
      .includes(res && res.code);
    updateState.status = authIssue ? 'login-required' : 'error';
    updateState.error = (res && res.message) || '检查更新失败';
    saveNow();
    emit();
    // 令牌问题的提示交给同步那边去说，这里不重复刷屏幕
    if (!silent && !authIssue) toastErr(updateState.error);
    return { ok: false, reason: authIssue ? 'auth-required' : 'error', message: updateState.error };
  }

  const d = res.data || {};
  updateState.latest = d.latest || null;
  updateState.error = '';
  updateState.status = d.updateAvailable ? 'available' : 'uptodate';
  if (d.latest) u.lastKnownVersion = d.latest.version;
  saveNow();
  emit();

  if (!d.updateAvailable) {
    if (!silent) {
      toastOk(`已是最新版本 v${updateState.current}${d.latest ? '' : '（服务端还没有发布过客户端）'}`);
    }
    return { ok: true, available: false, latest: d.latest || null };
  }

  if (u.ignoredVersion === d.latest.version) {
    if (!silent) toastWarn(`发现新版本 v${d.latest.version}，但你之前选择过跳过`);
    return { ok: true, available: true, latest: d.latest, ignored: true };
  }

  promptUpdate();
  return { ok: true, available: true, latest: d.latest };
}

/** 弹出「发现新版本」窗口（同一时刻只允许一个） */
export function promptUpdate() {
  if (modalOpen || !updateState.latest) return;
  modalOpen = true;
  openUpdateModal({
    release: updateState.latest,
    current: updateState.current,
    subscribe: (fn) => bus.on('update-state', fn),
    getStatus: () => updateState.status,
    getProgress: () => updateState.progress,
    actions: {
      download: () => downloadUpdate(),
      install: () => installUpdate(),
      skip: () => ignoreVersion(updateState.latest && updateState.latest.version),
      reveal: () => revealDownload(),
    },
    onClose: () => { modalOpen = false; },
  });
}

export async function downloadUpdate() {
  const s = syncCfg();
  const rel = updateState.latest;
  if (!rel) return { ok: false, reason: 'no-release', message: '没有可下载的版本' };
  if (!s.serverUrl || !s.token) {
    updateState.status = 'login-required';
    updateState.error = '登录已失效，请重新登录后再下载';
    emit();
    return { ok: false, reason: 'auth-required', message: updateState.error };
  }

  updateState.status = 'downloading';
  updateState.error = '';
  updateState.progress = { received: 0, total: Number(rel.size) || 0, percent: 0 };
  emit();

  const res = await bridge.update.download({ serverUrl: s.serverUrl, token: s.token, release: rel });

  if (!res.ok) {
    updateState.status = 'error';
    updateState.error = res.message || '下载失败';
    updateState.progress = null;
    emit();
    return { ok: false, reason: 'error', message: updateState.error };
  }

  updateState.status = 'downloaded';
  updateState.filePath = res.data.filePath;
  updateState.size = res.data.size;
  updateState.error = '';
  emit();
  return { ok: true, ...res.data };
}

export async function installUpdate() {
  if (!updateState.filePath) {
    return { ok: false, message: '还没有下载好的安装包' };
  }
  const res = await bridge.update.install(updateState.filePath);
  if (!res.ok) {
    toastErr(res.message || '无法打开安装程序');
    return { ok: false, message: res.message };
  }
  return { ok: true, path: res.path };
}

export async function revealDownload() {
  const dir = updateState.filePath || undefined;
  return bridge.update.reveal(dir);
}

/** 跳过某个版本：本次及以后启动都不再为它弹窗，直到出现更新的版本 */
export function ignoreVersion(version) {
  updateCfg().ignoredVersion = version || '';
  saveNow();
  emit();
}

/** 让「跳过」的版本重新可提示 */
export function clearIgnored() {
  ignoreVersion('');
  toastOk('已恢复该版本的更新提示');
}

/** 启动后的自动检查：静默、延迟，不跟同步抢首屏 */
export function scheduleStartupCheck() {
  const s = syncCfg();
  const u = updateCfg();
  if (!u.enabled) return;
  if (!s.serverUrl || !s.token) return;
  setTimeout(() => {
    // 期间用户可能刚好退登，再确认一次
    const now = syncCfg();
    if (!now.serverUrl || !now.token) return;
    checkForUpdate({ silent: true });
  }, 4000);
}
