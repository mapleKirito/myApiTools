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

  /* ---- 主进程菜单事件 ---- */
  onMenu: (handler) => {
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on('menu', listener);
    return () => ipcRenderer.removeListener('menu', listener);
  },
});
