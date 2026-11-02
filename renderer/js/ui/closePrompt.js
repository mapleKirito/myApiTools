/**
 * 关闭窗口确认框（应用内弹窗）
 * ---------------------------------------------------------------
 * 为什么不用 dialog.showMessageBox：
 *   原生框用的是系统主题（浅底、系统字体、系统按钮），一弹出来和这套暗色界面
 *   完全是两个东西。这里改成渲染进程里的弹窗，复用 .modal 的骨架与主题变量，
 *   视觉上和「导入 / 导出 / 更新确认」这些框是一套。
 *
 * 时序上的约束（改之前先看）：
 *   主进程收到 close 事件时会先 preventDefault 把窗口留住，再发 app:close-prompt
 *   过来等回复；渲染进程必须**主动**回一条 app:close-decision，否则主进程会一直
 *   等（它有超时兜底，超时会退回系统原生框）。所以这里每条出口 —— 确定 / 取消 /
 *   Esc / 点遮罩 —— 都必须走到 finish()，不能只是把 DOM 藏起来。
 */

import { qs, html } from './dom.js';

let session = null;   // 当前正在显示的会话（同时只允许一个）

export function initClosePrompt() {
  const api = window.bridge && window.bridge.closePrompt;
  if (!api) return;
  api.onAsk((payload) => open(payload || {}));
  // 主进程等超时会放弃这次询问，界面上那个框必须一起收掉，
  // 否则它会一直挡住界面，而且下次询问会被 session 判成「已经在问」直接吞掉
  if (api.onDismiss) api.onDismiss(() => { if (session) session.teardown(); });
}

/**
 * @param {object} payload 主进程给的建议默认项 { defaultAction: 'tray'|'quit' }
 */
function open(payload) {
  // 连按两次 Alt+F4 时会重复下发：旧的那个框直接收掉（它对应的等待已经作废），
  // 换成新的一次，避免把第二次询问吞掉
  if (session) session.teardown();

  const root = qs('#close-prompt-root');
  if (!root) return;

  const api = window.bridge.closePrompt;
  const defaultAction = payload.defaultAction === 'quit' ? 'quit' : 'tray';

  root.innerHTML = html`
    <div class="modal close-prompt" role="dialog" aria-modal="true" aria-labelledby="cp-title">
      <div class="modal-head">
        <span id="cp-title">关闭 MyApiTools</span>
        <span class="spacer"></span>
        <button type="button" class="row-icon-btn" data-act="cancel" title="取消（Esc）">✕</button>
      </div>

      <div class="modal-body">
        <div class="cp-lead">
          <div class="cp-glyph" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
                 stroke-linecap="round" stroke-linejoin="round">
              <rect x="3.5" y="2.8" width="17" height="9" rx="2.2" />
              <path d="M12 14.4v6.1" />
              <path d="M9.4 18 12 20.6 14.6 18" />
            </svg>
          </div>
          <div class="cp-lead-text">
            <div class="cp-question">要让 MyApiTools 继续在托盘里运行吗？</div>
            <div class="cp-note">窗口关掉后进程还在：批量执行、未保存的编辑都不会中断。</div>
          </div>
        </div>

        <div class="cp-options" role="radiogroup" aria-label="关闭方式">
          <button type="button" class="cp-opt" data-choice="tray" role="radio" aria-checked="false">
            <span class="cp-radio" aria-hidden="true"></span>
            <span class="cp-opt-text">
              <span class="cp-opt-title">保留在托盘<i class="cp-tag">推荐</i></span>
              <span class="cp-opt-desc">窗口收进系统托盘，点托盘图标可以随时唤回</span>
            </span>
          </button>
          <button type="button" class="cp-opt" data-choice="quit" role="radio" aria-checked="false">
            <span class="cp-radio" aria-hidden="true"></span>
            <span class="cp-opt-text">
              <span class="cp-opt-title">彻底退出</span>
              <span class="cp-opt-desc">关闭应用并结束托盘图标，下次需要重新启动</span>
            </span>
          </button>
        </div>

        <label class="cp-remember">
          <input type="checkbox" data-remember />
          <span>记住我的选择，下次不再询问</span>
        </label>
        <div class="cp-hint">以后想改回来：设置 → 窗口与托盘。</div>
      </div>

      <div class="modal-foot">
        <button type="button" class="btn" data-act="cancel">取消</button>
        <button type="button" class="btn primary" data-act="ok">确定</button>
      </div>
    </div>
  `;

  root.hidden = false;

  let choice = defaultAction;

  const opts = [...root.querySelectorAll('[data-choice]')];
  const okBtn = root.querySelector('[data-act="ok"]');
  const rememberEl = root.querySelector('[data-remember]');

  const paint = () => {
    for (const el of opts) {
      const on = el.dataset.choice === choice;
      el.classList.toggle('selected', on);
      el.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    // 「彻底退出」是破坏性动作，主按钮跟着变色，避免手快点到同一个蓝色按钮
    okBtn.textContent = choice === 'quit' ? '彻底退出' : '收进托盘';
    okBtn.classList.toggle('danger-solid', choice === 'quit');
  };
  paint();

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish('cancel');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      finish(choice);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      choice = choice === 'tray' ? 'quit' : 'tray';
      paint();
    }
  };

  function finish(action) {
    if (!session) return;
    const remember = action === 'cancel' ? false : !!rememberEl.checked;
    teardown();
    // 必须先回包再关：主进程收到这条才决定 hide / quit。渲染进程这边没有
    // 任何「窗口已经没了」的反馈，回包丢了就会卡到主进程超时
    try {
      api.decide({ action, remember });
    } catch {
      /* 回不去就算了，主进程有超时兜底 */
    }
  }

  function teardown() {
    session = null;
    document.removeEventListener('keydown', onKey, true);
    root.hidden = true;
    root.innerHTML = '';
  }

  root.onclick = (e) => {
    if (e.target === root) {
      finish('cancel');
      return;
    }
    const opt = e.target.closest('[data-choice]');
    if (opt) {
      choice = opt.dataset.choice;
      paint();
      return;
    }
    const act = e.target.closest('[data-act]');
    if (!act) return;
    finish(act.dataset.act === 'ok' ? choice : 'cancel');
  };

  document.addEventListener('keydown', onKey, true);

  session = { finish, teardown };

  // 焦点给到主按钮：默认项是「收进托盘」，直接回车就能走
  setTimeout(() => {
    try {
      okBtn.focus();
    } catch {
      /* ignore */
    }
  }, 30);
}
