'use strict';

/**
 * 应用级偏好（窗口 / 托盘行为）
 * ---------------------------------------------------------------
 * 为什么不放在 workspace 里：
 *   1. workspace 是「按 profile 分区」的，而托盘是进程级行为 —— 切账号不该改变
 *      关窗口的表现，也不该被同步推到远端；
 *   2. 主进程要在收到 close 事件的那一瞬间就知道该怎么办，那时候再走 IPC
 *      去问渲染进程拿设置已经来不及（窗口已经要关了）。
 * 所以单独存一份 userData/app-prefs.json，主进程独占读写，渲染进程只通过 IPC 改。
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  tray: {
    // 是否启用托盘图标。关掉之后关窗口 = 直接退出（没有托盘也就无处可去）。
    enabled: true,
    // 关闭主窗口时的行为：
    //   ask  = 第一次问一下，之后记住用户的选择
    //   tray = 最小化到托盘，进程继续跑
    //   quit = 彻底退出
    closeAction: 'ask',
  },
};

const VALID_ACTIONS = ['ask', 'tray', 'quit'];

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

class AppPrefs {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'app-prefs.json');
    this.data = clone(DEFAULTS);
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = this.normalize(parsed);
    } catch {
      // 文件不存在 / 内容坏了都退回默认值：这份配置丢了不影响任何业务数据
      this.data = clone(DEFAULTS);
    }
    return this.data;
  }

  /** 把外部来的（可能是旧版本 / 手改过的）对象收敛成合法结构 */
  normalize(input) {
    const src = input && typeof input === 'object' ? input : {};
    const tray = src.tray && typeof src.tray === 'object' ? src.tray : {};
    const action = VALID_ACTIONS.includes(tray.closeAction) ? tray.closeAction : DEFAULTS.tray.closeAction;
    return {
      tray: {
        enabled: tray.enabled === undefined ? DEFAULTS.tray.enabled : !!tray.enabled,
        closeAction: action,
      },
    };
  }

  get() {
    return clone(this.data);
  }

  /** 局部更新并落盘；返回更新后的完整快照，方便渲染进程直接用返回值刷新界面 */
  set(partial) {
    const next = clone(this.data);
    if (partial && typeof partial === 'object' && partial.tray && typeof partial.tray === 'object') {
      if (partial.tray.enabled !== undefined) next.tray.enabled = !!partial.tray.enabled;
      if (partial.tray.closeAction !== undefined) {
        const a = partial.tray.closeAction;
        if (VALID_ACTIONS.includes(a)) next.tray.closeAction = a;
      }
    }
    this.data = this.normalize(next);
    this.save();
    return this.get();
  }

  save() {
    try {
      // 先写临时文件再 rename，避免写到一半断电留下半个 JSON
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      // 落盘失败不该让关窗口流程崩掉，退化成「这次生效、下次重问」
      console.error('保存应用偏好失败：', e && e.message ? e.message : e);
    }
  }
}

module.exports = { AppPrefs, DEFAULTS };
