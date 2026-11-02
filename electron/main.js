'use strict';

const { app, BrowserWindow, ipcMain, protocol, net, dialog, shell, Menu, clipboard, Tray, nativeImage, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const { sendRequest } = require('./http-client');
const { ProfileManager } = require('./profile');
const { SyncClient } = require('./sync-client');
const { UpdateClient } = require('./update-client');
const { AppPrefs } = require('./prefs');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const APP_SCHEME = 'app';
const APP_ORIGIN = `${APP_SCHEME}://bundle`;

// 图标：窗口图标走 PNG（三个平台通吃），托盘在 Windows 上优先用 ICO ——
// 多尺寸 ICO 才能让系统按 DPI 缩放挑到清晰的那一档，单张 PNG 在高分屏上会糊。
const ASSETS_DIR = path.join(__dirname, 'assets');
const ICON_PNG = path.join(ASSETS_DIR, 'icon.png');
const TRAY_PNG = path.join(ASSETS_DIR, 'tray.png');
const TRAY_ICO = path.join(ASSETS_DIR, 'tray.ico');

// 冒烟测试：关闭硬件加速（无 GPU 环境会崩），并把数据目录隔离到临时位置，
// 绝不碰用户真实的 workspace.json
const SMOKE_DIR = (() => {
  if (process.env.MYAPITOOLS_SMOKE !== '1') return null;
  app.disableHardwareAcceleration();
  const dir = path.join(require('node:os').tmpdir(), `myapitools-smoke-${process.pid}`);
  app.setPath('userData', dir);
  return dir;
})();

let mainWindow = null;
let profileMgr = null;
let appPrefs = null;
let tray = null;
let isQuitting = false;
let closePrompting = false;
let trayHintShown = false;
// 界面是否已经加载完：关闭确认框要走应用内弹窗，界面还没起来就只能退回系统原生框
let rendererReady = false;
// 正在等界面回「关窗口怎么处理」，同一时刻只允许有一个
let pendingClosePrompt = null;
// 第一次收进托盘时「先提示、后隐藏」的定时器
let trayHintTimer = null;
const CLOSE_PROMPT_TIMEOUT = 25000;
const syncClient = new SyncClient();
const updateClient = new UpdateClient();

/* ------------------------------------------------------------------ *
 * 自定义协议：让渲染进程可以用原生 ES Module + fetch，
 * 而不必引入打包器（file:// 下 Chromium 会拦截 module 加载）
 * ------------------------------------------------------------------ */
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true },
  },
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function registerAppProtocol() {
  protocol.handle(APP_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      let pathname = decodeURIComponent(url.pathname || '/');
      if (!pathname || pathname === '/') pathname = '/index.html';
      // 阻止路径穿越
      const resolved = path.normalize(path.join(RENDERER_DIR, pathname));
      if (!resolved.startsWith(RENDERER_DIR)) {
        return new Response('Forbidden', { status: 403 });
      }
      const ext = path.extname(resolved).toLowerCase();
      if (ext === '.html' || ext === '.js' || ext === '.css') {
        const body = await fs.promises.readFile(resolved);
        return new Response(body, {
          headers: { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-cache' },
        });
      }
      return net.fetch(pathToFileURL(resolved).toString());
    } catch (e) {
      return new Response(`Not found: ${e.message}`, { status: 404 });
    }
  });
}

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */
function showMainWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  // 用户主动唤回就撤销「提示完再藏起来」的延时，否则窗口刚露脸又会自己消失
  clearTimeout(trayHintTimer);
  trayHintTimer = null;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

/**
 * 关闭时收进托盘：窗口只是隐藏，进程、批量执行、未落盘的编辑都还在。
 * 第一次收进托盘时先在界面里说一句「窗口去哪了」，停留一小会儿再隐藏 ——
 * 系统通知（Notification）长得跟应用完全不是一套，而且用户此刻正盯着窗口，
 * 在窗口里回答比弹一个系统气泡更直接。界面没起来时才退回系统通知。
 */
function hideToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (trayHintShown) {
    mainWindow.hide();
    return;
  }
  trayHintShown = true;

  if (!canUseInAppPrompt()) {
    hintTrayViaSystem();
    mainWindow.hide();
    return;
  }

  sendToRenderer('app:tray-hint');
  clearTimeout(trayHintTimer);
  trayHintTimer = setTimeout(() => {
    trayHintTimer = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  }, 1400);
}

/** 界面不可用时的兜底：用系统通知告知「还在后台」 */
function hintTrayViaSystem() {
  try {
    if (!Notification.isSupported()) return;
    new Notification({
      title: 'MyApiTools 仍在后台运行',
      body: '窗口已收进系统托盘，点托盘图标可以重新打开；右键托盘图标可以彻底退出。',
      silent: true,
    }).show();
  } catch {
    /* 系统通知不可用就算了，托盘本身还在 */
  }
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/** 界面能不能弹应用内对话框（没加载完 / 已销毁 / 正在重新加载都不行） */
function canUseInAppPrompt() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (!rendererReady) return false;
  try {
    return !mainWindow.webContents.isLoading();
  } catch {
    return false;
  }
}

/** 应用偏好快照：带上平台与托盘可用性，设置页直接拿去渲染 */
function prefsSnapshot() {
  if (!appPrefs) return { tray: { enabled: false, closeAction: 'quit' }, platform: process.platform, trayAvailable: false, version: app.getVersion() };
  const p = appPrefs.get();
  return {
    ...p,
    platform: process.platform,
    // 托盘图标此刻是否真的存在（Linux 某些桌面环境建不起来会是 false）
    trayAvailable: !!tray,
    version: app.getVersion(),
  };
}

/** 结束一次「等界面回话」，没在等就直接忽略（超时后再点按钮之类的） */
function settleClosePrompt(decision) {
  const p = pendingClosePrompt;
  if (!p) return;
  pendingClosePrompt = null;
  clearTimeout(p.timer);
  p.resolve(decision);
}

function quitApp() {
  isQuitting = true;
  clearTimeout(trayHintTimer);
  trayHintTimer = null;
  if (tray) {
    tray.destroy();
    tray = null;
  }
  app.quit();
}

/* ------------------------------ 托盘 ------------------------------ */
function trayMenu() {
  return Menu.buildFromTemplate([
    { label: `MyApiTools v${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: '显示主窗口', click: () => showMainWindow() },
    {
      label: '检查更新…',
      click: () => {
        showMainWindow();
        sendToRenderer('menu', { action: 'check-update' });
      },
    },
    {
      label: '设置…',
      click: () => {
        showMainWindow();
        sendToRenderer('menu', { action: 'open-settings' });
      },
    },
    { type: 'separator' },
    { label: '彻底退出', click: () => quitApp() },
  ]);
}

function createTray() {
  // 冒烟测试不建托盘：临时数据目录 + 无头环境里留一个托盘图标没有意义，
  // 反而会在测试收尾时拖住进程退出。
  if (SMOKE_DIR) return;
  if (tray) return;
  if (!appPrefs || !appPrefs.get().tray.enabled) return;

  try {
    const file = process.platform === 'win32' ? TRAY_ICO : TRAY_PNG;
    const img = nativeImage.createFromPath(file);
    tray = new Tray(img.isEmpty() ? TRAY_PNG : img);
    tray.setToolTip(`MyApiTools v${app.getVersion()}`);
    tray.setContextMenu(trayMenu());
    // Windows / Linux：单击直接唤回窗口（Windows 上双击会先触发一次 click，
    // 结果一样，所以不额外处理）
    tray.on('click', () => showMainWindow());
    if (process.platform === 'darwin') {
      // macOS 上托盘是「程序坞之外的入口」，双击没意义，忽略掉避免误触
      tray.setIgnoreDoubleClickEvents(true);
    }
  } catch (e) {
    // Linux 某些桌面环境没有 StatusNotifier / AppIndicator，创建会抛错。
    // 这种情况退回「关窗口即退出」，不能让整个应用起不来。
    console.error('托盘创建失败（该桌面环境可能不支持）：', e && e.message ? e.message : e);
    tray = null;
  }
}

function destroyTray() {
  if (!tray) return;
  try {
    tray.destroy();
  } catch {
    /* 已经没了就算了 */
  }
  tray = null;
}

/** 偏好变更后重新对齐托盘状态（开关托盘 / 改关闭行为都走这里） */
function applyTrayPrefs() {
  if (!appPrefs) return;
  if (appPrefs.get().tray.enabled) createTray();
  else destroyTray();
}

/**
 * 关闭主窗口时的行为
 * ---------------------------------------------------------------
 * 三种去向：问一次 / 收进托盘 / 直接退出。
 * 注意「问一次」是异步弹框，所以必须先 preventDefault 把这次关闭拦下来，
 * 等用户选完再决定 hide 还是 quit —— 中途不让窗口关掉，否则窗口没了就没法问。
 */
function attachCloseBehavior(win) {
  win.on('close', (e) => {
    if (isQuitting) return;

    const p = appPrefs ? appPrefs.get().tray : { enabled: false, closeAction: 'quit' };
    // 托盘没开（或这个平台建不起来）→ 关窗口就是退出，走 window-all-closed
    if (!p.enabled || !tray) return;
    if (p.closeAction === 'quit') return;

    e.preventDefault();

    if (p.closeAction === 'tray') {
      hideToTray();
      return;
    }
    // closeAction === 'ask'：同一时刻只弹一个框
    if (closePrompting) return;
    askCloseAction();
  });
}

/**
 * 关闭确认：优先用应用内弹窗（和主界面一套样式），界面不可用时退回系统框。
 * 两条路都必须返回同一种结构 { action: 'tray'|'quit'|'cancel', remember:boolean }，
 * 后面的分支就不用关心用户到底是在哪个框里点的。
 */
async function askCloseAction() {
  closePrompting = true;
  try {
    let decision = null;

    if (canUseInAppPrompt()) {
      const answer = new Promise((resolve) => {
        pendingClosePrompt = {
          resolve,
          timer: setTimeout(() => {
            // 界面卡住 / 回复丢了（理论上不该发生）也不能把窗口关不掉：
            // 超时后退回系统原生框，至少给用户一条能走的路
            console.error('关闭确认框超时未收到界面回复，退回系统对话框');
            sendToRenderer('app:close-prompt-dismiss');
            settleClosePrompt(null);
          }, CLOSE_PROMPT_TIMEOUT),
        };
      });
      sendToRenderer('app:close-prompt', { defaultAction: 'tray' });
      decision = await answer;
    }

    if (!decision) {
      // 窗口已经关了 / 正在退出：这时候再弹原生框没有意义（屏幕上已经没有主窗口了）
      if (isQuitting || !mainWindow || mainWindow.isDestroyed()) return;
      decision = await askCloseActionNative();
    }

    // 用户取消 / 直接关掉原生框：窗口保持原样
    if (!decision || decision.action === 'cancel') return;

    const toTray = decision.action === 'tray';
    if (decision.remember) {
      appPrefs.set({ tray: { closeAction: toTray ? 'tray' : 'quit' } });
      // 广播带平台与托盘可用性的快照，否则设置页会把「没有 trayAvailable」
      // 当成「托盘建不起来」，误报一条警告
      sendToRenderer('app-prefs-changed', prefsSnapshot());
    }

    if (toTray) hideToTray();
    else quitApp();
  } catch (e) {
    console.error('关闭确认弹窗失败：', e && e.message ? e.message : e);
  } finally {
    closePrompting = false;
  }
}

/** 兜底用的系统原生确认框（界面没加载完时的唯一选择） */
async function askCloseActionNative() {
  const opts = {
    type: 'question',
    title: '关闭窗口',
    message: '要让 MyApiTools 继续在托盘里运行吗？',
    detail:
      '「保留在托盘」：窗口收进系统托盘，正在跑的批量执行和没保存的编辑都不会中断，' +
      '点托盘图标可以重新打开。\n' +
      '「彻底退出」：关闭应用，所有窗口一并关掉。',
    buttons: ['保留在托盘', '彻底退出'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    checkboxLabel: '记住我的选择，下次不再询问',
    checkboxChecked: false,
  };
  try {
    const res = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, opts)
      : await dialog.showMessageBox(opts);
    return { action: res.response === 0 ? 'tray' : 'quit', remember: !!res.checkboxChecked };
  } catch (e) {
    console.error('系统关闭确认框失败：', e && e.message ? e.message : e);
    return null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 660,
    show: false,
    backgroundColor: '#16181d',
    title: 'MyApiTools',
    icon: ICON_PNG,
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // 冒烟测试全靠 setTimeout 推进时序。窗口在没有真实显示器的环境里会被
      // Chromium 判定为「不可见」，定时器被钳到 1 秒起步，整个测试会慢十几倍
      // 甚至卡死。正常运行时保留节流即可。
      backgroundThrottling: !SMOKE_DIR,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  attachCloseBehavior(mainWindow);

  // 界面加载状态：关闭确认框只在界面活着的时候走应用内弹窗
  mainWindow.webContents.on('did-start-loading', () => { rendererReady = false; });
  mainWindow.webContents.on('did-finish-load', () => { rendererReady = true; });

  mainWindow.on('show', () => {
    // 「先提示、后隐藏」还没走完就被唤回来了 → 撤销这次隐藏，否则刚露脸又消失
    clearTimeout(trayHintTimer);
    trayHintTimer = null;
  });

  mainWindow.on('closed', () => {
    rendererReady = false;
    clearTimeout(trayHintTimer);
    trayHintTimer = null;
    // 窗口没了，等回复的那个 Promise 不会有结果了，放它走
    settleClosePrompt(null);
    mainWindow = null;
  });

  // 双保险：某些环境下窗口会被判定为遮挡/后台，显式关掉节流（仅冒烟测试需要）
  if (SMOKE_DIR) mainWindow.webContents.setBackgroundThrottling(false);

  // 外部链接一律交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
  return mainWindow;
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const send = (channel, payload) => mainWindow && mainWindow.webContents.send(channel, payload);

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        { label: '新建请求', accelerator: 'CmdOrCtrl+N', click: () => send('menu', { action: 'new-request' }) },
        { label: '从 cURL 新建请求…', click: () => send('menu', { action: 'new-request-curl' }) },
        { label: '新建文件夹', accelerator: 'CmdOrCtrl+Shift+N', click: () => send('menu', { action: 'new-folder' }) },
        { label: '切换项目…', click: () => send('menu', { action: 'switch-project' }) },
        { type: 'separator' },
        { label: '导入配置…', accelerator: 'CmdOrCtrl+I', click: () => send('menu', { action: 'import' }) },
        { label: '导出配置…', accelerator: 'CmdOrCtrl+E', click: () => send('menu', { action: 'export' }) },
        { type: 'separator' },
        { label: '立即同步', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('menu', { action: 'sync-now' }) },
        { type: 'separator' },
        isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新界面' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '检查更新',
          click: () => send('menu', { action: 'check-update' }),
        },
        { type: 'separator' },
        {
          label: '打开数据目录',
          click: () => shell.openPath(app.getPath('userData')),
        },
        {
          label: '关于',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于 MyApiTools',
              message: `MyApiTools v${app.getVersion()}`,
              detail:
                '本地执行 API 请求，远端仅同步请求配置。\n' +
                `Electron ${process.versions.electron} · Node ${process.versions.node}\n` +
                `数据目录：${app.getPath('userData')}`,
              buttons: ['好'],
            });
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */
function registerIpc() {
  // ---- 应用信息 ----
  ipcMain.handle('app:info', () => {
    const active = profileMgr.getActive();
    const activeProfile = profileMgr.list().find((p) => p.active) || profileMgr.list()[0];
    return {
      version: app.getVersion(),
      platform: process.platform,
      userData: app.getPath('userData'),
      dataFile: active.dir,
      activeProfile: profileMgr.activeId,
      activeProfileName: activeProfile ? activeProfile.label : '',
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
    };
  });

  // ---- 本地数据（操作当前激活的 profile）----
  ipcMain.handle('store:load', () => profileMgr.getActive().load());
  ipcMain.handle('store:patch', (_e, partial) => profileMgr.getActive().patch(partial));
  ipcMain.handle('store:replace', (_e, full) => profileMgr.getActive().replace(full));
  ipcMain.handle('store:export', () => profileMgr.getActive().exportJSON());
  ipcMain.handle('store:import', (_e, text) => {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new Error('不是合法的 JSON：' + e.message);
    }
    return profileMgr.getActive().replace(parsed);
  });
  ipcMain.handle('store:reveal', () => {
    const dir = profileMgr.getActive().dir;
    fs.mkdirSync(dir, { recursive: true });
    shell.showItemInFolder(dir);
    return { ok: true };
  });

  // ---- 多用户 profile ----
  ipcMain.handle('profile:list', () => profileMgr.list());
  ipcMain.handle('profile:switch', async (_e, arg) => ({ workspace: await profileMgr.switchTo(arg) }));
  ipcMain.handle('profile:claimLocal', async (_e, payload) => ({ workspace: await profileMgr.claimLocalInto(payload) }));
  ipcMain.handle('profile:logout', async () => ({ workspace: await profileMgr.logoutToLocal() }));

  // ---- 请求执行（核心：在 Node 侧发起，无 CORS 限制）----
  ipcMain.handle('http:send', async (_e, reqDesc) => {
    try {
      return await sendRequest(reqDesc);
    } catch (e) {
      return {
        ok: false,
        error: { code: 'INTERNAL', message: e.message || String(e) },
        duration: 0,
      };
    }
  });

  // ---- 同步 ----
  // 统一把错误摊平成 { ok:false, message, status, code }，
  // 渲染进程靠 status/code 判断该不该弹登录框。
  const syncFail = (e) => ({
    ok: false,
    message: e && e.message ? e.message : String(e),
    status: (e && e.status) || 0,
    code: (e && e.code) || null,
  });

  ipcMain.handle('sync:health', async (_e, serverUrl) => {
    try {
      return { ok: true, data: await syncClient.health(serverUrl) };
    } catch (e) {
      return syncFail(e);
    }
  });
  ipcMain.handle('sync:register', async (_e, { serverUrl, email, password, device }) => {
    try {
      return { ok: true, data: await syncClient.register(serverUrl, email, password, device) };
    } catch (e) {
      return syncFail(e);
    }
  });
  ipcMain.handle('sync:login', async (_e, { serverUrl, email, password, device }) => {
    try {
      return { ok: true, data: await syncClient.login(serverUrl, email, password, device) };
    } catch (e) {
      return syncFail(e);
    }
  });
  ipcMain.handle('sync:me', async (_e, { serverUrl, token }) => {
    try {
      return { ok: true, data: await syncClient.me(serverUrl, token) };
    } catch (e) {
      return syncFail(e);
    }
  });
  ipcMain.handle('sync:logout', async (_e, { serverUrl, token }) => {
    try {
      return { ok: true, data: await syncClient.logout(serverUrl, token) };
    } catch (e) {
      return syncFail(e);
    }
  });
  ipcMain.handle('sync:push', async (_e, { cfg, entities, clientRev }) => {
    try {
      return { ok: true, data: await syncClient.push(cfg, entities, clientRev) };
    } catch (e) {
      return syncFail(e);
    }
  });
  ipcMain.handle('sync:pull', async (_e, { cfg, since }) => {
    try {
      return { ok: true, data: await syncClient.pull(cfg, since) };
    } catch (e) {
      return syncFail(e);
    }
  });

  // ---- 客户端更新 ----
  // 安装包统一落在 userData/updates，冒烟测试时 userData 被重定向到临时目录，
  // 所以测试不会污染用户真实的下载目录。
  const updatesDir = () => path.join(app.getPath('userData'), 'updates');

  ipcMain.handle('update:check', async (_e, { serverUrl, token, channel, current }) => {
    try {
      return { ok: true, data: await updateClient.check(serverUrl, token, { channel, current }) };
    } catch (e) {
      return syncFail(e);
    }
  });

  ipcMain.handle('update:download', async (e, { serverUrl, token, release }) => {
    try {
      const data = await updateClient.download(
        serverUrl,
        token,
        release,
        updatesDir(),
        (p) => {
          // 进度直接推给发起下载的那个窗口
          if (!e.sender.isDestroyed()) e.sender.send('update-progress', p);
        }
      );
      return { ok: true, data };
    } catch (err) {
      return syncFail(err);
    }
  });

  ipcMain.handle('update:cancel', () => ({ ok: true, cancelled: updateClient.cancel() }));

  ipcMain.handle('update:install', async (_e, filePath) => {
    if (!filePath || typeof filePath !== 'string') return { ok: false, message: '安装包路径无效' };
    // 只允许打开我们自己下载目录里的文件，避免渲染进程被 XSS 后拿去执行任意程序
    const dir = updatesDir();
    const abs = path.resolve(filePath);
    if (abs !== dir && !abs.startsWith(dir + path.sep)) {
      return { ok: false, message: '拒绝打开下载目录之外的文件' };
    }
    if (!fs.existsSync(abs)) return { ok: false, message: '安装包已不存在，请重新下载' };

    // 冒烟测试里安装包是假文件，真去 openPath 会唤起系统关联程序（可能弹窗甚至执行），
    // 所以测试环境下只回执「已请求打开」，不实际调用。生产路径不受影响。
    if (process.env.MYAPITOOLS_SMOKE === '1') {
      return { ok: true, path: abs, simulated: true };
    }

    // Windows / macOS 上直接交给系统打开安装器；Linux 先补可执行位（AppImage）
    try {
      if (process.platform === 'linux') fs.chmodSync(abs, 0o755);
    } catch { /* 权限受限就交给 shell 处理 */ }

    const err = await shell.openPath(abs);
    if (err) return { ok: false, message: '无法打开安装程序：' + err };
    return { ok: true, path: abs };
  });

  ipcMain.handle('update:reveal', (_e, filePath) => {
    const dir = updatesDir();
    const abs = filePath ? path.resolve(filePath) : dir;
    if (abs !== dir && !abs.startsWith(dir + path.sep)) {
      return { ok: false, message: '拒绝打开下载目录之外的位置' };
    }
    if (fs.existsSync(abs)) shell.showItemInFolder(abs);
    else shell.openPath(dir);
    return { ok: true };
  });

  // ---- 文件对话框 ----
  ipcMain.handle('dialog:open', async (_e, opts = {}) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: opts.title || '选择文件',
      properties: opts.properties || ['openFile'],
      filters: opts.filters || [{ name: '所有文件', extensions: ['*'] }],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, paths: res.filePaths, path: res.filePaths[0] };
  });

  ipcMain.handle('dialog:save', async (_e, opts = {}) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: opts.title || '保存文件',
      defaultPath: opts.defaultPath,
      filters: opts.filters || [{ name: '所有文件', extensions: ['*'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    if (opts.content !== undefined) {
      await fs.promises.writeFile(res.filePath, opts.content, 'utf8');
    }
    return { ok: true, path: res.filePath };
  });

  ipcMain.handle('fs:readText', async (_e, filePath) => {
    const text = await fs.promises.readFile(filePath, 'utf8');
    return { ok: true, text };
  });

  ipcMain.handle('clipboard:write', (_e, text) => {
    clipboard.writeText(String(text ?? ''));
    return { ok: true };
  });

  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { ok: true };
  });

  /* ---- 应用级偏好：托盘 / 关闭行为 ----
   * 这份配置不进 workspace、不参与同步、不按账号隔离 —— 它描述的是
   * 「这台机器上这个进程」的窗口行为，换账号不该跟着变。 */
  ipcMain.handle('app:prefs:get', () => prefsSnapshot());

  ipcMain.handle('app:prefs:set', (_e, partial) => {
    appPrefs.set(partial);
    applyTrayPrefs();
    const snap = prefsSnapshot();
    // 主进程自己也可能是弹窗改的偏好（关闭确认框里的「记住选择」），
    // 这里广播一次让设置页与状态栏跟上
    sendToRenderer('app-prefs-changed', snap);
    return snap;
  });

  ipcMain.handle('app:hideToTray', () => {
    hideToTray();
    return { ok: true, trayAvailable: !!tray };
  });

  ipcMain.handle('app:show', () => {
    showMainWindow();
    return { ok: true };
  });

  /* ---- 关闭确认：界面回话 ----
   * 渲染进程每条出口（确定 / 取消 / Esc / 点遮罩）都必须回一条，
   * 否则 askCloseAction 会一直等到超时才退回系统框。 */
  ipcMain.on('app:close-decision', (_e, payload) => {
    if (!pendingClosePrompt) return;   // 超时或窗口已关，这次回话没有意义
    const action = payload && payload.action;
    settleClosePrompt({
      action: action === 'tray' || action === 'quit' ? action : 'cancel',
      remember: !!(payload && payload.remember),
    });
  });
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 用户又双击了一次快捷方式：把收在托盘里的窗口捞出来，而不是开第二个实例
    showMainWindow();
  });

  app.whenReady().then(() => {
    // 托盘通知（Windows 的 toast）要靠 AUMID 认身份，必须和安装包的 appId 一致，
    // 否则通知不会显示、或者显示成 electron.app.xxx
    if (process.platform === 'win32') app.setAppUserModelId('com.myapitools.app');

    appPrefs = new AppPrefs(app.getPath('userData'));
    profileMgr = new ProfileManager(app.getPath('userData'));
    profileMgr.getActive().load();
    registerAppProtocol();
    registerIpc();
    buildMenu();
    createWindow();
    // 托盘要在窗口之后建：菜单里的「显示主窗口 / 检查更新」都依赖 mainWindow
    applyTrayPrefs();

    // 端到端冒烟测试：真实启动界面并模拟用户操作（npm run smoke）
    if (SMOKE_DIR) {
      try {
        require('../tools/smoke-hook').attach(mainWindow, app, SMOKE_DIR);
      } catch (e) {
        console.error('冒烟测试钩子加载失败：', e);
        app.exit(1);
      }
    }

    app.on('activate', () => {
      // macOS：点程序坞图标时，窗口可能只是被隐藏了
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (profileMgr) for (const s of profileMgr.stores.values()) s.flush();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    // 从这里开始，「关窗口」就是真的要退出了 —— 否则菜单里的「退出」和系统注销
    // 都会被 close 拦截逻辑收进托盘，表现为「点了退出没反应」
    isQuitting = true;
    if (profileMgr) for (const s of profileMgr.stores.values()) s.flush();
  });
}
