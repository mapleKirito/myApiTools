'use strict';

/**
 * Electron 端到端冒烟测试钩子
 * ---------------------------------------------------------------
 * 由 main.js 在 MYAPITOOLS_SMOKE=1 时挂载。
 * 真实启动窗口 → 在渲染进程里模拟用户操作 → 断言界面与请求链路。
 *   npm run smoke
 *
 * 这里会起两个本地服务：
 *   · echoServer  用来验证「请求执行」链路（含响应头 / JSON 高亮）
 *   · syncServer  一个最小可用的同步服务，用来验证「登录 / 注册 / 同步」全链路
 * 都是真 HTTP 往返，渲染进程 → preload → 主进程 → 网络，不 mock 内部实现。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * 版本号比较，语义与 server/server.js 的 compareVersion 一致。
 * 冒烟测试里的 mock 服务端要能自己判断「客户端是不是旧了」，
 * 不能简单地按字符串比（'1.10.0' < '1.9.0' 是文本比较的经典陷阱）。
 */
function compareVersion(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || '').trim());
    return m ? { n: [+m[1], +m[2], +m[3]], pre: m[4] || '' } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] - y.n[i];
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** 当前平台标识，与 electron/update-client.js 保持一致 */
const SMOKE_PLATFORM = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
const SMOKE_ARCH = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? 'ia32' : 'x64';

/**
 * 进度日志：Electron 主进程的 stdout 在重定向到文件时会被缓冲，
 * 一旦测试卡住就完全看不到进度，所以这里同步写一份到磁盘。
 * 设置 MYAPITOOLS_SMOKE_LOG 可指定路径。
 */
const PROGRESS_LOG = process.env.MYAPITOOLS_SMOKE_LOG
  || path.join(require('node:os').tmpdir(), 'myapitools-smoke-progress.log');
function step(msg) {
  if (!PROGRESS_LOG) return;
  try {
    fs.appendFileSync(PROGRESS_LOG, `[${new Date().toISOString().slice(11, 23)}] ${msg}\n`);
  } catch { /* ignore */ }
}

let echoServer = null;
let echoPort = 0;

/**
 * 把当前激活 profile 落盘的 sync 配置写进进度日志。
 * 多用户模型下工作区按 profile 隔离到 <userData>/profiles/<id>/，同步配置
 * 在 meta.json 的 settings.sync 里；这里先读 profiles.json 找到 active，
 * 再读对应目录的 meta.json。账号切换是否触发，取决于当前登录邮箱，不打出来只能靠猜。
 */
function dumpSync(smokeDir, label) {
  try {
    const metaPath = path.join(smokeDir, 'profiles.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const activeId = (meta && meta.active) || 'local';
    const profileDir = path.join(smokeDir, 'profiles', activeId);
    const ws = JSON.parse(fs.readFileSync(path.join(profileDir, 'meta.json'), 'utf8'));
    const sy = (ws.settings && ws.settings.sync) || {};
    // 令牌只留前 6 位，够判断「有没有登录」又不把完整凭据写进日志
    const brief = { ...sy, token: sy.token ? String(sy.token).slice(0, 6) + '…' : '' };
    step(`${label} [${activeId}] sync=` + JSON.stringify(brief));
  } catch (e) {
    step(`${label} sync 读取失败: ${e.message}`);
  }
}

/* ==================================================================== *
 * 最小同步服务（仅用于冒烟测试）
 * ==================================================================== */
let syncServer = null;
let syncPort = 0;

const syncState = {
  users: new Map(), // email -> password
  tokens: new Map(), // token -> email
  entities: [], // 最近一次 push 的内容
  pushes: [], // 每次 push 的实体数量（用于验证"是否把上一个账号的配置推给了新账号"）
  calls: [], // { method, path } 调用流水
  expireNext: false, // 下一次 pull 强制返回 401，用于验证令牌过期后的登录框
  seq: 0,
  // 客户端安装包：起初故意为空 —— 阶段 2~5 会自动检查更新，
  // 如果这时就有新版本，会平白弹出一个更新窗把那些阶段的断言搅乱。
  // 阶段 6 开始前再由测试主动「发布」一个。
  releases: [],
  downloads: [], // 每次下载的安装包 id
};

function startMockSync() {
  return new Promise((resolve) => {
    syncServer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch { /* 允许空体 */ }

        const url = new URL(req.url, 'http://127.0.0.1');
        syncState.calls.push({ method: req.method, path: url.pathname });
        step('  mock ' + req.method + ' ' + url.pathname);

        const json = (status, payload) => {
          const buf = Buffer.from(JSON.stringify(payload), 'utf8');
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
          res.end(buf);
        };
        const bearer = () => {
          const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
          return m ? m[1].trim() : '';
        };
        const tokenValid = () => !!syncState.tokens.get(bearer());

        if (url.pathname === '/api/health') {
          return json(200, { ok: true, name: '冒烟测试同步服务', version: '1.0.0', scope: '仅记录与回放请求配置' });
        }

        if (url.pathname === '/api/auth/register' && req.method === 'POST') {
          const email = String(body.email || '').toLowerCase();
          if (syncState.users.has(email)) return json(409, { ok: false, message: '该邮箱已注册', code: 'EMAIL_TAKEN' });
          syncState.users.set(email, body.password);
          const token = `tok-${++syncState.seq}-${Math.random().toString(36).slice(2)}`;
          syncState.tokens.set(token, email);
          return json(200, { ok: true, token, user: { id: syncState.users.size, email } });
        }

        if (url.pathname === '/api/auth/login' && req.method === 'POST') {
          const email = String(body.email || '').toLowerCase();
          if (syncState.users.get(email) !== body.password) {
            return json(401, { ok: false, message: '邮箱或密码不正确', code: 'BAD_CREDENTIALS' });
          }
          const token = `tok-${++syncState.seq}-${Math.random().toString(36).slice(2)}`;
          syncState.tokens.set(token, email);
          return json(200, { ok: true, token, user: { id: 1, email } });
        }

        if (url.pathname === '/api/auth/me') {
          const email = syncState.tokens.get(bearer());
          if (!email) return json(401, { ok: false, message: '登录已过期，请重新登录', code: 'AUTH_EXPIRED' });
          return json(200, { ok: true, user: { id: 1, email }, expiresAt: Date.now() + 86400000 });
        }

        if (url.pathname === '/api/auth/logout') {
          syncState.tokens.delete(bearer());
          return json(200, { ok: true });
        }

        if (url.pathname === '/api/sync/pull') {
          if (!tokenValid()) return json(401, { ok: false, message: '登录已过期，请重新登录', code: 'AUTH_EXPIRED' });
          if (syncState.expireNext) {
            syncState.expireNext = false;
            return json(401, { ok: false, message: '登录已过期，请重新登录', code: 'AUTH_EXPIRED' });
          }
          return json(200, { ok: true, entities: [], rev: 0, globalRev: 0, hasMore: false });
        }

        if (url.pathname === '/api/sync/push') {
          if (!tokenValid()) return json(401, { ok: false, message: '登录已过期，请重新登录', code: 'AUTH_EXPIRED' });
          const list = Array.isArray(body.entities) ? body.entities : [];
          syncState.entities = list;
          syncState.pushes.push(list.length);
          return json(200, { ok: true, applied: list.length, appliedList: [], conflicts: [], rev: list.length });
        }

        /* ---------- 客户端安装包 ---------- */
        if (url.pathname === '/api/releases/latest') {
          if (!tokenValid()) return json(401, { ok: false, message: '登录已过期，请重新登录', code: 'AUTH_EXPIRED' });
          const current = url.searchParams.get('current') || '';
          const rel = syncState.releases[0] || null;
          const upToDate = !rel || !current ? true : compareVersion(rel.version, current) <= 0;
          return json(200, {
            ok: true,
            channel: url.searchParams.get('channel') || 'stable',
            current: current || null,
            latest: rel ? {
              id: rel.id,
              channel: 'stable',
              version: rel.version,
              platform: rel.platform,
              arch: rel.arch,
              fileName: rel.fileName,
              size: rel.body.length,
              sha256: rel.sha256,
              notes: rel.notes,
              downloads: 0,
              publishedAt: rel.publishedAt,
              downloadUrl: `/api/releases/download/${rel.id}`,
            } : null,
            upToDate,
            updateAvailable: !!(rel && !upToDate),
            checkedAt: Date.now(),
          });
        }

        const dl = /^\/api\/releases\/download\/(\d+)$/.exec(url.pathname);
        if (dl) {
          if (!tokenValid()) return json(401, { ok: false, message: '登录已过期，请重新登录', code: 'AUTH_EXPIRED' });
          const rel = syncState.releases.find((r) => r.id === Number(dl[1]));
          if (!rel) return json(404, { ok: false, message: '安装包不存在', code: 'NOT_FOUND' });
          syncState.downloads.push(rel.id);
          // 安装包是二进制，这里不能用 json() 直接回
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': rel.body.length,
            'x-release-version': rel.version,
            'x-release-sha256': rel.sha256,
          });
          return res.end(rel.body);
        }

        return json(404, { ok: false, message: '未知接口' });
      });
    });
    syncServer.listen(0, '127.0.0.1', () => {
      syncPort = syncServer.address().port;
      resolve(syncPort);
    });
  });
}

/**
 * 造一个假的客户端安装包，并让 mock 服务端「发布」它。
 * 内容是可预测的字节，测试里能直接重算 sha256 对比。
 */
function publishFakeRelease(version = '9.9.9') {
  const body = Buffer.from(`MyApiTools ${version} 假安装包（冒烟测试用）\n`.repeat(4000), 'utf8');
  const rel = {
    id: syncState.releases.length + 1,
    version,
    platform: SMOKE_PLATFORM,
    arch: SMOKE_ARCH,
    fileName: `MyApiTools-Setup-${version}-${SMOKE_ARCH}.exe`,
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    notes: '冒烟测试：新增客户端更新检查',
    publishedAt: Date.now(),
    body,
  };
  syncState.releases.unshift(rel);
  return rel;
}

/* ==================================================================== *
 * 请求执行链路用的回显服务
 * ==================================================================== */
function startEchoServer() {
  return new Promise((resolve) => {
    echoServer = http.createServer((req, res) => {
      if (req.url.startsWith('/smoke')) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'x-smoke': 'yes' });
        res.end(JSON.stringify({ token: 'SMOKE_OK', method: req.method, url: req.url }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ok');
    });
    echoServer.listen(0, '127.0.0.1', () => {
      echoPort = echoServer.address().port;
      resolve(echoPort);
    });
  });
}

/* ==================================================================== *
 * 探针 1：界面骨架 / 请求执行 / 批量执行
 * ==================================================================== */
const PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (cond, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (cond()) return true; await sleep(150); } return !!cond(); };
  const out = {};
  const errs = [];

  window.addEventListener('error', (e) => errs.push('error: ' + e.message));
  window.addEventListener('unhandledrejection', (e) => errs.push('unhandledrejection: ' + (e.reason && e.reason.message || e.reason)));

  /* ---------- 1. 骨架 ---------- */
  out.bridgeExposed = !!window.bridge && typeof window.bridge.http.send === 'function';
  out.bridgeSyncApi = !!window.bridge.sync && typeof window.bridge.sync.login === 'function'
    && typeof window.bridge.sync.me === 'function' && typeof window.bridge.sync.logout === 'function';
  out.hasBrand = !!document.querySelector('.brand-name');
  out.hasSidebar = !!document.querySelector('#sidebar-body');
  out.hasTabbar = !!document.querySelector('#tabbar');
  out.statusText = (document.querySelector('#status-left') || {}).textContent || '';
  out.emptyWelcome = !!document.querySelector('#panes .empty-state');
  out.envPickerLabel = (document.querySelector('#env-picker-label') || {}).textContent || '';
  out.welcomeHasDemoBtn = !!document.querySelector('[data-welcome="demo"]');
  out.initialSyncLabel = (document.querySelector('#sync-label') || {}).textContent || '';
  out.initialSyncDot = (document.querySelector('#sync-dot') || {}).className || '';

  /* ---------- 1.1 hidden 属性必须真的生效（CSS 兜底规则） ---------- */
  // .modal-root 是 display:grid 的全屏遮罩（还带 backdrop-filter:blur），一旦 [hidden]
  // 压不过它，遮罩就从启动起一直盖着 —— 界面整体发虚、弹窗却清晰，且控制台零报错。
  const hiddenProbeEl = document.createElement('div');
  hiddenProbeEl.className = 'modal-root';
  hiddenProbeEl.setAttribute('hidden', '');
  document.body.appendChild(hiddenProbeEl);
  out.hiddenRuleDisplay = getComputedStyle(hiddenProbeEl).display;
  hiddenProbeEl.remove();
  // 顺带扫一遍页面上所有带 hidden 的元素，一次性覆盖所有同类问题
  const liveHiddenEls = [...document.querySelectorAll('[hidden]')];
  out.hiddenElementCount = liveHiddenEls.length;
  out.allHiddenCollapsed = liveHiddenEls.every((el) => getComputedStyle(el).display === 'none');

  /* ---------- 1.5 插入示例集合 ---------- */
  const demoBtn = document.querySelector('[data-welcome="demo"]');
  if (demoBtn) {
    demoBtn.click();
    await sleep(700);
  }
  out.demoCollections = document.querySelectorAll('#sidebar-body .tree-row[data-col]').length;
  out.demoRequests = document.querySelectorAll('#sidebar-body .tree-row[data-req]').length;
  out.demoEnvLabel = (document.querySelector('#env-picker-label') || {}).textContent || '';
  out.demoVariables = (document.querySelector('#env-picker') || {}).title || '';

  /* ---------- 2. 新建请求 ---------- */
  document.querySelector('#btn-new-request').click();
  await sleep(500);
  const pane = document.querySelector('#panes .pane.active');
  out.paneCreated = !!pane;
  out.tabCount = document.querySelectorAll('#tabbar .tab[data-tab-id]').length;
  /* 开标签后欢迎页必须被清掉。
     欢迎页是直接塞进 #panes 的裸 .empty-state（没有 .pane 包裹），一旦残留就会占在面板
     上方，把真正的面板整个挤到下面 —— 而界面不报错、按钮也都在，肉眼很容易忽略。 */
  const paneHostChildren = [...document.querySelector('#panes').children];
  out.panesStrayChildren = paneHostChildren.filter((c) => !c.classList.contains('pane')).length;
  out.welcomeClearedAfterTab = !document.querySelector('#panes .empty-state');
  out.activePaneNotPushedDown = (() => {
    const hostEl = document.querySelector('#panes');
    const active = hostEl.querySelector('.pane.active');
    if (!active) return false;
    return Math.abs(active.getBoundingClientRect().top - hostEl.getBoundingClientRect().top) <= 1;
  })();
  out.hasUrlInput = !!(pane && pane.querySelector('[data-role="url"]'));
  out.hasMethodSelect = !!(pane && pane.querySelector('[data-role="method"]'));
  out.subtabs = pane ? [...pane.querySelectorAll('[data-role="req-subtabs"] .subtab')].map((b) => b.textContent.trim()) : [];

  /* ---------- 3. Params 表可用 ---------- */
  if (pane) {
    const paramTab = [...pane.querySelectorAll('[data-subtab]')].find((b) => b.dataset.subtab === 'params');
    if (paramTab) paramTab.click();
    await sleep(200);
    const kvRows = pane.querySelectorAll('[data-kv="params"] tbody tr');
    out.paramTableReady = kvRows.length >= 1;
    const keyInput = kvRows[kvRows.length - 1].querySelector('[data-kv-field="key"]');
    if (keyInput) {
      keyInput.value = 'page';
      keyInput.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(250);
      const after = pane.querySelectorAll('[data-kv="params"] tbody tr');
      out.paramAutoGrow = after.length === kvRows.length + 1;
      const valInput = after[after.length - 2].querySelector('[data-kv-field="value"]');
      if (valInput) {
        valInput.value = '7';
        valInput.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(200);
      }
    }
  }

  /* ---------- 4. 填写地址并发送（真实走主进程 HTTP） ---------- */
  const urlInput = pane.querySelector('[data-role="url"]');
  urlInput.value = window.__SMOKE_URL + '/smoke';
  urlInput.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(200);
  out.urlPreview = (pane.querySelector('[data-role="url-preview"]') || {}).textContent.trim().slice(0, 90);

  pane.querySelector('[data-role="send"]').click();
  await until(() => {
    const m = pane.querySelector('[data-role="resp-meta"]');
    return !!m && m.textContent.includes('状态');
  }, 12000);
  const meta = pane.querySelector('[data-role="resp-meta"]');
  out.responseMeta = meta ? meta.textContent.replace(/\\s+/g, ' ').trim().slice(0, 130) : '';
  const respBody = pane.querySelector('[data-role="resp-body"]');
  out.responseHasToken = !!respBody && respBody.textContent.includes('SMOKE_OK');
  out.responseHighlighted = !!respBody && !!respBody.querySelector('.tk-key, .tk-str');

  /* ---------- 5. 响应子标签 ---------- */
  const hdrTab = [...pane.querySelectorAll('[data-resp-tab]')].find((b) => b.dataset.respTab === 'headers');
  if (hdrTab) {
    hdrTab.click();
    await sleep(200);
    out.headersRendered = (pane.querySelector('[data-resp-body], [data-role="resp-body"]') || {}).textContent.includes('x-smoke');
  }
  const timingTab = [...pane.querySelectorAll('[data-resp-tab]')].find((b) => b.dataset.respTab === 'timing');
  if (timingTab) {
    timingTab.click();
    await sleep(200);
    out.timingRendered = (pane.querySelector('[data-role="resp-body"]') || {}).textContent.includes('总耗时');
  }

  /* ---------- 6. 历史记录已写入 ---------- */
  const histBtn = [...document.querySelectorAll('.stab')].find((b) => b.dataset.tab === 'history');
  if (histBtn) {
    histBtn.click();
    await sleep(250);
    out.historyItems = document.querySelectorAll('#sidebar-body .history-item').length;
    const colBtn = [...document.querySelectorAll('.stab')].find((b) => b.dataset.tab === 'collections');
    if (colBtn) colBtn.click();
    await sleep(150);
  }
  out.treeRequests = document.querySelectorAll('#sidebar-body .tree-row[data-req]').length;

  /* ---------- 7. 设置页 ---------- */
  document.querySelector('#btn-settings').click();
  await sleep(500);
  out.settingsRendered = !!document.querySelector('.settings-page');
  out.settingsHasSyncSection = (document.querySelector('.settings-page') || {}).textContent.includes('配置同步');
  // 设置页是「欢迎页残留」最刺眼的受害者：它必须顶到主区域最上沿，而不是被挤到下半屏
  const settingsHost = document.querySelector('#panes');
  const settingsPane = settingsHost.querySelector('.pane.active');
  out.settingsPaneAtTop = !!settingsPane
    && Math.abs(settingsPane.getBoundingClientRect().top - settingsHost.getBoundingClientRect().top) <= 1;
  out.noWelcomeBehindSettings = !document.querySelector('#panes .empty-state');
  /* 设置页滚动条要贴主区域最右侧：滚动容器 .settings-page 必须满宽，内容宽度由
     内层 .settings-inner 收窄。若把 max-width 直接写在滚动容器上，滚动条会停在
     内容右边缘（860px 处），看起来就像「设置页比其他标签窄一截」。 */
  const settingsScroll = document.querySelector('.settings-page');
  const settingsInner = document.querySelector('.settings-page .settings-inner');
  out.settingsScrollFullWidth = !!settingsScroll
    && Math.abs(settingsScroll.getBoundingClientRect().right - settingsHost.getBoundingClientRect().right) <= 1
    && Math.abs(settingsScroll.getBoundingClientRect().left - settingsHost.getBoundingClientRect().left) <= 1;
  out.settingsContentCapped = !!settingsInner && Math.round(settingsInner.getBoundingClientRect().width) <= 860;
  out.settingsInnerHoldsContent = !!settingsInner && settingsInner.textContent.includes('配置同步');

  /* ---------- 8. 批量执行页 ---------- */
  document.querySelector('#btn-runner').click();
  await sleep(500);
  out.runnerRendered = !!document.querySelector('.runner');
  out.runnerHasStartBtn = !!document.querySelector('[data-runner="start"]');

  out.errorCount = errs.length;
  out.errors = errs.slice(0, 10);
  return out;
})()`;

/* ==================================================================== *
 * 探针 2：配置服务地址 → 首次同步弹出登录/注册框 → 注册 → 自动同步
 * ==================================================================== */
const PROBE_AUTH = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (cond, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (cond()) return true; await sleep(150); } return !!cond(); };
  const out = {};
  const errs = [];
  window.addEventListener('error', (e) => errs.push('error: ' + e.message));
  window.addEventListener('unhandledrejection', (e) => errs.push('unhandledrejection: ' + (e.reason && e.reason.message || e.reason)));

  try {
  const modalOf = () => document.querySelector('#modal-root .auth-form');
  // 提交/取消按钮在弹窗页脚（.modal-foot），不在表单体内，所以查询要用 .modal 作根
  const modalRoot = () => document.querySelector('#modal-root .modal');
  const modalTitle = () => (document.querySelector('#modal-root .modal-head span') || {}).textContent || '';
  const setVal = (root, sel, v) => {
    const el = root.querySelector(sel);
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el;
  };

  /* ---------- 1. 只在设置页填服务地址，先不登录 ---------- */
  document.querySelector('#btn-settings').click();
  await sleep(600);
  const page = () => document.querySelector('.settings-page');
  const urlInput = document.querySelector('[data-sync="serverUrl"]');
  out.hasServerField = !!urlInput;
  out.settingsPaneExists = !!page();
  out.syncActButtons = [...document.querySelectorAll('[data-sync-act]')].map((b) => b.dataset.syncAct);
  if (!urlInput) {
    out.diag = page() ? page().innerHTML.slice(0, 600) : '(设置页未渲染)';
    return out;
  }  urlInput.value = window.__SMOKE_SYNC;
  urlInput.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(600);
  out.pendingBadge = (document.querySelector('.sync-status-card .badge-pill') || {}).textContent || '';
  out.pendingSyncLabel = (document.querySelector('#sync-label') || {}).textContent || '';
  out.pendingSyncDot = (document.querySelector('#sync-dot') || {}).className || '';
  out.statusSyncText = (document.querySelector('#status-sync') || {}).textContent || '';

  /* ---------- 2. 点「登录 / 注册」应弹出登录框 ---------- */
  const entry = document.querySelector('[data-sync-act="account"]');
  out.hasAccountBtn = !!entry;
  if (!entry) {
    out.diag = page() ? page().innerHTML.slice(0, 900) : '(设置页未渲染)';
    return out;
  }
  out.accountBtnText = entry.textContent.trim();
  entry.click();
  await sleep(900);

  let modal = modalRoot();
  out.authModalShown = !!modalOf();
  if (!out.authModalShown || !modal) {
    out.diag = document.querySelector('#modal-root').innerHTML.slice(0, 900);
    return out;
  }
  out.authModalTitle = modalTitle();
  out.authTabs = [...modal.querySelectorAll('[data-auth-tab]')].map((b) => b.textContent.trim());
  out.prefilledServer = modal.querySelector('[data-auth="serverUrl"]').value;
  out.confirmHiddenOnLogin = modal.querySelector('[data-auth-row="confirm"]').hidden;
  out.bannerHasHint = (modal.querySelector('.auth-banner') || { textContent: '' }).textContent.length > 10;

  /* ---------- 3. 切到注册：确认密码出现 ---------- */
  modal.querySelector('[data-auth-tab="register"]').click();
  await sleep(220);
  out.confirmVisibleOnRegister = !modal.querySelector('[data-auth-row="confirm"]').hidden;
  out.submitLabelOnRegister = modal.querySelector('[data-auth-act="submit"]').textContent.trim();

  /* ---------- 4. 前端校验（不合法时不发请求） ---------- */
  setVal(modal, '[data-auth="email"]', 'not-an-email');
  setVal(modal, '[data-auth="password"]', 'smoke123456');
  setVal(modal, '[data-auth="password2"]', 'smoke123456');
  modal.querySelector('[data-auth-act="submit"]').click();
  await sleep(300);
  out.badEmailBlocked = !modal.querySelector('[data-role="auth-error"]').hidden;

  setVal(modal, '[data-auth="email"]', 'smoke@example.com');
  setVal(modal, '[data-auth="password"]', '123');
  setVal(modal, '[data-auth="password2"]', '123');
  modal.querySelector('[data-auth-act="submit"]').click();
  await sleep(300);
  out.shortPasswordBlocked = !modal.querySelector('[data-role="auth-error"]').hidden;

  setVal(modal, '[data-auth="password"]', 'smoke123456');
  setVal(modal, '[data-auth="password2"]', 'mismatch-here');
  modal.querySelector('[data-auth-act="submit"]').click();
  await sleep(300);
  out.mismatchBlocked = !modal.querySelector('[data-role="auth-error"]').hidden;

  /* ---------- 5. 合法提交 → 注册成功并自动同步 ----------
   * 新阶段：本地（local）在阶段 1 已写入示例内容，且 smoke@example.com 是一个
   * 全新账号（本机无记录、服务端也空），所以注册成功后会先弹「把本机内容归属给
   * 新账号」确认框，由用户决定把 local 这份内容认领给新账号（清空 local、内容上
   * 传）还是保留 local、新账号从空开始。这里按用户选择的「携带进账号（推荐）」点
   * 「归属给新账号」。 */
  setVal(modal, '[data-auth="password2"]', 'smoke123456');
  modal.querySelector('[data-auth-act="submit"]').click();
  // 等待：要么直接登录完成（本地无内容走 switch），要么弹出归属确认框
  await until(() => !!document.querySelector('[data-claim]')
    || !document.querySelector('#modal-root .modal'), 10000);
  const claimModal = document.querySelector('#modal-root .modal');
  out.claimShown = !!(claimModal && claimModal.querySelector('[data-claim]'));
  if (out.claimShown) {
    out.claimTitle = (claimModal.querySelector('.modal-head span') || {}).textContent || '';
    out.claimMentionsEmail = (claimModal.textContent || '').includes('smoke@example.com');
    out.claimHasYes = !!claimModal.querySelector('[data-claim="yes"]');
    out.claimHasNo = !!claimModal.querySelector('[data-claim="no"]');
    out.claimHasCancel = !!claimModal.querySelector('[data-claim="cancel"]');
    // 归属给新账号：local 内容搬进账号、立即上传
    claimModal.querySelector('[data-claim="yes"]').click();
    await until(() => !document.querySelector('#modal-root .modal'), 10000);
  } else if (!document.querySelector('#modal-root .modal')) {
    // 本地无内容时不会弹确认框，这里直接走 switch 分支，无需额外操作
    out.claimShown = false;
  } else {
    out.diag = '注册后既无归属确认框也无登录完成态；modal-root=' + modalLen();
    return out;
  }
  out.modalClosedAfterSubmit = !document.querySelector('#modal-root .modal');

  // 等自动同步跑完（登录后 300ms 触发）
  await sleep(3000);
  out.syncLabelAfter = (document.querySelector('#sync-label') || {}).textContent || '';
  out.syncDotAfter = (document.querySelector('#sync-dot') || {}).className || '';
  out.statusSyncAfter = (document.querySelector('#status-sync') || {}).textContent || '';

  // 设置页应刷新为已连接
  document.querySelector('#btn-runner').click();
  await sleep(250);
  document.querySelector('#btn-settings').click();
  await sleep(600);
  const settingsEl = document.querySelector('.settings-page');
  out.settingsShowsConnected = settingsEl ? settingsEl.textContent.includes('已连接') : false;
  out.settingsShowsAccount = settingsEl ? settingsEl.textContent.includes('smoke@example.com') : false;
  out.settingsHasSignOut = !!document.querySelector('[data-sync-act="sign-out"]');
  out.settingsHasSyncActions = !!document.querySelector('[data-sync-act="sync-now"]');

  /* ---------- 6. 在服务地址框里改动不该把登录态弄丢 ----------
   * 这是个很容易回归的点：同步相关设置是 settings.sync 这个子对象，
   * 局部更新时如果整块替换，token / email / accountKey 会被顺手抹掉，
   * 表现为「随手改一下地址就掉登录」。 */
  const urlEdit = document.querySelector('[data-sync="serverUrl"]');
  if (urlEdit) {
    const original = urlEdit.value;
    urlEdit.value = original + '/';
    urlEdit.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(400);
    out.badgeAfterUrlEdit = (document.querySelector('[data-role="sync-badge"]') || {}).textContent || '';
    out.accountAfterUrlEdit = (document.querySelector('[data-role="sync-form-account"]') || {}).textContent || '';
    urlEdit.value = original;
    urlEdit.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(400);
    out.badgeRestored = (document.querySelector('[data-role="sync-badge"]') || {}).textContent || '';
  }

  } catch (e) {
    out.probeError = e && e.stack ? e.stack : String(e);
  }
  out.errorCount = errs.length;
  out.errors = errs.slice(0, 10);
  return out;
})()`;

/* ==================================================================== *
 * 探针 3：令牌失效 → 点同步 → 自动弹出「登录已过期」
 * ==================================================================== */
const PROBE_EXPIRED = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (cond, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (cond()) return true; await sleep(150); } return !!cond(); };
  const out = {};
  const errs = [];
  window.addEventListener('error', (e) => errs.push('error: ' + e.message));
  window.addEventListener('unhandledrejection', (e) => errs.push('unhandledrejection: ' + (e.reason && e.reason.message || e.reason)));

  try {
  /* ---------- 通过顶栏同步菜单真正触发一次同步 ---------- */
  document.querySelector('#btn-sync').click();
  await sleep(350);
  const items = [...document.querySelectorAll('#context-menu .menu-item')];
  out.menuItems = items.map((i) => i.textContent.replace(/\\s+/g, ' ').trim());
  const syncItem = items.find((i) => i.textContent.includes('立即同步'));
  out.hasSyncMenuItem = !!syncItem;
  if (!syncItem) return out;
  syncItem.click();
  await until(() => !!document.querySelector('#modal-root .auth-form'), 8000);

  const modal = document.querySelector('#modal-root .auth-form');
  out.expiredModalShown = !!modal;
  out.expiredTitle = (document.querySelector('#modal-root .modal-head span') || {}).textContent || '';
  out.expiredBanner = modal ? (modal.querySelector('.auth-banner') || {}).textContent.replace(/\\s+/g, ' ').trim() : '';
  out.emailPrefilledOnExpire = modal ? modal.querySelector('[data-auth="email"]').value : '';
  out.serverPrefilledOnExpire = modal ? modal.querySelector('[data-auth="serverUrl"]').value : '';
  out.syncLabelDuringExpired = (document.querySelector('#sync-label') || {}).textContent || '';

  /* ---------- 取消后应回到「待登录」而不是继续报错 ---------- */
  const cancel = document.querySelector('[data-auth-act="cancel"]');
  if (cancel) cancel.click();
  await sleep(400);
  out.modalClosedOnCancel = !document.querySelector('#modal-root .auth-form');
  out.syncLabelAfterCancel = (document.querySelector('#sync-label') || {}).textContent || '';
  out.syncDotAfterCancel = (document.querySelector('#sync-dot') || {}).className || '';

  } catch (e) {
    out.probeError = e && e.stack ? e.stack : String(e);
  }
  out.errorCount = errs.length;
  out.errors = errs.slice(0, 10);
  return out;
})()`;

/* ==================================================================== *
 * 探针 4：从已登录账号切到另一个全新账号 → 账号工作区隔离、UI 更新
 *   新模型下每个账号是独立的 profile 目录，互相隔离。local 在阶段 2 已把示例内容
 *   「归属」给 smoke@example.com，因此切到另一个账号时 local 已为空，不会再弹旧式的
 *   「本机配置属于另一个账号」二选一框；新账号直接以空工作区登录，验证数据隔离。
 * ==================================================================== */
const PROBE_SWITCH = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (cond, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (cond()) return true; await sleep(150); } return !!cond(); };
  const out = {};
  const errs = [];
  window.addEventListener('error', (e) => errs.push('error: ' + e.message));
  window.addEventListener('unhandledrejection', (e) => errs.push('unhandledrejection: ' + (e.reason && e.reason.message || e.reason)));

  const setVal = (root, sel, v) => {
    const el = root.querySelector(sel);
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el;
  };
  const switchTab = (name) => {
    const b = [...document.querySelectorAll('.stab')].find((x) => x.dataset.tab === name);
    if (b) b.click();
  };
  const modalLen = () => {
    const el = document.querySelector('#modal-root');
    return el ? el.innerHTML.length : -1;
  };

  const body = async () => {
  // 阶段 3 取消过期登录后会处于「待登录」态，这里先以 smoke 重新登录，
  // 确保接下来「切换账号」走完整的 guard → 登出 → 登录 流程。
  let badge = (document.querySelector('[data-role="sync-badge"]') || {}).textContent || '';
  if (badge !== '已连接') {
    document.querySelector('#btn-settings').click();
    await sleep(500);
    const e0 = document.querySelector('[data-sync-act="account"]');
    if (e0) {
      e0.click();
      await sleep(800);
      const m = document.querySelector('#modal-root .modal');
      if (m) {
        const loginTab = m.querySelector('[data-auth-tab="login"]');
        if (loginTab) loginTab.click();
        await sleep(200);
        setVal(m, '[data-auth="email"]', 'smoke@example.com');
        setVal(m, '[data-auth="password"]', 'smoke123456');
        const srv = m.querySelector('[data-auth="serverUrl"]');
        if (srv && !srv.value.trim()) { srv.value = window.__SMOKE_SYNC; srv.dispatchEvent(new Event('input', { bubbles: true })); await sleep(150); }
        m.querySelector('[data-auth-act="submit"]').click();
        await until(() => !document.querySelector('#modal-root .modal'), 10000);
        await sleep(800);
      }
    }
    document.querySelector('#btn-settings').click();
    await sleep(500);
  }

  /* ---------- 切换前：当前登录的是 smoke@example.com，工作区里有示例内容 ---------- */
  switchTab('collections');
  await sleep(250);
  out.requestsBefore = document.querySelectorAll('#sidebar-body .tree-row[data-req]').length;

  document.querySelector('#btn-settings').click();
  await sleep(500);
  const entry = document.querySelector('[data-sync-act="account"]');
  if (!entry) { out.diag = '设置页找不到账号入口'; return; }
  out.entryText = entry.textContent.trim();
  out.badgeBefore = (document.querySelector('[data-role="sync-badge"]') || {}).textContent || '';
  out.serverUrlField = ((document.querySelector('[data-sync="serverUrl"]') || {}).value || '').trim();

  entry.click();
  out.modalAt0 = modalLen();
  await sleep(800);

  // 已登录时点「切换账号」会先弹一个「切换同步账号」确认框，必须先确认掉
  const guard = document.querySelector('#modal-root [data-act="ok"]');
  out.signOutConfirmShown = !!guard;
  if (guard) guard.click();
  await sleep(1200);
  out.authModalAfterGuard = !!document.querySelector('#modal-root .auth-form');

  const modal = document.querySelector('#modal-root .modal');
  if (!modal) { out.diag = 'guard 后未弹出登录框；modal-root=' + modalLen(); return; }

  // 登出后回到本机，本机没存服务地址，这里补上（注册/登录要用）
  const srvField = modal.querySelector('[data-auth="serverUrl"]');
  if (srvField && !srvField.value.trim()) {
    srvField.value = window.__SMOKE_SYNC;
    srvField.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(200);
  }

  /* ---------- 注册并登录另一个账号 ---------- */
  modal.querySelector('[data-auth-tab="register"]').click();
  await sleep(200);
  setVal(modal, '[data-auth="email"]', 'other@example.com');
  setVal(modal, '[data-auth="password"]', 'other123456');
  setVal(modal, '[data-auth="password2"]', 'other123456');
  modal.querySelector('[data-auth-act="submit"]').click();
  // 此时 local 已为空（阶段 2 认领给 smoke 账号），新账号不会触发归属确认框，直接登录
  await until(() => !!document.querySelector('[data-claim]')
    || !document.querySelector('#modal-root .modal'), 10000);
  out.legacySwitchDialogShown = !!document.querySelector('[data-switch]');
  out.claimPromptShown = !!document.querySelector('[data-claim]');
  // 防御：若意外弹了归属框（说明 local 非空，与预期不符），归属以不卡死流程
  if (out.claimPromptShown) {
    const cm = document.querySelector('#modal-root .modal');
    if (cm && cm.querySelector('[data-claim="yes"]')) cm.querySelector('[data-claim="yes"]').click();
  }
  await until(() => !document.querySelector('#modal-root .modal'), 10000);
  out.modalClosed = !document.querySelector('#modal-root .modal');

  /* ---------- 切到集合页：新账号工作区应隔离（为空） ---------- */
  switchTab('collections');
  await sleep(300);
  out.requestsAfter = document.querySelectorAll('#sidebar-body .tree-row[data-req]').length;
  out.collectionsAfter = document.querySelectorAll('#sidebar-body .tree-row[data-col]').length;

  document.querySelector('#btn-settings').click();
  await sleep(700);
  const st = document.querySelector('.settings-page');
  out.settingsShowsOther = st ? st.textContent.includes('other@example.com') : false;
  out.badgeAfter = (document.querySelector('[data-role="sync-badge"]') || {}).textContent || '';
  out.syncLabel = (document.querySelector('#sync-label') || {}).textContent || '';
  };

  try {
    await body();
  } catch (e) {
    out.probeError = e && e.stack ? e.stack : String(e);
  }
  out.errorCount = errs.length;
  out.errors = errs.slice(0, 10);
  return out;
})()`;

/* ==================================================================== *
 * 探针 5：退出登录回本机 → 本机造内容 → 注册第三个全新账号时弹归属确认
 *        → 选「不归属」：新账号从空开始，本机内容保留（登出可切回查看）
 *   验证点：① 归属确认框在「本地有内容 + 全新账号」时出现；② 选「不归属」后
 *   账号工作区为空（隔离、不把本机内容带进去）；③ 本机内容原样保留，登出后可见。
 * ==================================================================== */
const PROBE_KEEP = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (cond, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (cond()) return true; await sleep(150); } return !!cond(); };
  const out = {};
  const errs = [];
  window.addEventListener('error', (e) => errs.push('error: ' + e.message));
  window.addEventListener('unhandledrejection', (e) => errs.push('unhandledrejection: ' + (e.reason && e.reason.message || e.reason)));

  const setVal = (root, sel, v) => {
    const el = root.querySelector(sel);
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el;
  };
  const switchTab = (name) => {
    const b = [...document.querySelectorAll('.stab')].find((x) => x.dataset.tab === name);
    if (b) b.click();
  };
  const modalLen = () => {
    const el = document.querySelector('#modal-root');
    return el ? el.innerHTML.length : -1;
  };
  const closeGuard = async () => {
    const g = document.querySelector('#modal-root [data-act="ok"]');
    if (g) { g.click(); await sleep(900); }
  };

  const body = async () => {
  /* ---------- 1. 先退出当前账号，回到本机工作区 ---------- */
  document.querySelector('#btn-settings').click();
  await sleep(500);
  const signOutBtn = document.querySelector('[data-sync-act="sign-out"]');
  out.signOutBtnFound = !!signOutBtn;
  if (signOutBtn) {
    signOutBtn.click();
    await sleep(400);
    await closeGuard();
  }

  /* ---------- 2. 在本机造一条新请求（此时 active 是本机） ---------- */
  switchTab('collections');
  await sleep(200);
  document.querySelector('#btn-new-request').click();
  await sleep(500);
  out.requestsInLocal = document.querySelectorAll('#sidebar-body .tree-row[data-req]').length;

  /* ---------- 3. 注册第三个账号：本机有内容 + 新用户 → 弹归属确认 ---------- */
  document.querySelector('#btn-settings').click();
  await sleep(500);
  const entry = document.querySelector('[data-sync-act="account"]');
  if (!entry) { out.diag = '设置页找不到账号入口'; return; }
  // 退出登录后回到本机，本机没存服务地址；不先填地址，点「登录 / 注册」会被拦下只弹提示
  const srvInput = document.querySelector('[data-sync="serverUrl"]');
  if (srvInput && !srvInput.value.trim()) {
    srvInput.value = window.__SMOKE_SYNC;
    srvInput.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(200);
  }
  entry.click();
  await sleep(900);
  const modal = document.querySelector('#modal-root .modal');
  if (!modal) { out.diag = '未弹出登录框；modal-root=' + modalLen(); return; }
  // 本机没存服务地址，补上
  const srvField = modal.querySelector('[data-auth="serverUrl"]');
  if (srvField && !srvField.value.trim()) {
    srvField.value = window.__SMOKE_SYNC;
    srvField.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(200);
  }
  modal.querySelector('[data-auth-tab="register"]').click();
  await sleep(200);
  setVal(modal, '[data-auth="email"]', 'keep@example.com');
  setVal(modal, '[data-auth="password"]', 'keep123456');
  setVal(modal, '[data-auth="password2"]', 'keep123456');
  modal.querySelector('[data-auth-act="submit"]').click();

  // 本机有内容 + 新用户 → 弹归属确认框
  await until(() => !!document.querySelector('[data-claim]'), 10000);
  out.claimShown = !!document.querySelector('[data-claim]');
  if (!out.claimShown) { out.diag = '未弹出归属确认框；modal-root=' + modalLen(); return; }
  const claimModal = document.querySelector('#modal-root .modal');
  out.claimTitle = (claimModal.querySelector('.modal-head span') || {}).textContent || '';
  out.claimMentionsEmail = (claimModal.textContent || '').includes('keep@example.com');
  out.claimHasNo = !!claimModal.querySelector('[data-claim="no"]');
  out.claimHasYes = !!claimModal.querySelector('[data-claim="yes"]');
  out.claimHasCancel = !!claimModal.querySelector('[data-claim="cancel"]');

  // 选「不归属」：新账号从空开始，本机内容保留在「本机」工作区
  claimModal.querySelector('[data-claim="no"]').click();
  await until(() => !document.querySelector('#modal-root .modal'), 10000);
  out.modalClosed = !document.querySelector('#modal-root .modal');

  /* ---------- 4. 切到集合页：keep 账号隔离（应为空） ---------- */
  switchTab('collections');
  await sleep(300);
  out.requestsAfterKeep = document.querySelectorAll('#sidebar-body .tree-row[data-req]').length;

  document.querySelector('#btn-settings').click();
  await sleep(700);
  const st = document.querySelector('.settings-page');
  out.settingsShowsKeep = st ? st.textContent.includes('keep@example.com') : false;
  out.badgeAfter = (document.querySelector('[data-role="sync-badge"]') || {}).textContent || '';

  /* ---------- 5. 再登出，回到本机：本机内容应原样保留 ---------- */
  const signOutBtn2 = document.querySelector('[data-sync-act="sign-out"]');
  if (signOutBtn2) {
    signOutBtn2.click();
    await sleep(400);
    await closeGuard();
  }
  switchTab('collections');
  await sleep(300);
  out.requestsAfterLogout = document.querySelectorAll('#sidebar-body .tree-row[data-req]').length;
  };

  try {
    await body();
  } catch (e) {
    out.probeError = e && e.stack ? e.stack : String(e);
  }
  out.errorCount = errs.length;
  out.errors = errs.slice(0, 10);
  return out;
})()`;

/* ==================================================================== *
 * 阶段 6 探针：客户端更新（检查 → 下载 → 唤起安装器）
 * ==================================================================== */
const PROBE_UPDATE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (cond, ms) => {
    const t = Date.now();
    while (Date.now() - t < ms) { if (cond()) return true; await sleep(150); }
    return !!cond();
  };
  const out = {};
  const errs = [];
  window.addEventListener('error', (e) => errs.push('error: ' + e.message));
  window.addEventListener('unhandledrejection', (e) => errs.push('unhandledrejection: ' + (e.reason && e.reason.message || e.reason)));
  const modalOf = () => document.querySelector('#modal-root .modal');
  const text = (sel) => {
    const el = document.querySelector(sel);
    return el ? String(el.textContent || '').replace(/\\s+/g, ' ').trim() : '';
  };
  const setVal = (root, sel, v) => {
    const el = root.querySelector(sel);
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el;
  };

  const body = async () => {
    // 阶段 5 结束时已登出，更新检查需要登录态，这里先以 keep 重新登录
    let badge = (document.querySelector('[data-role="sync-badge"]') || {}).textContent || '';
    if (badge !== '已连接') {
      document.querySelector('#btn-settings').click();
      await sleep(500);
      const e0 = document.querySelector('[data-sync-act="account"]');
      if (e0) {
        e0.click();
        await sleep(800);
        const m = document.querySelector('#modal-root .modal');
        if (m) {
          const loginTab = m.querySelector('[data-auth-tab="login"]');
          if (loginTab) loginTab.click();
          await sleep(200);
          setVal(m, '[data-auth="email"]', 'keep@example.com');
          setVal(m, '[data-auth="password"]', 'keep123456');
          const srv = m.querySelector('[data-auth="serverUrl"]');
          if (srv && !srv.value.trim()) { srv.value = window.__SMOKE_SYNC; srv.dispatchEvent(new Event('input', { bubbles: true })); await sleep(150); }
          m.querySelector('[data-auth-act="submit"]').click();
          await until(() => !document.querySelector('#modal-root .modal'), 10000);
          await sleep(800);
        }
      }
    }

    /* ---------- 打开设置页，找到更新卡片 ---------- */
    document.querySelector('#btn-settings').click();
    await sleep(700);
    out.cardFound = !!document.querySelector('[data-role="upd-card"]');
    if (!out.cardFound) { out.diag = '设置页没有更新卡片'; return; }

    out.currentVersion = text('[data-role="upd-current"]');
    out.badgeBefore = text('[data-role="upd-badge"]');
    const checkBtn = document.querySelector('[data-upd-act="check"]');
    out.checkBtnFound = !!checkBtn;
    if (!checkBtn) { out.diag = '找不到「检查更新」按钮'; return; }

    /* ---------- 检查更新 ---------- */
    checkBtn.click();
    await until(() => {
      const b = text('[data-role="upd-badge"]');
      return b === '有新版本' || b === '已是最新' || b === '检查失败';
    }, 10000);
    out.badgeAfter = text('[data-role="upd-badge"]');
    out.latestText = text('[data-role="upd-latest"]');
    out.subAfter = text('[data-role="upd-sub"]');

    /* ---------- 有新版本应该自动弹出更新窗 ---------- */
    await until(() => !!modalOf(), 6000);
    out.modalShown = !!modalOf();
    if (!out.modalShown) { out.diag = '查到了新版本但没有弹窗'; return; }

    const m = modalOf();
    out.modalTitle = (m.querySelector('.modal-head span') || {}).textContent || '';
    out.modalBody = String(m.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 400);
    out.modalMentionsNew = out.modalBody.includes('9.9.9');
    out.modalMentionsNotes = out.modalBody.includes('新增客户端更新检查');
    out.hasDownloadBtn = !!m.querySelector('[data-update-act="download"]');
    out.hasSkipBtn = !!m.querySelector('[data-update-act="skip"]');
    out.hasLaterBtn = !!m.querySelector('[data-update-act="later"]');

    /* ---------- 下载并安装 ---------- */
    m.querySelector('[data-update-act="download"]').click();
    const settled = await until(() => {
      const r = document.querySelector('[data-role="update-result"]');
      return !!r && !r.hidden && /安装程序已打开|无法打开/.test(r.textContent || '');
    }, 25000);

    out.installSettled = settled;
    const result = document.querySelector('[data-role="update-result"]');
    out.resultText = result ? String(result.textContent || '').replace(/\\s+/g, ' ').trim() : '';
    out.resultOk = !!result && result.classList.contains('text-ok');
    out.progressText = text('[data-role="update-progress-text"]');
    const bar = document.querySelector('[data-role="update-progress"]');
    out.progressWidth = bar ? bar.style.width : '';

    /* ---------- 关掉弹窗，卡片应停在「待安装」 ---------- */
    const closeBtn = document.querySelector('#modal-root [data-modal-close]');
    if (closeBtn) closeBtn.click();
    await sleep(500);
    out.modalClosed = !modalOf();
    out.badgeAfterDownload = text('[data-role="upd-badge"]');
    out.installBtnText = (document.querySelector('[data-upd-act="install"]') || {}).textContent || '';
    out.subAfterDownload = text('[data-role="upd-sub"]');
    out.topbarDotShown = !document.querySelector('#update-dot').hidden;

    /* ---------- 跳过此版本 ---------- */
    const installBtn = document.querySelector('[data-upd-act="install"]');
    if (installBtn) {
      installBtn.click();
      await until(() => !!modalOf(), 5000);
      out.modalReopened = !!modalOf();
      if (out.modalReopened) {
        document.querySelector('[data-update-act="skip"]').click();
        await sleep(600);
        out.ignoredShown = !!document.querySelector('[data-role="upd-ignored"]');
        out.ignoredText = text('[data-role="upd-ignored"]');

        const un = document.querySelector('[data-upd-act="unignore"]');
        out.unignoreBtnFound = !!un;
        if (un) {
          un.click();
          await sleep(500);
          out.ignoredGoneAfterRestore = !document.querySelector('[data-role="upd-ignored"]');
        }
      }
    }
  };

  try {
    await body();
  } catch (e) {
    out.probeError = e && e.stack ? e.stack : String(e);
  }
  out.errorCount = errs.length;
  out.errors = errs.slice(0, 10);
  return out;
})()`;

/* ==================================================================== *
 * 挂载
 * ==================================================================== */

/**
 * 在渲染进程里跑一段探针，带超时。
 * 探针一旦卡住（等一个永远不出现的元素），默认的 executeJavaScript 会
 * 永远不 settle，整个冒烟测试就静默挂死 —— 这里用超时兜底，至少能报出
 * 是哪个阶段卡住了。
 */
async function runProbe(win, script, label, timeoutMs = 60000) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`阶段 ${label} 执行超时（${timeoutMs}ms）`)), timeoutMs);
  });
  try {
    return await Promise.race([win.webContents.executeJavaScript(script, true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function attach(win, app, smokeDir) {
  const consoleErrors = [];
  const levels = { 0: 'verbose', 1: 'info', 2: 'warning', 3: 'error' };

  win.webContents.on('console-message', (...args) => {
    // Electron 33 起可能是 (event, details) 形式，兼容两种签名
    let level;
    let message;
    let source;
    let line;
    if (args[1] && typeof args[1] === 'object') {
      ({ level, message, sourceId: source, lineNumber: line } = args[1]);
    } else {
      level = args[1];
      message = args[2];
      line = args[3];
      source = args[4];
    }
    if (level >= 2) {
      consoleErrors.push(`[${levels[level] || level}] ${message} (${source || '?'}:${line || '?'})`);
    }
    // 探针内部用 console.log('SMOKE|...') 上报进度，这里转写到磁盘，
    // 探针一旦卡死也能看到卡在哪一行
    if (typeof message === 'string' && message.startsWith('SMOKE|')) step(message);
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    consoleErrors.push('render-process-gone: ' + JSON.stringify(details));
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    consoleErrors.push(`did-fail-load ${code} ${desc} ${url}`);
  });
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    consoleErrors.push(`preload-error ${preloadPath}: ${error.message}`);
  });

  win.webContents.once('did-finish-load', async () => {
    step('did-finish-load');
    try {
      const echo = await startEchoServer();
      step('echo server up :' + echo);
      const sync = await startMockSync();
      syncState.url = `http://127.0.0.1:${sync}`;
      step('mock sync server up :' + sync);
      await new Promise((r) => setTimeout(r, 1800)); // 等 boot() 完成

      await win.webContents.executeJavaScript(
        `window.__SMOKE_URL = 'http://127.0.0.1:${echo}'; window.__SMOKE_SYNC = 'http://127.0.0.1:${sync}'; true;`
      );

      /* ---------- 阶段 1：基础界面与请求执行 ---------- */
      step('probe 1 start');
      const base = await runProbe(win, PROBE, '1');
      step('probe 1 done, errors=' + JSON.stringify(base.errors || []));
      dumpSync(smokeDir, 'after1');
      const checks = [
        ['preload 桥接已暴露', base.bridgeExposed],
        ['bridge.sync 新接口就位', base.bridgeSyncApi],
        ['顶栏渲染', base.hasBrand],
        ['侧栏渲染', base.hasSidebar],
        ['标签栏渲染', base.hasTabbar],
        ['状态栏有内容', !!base.statusText],
        ['初始空状态提示', base.emptyWelcome],
        ['环境选择器显示', !!base.envPickerLabel],
        ['欢迎页有示例按钮', base.welcomeHasDemoBtn],
        ['初始同步状态为未连接', base.initialSyncLabel === '未连接'],
        ['示例集合已创建', base.demoCollections >= 1],
        ['示例请求已创建（5 个）', base.demoRequests >= 5],
        ['示例环境自动设为当前', base.demoEnvLabel === '示例环境'],
        ['示例环境变量已就绪', base.demoVariables.includes('变量')],
        ['新建请求后生成面板', base.paneCreated],
        ['标签页已创建', base.tabCount === 1],
        ['开标签后欢迎页已清空', base.welcomeClearedAfterTab],
        ['主区域无残留非面板节点', base.panesStrayChildren === 0],
        ['活动面板未被挤下去', base.activePaneNotPushedDown],
        ['地址输入框存在', base.hasUrlInput],
        ['方法选择框存在', base.hasMethodSelect],
        ['请求子标签为 5 个', base.subtabs.length === 5],
        ['Params 表格就绪', base.paramTableReady],
        ['末行输入自动新增一行', base.paramAutoGrow],
        ['URL 实时预览生效', base.urlPreview.includes('/smoke')],
        ['响应元信息已渲染', base.responseMeta.includes('状态')],
        ['响应体含服务端内容', base.responseHasToken],
        ['响应体语法高亮生效', base.responseHighlighted],
        ['响应头子标签可用', base.headersRendered],
        ['耗时子标签可用', base.timingRendered],
        ['历史记录已写入', base.historyItems >= 1],
        ['侧栏树显示请求', base.treeRequests >= 1],
        ['设置页渲染', base.settingsRendered],
        ['设置页含同步分区', base.settingsHasSyncSection],
        ['设置页顶到主区域最上沿', base.settingsPaneAtTop],
        ['设置页背后无残留欢迎页', base.noWelcomeBehindSettings],
        ['设置页滚动容器铺满主区域（滚动条在最右）', base.settingsScrollFullWidth],
        ['设置页内容仍按 860px 收窄', base.settingsContentCapped],
        ['设置内容挂在内层容器上', base.settingsInnerHoldsContent],
        ['批量执行页渲染', base.runnerRendered],
        ['批量执行有开始按钮', base.runnerHasStartBtn],
        ['[hidden] 兜底规则生效（能压过 .modal-root 的 display:grid）', base.hiddenRuleDisplay === 'none'],
        ['页面上带 hidden 的元素确实都不可见', base.allHiddenCollapsed],
        ['阶段 1 渲染进程无未捕获异常', base.errorCount === 0],
      ];

      /* ---------- 阶段 2：配置地址 → 登录框 → 注册 → 自动同步 ---------- */
      step('probe 2 start');
      // 探针可能中途提前返回（带 diag），这里补一份默认值，避免断言处再抛错掩盖真实问题
      const auth = Object.assign(
        {
          authTabs: [], errorCount: 1,
          // 所有用 .includes / .length 读取的字段都要有默认值，否则提前返回时会二次报错
          pendingBadge: '', pendingSyncLabel: '', pendingSyncDot: '', statusSyncText: '',
          accountBtnText: '', prefilledServer: '', authModalTitle: '', submitLabelOnRegister: '',
          syncLabelAfter: '', syncDotAfter: '',
          badgeAfterUrlEdit: '', accountAfterUrlEdit: '', badgeRestored: '',
          // 全新账号 + 本地有内容时弹出的本机内容归属确认框
          claimShown: false, claimTitle: '', claimMentionsEmail: false,
          claimHasYes: false, claimHasNo: false, claimHasCancel: false,
        },
        await runProbe(win, PROBE_AUTH, '2')
      );
      step('probe 2 done, errors=' + JSON.stringify(auth.errors || []) + ' probeError=' + (auth.probeError ? 'yes' : 'no'));
      dumpSync(smokeDir, 'after2');

      const regCall = syncState.calls.find((c) => c.path === '/api/auth/register');
      const pushCall = syncState.calls.find((c) => c.path === '/api/sync/push');
      const pullCall = syncState.calls.find((c) => c.path === '/api/sync/pull');

      checks.push(
        ['设置页有服务地址输入框', auth.hasServerField],
        ['只填地址未登录时状态为待登录', auth.pendingBadge === '待登录'],
        ['顶栏同步标签显示待登录', auth.pendingSyncLabel === '待登录'],
        ['同步指示灯为待登录态', auth.pendingSyncDot.includes('auth')],
        ['状态栏提示点击登录', auth.statusSyncText.includes('待登录')],
        ['未登录时入口按钮为「登录 / 注册」', auth.accountBtnText.includes('登录')],
        ['首次同步弹出登录框', auth.authModalShown],
        ['弹窗标题正确', auth.authModalTitle === '登录同步账号'],
        ['提供登录与注册两个页签', auth.authTabs.length === 2],
        ['服务地址已带入弹窗', auth.prefilledServer === syncState.url],
        ['登录态下不显示确认密码', auth.confirmHiddenOnLogin === true],
        ['弹窗含说明文案', auth.bannerHasHint],
        ['切到注册后出现确认密码', auth.confirmVisibleOnRegister === true],
        ['注册按钮文案随页签变化', auth.submitLabelOnRegister.includes('注册')],
        ['非法邮箱被前端拦下', auth.badEmailBlocked],
        ['过短密码被前端拦下', auth.shortPasswordBlocked],
        ['两次密码不一致被拦下', auth.mismatchBlocked],
        ['注册成功后弹窗关闭', auth.modalClosedAfterSubmit],
        ['全新账号+本地有内容时弹出归属确认', auth.claimShown],
        ['归属确认框标题正确', auth.claimTitle === '把本机内容归属给新账号？'],
        ['归属确认框点明新账号邮箱', auth.claimMentionsEmail],
        ['归属确认含「归属/不归属/取消」三选项', auth.claimHasYes && auth.claimHasNo && auth.claimHasCancel],
        ['确实发出了注册请求', !!regCall],
        ['注册后状态为已登录 / 已同步', ['自动同步', '已登录'].includes(auth.syncLabelAfter) || auth.syncLabelAfter.includes('已同步')],
        ['同步指示灯转为正常', auth.syncDotAfter.includes('ok')],
        ['注册后自动上传了本机配置', !!pushCall && syncState.entities.length > 0],
        ['上传内容含请求实体', syncState.entities.some((e) => e.kind === 'request')],
        ['注册后自动拉取了远端增量', !!pullCall],
        ['设置页显示已连接', auth.settingsShowsConnected],
        ['设置页显示当前账号', auth.settingsShowsAccount],
        ['设置页出现退出登录按钮', auth.settingsHasSignOut],
        ['设置页出现同步动作区', auth.settingsHasSyncActions],
        ['改服务地址不会把登录态弄丢', auth.badgeAfterUrlEdit === '已连接'],
        ['改服务地址后账号仍正确', auth.accountAfterUrlEdit === 'smoke@example.com'],
        ['地址改回后仍为已连接', auth.badgeRestored === '已连接'],
        ['阶段 2 渲染进程无未捕获异常', auth.errorCount === 0]
      );

      /* ---------- 阶段 3：令牌失效 ---------- */
      syncState.expireNext = true;
      step('probe 3 start');
      const expired = Object.assign(
        {
          menuItems: [], expiredTitle: '', expiredBanner: '',
          emailPrefilledOnExpire: '', serverPrefilledOnExpire: '',
          syncLabelAfterCancel: '', syncDotAfterCancel: '', errorCount: 1,
        },
        await runProbe(win, PROBE_EXPIRED, '3')
      );
      step('probe 3 done, errors=' + JSON.stringify(expired.errors || []) + ' probeError=' + (expired.probeError ? 'yes' : 'no'));
      dumpSync(smokeDir, 'after3');

      checks.push(
        ['顶栏同步菜单含「立即同步」', expired.hasSyncMenuItem],
        ['令牌失效后自动弹出登录框', expired.expiredModalShown],
        ['标题提示登录已过期', expired.expiredTitle === '登录已过期'],
        ['弹窗说明登录已失效', /过期/.test(expired.expiredBanner)],
        ['过期弹窗带入上次账号邮箱', expired.emailPrefilledOnExpire === 'smoke@example.com'],
        ['过期弹窗保留服务地址', !!expired.serverPrefilledOnExpire],
        ['取消登录后弹窗关闭', expired.modalClosedOnCancel],
        ['取消后回到待登录状态', expired.syncLabelAfterCancel === '待登录'],
        ['取消后指示灯提示需登录', expired.syncDotAfterCancel.includes('auth')],
        ['阶段 3 渲染进程无未捕获异常', expired.errorCount === 0]
      );

      /* ---------- 阶段 4：换成另一个账号 → 清空本机 → 验证数据隔离 ---------- */
      const pushesAfterStage2 = syncState.pushes.length;
      step('probe 4 start');
      const sw = Object.assign(
        {
          errorCount: 1,
          signOutConfirmShown: false, authModalAfterGuard: false,
          requestsBefore: 0, legacySwitchDialogShown: false, claimPromptShown: false,
          requestsAfter: 0, collectionsAfter: 0, settingsShowsOther: false, badgeAfter: '',
        },
        await runProbe(win, PROBE_SWITCH, '4')
      );
      step('probe 4 done, errors=' + JSON.stringify(sw.errors || []) + ' probeError=' + (sw.probeError ? 'yes' : 'no'));
      dumpSync(smokeDir, 'after4');

      checks.push(
        ['切换账号时先确认登出（弹切换确认框）', sw.signOutConfirmShown],
        ['确认后弹出登录框', sw.authModalAfterGuard],
        ['切换前能看到 smoke 账号的示例内容', sw.requestsBefore >= 1],
        ['新账号登录后弹窗关闭', sw.modalClosed],
        ['旧模型「本机配置属于另一个账号」二选一框不再出现', !sw.legacySwitchDialogShown],
        ['local 为空时不会误弹归属确认框', !sw.claimPromptShown],
        ['新账号工作区与旧账号隔离（请求为空）', sw.requestsAfter === 0],
        ['新账号工作区与旧账号隔离（文件夹为空）', sw.collectionsAfter === 0],
        ['设置页显示新账号', sw.settingsShowsOther],
        ['新账号状态为已连接', sw.badgeAfter === '已连接'],
        ['切换账号未把旧账号内容推给新账号', syncState.pushes.length === pushesAfterStage2],
        ['阶段 4 渲染进程无未捕获异常', sw.errorCount === 0]
      );

      /* ---------- 阶段 5：登出回本机 → 本机造内容 → 注册新账号弹归属确认 → 选「不归属」 ---------- */
      const pushesBeforeKeep = syncState.pushes.length;
      step('probe 5 start');
      const keep = Object.assign(
        {
          errorCount: 1,
          signOutBtnFound: false, requestsInLocal: 0,
          claimShown: false, claimMentionsEmail: false,
          claimHasNo: false, claimHasYes: false, claimHasCancel: false,
          settingsShowsKeep: false, requestsAfterKeep: 0, requestsAfterLogout: 0,
        },
        await runProbe(win, PROBE_KEEP, '5')
      );
      step('probe 5 done, errors=' + JSON.stringify(keep.errors || []) + ' probeError=' + (keep.probeError ? 'yes' : 'no'));
      dumpSync(smokeDir, 'after5');

      checks.push(
        ['已登录时可退出登录', keep.signOutBtnFound],
        ['在本机新建请求成功', keep.requestsInLocal >= 1],
        ['新用户+本地有内容时弹出归属确认', keep.claimShown],
        ['归属确认框点明新账号邮箱', keep.claimMentionsEmail],
        ['归属确认含「归属/不归属/取消」三选项', keep.claimHasYes && keep.claimHasNo && keep.claimHasCancel],
        ['设置页显示第三个账号', keep.settingsShowsKeep],
        ['选「不归属」后新账号工作区为空（隔离）', keep.requestsAfterKeep === 0],
        ['选「不归属」后未把本机内容上传到新账号', syncState.pushes.length === pushesBeforeKeep],
        ['再次登出后本机内容原样保留', keep.requestsAfterLogout >= 1],
        ['阶段 5 渲染进程无未捕获异常', keep.errorCount === 0]
      );

      /* ---------- 阶段 6：客户端更新（检查 → 下载 → 唤起安装器） ----------
       * 到这里才发布安装包：前面几个阶段登录后都会自动检查更新，
       * 如果那时就有新版本，会平白弹出一个更新窗把它们的断言搅乱。 */
      const fakeRelease = publishFakeRelease('9.9.9');
      step('probe 6 start, released=' + fakeRelease.version + ' size=' + fakeRelease.body.length);
      const upd = Object.assign(
        { errorCount: 1 },
        await runProbe(win, PROBE_UPDATE, '6')
      );
      step('probe 6 done, errors=' + JSON.stringify(upd.errors || []) + ' probeError=' + (upd.probeError ? 'yes' : 'no'));

      checks.push(
        ['设置页有客户端更新卡片', upd.cardFound],
        // 客户端版本号支持 -dev 开发标记（1.0.0-dev / 1.0.0-dev.2），别写死三段
        ['卡片显示当前版本', /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(upd.currentVersion || ''))],
        ['有「检查更新」按钮', upd.checkBtnFound],
        ['检查后识别出新版本', upd.badgeAfter === '有新版本'],
        ['卡片显示服务端最新版本', String(upd.latestText || '').includes('9.9.9')],
        ['发现新版本后自动弹窗', upd.modalShown],
        ['弹窗标题正确', upd.modalTitle === '发现新版本'],
        ['弹窗点明目标版本', upd.modalMentionsNew],
        ['弹窗展示更新说明', upd.modalMentionsNotes],
        ['弹窗提供「下载并安装」', upd.hasDownloadBtn],
        ['弹窗提供「跳过此版本」', upd.hasSkipBtn],
        ['弹窗提供「稍后」', upd.hasLaterBtn],
        ['下载流程能走完', upd.installSettled],
        ['下载完成后唤起安装程序', /安装程序已打开/.test(String(upd.resultText || ''))],
        ['唤起结果标记为成功', upd.resultOk],
        ['安装包确实被下载过', syncState.downloads.length >= 1],
        ['下载的正是发布的那个包', syncState.downloads[0] === fakeRelease.id],
        ['进度条走到 100%', upd.progressWidth === '100%'],
        ['关闭弹窗后卡片显示待安装', upd.badgeAfterDownload === '待安装'],
        ['顶栏出现新版本小红点', upd.topbarDotShown],
        ['再次打开弹窗可跳过此版本', upd.modalReopened && upd.ignoredShown],
        ['跳过提示提到具体版本', String(upd.ignoredText || '').includes('9.9.9')],
        ['跳过后可恢复提示', upd.unignoreBtnFound && upd.ignoredGoneAfterRestore],
        ['阶段 6 渲染进程无未捕获异常', upd.errorCount === 0]
      );

      /* ---------- 汇总 ---------- */
      let pass = 0;
      let fail = 0;
      console.log('\n\n=============== 冒烟测试结果 ===============');
      for (const [name, ok] of checks) {
        console.log(`  ${ok ? '✓' : '✗'} ${name}`);
        if (ok) pass++;
        else fail++;
      }
      const allErrors = [
        ...(base.errors || []).map((e) => `[阶段1] ${e}`),
        ...(auth.errors || []).map((e) => `[阶段2] ${e}`),
        ...(expired.errors || []).map((e) => `[阶段3] ${e}`),
        ...(sw.errors || []).map((e) => `[阶段4] ${e}`),
        ...(keep.errors || []).map((e) => `[阶段5] ${e}`),
        ...(upd.errors || []).map((e) => `[阶段6] ${e}`),
      ];
      if (allErrors.length) {
        console.log('\n  渲染进程异常：');
        for (const e of allErrors) console.log('    · ' + e);
      }
      if (auth.probeError) {
        console.log('\n  阶段 2 探针异常：\n    ' + String(auth.probeError).split('\n').slice(0, 4).join('\n    '));
      }
      if (auth.diag) {
        console.log('\n  阶段 2 诊断（探针提前返回）：');
        console.log('    设置页已渲染 = ' + auth.settingsPaneExists);
        console.log('    可见的 data-sync-act = ' + JSON.stringify(auth.syncActButtons || []));
        console.log('    DOM 片段: ' + String(auth.diag).replace(/\s+/g, ' ').slice(0, 700));
      }
      if (expired.probeError) {
        console.log('\n  阶段 3 探针异常：\n    ' + String(expired.probeError).split('\n').slice(0, 4).join('\n    '));
      }
      if (expired.diag) {
        console.log('\n  阶段 3 诊断：' + String(expired.diag).replace(/\s+/g, ' ').slice(0, 700));
      }
      for (const [label, p] of [['4', sw], ['5', keep], ['6', upd]]) {
        if (p.probeError) {
          console.log(`\n  阶段 ${label} 探针异常：\n    ` + String(p.probeError).split('\n').slice(0, 4).join('\n    '));
        }
        if (p.diag) {
          console.log(`\n  阶段 ${label} 诊断：` + String(p.diag).replace(/\s+/g, ' ').slice(0, 700));
        }
      }
      if (consoleErrors.length) {
        console.log('\n  控制台报错：');
        for (const e of consoleErrors) console.log('    · ' + e);
      }
      if (fail) {
        for (const [label, p] of [['2', auth], ['3', expired], ['4', sw], ['5', keep], ['6', upd]]) {
          console.log(`\n  阶段 ${label} 原始返回：` + JSON.stringify(p).slice(0, 1500));
        }
      }
      console.log('-------------------------------------------');
      console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
      console.log('===========================================\n');

      cleanup(smokeDir);
      app.exit(fail === 0 ? 0 : 1);
    } catch (e) {
      console.error('冒烟测试执行异常：', e);
      // 中途失败时最有用的线索往往在渲染进程那边，别让它随进程退出一起丢掉
      if (consoleErrors.length) {
        console.error('\n渲染进程报错 / 异常：');
        for (const m of consoleErrors) console.error('  · ' + m);
      } else {
        console.error('（渲染进程未上报任何报错）');
      }
      cleanup(smokeDir);
      app.exit(1);
    }
  });
}

function cleanup(smokeDir) {
  try {
    if (echoServer) echoServer.close();
  } catch { /* ignore */ }
  try {
    if (syncServer) syncServer.close();
  } catch { /* ignore */ }
  if (smokeDir) {
    try {
      require('node:fs').rmSync(smokeDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
}

module.exports = {
  attach,
  PROBE,
  PROBE_AUTH,
  PROBE_EXPIRED,
  PROBE_SWITCH,
  PROBE_KEEP,
  PROBE_UPDATE,
  startEchoServer,
  startMockSync,
  publishFakeRelease,
  syncState,
};
