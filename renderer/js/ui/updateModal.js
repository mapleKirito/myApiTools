/**
 * 「发现新版本」弹窗
 * ---------------------------------------------------------------
 * 只做展示与按钮流转，版本判断 / 下载 / 打开安装器都在 update.js 与主进程里。
 * 依赖通过参数注入（subscribe / actions），避免与 update.js 形成循环引用。
 */

import { openModal } from './feedback.js';
import { escapeHtml, formatBytes, formatTime } from '../helpers.js';

export function openUpdateModal({ release, current, subscribe, getStatus, getProgress, actions, onClose }) {
  // 订阅要能跨 onMount / onClose 传递，所以放在外层作用域
  let unsubscribe = null;

  return openModal({
    title: '发现新版本',
    bodyHtml: `
      <div data-update-root>
        <div class="auth-banner info">
          当前版本 <b>v${escapeHtml(current || '—')}</b>，
          服务端最新版本 <b>v${escapeHtml(release.version)}</b>
          <span class="text-dim">（${escapeHtml(release.platform)}-${escapeHtml(release.arch)} · ${escapeHtml(release.channel)}）</span>
        </div>

        ${release.notes
          ? `<div class="update-notes">${escapeHtml(release.notes)}</div>`
          : '<div class="field-hint">本次发布没有填写更新说明。</div>'}

        <div class="update-meta">
          <span class="mono">${escapeHtml(release.fileName)}</span>
          <span class="text-dim">· ${escapeHtml(formatBytes(release.size))}</span>
          <span class="text-dim">· 发布于 ${escapeHtml(formatTime(release.publishedAt))}</span>
        </div>

        <div class="update-progress" data-role="update-progress-wrap" hidden>
          <div class="progress-track"><div class="progress-bar" data-role="update-progress"></div></div>
          <div class="field-hint" data-role="update-progress-text"></div>
        </div>

        <div class="field-hint" data-role="update-result" hidden></div>

        <div class="field-hint" style="margin-top:12px">
          下载完成后会直接唤起安装程序。装之前请先把正在编辑的内容存好 ——
          安装过程会关掉本应用。本机配置不会被卸载或覆盖。
        </div>
      </div>`,
    footerHtml: `
      <button class="btn" data-update-act="reveal" type="button" hidden>打开所在文件夹</button>
      <button class="btn" data-update-act="later" type="button">稍后</button>
      <button class="btn" data-update-act="skip" type="button">跳过此版本</button>
      <button class="btn primary" data-update-act="download" type="button">下载并安装</button>`,
    onMount(root, close) {
      const body = root.querySelector('[data-update-root]');
      const btnDownload = root.querySelector('[data-update-act="download"]');
      const btnSkip = root.querySelector('[data-update-act="skip"]');
      const btnLater = root.querySelector('[data-update-act="later"]');
      const btnReveal = root.querySelector('[data-update-act="reveal"]');
      const wrap = body.querySelector('[data-role="update-progress-wrap"]');
      const bar = body.querySelector('[data-role="update-progress"]');
      const progressText = body.querySelector('[data-role="update-progress-text"]');
      const result = body.querySelector('[data-role="update-result"]');

      let downloaded = false;

      const setBar = (pct, cls) => {
        bar.style.width = pct + '%';
        bar.className = 'progress-bar' + (cls ? ' ' + cls : '');
      };

      // 弹窗可能是「已经下载好之后」再被打开的（设置页卡片上的「打开安装程序」）。
      // 这时如果还按初始状态渲染，按钮写着「下载并安装」、进度条是空的，会让人以为
      // 白下了一遍。所以按当前状态把界面直接摆到「已下载」的样子。
      if (getStatus() === 'downloaded') {
        downloaded = true;
        wrap.hidden = false;
        setBar(100, 'done');
        progressText.textContent = `安装包已下载完成（${formatBytes(release.size)}）。`;
        btnDownload.textContent = '再次打开安装程序';
        btnReveal.hidden = false;
      }

      const setResult = (msg, tone) => {
        result.hidden = !msg;
        result.className = 'field-hint ' + (tone === 'ok' ? 'text-ok' : tone === 'err' ? 'text-err' : '');
        result.textContent = msg || '';
      };

      const renderProgress = (p) => {
        if (!p) return;
        wrap.hidden = false;
        const pct = Number(p.percent) || 0;
        setBar(pct, '');
        progressText.textContent =
          `下载中 ${pct}%（${formatBytes(p.received)} / ${formatBytes(p.total || release.size)}）`;
      };

      unsubscribe = subscribe(() => {
        if (downloaded) return;
        if (getStatus() === 'downloading') renderProgress(getProgress());
      });

      btnLater.onclick = () => close();

      btnSkip.onclick = () => {
        if (actions.skip) actions.skip();
        setResult('已跳过 v' + release.version + '，下次出现更新的版本时还会提示。', '');
        close();
      };

      btnReveal.onclick = () => { if (actions.reveal) actions.reveal(); };

      const runInstall = async () => {
        progressText.textContent = `已下载 ${formatBytes(getProgress() ? getProgress().total : release.size)}，正在唤起安装程序…`;
        const opened = await actions.install();
        if (opened.ok) {
          setResult('安装程序已打开，请按提示完成安装。安装完成后重新启动 MyApiTools 即可。', 'ok');
          btnDownload.disabled = false;
          btnDownload.textContent = '再次打开安装程序';
        } else {
          setBar(100, 'fail');
          setResult((opened.message || '无法打开安装程序') +
            ' 你可以点左下角的「打开所在文件夹」，手动运行安装包。', 'err');
          btnDownload.disabled = false;
          btnDownload.textContent = '重试打开';
        }
      };

      btnDownload.onclick = async () => {
        if (downloaded) return runInstall();

        btnDownload.disabled = true;
        btnSkip.disabled = true;
        btnLater.disabled = true;
        btnDownload.textContent = '下载中…';
        wrap.hidden = false;
        setBar(0, '');
        progressText.textContent = '开始下载…';
        setResult('');

        const res = await actions.download();

        btnSkip.disabled = false;
        btnLater.disabled = false;
        btnReveal.hidden = false;

        if (!res.ok) {
          btnDownload.disabled = false;
          btnDownload.textContent = '重试下载';
          setBar(0, 'fail');
          progressText.textContent = '下载失败';
          setResult(res.message || '下载失败', 'err');
          return;
        }

        downloaded = true;
        setBar(100, 'done');
        await runInstall();
      };
    },
    onClose: () => {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (onClose) onClose();
    },
  });
}
