'use strict';

/**
 * 配置同步客户端（运行在主进程）
 * ---------------------------------------------------------------
 * 只做一件事：把「请求配置」这类纯文本实体推给远端、从远端拉回来。
 * 远端服务不参与、也无法参与任何接口调用——它拿不到目标接口的地址，
 * 只存集合 / 请求 / 环境这些配置本身。
 *
 * 同步模型：
 *   · 每个实体带 updatedAt（毫秒时间戳）+ deleted 软删标记
 *   · 服务端维护单调递增的 rev 水位；客户端记住 lastRev，增量拉取
 *   · 冲突解决：按 updatedAt 做「后写覆盖」，被覆盖的一方在结果里回报
 */

function normalizeBase(url) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  if (!u) throw new Error('请先填写同步服务地址');
  return /^https?:\/\//i.test(u) ? u : 'http://' + u;
}

async function request(baseUrl, path, { method = 'GET', token, body, timeout = 15000 } = {}) {
  const base = normalizeBase(baseUrl);
  const url = base + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = 'Bearer ' + token;
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`服务端返回了非 JSON 内容（HTTP ${res.status}）：${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const msg = (json && (json.message || json.error)) || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      // 机器可读的错误码：调用方据此区分「令牌过期」与「账号被禁用」
      err.code = (json && json.code) || null;
      throw err;
    }
    return json;
  } catch (e) {
    // 我们自己抛的业务错误（带 status）原样向上传递
    if (e && e.status !== undefined) throw e;
    if (e && e.name === 'AbortError') {
      throw new Error(`连接同步服务超时（${timeout}ms）：${url}`);
    }

    const code = (e && e.cause && e.cause.code) || (e && e.code);
    const causeMsg = (e && e.cause && e.cause.message) || '';
    const byCode = {
      ECONNREFUSED: `无法连接同步服务 ${url}\n请确认服务已启动，且地址与端口正确。`,
      ENOTFOUND: `同步服务域名无法解析：${base}\n请检查地址拼写与本机 DNS 配置。`,
      EAI_AGAIN: `同步服务域名解析暂时失败：${base}\n请检查网络或稍后重试。`,
      ECONNRESET: '连接被对端重置，同步服务可能刚重启，请稍后重试。',
      EHOSTUNREACH: `目标主机不可达：${base}`,
      ENETUNREACH: '本机网络不可达，请检查网络连接。',
      DEPTH_ZERO_SELF_SIGNED_CERT: '同步服务使用自签名证书，请改用 http 或在服务端配置受信任证书。',
      CERT_HAS_EXPIRED: '同步服务的 TLS 证书已过期。',
    };
    if (byCode[code]) throw new Error(byCode[code]);
    if (/bad port/i.test(causeMsg)) {
      throw new Error(`同步服务端口不合法：${url}\n请填写合法的端口号（如 8787）。`);
    }
    if (/certificate|self.signed|SSL/i.test(causeMsg)) {
      throw new Error(`与同步服务的 TLS 握手失败：${causeMsg}\n若服务为自签名证书，请改用 http:// 访问。`);
    }
    // 兜底：不要只抛一句没有信息量的 "fetch failed"
    if (causeMsg) {
      throw new Error(`连接同步服务失败（${url}）：${causeMsg}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

class SyncClient {
  constructor() {
    this.conflictCount = 0;
  }

  health(serverUrl) {
    return request(serverUrl, '/api/health');
  }

  /** @param {string} device 设备名，仅用于服务端标识登录来源 */
  register(serverUrl, email, password, device) {
    return request(serverUrl, '/api/auth/register', { method: 'POST', body: { email, password, device } });
  }

  login(serverUrl, email, password, device) {
    return request(serverUrl, '/api/auth/login', { method: 'POST', body: { email, password, device } });
  }

  /** 校验令牌是否仍然有效，并取回当前账号信息与过期时间 */
  me(serverUrl, token) {
    return request(serverUrl, '/api/auth/me', { token, timeout: 10000 });
  }

  logout(serverUrl, token) {
    return request(serverUrl, '/api/auth/logout', { method: 'POST', token, timeout: 10000 });
  }

  /**
   * 推送本地变更
   * @param {object} cfg {serverUrl, token}
   * @param {Array} entities [{kind,id,updatedAt,deleted,data}]
   * @param {number} clientRev 客户端当前水位
   */
  push(cfg, entities, clientRev) {
    return request(cfg.serverUrl, '/api/sync/push', {
      method: 'POST',
      token: cfg.token,
      body: { entities, clientRev: clientRev || 0 },
      timeout: 30000,
    });
  }

  /** 拉取水位之后的远端变更 */
  pull(cfg, since) {
    return request(cfg.serverUrl, `/api/sync/pull?since=${encodeURIComponent(since || 0)}`, {
      token: cfg.token,
      timeout: 30000,
    });
  }
}

module.exports = { SyncClient, request, normalizeBase };
