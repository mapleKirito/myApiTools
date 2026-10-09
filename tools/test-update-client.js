'use strict';

/**
 * 客户端更新链路验证
 *   node tools/test-update-client.js
 *
 * 用 electron/update-client.js（应用真正调用的那份）配合真实的同步服务，
 * 走一遍「管理端发布 → 客户端查版本 → 下载 → 校验 sha256」：
 *   · 版本比较与平台隔离由服务端负责，这里确认客户端拿到的结论是对的
 *   · 下载必须字节一致且校验通过；内容被换掉时必须拒绝，而不是把坏包装进用户机器
 *   · 未登录 / 令牌失效必须被挡住
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { UpdateClient } = require('../electron/update-client');

const PORT = 18600 + Math.floor(Math.random() * 90);
const DB_FILE = path.join(os.tmpdir(), `myapitools-update-${Date.now()}.db`);
const RELEASES_DIR = path.join(os.tmpdir(), `myapitools-update-rel-${Date.now()}`);
const DOWNLOAD_DIR = path.join(os.tmpdir(), `myapitools-update-dl-${Date.now()}`);
const ADMIN_TOKEN = 'update-admin-' + Math.random().toString(36).slice(2);
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

function killAndWait(proc, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return resolve();
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, timeoutMs);
    proc.once('exit', done);
    try { proc.kill(); } catch { done(); }
  });
}

/** 通过管理端接口发布一个安装包（与管理页走同一条路径） */
async function publish({ version, platform, arch, body, name, notes }) {
  const qs = new URLSearchParams({ version, platform, arch });
  if (notes) qs.set('notes', notes);
  if (name) qs.set('name', Buffer.from(name, 'utf8').toString('base64url'));
  const res = await fetch(`${SERVER}/api/admin/releases?${qs}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream', 'x-admin-token': ADMIN_TOKEN },
    body,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

(async () => {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_FILE,
      HOST: '127.0.0.1',
      ADMIN_TOKEN,
      ADMIN_LOCAL_ONLY: '1',
      RELEASES_DIR,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.__stderr = '';
  proc.stderr.on('data', (d) => { proc.__stderr += d.toString(); });

  const cleanup = async () => {
    await killAndWait(proc);
    for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
      try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
    }
    for (const d of [RELEASES_DIR, DOWNLOAD_DIR]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  };

  const client = new UpdateClient();

  try {
    if (!await waitReady()) {
      console.error('服务未能启动：\n' + proc.__stderr);
      await cleanup();
      process.exit(1);
    }

    /* ---------------------- 准备账号 ---------------------- */
    console.log('\n【准备】');
    const reg = await (await fetch(SERVER + '/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'upd@example.com', password: 'pwd123456' }),
    })).json();
    const token = reg.token;
    eq('注册并取得令牌', typeof token, 'string');

    console.log('\n【服务端还没发布任何版本】');
    const empty = await client.check(SERVER, token, { current: '1.0.0', platform: 'win', arch: 'x64' });
    eq('没有发布过时不报错', empty.ok, true);
    eq('没有发布过时 latest 为空', empty.latest, null);
    eq('没有发布过时视为已最新', empty.upToDate, true);

    /* ---------------------- 发布 ---------------------- */
    console.log('\n【发布两个版本】');
    const exe190 = Buffer.from('MyApiTools 1.9.0 安装包内容'.repeat(3000), 'utf8');
    const exe1100 = Buffer.from('MyApiTools 1.10.0 安装包内容（不同）'.repeat(3500), 'utf8');
    eq('发布 1.9.0',
      (await publish({ version: '1.9.0', platform: 'win', arch: 'x64', body: exe190, name: 'MyApiTools-Setup-1.9.0-x64.exe' })).status,
      201);
    eq('发布 1.10.0',
      (await publish({ version: '1.10.0', platform: 'win', arch: 'x64', body: exe1100, name: 'MyApiTools-Setup-1.10.0-x64.exe', notes: '新增客户端更新检查' })).status,
      201);
    eq('发布 mac 版本（不应影响 win）',
      (await publish({ version: '9.9.9', platform: 'mac', arch: 'arm64', body: Buffer.from('mac 包'), name: 'MyApiTools-9.9.9-arm64.dmg' })).status,
      201);

    /* ---------------------- 查询 ---------------------- */
    console.log('\n【查询最新版本】');
    const older = await client.check(SERVER, token, { current: '1.0.0', platform: 'win', arch: 'x64' });
    eq('旧客户端查到可更新', older.updateAvailable, true);
    eq('取到的是 1.10.0', older.latest.version, '1.10.0');
    eq('带回更新说明', older.latest.notes, '新增客户端更新检查');
    eq('带回 sha256', /^[0-9a-f]{64}$/.test(older.latest.sha256), true);
    eq('带回下载地址', older.latest.downloadUrl, `/api/releases/download/${older.latest.id}`);

    const same = await client.check(SERVER, token, { current: '1.10.0', platform: 'win', arch: 'x64' });
    eq('同版本不提示更新', same.updateAvailable, false);
    eq('同版本 upToDate', same.upToDate, true);

    const newer = await client.check(SERVER, token, { current: '2.0.0', platform: 'win', arch: 'x64' });
    eq('客户端更新时不提示回退', newer.updateAvailable, false);

    const mac = await client.check(SERVER, token, { current: '1.0.0', platform: 'mac', arch: 'arm64' });
    eq('mac 拿到 mac 自己的最新版本', mac.latest.version, '9.9.9');

    console.log('\n【未登录 / 令牌失效】');
    let authErr = null;
    try {
      await client.check(SERVER, '', { current: '1.0.0', platform: 'win', arch: 'x64' });
    } catch (e) { authErr = e; }
    eq('未带令牌查询被拒', authErr && authErr.status, 401);
    eq('错误码是 AUTH_REQUIRED', authErr && authErr.code, 'AUTH_REQUIRED');

    let badErr = null;
    try {
      await client.check(SERVER, 'x'.repeat(64), { current: '1.0.0', platform: 'win', arch: 'x64' });
    } catch (e) { badErr = e; }
    eq('伪造令牌查询被拒', badErr && badErr.status, 401);

    /* ---------------------- 下载 ---------------------- */
    console.log('\n【下载安装包】');
    const ticks = [];
    const dl = await client.download(
      SERVER,
      token,
      older.latest,
      DOWNLOAD_DIR,
      (p) => ticks.push(p)
    );
    eq('落盘文件名与发布一致', dl.fileName, 'MyApiTools-Setup-1.10.0-x64.exe');
    eq('下载字节数与发布一致', dl.size, exe1100.length);
    eq('sha256 校验通过', dl.verified, true);
    eq('文件真的在磁盘上', fs.existsSync(dl.filePath), true);
    eq('磁盘内容与上传字节完全一致', fs.readFileSync(dl.filePath).equals(exe1100), true);
    ok('下载过程有进度回调', ticks.length > 0, `ticks=${ticks.length}`);
    eq('最后一次进度是 100%', ticks[ticks.length - 1].percent, 100);
    eq('没有留下 .part 临时文件', fs.readdirSync(DOWNLOAD_DIR).some((n) => n.endsWith('.part')), false);

    console.log('\n【二次下载覆盖同名文件】');
    const dl2 = await client.download(SERVER, token, older.latest, DOWNLOAD_DIR);
    eq('同一目录重复下载仍然成功', fs.readFileSync(dl2.filePath).equals(exe1100), true);
    eq('目录里仍只有一个文件', fs.readdirSync(DOWNLOAD_DIR).length, 1);

    console.log('\n【下载时未登录】');
    let dlAuthErr = null;
    try {
      await client.download(SERVER, '', older.latest, DOWNLOAD_DIR);
    } catch (e) { dlAuthErr = e; }
    eq('未带令牌下载被拒', dlAuthErr && dlAuthErr.status, 401);
    eq('下载鉴权失败带 AUTH_REQUIRED', dlAuthErr && dlAuthErr.code, 'AUTH_REQUIRED');

    console.log('\n【文件被篡改时必须拒绝】');
    {
      // 服务端库里存的是原始 sha256，但磁盘上的文件被换掉了。
      // 客户端必须靠摘要把这种包拦下来 —— 这正是「不许把坏包装到用户机器上」的那道闸。
      const tampered = path.join(RELEASES_DIR, 'stable', '1.10.0', 'MyApiTools-Setup-1.10.0-x64.exe');
      // 大小故意保持不变，确保只有内容变了
      const evil = Buffer.alloc(exe1100.length, 0x41);
      fs.writeFileSync(tampered, evil);
      eq('篡改后文件大小未变', fs.statSync(tampered).size, exe1100.length);

      let shaErr = null;
      try {
        await client.download(SERVER, token, older.latest, DOWNLOAD_DIR);
      } catch (e) { shaErr = e; }

      ok('内容被换掉时下载报错', !!shaErr, shaErr ? '' : '（居然成功了）');
      ok('错误信息说明是校验失败',
        !!shaErr && /sha256|校验/.test(shaErr.message), shaErr ? shaErr.message : '');
      eq('校验失败不留 .part 残留', fs.readdirSync(DOWNLOAD_DIR).some((n) => n.endsWith('.part')), false);
      eq('校验失败不覆盖已下载的好文件',
        fs.readFileSync(path.join(DOWNLOAD_DIR, 'MyApiTools-Setup-1.10.0-x64.exe')).equals(exe1100), true);
    }

    console.log('\n【下载不存在的安装包】');
    {
      let notFound = null;
      try {
        await client.download(SERVER, token, { downloadUrl: '/api/releases/download/99999', version: '1.0.0' }, DOWNLOAD_DIR);
      } catch (e) { notFound = e; }
      eq('不存在的安装包返回 404', notFound && notFound.status, 404);
    }

    console.log('\n【服务端摘要与本地重算一致】');
    {
      const local = crypto.createHash('sha256').update(exe1100).digest('hex');
      eq('客户端算出的 sha256 = 上传内容的 sha256', local, older.latest.sha256);
    }

    console.log('\n---------------------------------------------');
    console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
    console.log('---------------------------------------------\n');
    await cleanup();
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('验证过程异常：', e && e.stack ? e.stack : e);
    console.error(proc.__stderr);
    await cleanup();
    process.exit(1);
  }
})();
