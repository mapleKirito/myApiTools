/**
 * DOM 小工具
 */

import { escapeHtml } from '../helpers.js';

export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

const RAW = Symbol('raw');

/** 标记为「已经是安全 HTML，不要再转义」 */
export const raw = (s) => ({ [RAW]: String(s ?? '') });

function render(v) {
  if (v == null || v === false || v === true) return '';
  if (Array.isArray(v)) return v.map(render).join('');
  if (typeof v === 'object' && RAW in v) return v[RAW];
  return escapeHtml(v);
}

/**
 * 带自动转义的模板字符串。
 * 用法： html`<div class="x">${userInput}</div>`
 * 需要插入原始 HTML 时用 ${raw(...)} 包裹。
 */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return out;
}

export function mount(root, markup) {
  root.innerHTML = markup;
  return root;
}

/** 事件委托 */
export function on(root, event, selector, handler, options) {
  root.addEventListener(
    event,
    (e) => {
      const target = e.target.closest(selector);
      if (!target || !root.contains(target)) return;
      handler(e, target);
    },
    options
  );
}

/** 在 root 内查找带 data-key 的最近祖先 */
export function closestData(el, attr) {
  const node = el.closest(`[data-${attr}]`);
  return node ? node.getAttribute(`data-${attr}`) : null;
}

export function focusEnd(input) {
  if (!input) return;
  input.focus();
  const len = input.value.length;
  try {
    input.setSelectionRange(len, len);
  } catch { /* ignore */ }
}

export function autoSize(textarea, min = 120, max = 480) {
  if (!textarea) return;
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(Math.max(textarea.scrollHeight + 2, min), max) + 'px';
}
