'use strict';

const { app, BrowserWindow, ipcMain, protocol, net, dialog, shell, Menu, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const { sendRequest } = require('./http-client');
const { ProfileManager } = require('./profile');
const { SyncClient } = require('./sync-client');
const { UpdateClient } = require('./update-client');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const APP_SCHEME = 'app';
const APP_ORIGIN = `${APP_SCHEME}://bundle`;

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
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 660,
    show: false,
    backgroundColor: '#16181d',
    title: 'MyApiTools',
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
  mainWindow.on('closed', () => {
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
        { label: '新建文件夹', accelerator: 'CmdOrCtrl+Shift+N', click: () => send('menu', { action: 'new-folder' }) },
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

  ipcMain.handle('app:minimizeToTrayHint', () => ({ ok: true }));
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    profileMgr = new ProfileManager(app.getPath('userData'));
    profileMgr.getActive().load();
    registerAppProtocol();
    registerIpc();
    buildMenu();
    createWindow();

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
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (profileMgr) for (const s of profileMgr.stores.values()) s.flush();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    if (profileMgr) for (const s of profileMgr.stores.values()) s.flush();
  });
}
