'use strict';

/**
 * 同步服务端端到端验证脚本
 *   node server/test-e2e.js
 * 自拉起临时实例（独立 db 文件 + 随机端口），跑完自动清理。
 *
 * 覆盖五块：
 *   1. 基础与鉴权 / 推送拉取 / 冲突 / 软删除 / 多账号隔离
 *   2. 管理端 API 与账号治理（禁用、重置密码、吊销令牌、删除）
 *   3. 管理端安全策略（令牌、来源限制、未启用时不暴露存在性）
 *   4. 客户端安装包发布（权限、版本比较、平台隔离、下载一致性、覆盖、文件名安全、删除、
 *      正式版与 -dev 快照版的版本语义）
 *   5. 老库迁移（缺列的历史数据库能否平滑升级）
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const PORT = 18800 + Math.floor(Math.random() * 100);
const DB_FILE = path.join(os.tmpdir(), `myapitools-e2e-${Date.now()}.db`);
const ADMIN_TOKEN_FILE = path.join(os.tmpdir(), `myapitools-e2e-admin-${Date.now()}.txt`);
const RELEASES_DIR = path.join(os.tmpdir(), `myapitools-e2e-releases-${Date.now()}`);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = 'e2e-admin-token-' + Math.random().toString(36).slice(2);

let pass = 0;
let fail = 0;
let skipped = 0;

function check(name, actual, expected) {
  const ok = actual === expected;
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name.padEnd(42)} 实际=${actual}${ok ? '' : '  期望=' + expected}`);
}
function note(text) {
  skipped++;
  console.log(`  – ${text}（本机无可用非回环地址，跳过）`);
}
function section(title) {
  console.log(`\n【${title}】`);
}

/**
 * 从页面 HTML 里抠出一个具名纯函数的源码并求值。
 * 用来真跑管理页上的逻辑，而不是只 grep 字符串 —— 文件名推断那个 bug 的特征恰恰是
 * "代码看着没毛病、结果错了"，光断言某条正则存在根本拦不住。
 */
function extractPageFunction(html, name) {
  const at = html.indexOf('function ' + name + '(');
  if (at < 0) return null;
  const open = html.indexOf('{', at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) {
        try {
          return new Function('return (' + html.slice(at, i + 1) + ')')();
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** @param {{admin?:boolean, token?:string}} opts */
async function api(method, p, body, token, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  if (opts.admin) headers['x-admin-token'] = opts.admin === true ? ADMIN_TOKEN : opts.admin;
  const res = await fetch(BASE + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

/** 上传安装包：body 是原始字节流，元信息走 query（与管理端页面同一条路径） */
async function uploadRelease({ version, platform, arch, channel, notes, name, body, admin = true }) {
  const qs = new URLSearchParams({ version, platform, arch });
  if (channel) qs.set('channel', channel);
  if (notes) qs.set('notes', notes);
  if (name) qs.set('name', Buffer.from(name, 'utf8').toString('base64url'));
  const headers = { 'content-type': 'application/octet-stream' };
  if (admin) headers['x-admin-token'] = admin === true ? ADMIN_TOKEN : admin;
  const res = await fetch(`${BASE}/api/admin/releases?${qs}`, { method: 'PUT', headers, body });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

async function waitReady(base = BASE, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

/** 本机是否存在可用于「模拟远程来源」的非回环 IPv4 */
function findLanIp() {
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

function spawnServer(extraEnv) {
  const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_FILE, HOST: '127.0.0.1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.__stderr = '';
  proc.stderr.on('data', (d) => { proc.__stderr += d.toString(); });
  return proc;
}

/**
 * 杀掉子进程并等它真的退出。
 * Windows 上只要还有别的进程握着文件句柄，rmSync 就会失败（EBUSY/EPERM），
 * 所以不能杀完立刻删库 —— 那样错误会被 catch 吞掉，临时库就永久留在 %TEMP% 里。
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
  const proc = spawnServer({
    ADMIN_TOKEN,
    ADMIN_LOCAL_ONLY: '1',
    ADMIN_TOKEN_FILE,
    RELEASES_DIR,
  });

  const cleanup = async () => {
    await killAndWait(proc);
    for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm', ADMIN_TOKEN_FILE]) {
      try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
    }
    try { fs.rmSync(RELEASES_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  try {
    if (!await waitReady()) {
      console.error('服务未能启动：\n' + proc.__stderr);
      await cleanup();
      process.exit(1);
    }

    /* ============================ 1. 基础 ============================ */
    section('基础与鉴权');
    check('健康检查', (await api('GET', '/api/health')).status, 200);
    check('未知路径返回 404', (await api('GET', '/api/nope')).status, 404);
    check('错误方法返回 405', (await api('POST', '/api/health')).status, 405);

    const reg = await api('POST', '/api/auth/register', { email: 'tester@example.com', password: 'pwd12345' });
    check('注册成功', reg.status, 200);
    check('注册返回令牌', typeof reg.data.token === 'string' && reg.data.token.length === 64, true);
    const token = reg.data.token;

    check('重复注册被拒', (await api('POST', '/api/auth/register', { email: 'tester@example.com', password: 'pwd12345' })).status, 409);
    check('弱密码被拒', (await api('POST', '/api/auth/register', { email: 'x@y.com', password: '123' })).status, 400);
    check('非法邮箱被拒', (await api('POST', '/api/auth/register', { email: 'not-an-email', password: 'pwd12345' })).status, 400);

    const badLogin = await api('POST', '/api/auth/login', { email: 'tester@example.com', password: 'bad' });
    check('错误密码登录失败', badLogin.status, 401);
    check('登录失败带机器可读 code', badLogin.data.code, 'BAD_CREDENTIALS');

    check('正确密码登录成功', (await api('POST', '/api/auth/login', { email: 'tester@example.com', password: 'pwd12345' })).status, 200);

    const noAuth = await api('GET', '/api/sync/pull?since=0');
    check('无令牌拉取被拒', noAuth.status, 401);
    check('无令牌返回 AUTH_REQUIRED', noAuth.data.code, 'AUTH_REQUIRED');
    check('伪造令牌被拒', (await api('GET', '/api/sync/pull?since=0', undefined, 'a'.repeat(64))).status, 401);

    section('身份自检 /api/auth/me');
    const me = await api('GET', '/api/auth/me', undefined, token);
    check('me 返回 200', me.status, 200);
    check('me 返回当前邮箱', me.data.user.email, 'tester@example.com');
    check('me 返回令牌过期时间', me.data.expiresAt > Date.now(), true);
    check('me 不泄漏密码散列', JSON.stringify(me.data).includes('password_hash'), false);

    section('推送与增量拉取');
    const push1 = await api('POST', '/api/sync/push', {
      clientRev: 0,
      entities: [
        { kind: 'collection', id: 'c1', updatedAt: 1000, deleted: false, data: { name: '用户中心' } },
        { kind: 'request', id: 'r1', updatedAt: 1000, deleted: false, data: { name: '登录', method: 'POST', url: '/api/login' } },
        { kind: 'environment', id: 'e1', updatedAt: 1000, deleted: false, data: { name: 'dev', variables: [{ key: 'host', value: 'http://127.0.0.1:8080' }] } },
      ],
    }, token);
    check('推送状态', push1.status, 200);
    check('落地实体数', push1.data.applied, 3);

    const pull1 = await api('GET', '/api/sync/pull?since=0', undefined, token);
    check('全量拉取实体数', pull1.data.entities.length, 3);
    check('拉取带出 rev 水位', pull1.data.rev > 0, true);
    check('按水位增量拉取为空', (await api('GET', `/api/sync/pull?since=${pull1.data.rev}`, undefined, token)).data.entities.length, 0);

    const pushNoop = await api('POST', '/api/sync/push', {
      clientRev: 0,
      entities: [{ kind: 'request', id: 'r1', updatedAt: 1000, deleted: false, data: { name: '登录', method: 'POST', url: '/api/login' } }],
    }, token);
    check('无变化的重复推送被跳过', pushNoop.data.applied, 0);

    section('冲突处理（后写覆盖）');
    const stale = await api('POST', '/api/sync/push', {
      clientRev: 0,
      entities: [{ kind: 'request', id: 'r1', updatedAt: 500, deleted: false, data: { name: '旧版本' } }],
    }, token);
    check('过期写入被拒绝', stale.data.applied, 0);
    check('过期写入回报为冲突', stale.data.conflicts.length, 1);
    check('冲突回传服务端版本', stale.data.conflicts[0].serverData.name, '登录');
    check('较新写入被接受', (await api('POST', '/api/sync/push', {
      clientRev: 0,
      entities: [{ kind: 'request', id: 'r1', updatedAt: 5000, deleted: false, data: { name: '新版本' } }],
    }, token)).data.applied, 1);

    section('软删除');
    const del = await api('POST', '/api/sync/push', {
      clientRev: 0,
      entities: [{ kind: 'request', id: 'r1', updatedAt: 9000, deleted: true, data: null }],
    }, token);
    check('删除写入被接受', del.data.applied, 1);
    const afterDel = await api('GET', '/api/sync/pull?since=0', undefined, token);
    check('删除标记同步可见', afterDel.data.entities.find((e) => e.id === 'r1').deleted, true);
    check('统计不含已删除实体', (await api('GET', '/api/sync/stats', undefined, token)).data.entities, 2);

    section('多账号数据隔离');
    const reg2 = await api('POST', '/api/auth/register', { email: 'other@example.com', password: 'pwd12345' });
    const token2 = reg2.data.token;
    check('另一账号看不到别人的配置', (await api('GET', '/api/sync/pull?since=0', undefined, token2)).data.entities.length, 0);
    const cross = await api('POST', '/api/sync/push', {
      clientRev: 0,
      entities: [{ kind: 'request', id: 'r1', updatedAt: 99999, deleted: false, data: { name: '越权覆盖' } }],
    }, token2);
    check('跨账号写入落到自己名下', cross.data.applied, 1);
    const mine = await api('GET', '/api/sync/pull?since=0', undefined, token);
    check('原账号数据未被污染', mine.data.entities.find((e) => e.id === 'r1').deleted, true);

    section('登录限流：挡爆破，但不误伤本人');
    {
      // 连续成功登录不应消耗配额 —— 否则别人拿你的邮箱狂发请求就能把你锁住
      let allOk = true;
      for (let i = 0; i < 12; i++) {
        const r = await api('POST', '/api/auth/login', { email: 'other@example.com', password: 'pwd12345' });
        if (r.status !== 200) { allOk = false; break; }
      }
      check('连续 12 次成功登录未被限流', allOk, true);
    }
    {
      // 但真正的密码爆破必须被挡住
      let blockedAt = 0;
      for (let i = 1; i <= 25; i++) {
        const r = await api('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'wrong-guess' });
        if (r.status === 429) { blockedAt = i; break; }
      }
      check('同一账号连续失败会被限流', blockedAt > 0, true);
      check('失败上限为 20 次', blockedAt, 21);
    }

    /* ======================== 2. 管理端安全策略 ======================== */
    section('管理端：安全策略');
    check('未带管理令牌访问管理接口 → 401', (await api('GET', '/api/admin/overview')).status, 401);
    check('未带令牌不泄漏服务信息', (await api('GET', '/api/admin/overview')).data.totals, undefined);
    const wrongToken = await api('GET', '/api/admin/overview', undefined, undefined, { admin: 'wrong-token-value' });
    check('错误管理令牌 → 401', wrongToken.status, 401);
    check('错误令牌返回 ADMIN_TOKEN_INVALID', wrongToken.data.code, 'ADMIN_TOKEN_INVALID');
    check('管理页面本身可访问（用于输入令牌）', (await api('GET', '/admin')).status, 200);
    check('管理页面含令牌输入框', (await api('GET', '/admin')).data.includes('gate-token'), true);
    check('管理页面不内嵌任何令牌', (await api('GET', '/admin')).data.includes(ADMIN_TOKEN), false);

    // 回归守卫：页面靠 element.hidden 切换闸门与主体，而 #gate 自己带 display:flex。
    // 浏览器默认的 [hidden]{display:none} 优先级低于类选择器，一旦这条兜底规则没了，
    // 登录成功后闸门不会消失（表现为"输了令牌没反应、控制台零报错"），极难排查。
    const gateHtml = (await api('GET', '/admin')).data;
    check('管理页面定义 [hidden] 显隐兜底规则', /\[hidden\]\s*\{/.test(gateHtml), true);
    check('[hidden] 兜底规则为 display:none !important',
      /\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/.test(gateHtml), true);

    // 回归守卫：管理页从安装包文件名推断版本号。
    // 曾经的取法是 `/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/`，后缀段的字符集含 `.` 和字母数字，
    // 会把架构尾巴整段吃掉（MyApiTools-Setup-1.2.0-x64.exe → 1.2.0-x64.exe）。发布校验正则和
    // 服务端 parseVersion 又都放它过关 → "发布成功、版本号却是垃圾"，零报错。
    // 带 -dev 的文件名反而碰巧正确，所以只咬正式版文件名 —— 不真跑一遍根本发现不了。
    const inferVersion = extractPageFunction(gateHtml, 'inferVersionFromName');
    check('管理页提供文件名→版本号推断函数', typeof inferVersion, 'function');
    if (typeof inferVersion === 'function') {
      const nameCases = [
        ['MyApiTools-Setup-1.2.0-x64.exe', '1.2.0'],
        ['MyApiTools-1.2.0-arm64.dmg', '1.2.0'],
        ['MyApiTools-Setup-1.10.0-ia32.exe', '1.10.0'],
        ['MyApiTools-1.2.0.AppImage', '1.2.0'],
        ['MyApiTools-1.2.0-linux.AppImage', '1.2.0'],
        ['MyApiTools-Setup-1.2.0-win.exe', '1.2.0'],
        ['我的工具-Setup-1.2.0-x64.exe', '1.2.0'],
        ['MyApiTools-Setup-1.2.0-dev-x64.exe', '1.2.0-dev'],
        ['MyApiTools-Setup-1.2.0-dev.2-x64.exe', '1.2.0-dev.2'],
        ['MyApiTools-1.2.0-beta.1-arm64.dmg', '1.2.0-beta.1'],
        ['文件名里没有版本号.exe', ''],
      ];
      for (const [name, want] of nameCases) {
        check('文件名推断：' + name, inferVersion(name), want);
      }
      // 推断出来的东西必须能过发布校验（与服务端 uploadRelease 的正则一致），
      // 否则等到发布时才报错，甚至悄悄记成垃圾版本号
      const RELEASE_VERSION_OK = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
      for (const [name] of nameCases) {
        const v = inferVersion(name);
        if (v) check('推断结果可发布：' + v, RELEASE_VERSION_OK.test(v), true);
      }
    }

    const who = await api('GET', '/api/admin/whoami', undefined, undefined, { admin: true });
    check('正确管理令牌通过校验', who.status, 200);
    check('whoami 不回显管理令牌', JSON.stringify(who.data).includes(ADMIN_TOKEN), false);
    check('whoami 标明仅本机', who.data.localOnly, true);

    /* ======================== 3. 管理端功能 ======================== */
    section('管理端：服务概览');
    const ov = await api('GET', '/api/admin/overview', undefined, undefined, { admin: true });
    check('概览返回 200', ov.status, 200);
    check('概览统计用户数', ov.data.totals.users, 2);
    check('概览统计启用用户数', ov.data.totals.activeUsers, 2);
    // tester 有 c1/e1 两条存活配置，other 有 1 条，r1 已被软删不计入
    check('概览统计配置项数', ov.data.totals.entities, 3);
    check('概览区分已软删配置', ov.data.totals.deletedEntities, 1);
    check('概览返回同步水位', ov.data.rev > 0, true);
    check('概览返回运行时长', ov.data.uptimeSec >= 0, true);
    check('概览说明访问范围', ov.data.admin.localOnly, true);
    check('概览不回显管理令牌', JSON.stringify(ov.data).includes(ADMIN_TOKEN), false);

    section('管理端：用户列表');
    const list = await api('GET', '/api/admin/users', undefined, undefined, { admin: true });
    check('列表返回 200', list.status, 200);
    check('列表返回全部账号', list.data.users.length, 2);
    const tester = list.data.users.find((u) => u.email === 'tester@example.com');
    check('列表含账号状态字段', tester.status, 'active');
    check('列表含配置项计数', tester.entities, 2);
    check('列表含有效令牌数', tester.activeTokens >= 1, true);
    check('列表不含密码散列', JSON.stringify(list.data).includes('password_hash'), false);
    check('列表不含盐值', JSON.stringify(list.data).includes('"salt"'), false);
    const searched = await api('GET', '/api/admin/users?q=other', undefined, undefined, { admin: true });
    check('按邮箱搜索生效', searched.data.users.length, 1);
    check('状态筛选生效', (await api('GET', '/api/admin/users?status=disabled', undefined, undefined, { admin: true })).data.users.length, 0);

    section('管理端：创建账号');
    const created = await api('POST', '/api/admin/users', { email: 'Managed@Example.com', password: 'init123456', note: '管理员代建' }, undefined, { admin: true });
    check('管理端创建账号成功', created.status, 200);
    check('邮箱被规范化为小写', created.data.user.email, 'managed@example.com');
    check('备注被保存', created.data.user.note, '管理员代建');
    check('新账号初始为启用', created.data.user.status, 'active');
    check('新账号无配置数据', created.data.user.entities, 0);
    check('重复邮箱被拒', (await api('POST', '/api/admin/users', { email: 'managed@example.com', password: 'init123456' }, undefined, { admin: true })).status, 409);
    check('弱密码被拒', (await api('POST', '/api/admin/users', { email: 'weak@example.com', password: '123' }, undefined, { admin: true })).status, 400);
    const managedToken = (await api('POST', '/api/auth/login', { email: 'managed@example.com', password: 'init123456' })).data.token;
    check('代建账号可直接登录', !!managedToken, true);

    section('管理端：禁用账号即刻生效');
    const managedUser = (await api('GET', '/api/admin/users?q=managed@', undefined, undefined, { admin: true })).data.users[0];
    const disable = await api('PATCH', `/api/admin/users/${managedUser.id}`, { status: 'disabled' }, undefined, { admin: true });
    check('禁用操作成功', disable.status, 200);
    check('禁用后状态变更', disable.data.user.status, 'disabled');
    // 管理端禁用会连带吊销全部令牌，所以旧令牌是"不存在"而非"存在但被拒"
    const disabledSync = await api('GET', '/api/sync/pull?since=0', undefined, managedToken);
    check('禁用后原令牌立即失效', disabledSync.status, 401);
    check('旧令牌已被实际吊销', disabledSync.data.code, 'AUTH_INVALID');
    const disabledLogin = await api('POST', '/api/auth/login', { email: 'managed@example.com', password: 'init123456' });
    check('禁用后无法再登录', disabledLogin.status, 403);
    check('禁用后返回 ACCOUNT_DISABLED', disabledLogin.data.code, 'ACCOUNT_DISABLED');
    check('禁用后有效令牌数归零', (await api('GET', '/api/admin/users?q=managed@', undefined, undefined, { admin: true })).data.users[0].activeTokens, 0);

    const enable = await api('PATCH', `/api/admin/users/${managedUser.id}`, { status: 'active' }, undefined, { admin: true });
    check('重新启用成功', enable.data.user.status, 'active');
    check('启用后可正常登录', (await api('POST', '/api/auth/login', { email: 'managed@example.com', password: 'init123456' })).status, 200);

    section('管理端：账号状态兜底校验（令牌在、状态被改）');
    {
      // 管理端禁用会顺手吊销令牌，所以上面测的是"令牌没了"这条路。
      // 这里绕过管理端直连数据库只改 status，验证 authenticate() 里的状态兜底：
      // 万一有人直接改库、或将来新增了不改状态的禁用入口，令牌也不能继续用。
      const backToken = (await api('POST', '/api/auth/login', { email: 'managed@example.com', password: 'init123456' })).data.token;
      check('先取得一个可用令牌', (await api('GET', '/api/sync/pull?since=0', undefined, backToken)).status, 200);

      const raw = new DatabaseSync(DB_FILE);
      raw.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(managedUser.id);
      raw.close();

      const blocked = await api('GET', '/api/sync/pull?since=0', undefined, backToken);
      check('令牌仍在但账号已禁用 → 403', blocked.status, 403);
      check('兜底路径返回 ACCOUNT_DISABLED', blocked.data.code, 'ACCOUNT_DISABLED');
      check('兜底时顺手吊销该令牌', (await api('GET', '/api/sync/pull?since=0', undefined, backToken)).status, 401);
      check('被兜底禁用的账号无法登录', (await api('POST', '/api/auth/login', { email: 'managed@example.com', password: 'init123456' })).status, 403);

      await api('PATCH', `/api/admin/users/${managedUser.id}`, { status: 'active' }, undefined, { admin: true });
      check('恢复启用后可继续使用', (await api('POST', '/api/auth/login', { email: 'managed@example.com', password: 'init123456' })).status, 200);
    }

    section('管理端：重置密码');
    const beforeReset = (await api('POST', '/api/auth/login', { email: 'managed@example.com', password: 'init123456' })).data.token;
    const reset = await api('PATCH', `/api/admin/users/${managedUser.id}`, { password: 'brandnew999' }, undefined, { admin: true });
    check('重置密码成功', reset.status, 200);
    check('重置后旧令牌失效', (await api('GET', '/api/sync/pull?since=0', undefined, beforeReset)).status, 401);
    check('旧密码不再可用', (await api('POST', '/api/auth/login', { email: 'managed@example.com', password: 'init123456' })).status, 401);
    check('新密码可以登录', (await api('POST', '/api/auth/login', { email: 'managed@example.com', password: 'brandnew999' })).status, 200);
    check('过短的新密码被拒', (await api('PATCH', `/api/admin/users/${managedUser.id}`, { password: '123' }, undefined, { admin: true })).status, 400);

    section('管理端：吊销令牌 / 强制下线');
    const t1 = (await api('POST', '/api/auth/login', { email: 'managed@example.com', password: 'brandnew999', device: 'dev-A' })).data.token;
    const t2 = (await api('POST', '/api/auth/login', { email: 'managed@example.com', password: 'brandnew999', device: 'dev-B' })).data.token;
    // 上面"新密码可以登录"那次也留下了一个令牌，共 3 个
    check('该账号现有 3 个有效令牌', (await api('GET', '/api/admin/users?q=managed@', undefined, undefined, { admin: true })).data.users[0].activeTokens, 3);
    const revoke = await api('POST', `/api/admin/users/${managedUser.id}/tokens/revoke`, {}, undefined, { admin: true });
    check('吊销接口返回吊销数量', revoke.data.revoked, 3);
    check('吊销后有效令牌归零', (await api('GET', '/api/admin/users?q=managed@', undefined, undefined, { admin: true })).data.users[0].activeTokens, 0);
    check('设备 A 令牌失效', (await api('GET', '/api/sync/pull?since=0', undefined, t1)).status, 401);
    check('设备 B 令牌失效', (await api('GET', '/api/sync/pull?since=0', undefined, t2)).status, 401);

    section('管理端：删除账号及其数据');
    const keepToken = (await api('POST', '/api/auth/login', { email: 'managed@example.com', password: 'brandnew999' })).data.token;
    await api('POST', '/api/sync/push', {
      clientRev: 0,
      entities: [{ kind: 'request', id: 'rm1', updatedAt: 10, deleted: false, data: { name: '待删除' } }],
    }, keepToken);
    check('删除前该账号有 1 项配置', (await api('GET', '/api/admin/users?q=managed@', undefined, undefined, { admin: true })).data.users[0].entities, 1);
    const removed = await api('DELETE', `/api/admin/users/${managedUser.id}`, undefined, undefined, { admin: true });
    check('删除账号成功', removed.status, 200);
    check('删除同时清理配置数据', removed.data.deleted.entities, 1);
    check('删除后账号不再存在', (await api('GET', '/api/admin/users?q=managed@', undefined, undefined, { admin: true })).data.users.length, 0);
    check('删除后无法登录', (await api('POST', '/api/auth/login', { email: 'managed@example.com', password: 'brandnew999' })).status, 401);
    check('删除后原令牌失效', (await api('GET', '/api/sync/pull?since=0', undefined, keepToken)).status, 401);
    check('删除不存在的账号返回 404', (await api('DELETE', '/api/admin/users/99999', undefined, undefined, { admin: true })).status, 404);
    check('其它账号数据未受影响', (await api('GET', '/api/sync/pull?since=0', undefined, token)).data.entities.length, 3);

    section('管理端：审计日志');
    const audit = await api('GET', '/api/admin/audit?limit=200', undefined, undefined, { admin: true });
    const actions = audit.data.items.map((a) => a.action);
    check('审计记录创建动作', actions.includes('user.create'), true);
    check('审计记录禁用动作（含 status 变更）', audit.data.items.some((a) => a.action === 'user.update' && /status=disabled/.test(a.detail)), true);
    check('审计记录重置密码动作', audit.data.items.some((a) => a.action === 'user.update' && /password-reset/.test(a.detail)), true);
    check('审计记录吊销令牌动作', actions.includes('user.revoke-tokens'), true);
    check('审计记录删除动作', actions.includes('user.delete'), true);
    check('审计记录错误令牌尝试', actions.includes('admin.bad-token'), true);
    check('审计不含管理令牌本身', JSON.stringify(audit.data).includes(ADMIN_TOKEN), false);
    check('审计记录来源 IP', audit.data.items[0].ip, '127.0.0.1');

    /* ===================== 4. 非回环来源门禁 ===================== */
    section('管理端：来源限制（ADMIN_LOCAL_ONLY）');
    const lan = findLanIp();
    if (!lan) {
      note('跳过非回环来源测试');
    } else {
      const lanPort = PORT + 1;
      const lanBase = `http://${lan}:${lanPort}`;
      const lanTokenFile = ADMIN_TOKEN_FILE + '.lan';
      const lanProc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
        env: {
          ...process.env,
          PORT: String(lanPort),
          DB_FILE: DB_FILE + '.lan',
          HOST: '0.0.0.0',
          ADMIN_TOKEN,
          ADMIN_LOCAL_ONLY: '1',
          ADMIN_TOKEN_FILE: lanTokenFile,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const lanCleanup = async () => {
        await killAndWait(lanProc);
        for (const f of [DB_FILE + '.lan', DB_FILE + '.lan-wal', DB_FILE + '.lan-shm', lanTokenFile]) {
          try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
        }
      };
      try {
        if (!await waitReady(lanBase)) {
          note('非回环地址无法连通，跳过');
        } else {
          const remote = await fetch(lanBase + '/api/admin/overview', { headers: { 'x-admin-token': ADMIN_TOKEN } });
          check('远程来源即使令牌正确也返回 404', remote.status, 404);
          const remotePage = await fetch(lanBase + '/admin');
          check('远程来源看不到管理页面', remotePage.status, 404);
          const local = await fetch('http://127.0.0.1:' + lanPort + '/api/admin/whoami', { headers: { 'x-admin-token': ADMIN_TOKEN } });
          check('同一实例的本机访问仍放行', local.status, 200);
        }
      } finally {
        await lanCleanup();
      }
    }

    /* ===================== 5. 管理端整体关闭 ===================== */
    section('管理端：未启用时不暴露存在性');
    const offPort = PORT + 2;
    const offBase = `http://127.0.0.1:${offPort}`;
    const offProc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      env: {
        ...process.env,
        PORT: String(offPort),
        DB_FILE: DB_FILE + '.off',
        HOST: '127.0.0.1',
        ADMIN_DISABLED: '1',
        // 即便夹具环境里存在 ADMIN_TOKEN，ADMIN_DISABLED 也必须优先
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const offCleanup = async () => {
      await killAndWait(offProc);
      for (const f of [DB_FILE + '.off', DB_FILE + '.off-wal', DB_FILE + '.off-shm']) {
        try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
      }
    };
    try {
      if (!await waitReady(offBase)) {
        note('关闭态实例未能启动，跳过');
      } else {
        const offAdmin = await fetch(offBase + '/api/admin/overview', { headers: { 'x-admin-token': ADMIN_TOKEN } });
        check('管理端关闭后接口返回 404', offAdmin.status, 404);
        check('关闭态与未知路径响应体一致', offAdmin.status, (await fetch(offBase + '/api/nope')).status);
        check('管理页面也不可访问', (await fetch(offBase + '/admin')).status, 404);
        check('普通同步接口不受影响', (await fetch(offBase + '/api/health')).status, 200);
      }
    } finally {
      await offCleanup();
    }

    /* ===================== 6. 客户端安装包发布 ===================== */
    section('客户端发布：权限');

    const exe190 = Buffer.from('MyApiTools 1.9.0 安装包（假数据）'.repeat(2000), 'utf8');
    const exe1100 = Buffer.from('MyApiTools 1.10.0 安装包（内容与 1.9.0 不同）'.repeat(2500), 'utf8');
    const exeMac = Buffer.from('MyApiTools mac arm64 包'.repeat(1000), 'utf8');

    check('未登录查询最新版本 → 401', (await api('GET', '/api/releases/latest?platform=win&arch=x64')).status, 401);
    check('未登录返回 AUTH_REQUIRED', (await api('GET', '/api/releases/latest')).data.code, 'AUTH_REQUIRED');
    check('无管理令牌不能发布', (await uploadRelease({
      version: '1.9.0', platform: 'win', arch: 'x64', body: exe190, admin: false,
    })).status, 401);
    check('错误管理令牌不能发布', (await uploadRelease({
      version: '1.9.0', platform: 'win', arch: 'x64', body: exe190, admin: 'not-the-token',
    })).status, 401);

    section('客户端发布：元信息校验');
    check('非法版本号被拒', (await uploadRelease({
      version: 'v1.9', platform: 'win', arch: 'x64', body: exe190,
    })).data.code, 'BAD_VERSION');
    check('非法平台被拒', (await uploadRelease({
      version: '1.9.0', platform: 'android', arch: 'x64', body: exe190,
    })).data.code, 'BAD_PLATFORM');
    check('非法架构被拒', (await uploadRelease({
      version: '1.9.0', platform: 'win', arch: 'sparc', body: exe190,
    })).data.code, 'BAD_ARCH');
    check('非法渠道名被拒', (await uploadRelease({
      version: '1.9.0', platform: 'win', arch: 'x64', channel: 'Bad Channel!', body: exe190,
    })).data.code, 'BAD_CHANNEL');
    check('空文件被拒', (await uploadRelease({
      version: '1.9.0', platform: 'win', arch: 'x64', body: Buffer.alloc(0),
    })).data.code, 'EMPTY_BODY');

    section('客户端发布：发布与查询');
    const up190 = await uploadRelease({
      version: '1.9.0', platform: 'win', arch: 'x64', notes: '修复若干问题',
      name: 'MyApiTools-Setup-1.9.0-x64.exe', body: exe190,
    });
    check('上传安装包返回 201', up190.status, 201);
    check('返回记录带版本号', up190.data.release.version, '1.9.0');
    check('返回记录带 sha256', /^[0-9a-f]{64}$/.test(up190.data.release.sha256), true);
    check('返回记录字节数正确', up190.data.release.size, exe190.length);
    check('返回记录保留原始文件名', up190.data.release.fileName, 'MyApiTools-Setup-1.9.0-x64.exe');

    // 1.9.0 与 1.10.0 是关键用例：版本号当文本排会把 '1.10.0' 排到 '1.9.0' 前面（字符串比较），
    // 所以服务端必须逐条用 compareVersion 比，这条断言就是钉住这个行为的
    const up1100 = await uploadRelease({
      version: '1.10.0', platform: 'win', arch: 'x64', notes: '新增客户端更新检查',
      name: 'MyApiTools-Setup-1.10.0-x64.exe', body: exe1100,
    });
    check('第二个版本上传成功', up1100.status, 201);

    const latestSame = await api('GET', '/api/releases/latest?platform=win&arch=x64&current=1.10.0', undefined, token);
    check('latest 取到 1.10.0 而非文本更大的 1.9.0', latestSame.data.latest.version, '1.10.0');
    check('版本相同时 upToDate=true', latestSame.data.upToDate, true);
    check('版本相同时 updateAvailable=false', latestSame.data.updateAvailable, false);
    check('latest 带下载地址', latestSame.data.latest.downloadUrl, `/api/releases/download/${up1100.data.release.id}`);
    check('latest 带更新说明', latestSame.data.latest.notes, '新增客户端更新检查');

    const latestOld = await api('GET', '/api/releases/latest?platform=win&arch=x64&current=0.9.0', undefined, token);
    check('客户端更旧时提示可更新', latestOld.data.updateAvailable, true);
    check('客户端更旧时 upToDate=false', latestOld.data.upToDate, false);
    check('客户端版本被原样回显', latestOld.data.current, '0.9.0');

    check('客户端更新时不误报更新', (await api(
      'GET', '/api/releases/latest?platform=win&arch=x64&current=2.0.0', undefined, token
    )).data.updateAvailable, false);

    // 预发布版必须小于同号正式版：1.10.0-beta.1 < 1.10.0
    await uploadRelease({ version: '1.10.0-beta.1', platform: 'linux', arch: 'x64', body: Buffer.from('beta'), name: 'MyApiTools-1.10.0-beta.1.AppImage' });
    await uploadRelease({ version: '1.10.0', platform: 'linux', arch: 'x64', body: Buffer.from('stable'), name: 'MyApiTools-1.10.0.AppImage' });
    check('同号正式版压过预发布版', (await api(
      'GET', '/api/releases/latest?platform=linux&arch=x64', undefined, token
    )).data.latest.version, '1.10.0');

    await uploadRelease({ version: '9.9.9', platform: 'mac', arch: 'arm64', body: exeMac, name: 'MyApiTools-9.9.9-arm64.dmg' });
    check('查 win 不受 mac 版本影响', (await api(
      'GET', '/api/releases/latest?platform=win&arch=x64', undefined, token
    )).data.latest.version, '1.10.0');
    check('查 mac 拿到 mac 自己的版本', (await api(
      'GET', '/api/releases/latest?platform=mac&arch=arm64', undefined, token
    )).data.latest.version, '9.9.9');
    check('不带平台时返回全局最新', (await api(
      'GET', '/api/releases/latest', undefined, token
    )).data.latest.version, '9.9.9');
    check('查询非法平台被拒', (await api(
      'GET', '/api/releases/latest?platform=plan9', undefined, token
    )).data.code, 'BAD_PLATFORM');
    check('未发布过的渠道返回空且不报错', (await api(
      'GET', '/api/releases/latest?channel=nightly', undefined, token
    )).data.latest, null);

    // ---- 开发快照版（版本号带 -dev）----
    // 规则：x.y.z 是正式版（发布后不再变），x.y.z-dev 是开发快照版（内容随时可被覆盖重推）。
    // 对「查最新版」的含义：仍然按版本号大小比，但**同号**时正式版压过快照版 ——
    // 跑正式版的机器不该被一个同号的开发构建顶掉；快照版号本身更高时（2.0.0-dev > 1.10.0）
    // 它确实更新，照常提示。这正是 compareVersion 里「预发布段小于同号正式版」那条。
    await uploadRelease({
      version: '1.10.0-dev', platform: 'win', arch: 'x64', body: Buffer.from('snapshot 1.10.0-dev'),
      name: 'MyApiTools-Setup-1.10.0-dev-x64.exe',
    });
    check('同号快照版压不过正式版', (await api(
      'GET', '/api/releases/latest?platform=win&arch=x64', undefined, token
    )).data.latest.version, '1.10.0');
    check('正式版客户端不会被同号快照版顶掉', (await api(
      'GET', '/api/releases/latest?platform=win&arch=x64&current=1.10.0', undefined, token
    )).data.updateAvailable, false);
    check('跑快照版的客户端会被提示升到同号正式版', (await api(
      'GET', '/api/releases/latest?platform=win&arch=x64&current=1.10.0-dev', undefined, token
    )).data.updateAvailable, true);

    await uploadRelease({
      version: '2.0.0-dev', platform: 'win', arch: 'ia32', body: Buffer.from('snapshot 2.0.0-dev'),
      name: 'MyApiTools-Setup-2.0.0-dev-ia32.exe',
    });
    check('只发过快照版时 latest 就是该快照', (await api(
      'GET', '/api/releases/latest?platform=win&arch=ia32', undefined, token
    )).data.latest.version, '2.0.0-dev');
    check('版号更高的快照照常提示更新', (await api(
      'GET', '/api/releases/latest?platform=win&arch=ia32&current=1.10.0', undefined, token
    )).data.updateAvailable, true);

    // 主实例跑的是工作副本的 package.json 版本号，而打快照镜像时它会被改成 x.y.z-dev，
    // 所以这里断言「标注与版本号形态一致」，而不是假定工作副本一定是正式版。
    const mainHealth = (await api('GET', '/api/health')).data;
    check('主实例 health.snapshot 与版本号形态一致',
      mainHealth.snapshot, /-dev(\.|$)/.test(mainHealth.version));

    section('客户端发布：下载');
    const relId = up1100.data.release.id;
    check('未登录下载被拒', (await api('GET', `/api/releases/download/${relId}`)).status, 401);

    const dl = await fetch(`${BASE}/api/releases/download/${relId}`, {
      headers: { authorization: 'Bearer ' + token },
    });
    check('登录后可下载', dl.status, 200);
    const dlBuf = Buffer.from(await dl.arrayBuffer());
    check('下载字节与上传完全一致', dlBuf.equals(exe1100), true);
    check('下载响应带版本号', dl.headers.get('x-release-version'), '1.10.0');
    check('下载响应 sha256 与记录一致', dl.headers.get('x-release-sha256'), up1100.data.release.sha256);
    check('下载响应声明为附件', /^attachment;/.test(dl.headers.get('content-disposition') || ''), true);
    check('download 计数已累加', (await api('GET', `/api/admin/releases`, undefined, undefined, { admin: true }))
      .data.releases.find((r) => r.id === relId).downloads, 1);
    check('下载不存在的安装包 → 404', (await api('GET', '/api/releases/download/99999', undefined, token)).status, 404);
    check('下载接口不支持写方法', (await api('POST', `/api/releases/download/${relId}`, {}, token)).status, 405);

    section('客户端发布：重复发布按覆盖处理');
    const countBeforeOverwrite = (await api('GET', '/api/admin/releases', undefined, undefined, { admin: true })).data.total;
    const exe1100b = Buffer.from('重新打包、重新签名的 1.10.0（体积故意不同）'.repeat(4000), 'utf8');
    const over = await uploadRelease({
      version: '1.10.0', platform: 'win', arch: 'x64', notes: '重新签名',
      name: 'MyApiTools-Setup-1.10.0-x64.exe', body: exe1100b,
    });
    check('重复发布返回 200 而非 201', over.status, 200);
    check('重复发布标记 replaced', over.data.replaced, true);
    check('重复发布复用同一条记录', over.data.release.id, relId);
    check('发布总数不变', (await api('GET', '/api/admin/releases', undefined, undefined, { admin: true })).data.total, countBeforeOverwrite);
    check('覆盖后字节数已更新', over.data.release.size, exe1100b.length);
    check('覆盖后 sha256 已更新', over.data.release.sha256 !== up1100.data.release.sha256, true);
    check('覆盖后更新说明已替换', over.data.release.notes, '重新签名');

    const dlAfterOverwrite = Buffer.from(await (await fetch(`${BASE}/api/releases/download/${relId}`, {
      headers: { authorization: 'Bearer ' + token },
    })).arrayBuffer());
    check('覆盖后下载到的是新内容', dlAfterOverwrite.equals(exe1100b), true);

    section('客户端发布：文件名安全');
    const cnName = 'MyApiTools 安装程序 2.0.0.exe';
    const cn = await uploadRelease({
      version: '2.0.0', platform: 'win', arch: 'x64', name: cnName, body: Buffer.from('中文名安装包'),
    });
    check('中文文件名被接受', cn.status, 201);
    check('中文文件名原样保留', cn.data.release.fileName, cnName);
    check('中文名也能正常下载', (await fetch(`${BASE}/api/releases/download/${cn.data.release.id}`, {
      headers: { authorization: 'Bearer ' + token },
    })).status, 200);

    const evil = await uploadRelease({
      version: '3.0.0', platform: 'win', arch: 'x64',
      name: '../../../../evil.exe', body: Buffer.from('x'),
    });
    check('路径穿越文件名被清洗成 basename', evil.data.release.fileName, 'evil.exe');
    check('文件落在发布目录内的预期位置',
      fs.existsSync(path.join(RELEASES_DIR, 'stable', '3.0.0', 'evil.exe')), true);

    // 直接 curl 调接口的人会按常理传明文文件名。这里曾经把明文当 base64url 解，
    // 结果是「发布成功、返回 201、文件名一串乱码」而且不报任何错 —— 因为
    // Buffer.from(v,'base64url') 对非法字符是静默忽略的。下面两条守住这个回归。
    const plainQs = new URLSearchParams({ version: '4.0.0', platform: 'win', arch: 'x64' });
    plainQs.set('name', 'MyApiTools-Setup-4.0.0-x64.exe');
    const plainRes = await fetch(`${BASE}/api/admin/releases?${plainQs}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'x-admin-token': ADMIN_TOKEN },
      body: Buffer.from('plain-name'),
    });
    const plainData = await plainRes.json();
    check('明文文件名被原样保留', plainData.release.fileName, 'MyApiTools-Setup-4.0.0-x64.exe');
    check('明文名没有退化成兜底名',
      plainData.release.fileName === 'MyApiTools-4.0.0-win-x64.exe', false);
    check('明文名对应的文件真的落盘',
      fs.existsSync(path.join(RELEASES_DIR, 'stable', '4.0.0', 'MyApiTools-Setup-4.0.0-x64.exe')), true);

    // 反过来：合法的 base64url 仍然必须按编码解析（管理页走的就是这条路）
    const b64Qs = new URLSearchParams({ version: '4.0.1', platform: 'win', arch: 'x64' });
    b64Qs.set('name', Buffer.from('我的工具-Setup-4.0.1.exe', 'utf8').toString('base64url'));
    const b64Res = await fetch(`${BASE}/api/admin/releases?${b64Qs}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'x-admin-token': ADMIN_TOKEN },
      body: Buffer.from('b64-name'),
    });
    check('base64url 文件名仍按编码解析', (await b64Res.json()).release.fileName, '我的工具-Setup-4.0.1.exe');

    section('客户端发布：删除');
    const delRel = await api('DELETE', `/api/admin/releases/${evil.data.release.id}`, undefined, undefined, { admin: true });
    check('删除发布成功', delRel.status, 200);
    check('删除后文件从磁盘移除',
      fs.existsSync(path.join(RELEASES_DIR, 'stable', '3.0.0', 'evil.exe')), false);
    check('删除后记录从列表消失',
      (await api('GET', '/api/admin/releases', undefined, undefined, { admin: true }))
        .data.releases.some((r) => r.id === evil.data.release.id), false);
    check('删除后下载返回 404', (await api(
      'GET', `/api/releases/download/${evil.data.release.id}`, undefined, token
    )).status, 404);
    check('重复删除返回 404', (await api(
      'DELETE', `/api/admin/releases/${evil.data.release.id}`, undefined, undefined, { admin: true }
    )).status, 404);
    check('删除不存在的发布返回 404', (await api(
      'DELETE', '/api/admin/releases/99999', undefined, undefined, { admin: true }
    )).status, 404);

    // 记录还在、文件被外部删掉（换机器、误删目录）时给 410，
    // 而不是含糊的 404 —— 提示是「文件丢了，去管理端重新发布」
    fs.rmSync(path.join(RELEASES_DIR, 'stable', '2.0.0', cnName), { force: true });
    const gone = await api('GET', `/api/releases/download/${cn.data.release.id}`, undefined, token);
    check('文件被外部删除后下载返回 410', gone.status, 410);
    check('文件丢失返回 GONE', gone.data.code, 'GONE');

    const relList = await api('GET', '/api/admin/releases', undefined, undefined, { admin: true });
    check('列表返回发布目录', relList.data.releasesDir, RELEASES_DIR);
    check('列表返回总占用字节', relList.data.totalBytes > 0, true);
    check('列表返回渠道集合', relList.data.channels.includes('stable'), true);
    check('列表按 id 倒序', relList.data.releases[0].id > relList.data.releases[1].id, true);

    const relAudit = await api('GET', '/api/admin/audit?limit=300', undefined, undefined, { admin: true });
    const relActions = relAudit.data.items.map((a) => a.action);
    check('审计记录发布动作', relActions.includes('release.publish'), true);
    check('审计记录覆盖动作', relActions.includes('release.overwrite'), true);
    check('审计记录删除动作', relActions.includes('release.delete'), true);
    check('发布审计不含管理令牌', JSON.stringify(relAudit.data).includes(ADMIN_TOKEN), false);

    /* ===================== 7. 上传体积上限 ===================== */
    section('客户端发布：上传体积上限');
    {
      const capPort = PORT + 4;
      const capBase = `http://127.0.0.1:${capPort}`;
      const capReleases = RELEASES_DIR + '.cap';
      const capProc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
        env: {
          ...process.env,
          PORT: String(capPort),
          DB_FILE: DB_FILE + '.cap',
          HOST: '127.0.0.1',
          ADMIN_TOKEN,
          ADMIN_LOCAL_ONLY: '1',
          RELEASES_DIR: capReleases,
          RELEASE_MAX_MB: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const capCleanup = async () => {
        await killAndWait(capProc);
        for (const f of [DB_FILE + '.cap', DB_FILE + '.cap-wal', DB_FILE + '.cap-shm']) {
          try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
        }
        try { fs.rmSync(capReleases, { recursive: true, force: true }); } catch { /* ignore */ }
      };
      try {
        if (!await waitReady(capBase)) {
          note('体积上限实例未能启动，跳过');
        } else {
          const qs = new URLSearchParams({ version: '1.0.0', platform: 'win', arch: 'x64' });
          const big = await fetch(`${capBase}/api/admin/releases?${qs}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/octet-stream', 'x-admin-token': ADMIN_TOKEN },
            body: Buffer.alloc(2 * 1024 * 1024, 7),
          });
          check('超过上限的安装包被拒', big.status, 413);
          check('超限返回 TOO_LARGE', (await big.json()).code, 'TOO_LARGE');
          check('超限不会留下半截文件',
            fs.existsSync(path.join(capReleases, 'stable', '1.0.0')), false);

          // 同一个实例里，合法大小仍然要能正常发布
          const ok = await fetch(`${capBase}/api/admin/releases?${qs}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/octet-stream', 'x-admin-token': ADMIN_TOKEN },
            body: Buffer.alloc(64 * 1024, 1),
          });
          check('上限之内正常发布', ok.status, 201);
        }
      } finally {
        await capCleanup();
      }
    }

    /* ===================== 7.5 快照版实例（版本号带 -dev） ===================== */
    section('开发快照版实例（版本号带 -dev）');
    {
      // 版本号形态只影响「怎么被解读」，不改变任何服务行为。这里把 server/ 的文件拷到
      // 临时目录、只把 package.json 的版本号改成 -dev 形态，起一个独立实例，验证两处
      // 对外可见的标注：/api/health 的 snapshot 字段、启动横幅的提醒。
      const devDir = path.join(os.tmpdir(), `myapitools-e2e-dev-${Date.now()}`);
      fs.mkdirSync(devDir, { recursive: true });
      for (const f of ['server.js', 'admin.html']) {
        fs.copyFileSync(path.join(__dirname, f), path.join(devDir, f));
      }
      const devPkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
      devPkg.version = '1.2.0-dev';
      fs.writeFileSync(path.join(devDir, 'package.json'), JSON.stringify(devPkg, null, 2) + '\n');

      const devPort = PORT + 6;
      const devBase = `http://127.0.0.1:${devPort}`;
      const devProc = spawn(process.execPath, [path.join(devDir, 'server.js')], {
        env: {
          ...process.env,
          PORT: String(devPort),
          DB_FILE: path.join(devDir, 'sync.db'),
          HOST: '127.0.0.1',
          ADMIN_DISABLED: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let banner = '';
      devProc.stdout.on('data', (d) => { banner += d.toString(); });
      try {
        if (!await waitReady(devBase)) {
          note('快照版实例未能启动，跳过');
        } else {
          const health = await (await fetch(devBase + '/api/health')).json();
          check('快照版实例自报版本号', health.version, '1.2.0-dev');
          check('快照版实例 health.snapshot', health.snapshot, true);

          // 横幅是运维第一眼看到的东西，必须挑明性质
          await new Promise((r) => setTimeout(r, 200));
          check('启动横幅标注开发快照版', /开发快照版/.test(banner), true);
          check('横幅提示内容可能被覆盖更新', /可能随时被覆盖/.test(banner), true);
          check('横幅给出转正式版的做法', /去掉 -dev 后缀/.test(banner), true);
        }
      } finally {
        await killAndWait(devProc);
        try { fs.rmSync(devDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }

    /* ===================== 8. 老库迁移 ===================== */
    section('老库迁移（缺列的历史数据库）');
    const legacyFile = path.join(os.tmpdir(), `myapitools-legacy-${Date.now()}.db`);
    const legacyPort = PORT + 3;
    const legacyBase = `http://127.0.0.1:${legacyPort}`;
    {
      // 造一个没有 role/status/last_login_at/note/updated_at 的旧版 users 表
      const legacy = new DatabaseSync(legacyFile);
      legacy.exec(`
        CREATE TABLE users (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          email         TEXT    NOT NULL UNIQUE,
          password_hash TEXT    NOT NULL,
          salt          TEXT    NOT NULL,
          created_at    INTEGER NOT NULL
        );
        CREATE TABLE tokens (
          token      TEXT    PRIMARY KEY,
          user_id    INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          device     TEXT
        );
        CREATE TABLE rev_counter (id INTEGER PRIMARY KEY CHECK (id = 1), rev INTEGER NOT NULL);
        INSERT INTO rev_counter (id, rev) VALUES (1, 0);
        CREATE TABLE entities (
          user_id    INTEGER NOT NULL,
          kind       TEXT    NOT NULL,
          id         TEXT    NOT NULL,
          data       TEXT,
          deleted    INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          rev        INTEGER NOT NULL,
          PRIMARY KEY (user_id, kind, id)
        );
      `);
      legacy.close();
    }
    const legacyProc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      env: {
        ...process.env,
        PORT: String(legacyPort),
        DB_FILE: legacyFile,
        HOST: '127.0.0.1',
        ADMIN_TOKEN,
        ADMIN_LOCAL_ONLY: '1',
        ADMIN_TOKEN_FILE: legacyFile + '.admin',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let legacyErr = '';
    legacyProc.stderr.on('data', (d) => { legacyErr += d.toString(); });
    const legacyCleanup = async () => {
      await killAndWait(legacyProc);
      for (const f of [legacyFile, legacyFile + '-wal', legacyFile + '-shm', legacyFile + '.admin']) {
        try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
      }
    };
    try {
      if (!await waitReady(legacyBase)) {
        check('老库能启动（未崩在缺列上）', 'failed: ' + legacyErr.slice(-160), 'ok');
      } else {
        check('老库能正常启动', true, true);
        const legacyReg = await fetch(legacyBase + '/api/auth/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'legacy@example.com', password: 'pwd12345' }),
        });
        check('老库可注册新账号（缺列已补齐）', legacyReg.status, 200);
        const legacyAdmin = await fetch(legacyBase + '/api/admin/users', { headers: { 'x-admin-token': ADMIN_TOKEN } });
        const legacyAdminJson = await legacyAdmin.json();
        check('老库管理端可列出账号', legacyAdmin.status, 200);
        check('老库账号状态默认启用', legacyAdminJson.users[0].status, 'active');
        check('老库账号角色默认为普通', legacyAdminJson.users[0].role, 'user');
      }
    } finally {
      await legacyCleanup();
    }

    console.log('\n---------------------------------------------');
    console.log(`  通过 ${pass} 项，失败 ${fail} 项${skipped ? `，跳过 ${skipped} 项` : ''}`);
    console.log('---------------------------------------------\n');
    await cleanup();
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('验证过程异常：', e);
    await cleanup();
    process.exit(1);
  }
})();
