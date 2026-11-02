'use strict';

/**
 * 预加载脚本：在隔离上下文中暴露一组最小化、语义清晰的 API。
 * 渲染进程拿不到 Node，只能通过这里定义的通道与主进程通信。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  /* ---- 应用信息 ---- */
  info: () => ipcRenderer.invoke('app:info'),

  /* ---- 本地数据 ---- */
  store: {
    load: () => ipcRenderer.invoke('store:load'),
    patch: (partial) => ipcRenderer.invoke('store:patch', partial),
    replace: (full) => ipcRenderer.invoke('store:replace', full),
    exportJSON: () => ipcRenderer.invoke('store:export'),
    importJSON: (text) => ipcRenderer.invoke('store:import', text),
    reveal: () => ipcRenderer.invoke('store:reveal'),
  },

  /* ---- 请求执行（主进程发起，无 CORS）---- */
  http: {
    send: (reqDesc) => ipcRenderer.invoke('http:send', reqDesc),
  },

  /* ---- 远端配置同步 ---- */
  sync: {
    health: (serverUrl) => ipcRenderer.invoke('sync:health', serverUrl),
    register: (payload) => ipcRenderer.invoke('sync:register', payload),
    login: (payload) => ipcRenderer.invoke('sync:login', payload),
    me: (payload) => ipcRenderer.invoke('sync:me', payload),
    logout: (payload) => ipcRenderer.invoke('sync:logout', payload),
    push: (payload) => ipcRenderer.invoke('sync:push', payload),
    pull: (payload) => ipcRenderer.invoke('sync:pull', payload),
  },

  /* ---- 客户端更新 ---- */
  update: {
    check: (payload) => ipcRenderer.invoke('update:check', payload),
    download: (payload) => ipcRenderer.invoke('update:download', payload),
    cancel: () => ipcRenderer.invoke('update:cancel'),
    install: (filePath) => ipcRenderer.invoke('update:install', filePath),
    reveal: (filePath) => ipcRenderer.invoke('update:reveal', filePath),
    onProgress: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('update-progress', listener);
      return () => ipcRenderer.removeListener('update-progress', listener);
    },
  },

  /* ---- 多用户 profile ---- */
  profile: {
    list: () => ipcRenderer.invoke('profile:list'),
    switch: (arg) => ipcRenderer.invoke('profile:switch', arg),
    claimLocal: (payload) => ipcRenderer.invoke('profile:claimLocal', payload),
    logout: () => ipcRenderer.invoke('profile:logout'),
  },

  /* ---- 文件与系统 ---- */
  dialog: {
    open: (opts) => ipcRenderer.invoke('dialog:open', opts),
    save: (opts) => ipcRenderer.invoke('dialog:save', opts),
  },
  fs: {
    readText: (filePath) => ipcRenderer.invoke('fs:readText', filePath),
  },
  clipboard: {
    write: (text) => ipcRenderer.invoke('clipboard:write', text),
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  },

  /* ---- 应用级偏好（托盘 / 关闭行为）----
   * 存在主进程自己的 app-prefs.json 里，不进 workspace、不参与同步，
   * 因为主进程要在窗口 close 的那一刻就能立刻决定怎么办。 */
  prefs: {
    get: () => ipcRenderer.invoke('app:prefs:get'),
    set: (partial) => ipcRenderer.invoke('app:prefs:set', partial),
    onChanged: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('app-prefs-changed', listener);
      return () => ipcRenderer.removeListener('app-prefs-changed', listener);
    },
  },
  app: {
    hideToTray: () => ipcRenderer.invoke('app:hideToTray'),
    show: () => ipcRenderer.invoke('app:show'),
  },

  /* ---- 关闭窗口确认 ----
   * 主进程在 close 事件里拦下窗口后，通过 onAsk 把选择权交给界面，
   * 界面做完决定必须回一条 decide —— 不回的话主进程会一直等到超时。 */
  closePrompt: {
    onAsk: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('app:close-prompt', listener);
      return () => ipcRenderer.removeListener('app:close-prompt', listener);
    },
    decide: (payload) => ipcRenderer.send('app:close-decision', payload),
    // 主进程等超时了、放弃这次询问：界面把自己的框收掉，别再挡着
    onDismiss: (handler) => {
      const listener = () => handler();
      ipcRenderer.on('app:close-prompt-dismiss', listener);
      return () => ipcRenderer.removeListener('app:close-prompt-dismiss', listener);
    },
  },

  /* 第一次收进托盘时，界面里给一条「窗口去哪了」的提示 */
  onTrayHint: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('app:tray-hint', listener);
    return () => ipcRenderer.removeListener('app:tray-hint', listener);
  },

  /* ---- 主进程菜单事件 ---- */
  onMenu: (handler) => {
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on('menu', listener);
    return () => ipcRenderer.removeListener('menu', listener);
  },
});
