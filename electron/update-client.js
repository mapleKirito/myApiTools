'use strict';

/**
 * 客户端更新检查与安装包下载（运行在主进程）
 * ---------------------------------------------------------------
 * 边界很清楚：
 *   · 检查更新 = 问服务端「我这个平台/架构最新是哪个版本」，由服务端比较版本号
 *   · 下载     = 把安装包拉到一个本地目录，边下边算 sha256，摘要对不上就删掉
 *   · 安装     = 交给系统去打开安装器（.exe / .dmg / .AppImage），
 *               客户端自己不试图替换正在运行的自己 —— Windows 上那样做必然失败
 *
 * 不做静默自动升级：Windows 与 macOS 都强制校验代码签名，本项目没有签名证书，
 * 硬做只会让用户看到「来源不明」的拦截提示。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const { request, normalizeBase } = require('./sync-client');

/** 当前运行平台 → 服务端认识的平台标识 */
function currentPlatform() {
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

/** 当前运行架构 → 服务端认识的架构标识 */
function currentArch() {
  if (process.arch === 'arm64') return 'arm64';
  if (process.arch === 'ia32') return 'ia32';
  if (process.arch === 'arm') return 'armv7l';
  return 'x64';
}

/** 落盘文件名清洗，避免服务端给的 fileName 里有路径分隔符 */
function safeFileName(name, fallback) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').replace(/["'`<>|:*?]/g, '_').replace(/^\.+/, '').trim();
  return cleaned.slice(0, 120) || fallback;
}

class UpdateClient {
  constructor() {
    this.controller = null;
  }

  /**
   * 问服务端当前平台/架构下的最新版本。
   * @param {string} serverUrl
   * @param {string} token 同步账号令牌（服务端要求已登录才给查）
   * @param {{current?:string, channel?:string, platform?:string, arch?:string}} opts
   */
  check(serverUrl, token, opts = {}) {
    const qs = new URLSearchParams({
      platform: opts.platform || currentPlatform(),
      arch: opts.arch || currentArch(),
      channel: opts.channel || 'stable',
      current: opts.current || '',
    });
    return request(serverUrl, '/api/releases/latest?' + qs.toString(), { token, timeout: 15000 });
  }

  /**
   * 下载安装包到 destDir，返回本地路径。
   * @param {function} onProgress ({received,total,percent}) 按约 120ms 节流
   */
  async download(serverUrl, token, release, destDir, onProgress) {
    if (!release || !release.downloadUrl) throw new Error('服务端没有给出可下载的安装包');
    if (this.controller) throw new Error('已有一个下载任务在进行中');

    fs.mkdirSync(destDir, { recursive: true });
    const fileName = safeFileName(
      release.fileName,
      `MyApiTools-${release.version}-${release.platform}-${release.arch}`
    );
    const finalPath = path.join(destDir, fileName);
    // 先落到 .part，校验通过再改名：中途断网不会留下一个看起来完好的安装包
    const partPath = finalPath + '.part';

    this.controller = new AbortController();
    const signal = this.controller.signal;

    let res;
    try {
      res = await fetch(normalizeBase(serverUrl) + release.downloadUrl, {
        headers: token ? { authorization: 'Bearer ' + token } : {},
        signal,
      });
    } catch (e) {
      this.controller = null;
      if (e && e.name === 'AbortError') throw new Error('已取消下载');
      throw new Error('无法连接同步服务下载安装包：' + ((e && e.cause && e.cause.message) || e.message || e));
    }

    if (!res.ok) {
      this.controller = null;
      let message = `下载安装包失败（HTTP ${res.status}）`;
      try {
        const j = await res.json();
        if (j && j.message) message = j.message;
      } catch { /* 非 JSON，用默认文案 */ }
      const err = new Error(message);
      err.status = res.status;
      if (res.status === 401 || res.status === 403) err.code = 'AUTH_REQUIRED';
      throw err;
    }

    const total = Number(res.headers.get('content-length') || 0) || Number(release.size) || 0;
    const expectSha = String(res.headers.get('x-release-sha256') || release.sha256 || '').toLowerCase();

    let received = 0;
    let lastTick = 0;
    const hash = crypto.createHash('sha256');
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        received += chunk.length;
        hash.update(chunk);
        const now = Date.now();
        // 节流：几百 MB 的包如果每个 chunk 都往渲染进程推一次，会把 IPC 打爆
        if (onProgress && (now - lastTick > 120 || (total && received >= total))) {
          lastTick = now;
          onProgress({
            received,
            total,
            percent: total ? Math.min(100, Math.round((received / total) * 100)) : 0,
          });
        }
        cb(null, chunk);
      },
    });

    try {
      await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(partPath));
    } catch (e) {
      try { fs.rmSync(partPath, { force: true }); } catch { /* ignore */ }
      if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) throw new Error('已取消下载');
      throw new Error('下载中断：' + (e && e.message ? e.message : String(e)));
    } finally {
      this.controller = null;
    }

    if (total && received !== total) {
      try { fs.rmSync(partPath, { force: true }); } catch { /* ignore */ }
      throw new Error(`下载不完整（收到 ${received} / ${total} 字节），请重试`);
    }

    const sha256 = hash.digest('hex');
    if (expectSha && sha256 !== expectSha) {
      try { fs.rmSync(partPath, { force: true }); } catch { /* ignore */ }
      throw new Error(
        '安装包校验失败（sha256 与预期不符），已删除下载文件。\n' +
        `期望 ${expectSha.slice(0, 16)}…，实际 ${sha256.slice(0, 16)}…`
      );
    }

    try { fs.rmSync(finalPath, { force: true }); } catch { /* ignore */ }
    fs.renameSync(partPath, finalPath);

    if (onProgress) onProgress({ received, total: total || received, percent: 100 });
    return { filePath: finalPath, fileName, size: received, sha256, verified: !!expectSha };
  }

  /** 取消进行中的下载 */
  cancel() {
    if (this.controller) {
      this.controller.abort();
      return true;
    }
    return false;
  }
}

module.exports = { UpdateClient, currentPlatform, currentArch };
