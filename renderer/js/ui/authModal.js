/**
 * 同步账号登录 / 注册弹窗
 * ---------------------------------------------------------------
 * 触发时机由 sync.js 决定：
 *   · 配好了服务地址，但本机没有登录凭证（reason = missing）
 *   · 服务端返回 401，令牌过期或已被吊销（expired / invalid）
 *   · 账号被服务端管理员禁用（disabled）
 *
 * 弹窗只负责「收集凭据并完成一次登录/注册」，把结果交回调用方；
 * 落盘、账号切换确认、同步编排都在 sync.js 里，职责不混。
 */

import { openModal } from './feedback.js';
import { escapeHtml } from '../helpers.js';

const bridge = window.bridge;

const REASON = {
  missing: {
    title: '登录同步账号',
    tone: 'info',
    text: '本机还没有保存该服务的登录凭证。登录或注册后，集合、请求与环境变量即可在多台设备间同步。',
  },
  expired: {
    title: '登录已过期',
    tone: 'warn',
    text: '登录凭证已过期，请重新登录后继续同步。本机配置不会丢失。',
  },
  invalid: {
    title: '登录凭证无效',
    tone: 'warn',
    text: '服务端不认可本机保存的登录凭证（可能已在别处退出或被管理员吊销），请重新登录。',
  },
  disabled: {
    title: '账号已被禁用',
    tone: 'error',
    text: '该账号已被服务端管理员禁用，无法继续同步。如果是你自己的服务，可在服务端管理端重新启用；否则请改用其它账号。',
  },
  manual: {
    title: '登录同步账号',
    tone: 'info',
    text: '登录或注册后，集合、请求与环境变量即可在多台设备间同步。',
  },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * @param {object} opts { serverUrl, email, deviceName, reason }
 * @returns {Promise<null | {ok:true, serverUrl, email, token, mode, device}>}
 *          用户取消时返回 null
 */
export function openAuthModal({ serverUrl = '', email = '', deviceName = '', reason = 'missing' } = {}) {
  const meta = REASON[reason] || REASON.missing;

  return new Promise((resolve) => {
    let settled = false;
    let mode = 'login';
    let busy = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const modal = openModal({
      title: meta.title,
      bodyHtml: `
        <div class="auth-form" data-auth-root>
          <div class="auth-tabs">
            <button type="button" class="auth-tab active" data-auth-tab="login">登录</button>
            <button type="button" class="auth-tab" data-auth-tab="register">注册新账号</button>
          </div>

          <div class="auth-banner ${meta.tone}">${escapeHtml(meta.text)}</div>

          <div class="field-block">
            <label class="field-label">服务地址</label>
            <div class="auth-inline">
              <input type="text" data-auth="serverUrl" value="${escapeHtml(serverUrl)}"
                     placeholder="http://127.0.0.1:8787" spellcheck="false" autocomplete="off" />
              <button type="button" class="btn" data-auth-act="test">测试连接</button>
            </div>
            <div class="field-hint" data-role="test-result" hidden></div>
          </div>

          <div class="field-block">
            <label class="field-label">账号邮箱</label>
            <input type="text" data-auth="email" value="${escapeHtml(email)}"
                   placeholder="you@example.com" spellcheck="false" autocomplete="username" />
          </div>

          <div class="field-block">
            <label class="field-label">密码</label>
            <input type="password" data-auth="password" placeholder="至少 6 位" autocomplete="current-password" />
          </div>

          <div class="field-block" data-auth-row="confirm" hidden>
            <label class="field-label">确认密码</label>
            <input type="password" data-auth="password2" placeholder="再输入一次" autocomplete="new-password" />
          </div>

          <details class="auth-advanced">
            <summary>高级设置</summary>
            <div class="field-block">
              <label class="field-label">设备名称</label>
              <input type="text" data-auth="device" value="${escapeHtml(deviceName)}" spellcheck="false" />
              <div class="field-hint">仅用于在服务端区分登录来源，方便你在管理端识别哪台设备在用。</div>
            </div>
          </details>

          <div class="auth-error" data-role="auth-error" hidden></div>
        </div>`,
      footerHtml: `
        <button class="btn" data-auth-act="cancel" type="button">取消</button>
        <button class="btn primary" data-auth-act="submit" type="button">登录</button>`,
      onMount(root, close) {
        const form = root.querySelector('[data-auth-root]');
        const submitBtn = root.querySelector('[data-auth-act="submit"]');
        const errorBox = root.querySelector('[data-role="auth-error"]');
        const testBox = root.querySelector('[data-role="test-result"]');
        const field = (name) => form.querySelector(`[data-auth="${name}"]`);

        const showError = (msg) => {
          errorBox.hidden = !msg;
          errorBox.textContent = msg || '';
        };

        const applyMode = (next) => {
          mode = next;
          for (const btn of form.querySelectorAll('[data-auth-tab]')) {
            btn.classList.toggle('active', btn.dataset.authTab === next);
          }
          form.querySelector('[data-auth-row="confirm"]').hidden = next !== 'register';
          submitBtn.textContent = next === 'register' ? '注册并登录' : '登录';
          showError('');
        };

        form.addEventListener('click', (e) => {
          const tab = e.target.closest('[data-auth-tab]');
          if (tab) applyMode(tab.dataset.authTab);
        });

        const setBusy = (on, label) => {
          busy = on;
          submitBtn.disabled = on;
          submitBtn.textContent = on ? label : mode === 'register' ? '注册并登录' : '登录';
        };

        const readForm = () => ({
          serverUrl: field('serverUrl').value.trim(),
          email: field('email').value.trim(),
          password: field('password').value,
          password2: field('password2').value,
          device: field('device').value.trim(),
        });

        const validate = (v) => {
          if (!v.serverUrl) return '请填写服务地址';
          if (!EMAIL_RE.test(v.email)) return '请填写正确的邮箱地址';
          if (!v.password) return '请填写密码';
          if (v.password.length < 6) return '密码至少 6 位';
          if (mode === 'register' && v.password !== v.password2) return '两次输入的密码不一致';
          return null;
        };

        const submit = async () => {
          if (busy) return;
          const v = readForm();
          const invalid = validate(v);
          if (invalid) return showError(invalid);

          showError('');
          setBusy(true, mode === 'register' ? '注册中…' : '登录中…');
          const payload = { serverUrl: v.serverUrl, email: v.email, password: v.password, device: v.device };
          const res = mode === 'register'
            ? await bridge.sync.register(payload)
            : await bridge.sync.login(payload);
          setBusy(false);

          if (!res.ok) return showError(res.message || '操作失败');
          finish({
            ok: true,
            mode,
            serverUrl: v.serverUrl,
            email: (res.data.user && res.data.user.email) || v.email,
            token: res.data.token,
            device: v.device,
          });
          close();
        };

        root.querySelector('[data-auth-act="submit"]').onclick = submit;
        root.querySelector('[data-auth-act="cancel"]').onclick = () => close();

        root.querySelector('[data-auth-act="test"]').onclick = async (e) => {
          const btn = e.currentTarget;
          const url = field('serverUrl').value.trim();
          if (!url) return showError('请先填写服务地址');
          btn.disabled = true;
          btn.textContent = '测试中…';
          const res = await bridge.sync.health(url);
          btn.disabled = false;
          btn.textContent = '测试连接';
          testBox.hidden = false;
          if (res.ok) {
            testBox.className = 'field-hint text-ok';
            testBox.textContent = `连接成功：${res.data.name} v${res.data.version}`;
          } else {
            testBox.className = 'field-hint text-err';
            testBox.textContent = res.message;
          }
        };

        form.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        });

        setTimeout(() => {
          const target = serverUrl ? field('email') : field('serverUrl');
          target.focus();
          if (target === field('email')) target.select();
        }, 40);
      },
      onClose: () => finish(null),
    });

    // openModal 若在挂载阶段就抛错，这里兜底，避免 Promise 悬空
    if (!modal) finish(null);
  });
}

/**
 * 本地未登录内容 → 新注册/登录用户的过渡确认。
 * 仅在「本机没有该账号记录、且服务端也没有任何数据」这种全新用户场景下弹出，
 * 由用户主动决定：把本机 local 这份内容「认领」给新账号（local 清空、内容归新账号并上传），
 * 还是保留 local、新账号从空开始。
 * @returns {Promise<boolean|null>} true=认领, false=不认领, null=取消登录
 */
export function confirmLocalClaim({ email, serverUrl, requests = 0, environments = 0, collections = 0 }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    openModal({
      title: '把本机内容归属给新账号？',
      bodyHtml: `
        <div class="auth-banner info">
          检测到 <b>${escapeHtml(email)}</b> 是一个新账号：本机没有它的记录，服务端也还没有任何数据。
          本机当前有一份尚未同步的内容，你可以选择把它直接归属给这个新账号。
        </div>
        <div style="line-height:2;font-size:12.5px">
          本机现有内容：<b>${collections}</b> 个文件夹 · <b>${requests}</b> 个请求 · <b>${environments}</b> 个环境
        </div>
        <div class="auth-choice">
          <div class="auth-choice-item">
            <b>归属给新账号</b>
            <span>本机「本机」工作区清空，现有内容视作 <b>${escapeHtml(email)}</b> 的内容并立即上传到服务端。</span>
          </div>
          <div class="auth-choice-item">
            <b>不归属（保留本机）</b>
            <span>新账号单独使用、从空开始；本机原有内容仍留在「本机」工作区，退出登录后可切回查看。</span>
          </div>
        </div>`,
      footerHtml: `
        <button class="btn" data-claim="cancel" type="button">取消登录</button>
        <button class="btn" data-claim="no" type="button">不归属</button>
        <button class="btn primary" data-claim="yes" type="button">归属给新账号</button>`,
      onMount(root, close) {
        root.querySelector('[data-claim="cancel"]').onclick = () => { finish(null); close(); };
        root.querySelector('[data-claim="no"]').onclick = () => { finish(false); close(); };
        root.querySelector('[data-claim="yes"]').onclick = () => { finish(true); close(); };
      },
      onClose: () => finish(null),
    });
  });
}
