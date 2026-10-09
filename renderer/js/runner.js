/**
 * 请求执行器
 * ---------------------------------------------------------------
 * 单个请求与批量执行都走这里。真正的网络动作发生在 Electron 主进程，
 * 因此不受浏览器同源策略约束。
 */

import { compileRequest } from './vars.js';
import { pushHistory, state } from './state.js';

const bridge = window.bridge;

/** 取消标志容器，用于批量执行的「中止」按钮 */
export const cancelToken = { cancelled: false };

export function resetCancel() {
  cancelToken.cancelled = false;
}

function historyEntry(request, descriptor, response) {
  return {
    name: request.name,
    requestId: request.id,
    method: descriptor.method,
    url: descriptor.url,
    requestSnapshot: {
      method: request.method,
      url: request.url,
      params: request.params,
      headers: request.headers,
      body: request.body,
      auth: request.auth,
      options: request.options,
    },
    status: response.status || 0,
    ok: !!response.ok,
    duration: response.duration || 0,
    size: response.size || 0,
    errorMessage: response.error ? response.error.message : '',
  };
}

/**
 * 执行单个请求
 * @param {object} request 配置态的请求对象
 * @param {object} [opts] { recordHistory:boolean }
 * @returns {Promise<object>} { descriptor, response, unresolved, at }
 */
export async function sendOne(request, opts = {}) {
  const { recordHistory = true } = opts;
  const { descriptor, unresolved, resolvedUrl } = compileRequest(request);
  const at = Date.now();
  let response;
  try {
    response = await bridge.http.send(descriptor);
  } catch (e) {
    response = {
      ok: false,
      status: 0,
      duration: 0,
      size: 0,
      error: { code: 'IPC_ERROR', message: e.message || String(e) },
    };
  }
  if (recordHistory) {
    try {
      pushHistory(historyEntry(request, descriptor, response));
    } catch (e) {
      console.error('[history] 写入失败', e);
    }
  }
  return { descriptor, response, unresolved, resolvedUrl, at };
}

/**
 * 批量执行
 * @param {object} cfg
 *   cfg.items        [{request, path}] 或 [request]
 *   cfg.concurrency  并发数
 *   cfg.onProgress   (result, index, total) => void
 *   cfg.onStart      (item, index) => void
 * @returns {Promise<Array>} 结果数组，顺序与输入一致
 */
export async function runBatch(cfg) {
  const { items = [], concurrency = 5, onProgress, onStart, stopOnError = false } = cfg;
  const limit = Math.max(1, Math.min(Number(concurrency) || 5, 20));
  const results = new Array(items.length);
  let cursor = 0;
  let completed = 0;
  let aborted = false;

  const workers = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (cancelToken.cancelled || aborted) return;
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index];
      const request = item.request || item;
      const path = item.path || [];
      if (onStart) onStart(item, index);

      const startedAt = Date.now();
      let result;
      try {
        const { descriptor, response, unresolved } = await sendOne(request, { recordHistory: false });
        result = {
          index,
          requestId: request.id,
          name: request.name,
          path,
          method: descriptor.method,
          url: descriptor.url,
          status: response.status || 0,
          ok: !!response.ok,
          duration: response.duration ?? Date.now() - startedAt,
          size: response.size || 0,
          error: response.error || null,
          unresolved,
          response,
          at: Date.now(),
        };
      } catch (e) {
        result = {
          index,
          requestId: request.id,
          name: request.name,
          path,
          method: request.method,
          url: request.url,
          status: 0,
          ok: false,
          duration: Date.now() - startedAt,
          size: 0,
          error: { code: 'COMPILE_ERROR', message: e.message },
          response: null,
          at: Date.now(),
        };
      }
      results[index] = result;
      completed += 1;
      if (onProgress) onProgress(result, completed, items.length);
      if (stopOnError && !result.ok) aborted = true;
    }
  });

  await Promise.all(workers);
  return results.map((r, i) => r || {
    index: i,
    requestId: (items[i]?.request || items[i])?.id,
    name: (items[i]?.request || items[i])?.name || '-',
    path: items[i]?.path || [],
    method: (items[i]?.request || items[i])?.method || 'GET',
    url: '',
    status: 0,
    ok: false,
    duration: 0,
    size: 0,
    error: { code: 'CANCELLED', message: '已取消' },
    response: null,
    at: Date.now(),
  });
}

/** 把批量结果导出为 CSV 文本 */
export function resultsToCsv(results) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['序号', '分组', '名称', '方法', 'URL', '状态码', '耗时(ms)', '大小(字节)', '结果', '错误'];
  const rows = results.map((r, i) => [
    i + 1,
    (r.path || []).join(' / '),
    r.name,
    r.method,
    r.url,
    r.status || '',
    r.duration || 0,
    r.size || 0,
    r.ok ? '成功' : '失败',
    r.error ? r.error.message : '',
  ]);
  const lines = [head, ...rows].map((r) => r.map(esc).join(','));
  // 带 BOM，Excel 打开不乱码
  return '\uFEFF' + lines.join('\r\n');
}

/** 汇总统计 */
export function summarizeResults(results) {
  const total = results.length;
  const success = results.filter((r) => r.ok).length;
  const failed = total - success;
  const durations = results.map((r) => r.duration || 0);
  const totalMs = durations.reduce((a, b) => a + b, 0);
  const avg = total ? Math.round(totalMs / total) : 0;
  const max = durations.length ? Math.max(...durations) : 0;
  const p95 = (() => {
    if (!durations.length) return 0;
    const sorted = [...durations].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  })();
  return { total, success, failed, avg, max, p95, totalMs };
}
