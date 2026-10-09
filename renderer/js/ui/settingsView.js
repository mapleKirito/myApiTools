/**
 * 设置页：同步服务、请求默认值、数据与备份
 */

import { qs, on, html, raw } from './dom.js';
import { toastOk, toastErr, toastWarn, confirmDialog, openModal } from './feedback.js';
import {
  state,
  bus,
  updateSettings,
  environments,
  setActiveEnv,
  saveNow,
} from '../state.js';
import { escapeHtml, formatRelative, formatTime, formatBytes } from '../helpers.js';
import { syncNow, syncAfterAuth, testServer, ensureAuth, signOut, syncCfg } from '../sync.js';
import {
  updateCfg,
  updateState,
  checkForUpdate,
  promptUpdate,
  clearIgnored,
  appInfo,
} from '../update.js';

const bridge = window.bridge;

let lastTestResult = null;
let busy = false;

export function renderSettingsPane() {
  /* 外层 .settings-page 只负责滚动（满宽），内层 .settings-inner 才限制内容宽度，
     否则滚动条会停在内容右边缘而不是主区域最右侧。 */
  return '<div class="settings-page"><div class="settings-inner" data-role="settings-body"></div></div>';
}

export function renderSettingsContent(tab) {
  const pane = qs(`.pane[data-tab="${tab.id}"]`);
  if (!pane) return;
  const host = pane.querySelector('[data-role="settings-body"]');
  if (!host) return;
  const s = state.workspace.settings;
  const sy = s.sync;

  const connected = !!(sy.token && sy.serverUrl);
  const pendingLogin = !!sy.serverUrl && !sy.token;
  const badge = connected ? 'ok' : pendingLogin ? 'err' : 'off';

  host.innerHTML = html`
    <h2>设置</h2>
    <div class="hint">
      所有请求都在本机直接发出；远端服务只保存和分发请求配置，不会、也无法代发任何业务接口。
    </div>

    <h3>配置同步</h3>
    <div class="sync-status-card">
      <span class="badge-pill ${badge}" data-role="sync-badge">${connected ? '已连接' : pendingLogin ? '待登录' : '未连接'}</span>
      <div>
        <div data-role="sync-account">${connected
          ? escapeHtml(sy.email || '已登录')
          : pendingLogin ? '已配置服务地址，尚未登录' : '尚未配置同步服务'}</div>
        <div class="text-dim" style="font-size:11.5px" data-role="sync-sub">
          ${connected
            ? `服务地址 ${escapeHtml(sy.serverUrl)} · 最近同步 ${escapeHtml(formatRelative(sy.lastSyncAt))} · 水位 ${sy.lastRev}`
            : pendingLogin
              ? '点下方「登录 / 注册」，登录后即可开始同步'
              : '填写服务地址并登录后，即可在多台设备间同步集合、请求与环境变量'}
        </div>
      </div>
      <span style="flex:1"></span>
      <label class="switch" title="本地改动后自动推送到远端">
        <input type="checkbox" data-sync="enabled" ${sy.enabled ? 'checked' : ''} />
        <span>自动同步</span>
      </label>
    </div>

    <div class="card">
      <div class="form-row">
        <label>服务地址</label>
        <input type="text" data-sync="serverUrl" value="${escapeHtml(sy.serverUrl)}" placeholder="http://127.0.0.1:8787" spellcheck="false" />
        <button class="btn" data-sync-act="test" type="button">测试连接</button>
      </div>
      <div class="form-row">
        <label>同步账号</label>
        <span class="mono" style="font-size:12px" data-role="sync-form-account"></span>
        <span class="text-dim" style="font-size:11.5px" data-role="sync-owner"></span>
      </div>
      <div class="btn-row" data-role="sync-account-actions" style="margin-left:142px;margin-top:6px">
        <button class="btn danger" data-sync-act="sign-out" data-role="sync-signout-btn" type="button" hidden>退出登录</button>
        <button class="btn primary" data-sync-act="account" data-role="sync-account-btn" type="button">登录 / 注册</button>
      </div>
      ${lastTestResult ? raw(`<div style="margin-top:12px;margin-left:142px;font-size:12px" class="${lastTestResult.ok ? 'text-ok' : 'text-err'}">${escapeHtml(lastTestResult.message)}</div>`) : ''}
      <div class="field-hint" style="margin-left:142px;margin-top:8px">
        账号密码在登录弹窗里填写，不保存在设置页。本机只保存登录令牌。
      </div>
    </div>

    <div data-role="sync-actions-card"></div>

    <h3>客户端更新</h3>
    <div class="card" data-role="upd-card"></div>

    <h3>请求默认值</h3>
    <div class="card">
      <div class="form-row">
        <label>超时（毫秒）</label>
        <input type="number" data-setting="timeout" value="${s.timeout}" min="1000" step="1000" />
      </div>
      <div class="form-row">
        <label>最大重定向次数</label>
        <input type="number" data-setting="maxRedirects" value="${s.maxRedirects}" min="0" max="30" />
      </div>
      <div class="form-row">
        <label>跟随重定向</label>
        <label class="switch"><input type="checkbox" data-setting="followRedirects" ${s.followRedirects ? 'checked' : ''} /><span>默认开启</span></label>
      </div>
      <div class="form-row">
        <label>校验证书</label>
        <label class="switch"><input type="checkbox" data-setting="verifyTls" ${s.verifyTls ? 'checked' : ''} /><span>关闭后可访问自签名 HTTPS</span></label>
      </div>
      <div class="form-row">
        <label>回车发送</label>
        <label class="switch"><input type="checkbox" data-setting="sendOnEnter" ${s.sendOnEnter ? 'checked' : ''} /><span>在地址栏按 Enter 直接发送</span></label>
      </div>
      <div class="form-row">
        <label>批量默认并发</label>
        <input type="number" data-setting="concurrency" value="${s.concurrency}" min="1" max="20" />
      </div>
    </div>

    <h3>数据与备份</h3>
    <div class="card">
      <div class="form-row">
        <label>历史记录上限</label>
        <input type="number" data-setting="historyLimit" value="${s.historyLimit}" min="20" max="5000" />
        <span class="desc" style="margin-left:0">仅保存在本机，不参与同步</span>
      </div>
      <div class="form-row">
        <label>本地数据文件</label>
        <span class="mono text-dim" style="font-size:11.5px;word-break:break-all" data-role="data-path">读取中…</span>
      </div>
      <div class="btn-row" style="margin-left:142px">
        <button class="btn" data-data-act="reveal" type="button">在文件夹中显示</button>
        <button class="btn" data-data-act="export" type="button">导出全部配置</button>
        <button class="btn" data-data-act="import" type="button">从备份恢复</button>
      </div>
      <div class="field-hint" style="margin-left:142px;margin-top:8px">
        导出的 JSON 包含集合、请求、环境与全局变量，可直接导入到另一台设备。
      </div>
    </div>

    <h3>关于</h3>
    <div class="card">
      <div class="form-row"><label>版本</label><span data-role="app-version">—</span></div>
      <div class="form-row"><label>运行时</label><span class="mono text-dim" data-role="app-runtime" style="font-size:11.5px">—</span></div>
      <div class="field-hint" style="margin-left:142px">
        本工具不代理、不代发、不记录任何业务接口的请求与响应；<br />
        网络动作全部在你本机完成，远端只保存「怎么调」的配置。
      </div>
    </div>
  `;

  // 同步卡片里有一半是「状态相关」的内容（账号、按钮、动作区），
  // 统一交给 paintSyncCard 计算，避免模板和刷新逻辑两处各写一套写法不一致
  paintSyncCard(pane);
  paintUpdateCard(pane);
  fillAppInfo(host);
}

/**
 * 「客户端更新」卡片的内容完全由 update.js 的状态决定，
 * 所以模板里只留一个空容器，这里按状态渲染。
 */
function paintUpdateCard(pane) {
  const card = pane && pane.querySelector('[data-role="upd-card"]');
  if (!card) return;

  const sy = syncCfg();
  const u = updateCfg();
  const st = updateState;
  const loggedIn = !!(sy.serverUrl && sy.token);
  const current = st.current || '—';

  let badgeClass = 'off';
  let badgeText = '未检查';
  let sub = '';
  let primary = '';   // 主按钮

  // 「跳过此版本」的提示 + 恢复入口。
  // 注意它不能只挂在「有新版本」这一种状态上：用户完全可能在下载完之后才点跳过，
  // 那时状态已经是「待安装」了 —— 只在 available 分支渲染的话，提示和「恢复提示」
  // 按钮就永远出不来，用户没有反悔的入口。
  const skipped = !!(u.ignoredVersion && st.latest && u.ignoredVersion === st.latest.version);
  const ignoredHint = skipped
    ? `已跳过 v${escapeHtml(st.latest.version)}，启动时不会再自动提示。` +
      '<button class="btn-link" data-upd-act="unignore" type="button">恢复提示</button>'
    : '';

  switch (st.status) {
    case 'checking':
      badgeText = '检查中…';
      sub = '正在向同步服务查询当前平台的可用版本。';
      break;

    case 'uptodate':
      badgeClass = 'ok';
      badgeText = '已是最新';
      sub = st.latest
        ? `服务端当前发布的版本就是 v${escapeHtml(st.latest.version)}，无需更新。`
        : '服务端还没有发布过客户端安装包。';
      break;

    case 'available':
      badgeClass = 'err';
      badgeText = '有新版本';
      sub = `服务端已发布 v${escapeHtml(st.latest ? st.latest.version : '')}` +
        (st.latest ? `（${escapeHtml(st.latest.platform)}-${escapeHtml(st.latest.arch)} · ${escapeHtml(formatBytes(st.latest.size))}）` : '') +
        '，可下载并安装。';
      primary = 'download';
      break;

    case 'downloading': {
      badgeClass = 'err';
      const p = st.progress || { percent: 0 };
      badgeText = `下载中 ${p.percent || 0}%`;
      sub = `${escapeHtml(formatBytes(p.received || 0))} / ${escapeHtml(formatBytes(p.total || (st.latest ? st.latest.size : 0)))}`;
      break;
    }

    case 'downloaded':
      badgeClass = 'ok';
      badgeText = '待安装';
      sub = `安装包已下载到本机（${escapeHtml(formatBytes(st.size))}）。点「打开安装程序」继续。`;
      primary = 'install';
      break;

    case 'login-required':
      badgeClass = 'err';
      badgeText = '待登录';
      sub = '检查更新需要登录同步账号 —— 登录后会自动检查一次。';
      break;

    case 'error':
      badgeClass = 'err';
      badgeText = '检查失败';
      sub = escapeHtml(st.error || '无法连接同步服务。');
      break;

    default:
      sub = loggedIn
        ? '点右侧「检查更新」查询服务端有没有发布新版本。'
        : '配置同步服务并登录后，这里会自动检查客户端更新。';
  }

  const lastChecked = st.checkedAt
    ? `上次检查 ${escapeHtml(formatRelative(st.checkedAt))}`
    : '尚未检查';
  const channelText = `更新渠道 ${escapeHtml(u.channel || 'stable')}`;

  card.innerHTML = html`
    <div class="update-card-head">
      <span class="badge-pill ${badgeClass}" data-role="upd-badge">${badgeText}</span>
      <span class="update-version ${st.status === 'available' ? 'has-new' : ''}" data-role="upd-current">v${escapeHtml(current)}</span>
      <span class="text-dim" data-role="upd-latest">${st.latest ? '→ v' + escapeHtml(st.latest.version) : ''}</span>
      <span class="spacer"></span>
      <button class="btn" data-upd-act="check" data-role="upd-check-btn" type="button">检查更新</button>
      ${primary === 'download'
        ? raw('<button class="btn primary" data-upd-act="install" data-role="upd-install-btn" type="button">下载并安装</button>')
        : primary === 'install'
          ? raw('<button class="btn primary" data-upd-act="install" data-role="upd-install-btn" type="button">打开安装程序</button>')
          : ''}
    </div>

    <div class="update-progress" data-role="upd-progress-wrap" ${st.status === 'downloading' ? '' : 'hidden'}>
      <div class="progress-track"><div class="progress-bar" data-role="upd-progress" style="width:${st.status === 'downloading' ? (st.progress ? st.progress.percent || 0 : 0) : 0}%"></div></div>
      <div class="field-hint" data-role="upd-progress-text">${st.status === 'downloading' ? '下载中…' : ''}</div>
    </div>

    <div class="field-hint" data-role="upd-sub" style="margin-top:10px">${raw(sub)}</div>
    ${ignoredHint ? raw(`<div class="field-hint text-warn" data-role="upd-ignored" style="margin-top:6px">${ignoredHint}</div>`) : ''}
    <div class="field-hint" style="margin-top:6px">
      ${channelText} · ${lastChecked} · 安装包从同步服务下载并校验 sha256 后才会唤起安装程序。
    </div>
  `;
}

function syncActionsCard(sy) {
  return `
    <div class="card">
      <div class="btn-row">
        <button class="btn primary" data-sync-act="sync-now" type="button">立即双向同步</button>
        <button class="btn" data-sync-act="push-all" type="button" title="把本机全部配置上传，覆盖远端">全量上传</button>
        <button class="btn" data-sync-act="pull-all" type="button" title="把远端配置拉下来覆盖本机">全量下载</button>
      </div>
      <div class="field-hint" style="margin-top:10px">
        同步内容：集合结构、请求定义、环境与变量（共 ${state.workspace.requests.filter((r) => !r.deleted).length} 个请求，
        ${environments().length} 个环境）。<br />
        以上内容都归属账号 <b>${escapeHtml(sy.email || '—')}</b>；换账号登录时服务端数据是完全隔离的。<br />
        历史记录、超时等偏好设置只保存在本机，不参与同步。
      </div>
    </div>`;
}

async function fillAppInfo(host) {
  const info = await appInfo();
  const p = host.querySelector('[data-role="app-version"]');
  const r = host.querySelector('[data-role="app-runtime"]');
  const d = host.querySelector('[data-role="data-path"]');
  if (p) p.textContent = 'v' + info.version + ' · ' + info.platform;
  if (r) r.textContent = `Electron ${info.electron} · Node ${info.node} · Chromium ${info.chrome}`;
  if (d) d.textContent = info.dataFile;

  // 版本号是异步取回来的，拿到之后补一次更新卡片，免得它一直显示「v—」
  if (updateState.current !== info.version) {
    updateState.current = info.version;
    paintUpdateCard(host);
  }
}

/* ==================================================================== *
 * 事件
 * ==================================================================== */
function tabOf(el) {
  const pane = el.closest('.pane');
  return pane ? state.tabs.find((t) => t.id === pane.dataset.tab) : null;
}

function rerender(el) {
  const tab = tabOf(el);
  if (tab) renderSettingsContent(tab);
}

/**
 * 就地刷新「配置同步」相关的那几块界面，不整页重绘。
 * 两个原因必须这么做：
 *   1. 整页重绘会让服务地址这类正在输入的输入框失焦、光标跳位；
 *   2. 设置页本身不会随 bus 的 change 自动重绘（refreshPane 有意跳过，
 *      避免打断输入），所以登录 / 退登 / 换账号之后必须主动来刷一次，
 *      否则徽标和按钮会一直停在「已连接 / 切换账号」的旧样子。
 */
function paintSyncCard(pane) {
  if (!pane) return;
  const sy = state.workspace.settings.sync;
  const connected = !!(sy.token && sy.serverUrl);
  const pending = !!sy.serverUrl && !sy.token;
  // 这个函数会被 bus 的 change 高频调用（每一次 commit 都会来一趟），
  // 所以只在内容真的变化时才写 DOM，避免无谓的重排
  const setText = (sel, text) => {
    const el = pane.querySelector(sel);
    if (el && el.textContent !== text) el.textContent = text;
  };

  const badge = pane.querySelector('[data-role="sync-badge"]');
  if (badge) {
    const cls = 'badge-pill ' + (connected ? 'ok' : pending ? 'err' : 'off');
    if (badge.className !== cls) badge.className = cls;
    const text = connected ? '已连接' : pending ? '待登录' : '未连接';
    if (badge.textContent !== text) badge.textContent = text;
  }
  setText('[data-role="sync-account"]', connected
    ? (sy.email || '已登录')
    : pending ? '已配置服务地址，尚未登录' : '尚未配置同步服务');
  setText('[data-role="sync-sub"]', connected
    ? `服务地址 ${sy.serverUrl} · 最近同步 ${formatRelative(sy.lastSyncAt)} · 水位 ${sy.lastRev}`
    : pending
      ? '点下方「登录 / 注册」，登录后即可开始同步'
      : '填写服务地址并登录后，即可在多台设备间同步集合、请求与环境变量');

  /* ---------- 表单里的账号与归属 ---------- */
  setText('[data-role="sync-form-account"]', connected ? (sy.email || '已登录') : '未登录');
  const staleOwner = sy.accountKey && sy.accountKey.toLowerCase() !== String(sy.email).toLowerCase();
  setText('[data-role="sync-owner"]', staleOwner ? `本机配置归属 ${sy.accountKey}` : '');

  /* ---------- 按钮：登录/注册 ↔ 切换账号 ---------- */
  const accountBtn = pane.querySelector('[data-role="sync-account-btn"]');
  if (accountBtn) {
    accountBtn.textContent = connected ? '切换账号' : '登录 / 注册';
    accountBtn.classList.toggle('primary', !connected);
    if (connected) accountBtn.title = '退出当前账号并登录另一个';
    else accountBtn.removeAttribute('title');
  }
  const signOutBtn = pane.querySelector('[data-role="sync-signout-btn"]');
  if (signOutBtn) signOutBtn.hidden = !connected;

  /* ---------- 同步动作区（只在已连接时出现，内部没有输入框，直接重绘） ---------- */
  const actions = pane.querySelector('[data-role="sync-actions-card"]');
  if (actions) {
    // 归属账号变了也要重绘（动作区里写着「以上内容都归属账号 X」）
    const stateKey = connected ? 'on:' + (sy.email || '') : 'off';
    if (actions.dataset.state !== stateKey) {
      actions.innerHTML = connected ? syncActionsCard(sy) : '';
      actions.dataset.state = stateKey;
    }
  }
}

/** 页面上所有设置面板（settings-body 只有设置页才有） */
function settingsPanes() {
  return [...document.querySelectorAll('.pane [data-role="settings-body"]')].map((el) => el.closest('.pane'));
}

export function initSettingsEvents(root) {
  /* ---------- 同步状态变化时刷新同步卡片 ----------
   * 设置面板在 refreshPane 里被有意跳过（避免打断输入），所以登录、
   * 退登、令牌失效、换账号这些场景都得在这里补一次局部刷新。 */
  bus.on('change', () => {
    for (const pane of settingsPanes()) paintSyncCard(pane);
  });
  bus.on('sync-state', () => {
    for (const pane of settingsPanes()) {
      paintSyncCard(pane);
      // 登录 / 退登会改变「能不能检查更新」，更新卡片得跟着刷新
      paintUpdateCard(pane);
    }
  });
  bus.on('sync-status', () => {
    for (const pane of settingsPanes()) paintSyncCard(pane);
  });
  bus.on('update-state', () => {
    for (const pane of settingsPanes()) paintUpdateCard(pane);
  });

  /* ---------- 普通设置项 ---------- */
  on(root, 'change', '[data-setting]', (_e, el) => {
    const key = el.dataset.setting;
    const isCheck = el.type === 'checkbox';
    let value = isCheck ? el.checked : Number(el.value);
    if (!isCheck && !Number.isFinite(value)) value = el.value;
    if (!isCheck) {
      const min = Number(el.min);
      const max = Number(el.max);
      if (Number.isFinite(min) && value < min) value = min;
      if (Number.isFinite(max) && value > max) value = max;
      el.value = value;
    }
    updateSettings({ [key]: value });
  });

  /* ---------- 同步字段 ---------- */
  on(root, 'input', '[data-sync="serverUrl"]', (_e, el) => {
    updateSettings({ sync: { serverUrl: el.value.trim() } });
    // 地址从空变非空（或反向）会改变卡片状态，这里就地刷新，不重绘整页
    paintSyncCard(el.closest('.pane'));
  });

  on(root, 'change', '[data-sync="enabled"]', (_e, el) => {
    updateSettings({ sync: { enabled: el.checked } });
    const sy = syncCfg();
    if (el.checked && sy.token && sy.serverUrl) {
      syncNow('both');
    }
  });

  /* ---------- 同步动作 ---------- */
  on(root, 'click', '[data-sync-act]', async (_e, el) => {
    const act = el.dataset.syncAct;
    if (busy) return;

    if (act === 'test') {
      const pane = el.closest('.pane');
      const node = pane.querySelector('[data-sync="serverUrl"]');
      const serverUrl = node ? node.value.trim() : '';
      if (!serverUrl) return toastWarn('请先填写服务地址');
      busy = true;
      el.disabled = true;
      el.textContent = '测试中…';
      const res = await testServer(serverUrl);
      busy = false;
      lastTestResult = res.ok
        ? { ok: true, message: `连接成功：${res.data.name} v${res.data.version}（${res.data.scope}）` }
        : { ok: false, message: '连接失败：' + res.message };
      rerender(el);
      if (res.ok) toastOk('同步服务连接正常');
      else toastErr(res.message, '连接失败');
      return;
    }

    // 登录 / 注册 / 切换账号都走同一个弹窗，避免密码长期停留在设置页表单里
    if (act === 'account') {
      const pane = el.closest('.pane');
      const node = pane.querySelector('[data-sync="serverUrl"]');
      if (node && node.value.trim()) {
        updateSettings({ sync: { serverUrl: node.value.trim() } });
        saveNow();
      }
      const sy = syncCfg();
      if (!sy.serverUrl) return toastWarn('请先填写服务地址');

      // 已登录时是「切换账号」：先登出，再弹框登录新账号
      if (sy.token) {
        const ok = await confirmDialog({
          title: '切换同步账号',
          message:
            '将退出当前账号，然后登录另一个账号。\n' +
            '远端数据不受影响；本机配置保留，登录新账号时会再确认如何处理本机内容。',
          confirmText: '继续切换',
        });
        if (!ok) return;
        await signOut();
      }

      busy = true;
      const auth = await ensureAuth('manual');
      busy = false;
      rerender(el);
      if (!auth) return;
      // 换账号时按用户在归属确认框里的选择决定同步方向（清空→只拉取 / 保留→全量上传）
      setTimeout(() => syncAfterAuth(auth, 'both'), 300);
      return;
    }

    if (act === 'sign-out') {
      const sy = syncCfg();
      if (!await confirmDialog({
        title: '退出同步登录',
        message: '将清除本机保存的登录令牌。\n远端数据不受影响，本机配置也完整保留。',
        confirmText: '退出登录',
        danger: true,
      })) return;
      await signOut();
      rerender(el);
      toastOk(sy.email ? `已退出 ${sy.email}` : '已退出登录');
      return;
    }

    if (act === 'sync-now' || act === 'push-all' || act === 'pull-all') {
      if (act === 'pull-all' && !await confirmDialog({
        title: '全量下载',
        message: '会用远端配置覆盖本机的集合、请求与环境变量。\n本机未上传的改动将丢失，确定继续？',
        confirmText: '覆盖本机',
        danger: true,
      })) return;
      if (act === 'push-all' && !await confirmDialog({
        title: '全量上传',
        message: '会把本机全部配置推送到远端。\n如果远端更新，仍以较新的版本为准。确定继续？',
        confirmText: '开始上传',
      })) return;

      busy = true;
      el.disabled = true;
      const original = el.textContent;
      el.textContent = '处理中…';
      const mode = act === 'push-all' ? 'pushAll' : act === 'pull-all' ? 'pull' : 'both';
      await syncNow(mode, { forcePull: act === 'pull-all' });
      busy = false;
      rerender(el);
      return;
    }
  });

  /* ---------- 客户端更新 ---------- */
  on(root, 'click', '[data-upd-act]', async (_e, el) => {
    const act = el.dataset.updAct;

    if (act === 'check') {
      el.disabled = true;
      const old = el.textContent;
      el.textContent = '检查中…';
      await checkForUpdate({ silent: false });
      el.disabled = false;
      el.textContent = old;
      // 状态变化会经由 update-state 事件触发卡片重绘，这里不用手动刷
      return;
    }

    if (act === 'install') {
      // 下载 / 安装的完整流程统一走那个弹窗，避免两处各写一套
      promptUpdate();
      return;
    }

    if (act === 'unignore') {
      clearIgnored();
      return;
    }
  });

  /* ---------- 数据动作 ---------- */
  on(root, 'click', '[data-data-act]', async (_e, el) => {
    const act = el.dataset.dataAct;
    if (act === 'reveal') {
      await bridge.store.reveal();
      return;
    }
    if (act === 'export') {
      const json = await bridge.store.exportJSON();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
      const res = await bridge.dialog.save({
        title: '导出全部配置',
        defaultPath: `myapitools-backup-${stamp}.json`,
        content: json,
      });
      if (res.ok) toastOk('已导出到 ' + res.path);
      return;
    }
    if (act === 'import') {
      const pick = await bridge.dialog.open({
        title: '选择备份文件',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!pick.ok) return;
      if (!await confirmDialog({
        title: '从备份恢复',
        message: '将用备份文件覆盖当前全部本地配置，此操作不可撤销。确定继续？',
        confirmText: '覆盖恢复',
        danger: true,
      })) return;
      const read = await bridge.fs.readText(pick.path);
      if (!read.ok) return toastErr('读取文件失败');
      try {
        await bridge.store.importJSON(read.text);
        toastOk('恢复成功，正在重新载入界面…');
        setTimeout(() => window.location.reload(), 800);
      } catch (e) {
        toastErr(e.message, '恢复失败');
      }
    }
  });
}
