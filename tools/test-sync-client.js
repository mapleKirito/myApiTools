'use strict';

/**
 * 双设备同步链路验证
 *   node tools/test-sync-client.js
 *
 * 用 electron/sync-client.js（应用真正调用的那份客户端）配合真实的同步服务，
 * 模拟两台设备各自登录、推送、拉取，验证最终一致性。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SyncClient } = require('../electron/sync-client');

const PORT = 18900 + Math.floor(Math.random() * 80);
const DB_FILE = path.join(os.tmpdir(), `myapitools-sync-${Date.now()}.db`);
const SERVER = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}

async function waitReady(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(SERVER + '/api/health');
      if (r.ok) return true;
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

/**
 * 杀掉子进程并等它真的退出。
 * Windows 上还有进程握着句柄时 rmSync 会失败（EBUSY/EPERM），
 * 杀完立刻删会被 catch 吞掉，临时库就永久留在 %TEMP%。
 */
function killAndWait(proc, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return resolve();
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, timeoutMs);
    proc.once('exit', done);
    try { proc.kill(); } catch { done(); }
  });
}

(async () => {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_FILE, HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverErr = '';
  proc.stderr.on('data', (d) => { serverErr += d.toString(); });

  const cleanup = async () => {
    await killAndWait(proc);
    for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
      try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
    }
  };

  try {
    if (!await waitReady()) {
      console.error('服务未能启动：\n' + serverErr);
      await cleanup();
      process.exit(1);
    }

    const client = new SyncClient();

    /* ---------- 连接与账号 ---------- */
    console.log('\n【连接与账号】');
    {
      const h = await client.health(SERVER);
      eq('健康检查通过', h.ok, true);
      ok('健康检查说明了职责边界', h.scope.includes('不参与任何接口调用'));
    }
    {
      // 不带协议的地址应被自动补全
      const h = await client.health(`127.0.0.1:${PORT}`);
      eq('裸地址自动补 http://', h.ok, true);
    }

    const email = 'device-test@example.com';
    const reg = await client.register(SERVER, email, 'pwd123456');
    ok('注册返回令牌', typeof reg.token === 'string' && reg.token.length === 64);

    let duplicateRejected = false;
    try { await client.register(SERVER, email, 'pwd123456'); } catch (e) { duplicateRejected = e.status === 409; }
    ok('重复注册被拒绝', duplicateRejected);

    let badPwdRejected = false;
    try { await client.login(SERVER, email, 'wrong-password'); } catch (e) { badPwdRejected = e.status === 401; }
    ok('错误密码被拒绝', badPwdRejected);

    /* ---------- 设备 A 首次全量上传 ---------- */
    console.log('\n【设备 A：首次上传】');
    const deviceA = { serverUrl: SERVER, token: reg.token };
    const entity = (kind, id, updatedAt, data, deleted = false) => ({ kind, id, updatedAt, deleted, data });

    const pushA = await client.push(deviceA, [
      entity('collection', 'col-api', 1000, { id: 'col-api', name: '接口测试', parentId: null, sort: 0, deleted: false, updatedAt: 1000 }),
      entity('request', 'req-login', 1000, { id: 'req-login', name: '登录', collectionId: 'col-api', method: 'POST', url: '{{host}}/login', params: [], headers: [], body: { mode: 'json', content: '{"u":"a"}' }, auth: { type: 'none' }, options: {}, deleted: false, updatedAt: 1000 }),
      entity('request', 'req-list', 1000, { id: 'req-list', name: '列表', collectionId: 'col-api', method: 'GET', url: '{{host}}/list', params: [], headers: [], body: { mode: 'none' }, auth: { type: 'none' }, options: {}, deleted: false, updatedAt: 1000 }),
      entity('environment', 'env-dev', 1000, { id: 'env-dev', name: '开发环境', variables: [{ key: 'host', value: 'http://127.0.0.1:8080', enabled: true }], deleted: false, updatedAt: 1000 }),
      entity('globals', 'globals', 1000, [{ key: 'shared', value: 'v1', enabled: true }]),
    ], 0);
    eq('A 上传落地 5 个实体', pushA.applied, 5);
    eq('A 无冲突', pushA.conflicts.length, 0);
    ok('返回服务端水位', pushA.rev > 0);

    /* ---------- 设备 B 登录并拉取 ---------- */
    console.log('\n【设备 B：登录并拉取】');
    const loginB = await client.login(SERVER, email, 'pwd123456');
    const deviceB = { serverUrl: SERVER, token: loginB.token };
    ok('B 拿到独立令牌', loginB.token !== reg.token);

    const pullB = await client.pull(deviceB, 0);
    eq('B 拉到全部 5 个实体', pullB.entities.length, 5);
    const reqB = pullB.entities.find((e) => e.id === 'req-login');
    eq('B 拿到请求名称', reqB.data.name, '登录');
    eq('B 拿到请求方法', reqB.data.method, 'POST');
    eq('B 拿到请求体', JSON.parse(reqB.data.body.content).u, 'a');
    const envB = pullB.entities.find((e) => e.id === 'env-dev');
    eq('B 拿到环境变量', envB.data.variables[0].value, 'http://127.0.0.1:8080');
    const globB = pullB.entities.find((e) => e.kind === 'globals');
    ok('B 拿到全局变量', Array.isArray(globB.data) && globB.data[0].key === 'shared');

    const revAfterB = pullB.rev;
    const pullAgain = await client.pull(deviceB, revAfterB);
    eq('B 按水位再次拉取为空', pullAgain.entities.length, 0);

    /* ---------- 设备 B 修改后 A 增量拉取 ---------- */
    console.log('\n【设备 B 改动 → 设备 A 增量拉取】');
    const pushB = await client.push(deviceB, [
      entity('request', 'req-login', 5000, { id: 'req-login', name: '登录（B 改过）', collectionId: 'col-api', method: 'POST', url: '{{host}}/v2/login', params: [], headers: [], body: { mode: 'json', content: '{"u":"b"}' }, auth: { type: 'none' }, options: {}, deleted: false, updatedAt: 5000 }),
      entity('request', 'req-new-from-b', 5000, { id: 'req-new-from-b', name: 'B 新增的请求', collectionId: 'col-api', method: 'GET', url: 'https://example.com/b', params: [], headers: [], body: { mode: 'none' }, auth: { type: 'none' }, options: {}, deleted: false, updatedAt: 5000 }),
    ], revAfterB);
    eq('B 上传 2 项', pushB.applied, 2);

    const pullA = await client.pull(deviceA, revAfterB);
    eq('A 只拉到 2 条增量', pullA.entities.length, 2);
    const changed = pullA.entities.find((e) => e.id === 'req-login');
    eq('A 看到 B 的改动', changed.data.name, '登录（B 改过）');
    eq('A 看到 B 改后的 URL', changed.data.url, '{{host}}/v2/login');
    ok('A 看到 B 新增的请求', pullA.entities.some((e) => e.id === 'req-new-from-b'));

    /* ---------- 冲突：旧版本写入被拒 ---------- */
    console.log('\n【冲突处理】');
    const stale = await client.push(deviceA, [
      entity('request', 'req-login', 3000, { id: 'req-login', name: 'A 的旧改动', collectionId: 'col-api', method: 'POST', url: 'https://stale.example.com', params: [], headers: [], body: { mode: 'none' }, auth: { type: 'none' }, options: {}, deleted: false, updatedAt: 3000 }),
    ], pullA.rev);
    eq('过期写入未落地', stale.applied, 0);
    eq('回报 1 条冲突', stale.conflicts.length, 1);
    const conflict = stale.conflicts[0];
    eq('冲突带出实体 id', conflict.id, 'req-login');
    ok('冲突带出服务端版本时间戳', conflict.serverUpdatedAt === 5000);
    eq('冲突带出服务端数据，客户端可直接覆盖本地', conflict.serverData.name, '登录（B 改过）');
    eq('冲突带出服务端 URL', conflict.serverData.url, '{{host}}/v2/login');

    /* ---------- 较新写入获胜 ---------- */
    const newer = await client.push(deviceA, [
      entity('request', 'req-login', 9000, { id: 'req-login', name: 'A 的最新改动', collectionId: 'col-api', method: 'POST', url: 'https://newest.example.com', params: [], headers: [], body: { mode: 'none' }, auth: { type: 'none' }, options: {}, deleted: false, updatedAt: 9000 }),
    ], stale.rev);
    eq('较新写入落地', newer.applied, 1);

    const pullB2 = await client.pull(deviceB, pushB.rev);
    const latest = pullB2.entities.find((e) => e.id === 'req-login');
    eq('B 最终看到 A 的最新版本', latest.data.name, 'A 的最新改动');
    eq('收敛到一致的 URL', latest.data.url, 'https://newest.example.com');

    /* ---------- 删除传播 ---------- */
    console.log('\n【删除传播】');
    const del = await client.push(deviceA, [
      entity('request', 'req-list', 12000, null, true),
    ], newer.rev);
    eq('删除写入落地', del.applied, 1);
    const pullB3 = await client.pull(deviceB, pullB2.rev);
    const deleted = pullB3.entities.find((e) => e.id === 'req-list');
    ok('B 收到删除标记', deleted && deleted.deleted === true);
    eq('删除的实体不带数据', deleted.data, null);

    /* ---------- 账号隔离 ---------- */
    console.log('\n【账号隔离】');
    const other = await client.register(SERVER, 'other-device@example.com', 'pwd123456');
    const otherPull = await client.pull({ serverUrl: SERVER, token: other.token }, 0);
    eq('新账号看不到他人配置', otherPull.entities.length, 0);

    /* ---------- 错误处理 ---------- */
    console.log('\n【错误处理】');
    {
      let msg = '';
      try { await client.pull({ serverUrl: SERVER, token: 'f'.repeat(64) }, 0); } catch (e) { msg = e.message; }
      ok('失效令牌给出可读提示', msg.includes('登录') || msg.includes('令牌'));
    }
    {
      let msg = '';
      try { await client.health('http://127.0.0.1:59987'); } catch (e) { msg = e.message; }
      ok('连不上服务时给出可操作提示', msg.includes('无法连接') && msg.includes('请确认'), `实际：${msg}`);
    }
    {
      let msg = '';
      try { await client.health('http://127.0.0.1:1'); } catch (e) { msg = e.message; }
      ok('非法端口给出明确提示', msg.includes('端口'), `实际：${msg}`);
    }
    {
      let msg = '';
      try { await client.health('http://this-host-does-not-exist.invalid'); } catch (e) { msg = e.message; }
      ok('域名无法解析时给出提示', msg.includes('域名'), `实际：${msg}`);
    }

    /* ---------- 水位单调性 ---------- */
    console.log('\n【水位行为】');
    {
      const before = await client.pull(deviceA, 0);
      const noop = await client.push(deviceA, [
        entity('request', 'req-new-from-b', 5000, { id: 'req-new-from-b', name: 'B 新增的请求', collectionId: 'col-api', method: 'GET', url: 'https://example.com/b', params: [], headers: [], body: { mode: 'none' }, auth: { type: 'none' }, options: {}, deleted: false, updatedAt: 5000 }),
      ], before.rev);
      eq('内容无变化的重复推送不推进水位', noop.applied, 0);
    }

    console.log('\n---------------------------------------------');
    console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
    console.log('---------------------------------------------\n');
    await cleanup();
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('验证过程异常：', e);
    await cleanup();
    process.exit(1);
  }
})();
