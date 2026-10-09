/**
 * 反馈层：Toast / 确认框 / 输入框 / 通用弹窗 / 右键菜单
 */

import { qs, html, raw } from './dom.js';
import { escapeHtml } from '../helpers.js';

/* ------------------------------- Toast ------------------------------- */
const toastRoot = () => qs('#toast-root');

export function toast(message, type = 'info', title = '', timeout = 3600) {
  const root = toastRoot();
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = html`
    ${title ? raw(`<div class="toast-title">${escapeHtml(title)}</div>`) : ''}
    <div class="toast-msg">${message}</div>
  `;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s, transform .2s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(18px)';
    setTimeout(() => el.remove(), 220);
  }, timeout);
}

export const toastOk = (m, t = '') => toast(m, 'success', t);
export const toastErr = (m, t = '操作失败') => toast(m, 'error', t, 6000);
export const toastWarn = (m, t = '') => toast(m, 'warn', t, 4800);

/* ------------------------------ 通用弹窗 ------------------------------ */
/**
 * @param {object} cfg
 *   title, bodyHtml, footerHtml, wide, onMount(root), onClose()
 * @returns {{close:Function, root:HTMLElement}}
 */
export function openModal(cfg) {
  const rootEl = qs('#modal-root');
  rootEl.hidden = false;
  rootEl.innerHTML = html`
    <div class="modal ${cfg.wide ? 'wide' : ''}">
      <div class="modal-head">
        <span>${cfg.title || ''}</span>
        <span class="spacer"></span>
        <button class="row-icon-btn" data-modal-close title="关闭">✕</button>
      </div>
      <div class="modal-body ${cfg.noPad ? 'no-pad' : ''}">${raw(cfg.bodyHtml || '')}</div>
      ${cfg.footerHtml ? raw(`<div class="modal-foot">${cfg.footerHtml}</div>`) : ''}
    </div>
  `;

  const close = () => {
    rootEl.hidden = true;
    rootEl.innerHTML = '';
    document.removeEventListener('keydown', onKey, true);
    if (cfg.onClose) cfg.onClose();
  };

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);

  rootEl.onclick = (e) => {
    if (e.target === rootEl) close();
    if (e.target.closest('[data-modal-close]')) close();
  };

  const modal = rootEl.querySelector('.modal');
  if (cfg.onMount) cfg.onMount(modal, close);
  return { close, root: modal };
}

/* ------------------------------ 确认框 ------------------------------ */
export function confirmDialog({ title = '请确认', message = '', confirmText = '确定', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const m = openModal({
      title,
      bodyHtml: `<div style="line-height:1.8;white-space:pre-wrap">${escapeHtml(message)}</div>`,
      footerHtml: `
        <button class="btn" data-act="cancel">取消</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-act="ok">${escapeHtml(confirmText)}</button>`,
      onMount(root, close) {
        root.querySelector('[data-act="cancel"]').onclick = () => { finish(false); close(); };
        root.querySelector('[data-act="ok"]').onclick = () => { finish(true); close(); };
      },
      onClose: () => finish(false),
    });
  });
}

/* ------------------------------ 输入框 ------------------------------ */
export function promptDialog({ title = '请输入', label = '', value = '', placeholder = '', multiline = false, okText = '确定' }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    openModal({
      title,
      bodyHtml: `
        <div class="field-block">
          ${label ? `<label class="field-label">${escapeHtml(label)}</label>` : ''}
          ${multiline
            ? `<textarea data-input placeholder="${escapeHtml(placeholder)}"></textarea>`
            : `<input type="text" data-input placeholder="${escapeHtml(placeholder)}" />`}
        </div>`,
      footerHtml: `
        <button class="btn" data-act="cancel">取消</button>
        <button class="btn primary" data-act="ok">${escapeHtml(okText)}</button>`,
      onMount(root, close) {
        const input = root.querySelector('[data-input]');
        input.value = value;
        setTimeout(() => {
          input.focus();
          if (!multiline) input.select();
        }, 30);
        const ok = () => { finish(input.value); close(); };
        root.querySelector('[data-act="ok"]').onclick = ok;
        root.querySelector('[data-act="cancel"]').onclick = () => { finish(null); close(); };
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            ok();
          }
        });
      },
      onClose: () => finish(null),
    });
  });
}

/* ------------------------------ 右键菜单 ------------------------------ */
let menuCloser = null;

export function closeContextMenu() {
  const el = qs('#context-menu');
  if (!el) return;
  el.hidden = true;
  el.innerHTML = '';
  if (menuCloser) {
    document.removeEventListener('mousedown', menuCloser, true);
    window.removeEventListener('blur', menuCloser);
    menuCloser = null;
  }
}

/**
 * @param {MouseEvent} e
 * @param {Array} items [{label, icon, shortcut, danger, disabled, separator:true, action:fn}]
 */
export function showContextMenu(e, items) {
  e.preventDefault();
  e.stopPropagation();
  closeContextMenu();

  const el = qs('#context-menu');
  el.innerHTML = items
    .map((it, i) => {
      if (it.separator) return '<div class="menu-sep"></div>';
      if (it.label && it.header) return `<div class="menu-label">${escapeHtml(it.label)}</div>`;
      return `<div class="menu-item ${it.danger ? 'danger' : ''} ${it.disabled ? 'disabled' : ''}" data-idx="${i}"
        style="${it.disabled ? 'opacity:.4;pointer-events:none' : ''}">
        <span style="width:14px;text-align:center">${escapeHtml(it.icon || '')}</span>
        <span>${escapeHtml(it.label)}</span>
        ${it.shortcut ? `<span class="shortcut">${escapeHtml(it.shortcut)}</span>` : ''}
      </div>`;
    })
    .join('');

  el.hidden = false;
  // 先渲染再测量，避免超出视口
  const rect = el.getBoundingClientRect();
  const x = Math.min(e.clientX, window.innerWidth - rect.width - 8);
  const y = Math.min(e.clientY, window.innerHeight - rect.height - 8);
  el.style.left = Math.max(4, x) + 'px';
  el.style.top = Math.max(4, y) + 'px';

  el.onclick = (ev) => {
    const item = ev.target.closest('.menu-item');
    if (!item) return;
    const it = items[Number(item.dataset.idx)];
    closeContextMenu();
    if (it && it.action) it.action();
  };

  menuCloser = (ev) => {
    // 点在菜单内部时不关（否则 mousedown 会先把菜单项清空，导致后面的 click 拿不到 .menu-item）
    if (ev && ev.target && ev.target.closest && ev.target.closest('#context-menu')) return;
    closeContextMenu();
  };
  setTimeout(() => {
    document.addEventListener('mousedown', menuCloser, true);
    window.addEventListener('blur', menuCloser);
  }, 0);
}

document.addEventListener('scroll', closeContextMenu, true);
