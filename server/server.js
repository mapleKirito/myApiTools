#!/usr/bin/env node
'use strict';

/**
 * MyApiTools 配置同步服务
 * ---------------------------------------------------------------
 * 职责边界（重要）：
 *   ✅ 保存用户账号、保存并分发「请求配置」实体（集合 / 请求 / 环境 / 全局变量）
 *   ❌ 不代理、不转发、不代发任何目标业务接口请求，也不存储任何接口地址之外的调用结果
 *
 * 技术上零外部依赖：数据库用 Node 22 内置的 node:sqlite，
 * HTTP 服务用内置 http 模块，直接 `node server.js` 就能跑。
 *
 * 环境变量：
 *   PORT            监听端口，默认 8787
 *   HOST            监听地址，默认 0.0.0.0
 *   DB_FILE         数据库文件，默认 ./data/sync.db
 *   TOKEN_TTL_DAYS  用户令牌有效期天数，默认 30
 *
 * 客户端安装包发布相关：
 *   RELEASES_DIR     安装包目录，默认 <数据库目录>/releases
 *   RELEASE_MAX_MB   单个安装包上限（MB），默认 500
 *   RELEASE_CHANNEL  默认发布渠道，默认 stable
 *
 * 管理端（/admin 与 /api/admin/*）相关：见文件后半部分「管理端安全策略」注释。
 *   ADMIN_TOKEN       管理令牌；显式设置时优先使用
 *   ADMIN_TOKEN_FILE  管理令牌落盘位置，默认 <数据库目录>/admin-token.txt（权限 0600）
 *   ADMIN_DISABLED    设为 1 则彻底关闭管理端（路由返回 404，不暴露存在性）
 *   ADMIN_LOCAL_ONLY  默认 1，仅允许回环地址访问管理端；设 0 才允许远程
 *   ADMIN_ALLOW       额外允许的访问来源，逗号分隔 IP 或前缀（如 172.17.0.1），仅
 *                     ADMIN_LOCAL_ONLY=0 时需要
 */

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const DB_FILE = path.resolve(process.env.DB_FILE || path.join(__dirname, 'data', 'sync.db'));
const TOKEN_TTL_DAYS = Number(process.env.TOKEN_TTL_DAYS || 30);
const IS_INIT_ONLY = process.argv.includes('--init-only');

/**
 * 服务端版本号：唯一来源是 server/package.json 的 version。
 *
 * 不要再在这里硬编码一个字符串 —— 之前那个字面量跟 package.json 各写各的，
 * 结果 /api/health 和管理页上显示的版本跟仓库里那个对不上，谁也说不清哪个是真的。
 * 现在改版本只需要改 package.json 一处（`npm version minor` 也能直接 bump）。
 *
 * 注意这与**客户端**版本是两回事：客户端版本在仓库根目录的 package.json，
 * 由 electron-builder 打安装包时写入，也是客户端上报给服务端的 `current`。
 */
const VERSION = require('./package.json').version;

/**
 * 版本号规则：三段之上只认两种形态 ——
 *   x.y.z       正式版，发布出去内容就不再变化；
 *   x.y.z-dev   开发快照版（带序号写作 x.y.z-dev.N），内容随时可能被覆盖重推。
 *
 * 这里只用来在启动横幅、/api/health、管理页上「说清楚跑的是哪一种」，
 * 不做任何行为分支 —— 服务端行为不因版本形态而变。镜像的 tag 覆盖策略
 * 由 server/build-push.sh（.ps1）按同一规则执行。
 */
const IS_SNAPSHOT = /-dev(\.|$)/.test(String(VERSION));

const STARTED_AT = Date.now();

/* 客户端安装包仓库：与数据库同目录，跟着 volume 一起持久化 */
const RELEASES_DIR = path.resolve(
  process.env.RELEASES_DIR || path.join(path.dirname(DB_FILE), 'releases')
);
/* 单个安装包上限。Electron 安装包通常 70~120MB，默认给到 500MB */
const RELEASE_MAX_MB = Number(process.env.RELEASE_MAX_MB || 500);
const RELEASE_MAX_BYTES = RELEASE_MAX_MB * 1024 * 1024;
/* 默认发布渠道，客户端按渠道取不同的版本线（stable / beta ...） */
const DEFAULT_CHANNEL = String(process.env.RELEASE_CHANNEL || 'stable').trim() || 'stable';

/* ------------------------------------------------------------------ *
 * 数据库
 * ------------------------------------------------------------------ */
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
fs.mkdirSync(RELEASES_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    salt          TEXT    NOT NULL,
    created_at    INTEGER NOT NULL,
    -- 下面几列由 migrate() 兼容补齐，老库升级后自动填充默认值
    role          TEXT    NOT NULL DEFAULT 'user',    -- user | admin（角色仅作标记，管理端鉴权用的是管理令牌）
    status        TEXT    NOT NULL DEFAULT 'active',  -- active | disabled（disabled 后所有令牌立即失效）
    last_login_at INTEGER,
    note          TEXT,
    updated_at    INTEGER
  );

  CREATE TABLE IF NOT EXISTS tokens (
    token      TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    device     TEXT
  );

  /* 管理端写操作审计。管理令牌本身不落库，这里只记录"用令牌做了什么" */
  CREATE TABLE IF NOT EXISTS admin_audit (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    at             INTEGER NOT NULL,
    action         TEXT    NOT NULL,
    target_user_id INTEGER,
    target_email   TEXT,
    detail         TEXT,
    ip             TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_audit_at ON admin_audit (at DESC);

  /* 全局单调递增的同步水位：每条变更占一个 rev */
  CREATE TABLE IF NOT EXISTS rev_counter (
    id   INTEGER PRIMARY KEY CHECK (id = 1),
    rev  INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO rev_counter (id, rev) VALUES (1, 0);

  CREATE TABLE IF NOT EXISTS entities (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT    NOT NULL,      -- collection | request | environment | globals
    id         TEXT    NOT NULL,
    data       TEXT,                  -- JSON 文本；软删时为 NULL
    deleted    INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,      -- 客户端时间戳，用于后写覆盖判定
    rev        INTEGER NOT NULL,      -- 服务端水位
    PRIMARY KEY (user_id, kind, id)
  );
  CREATE INDEX IF NOT EXISTS idx_entities_rev ON entities (user_id, rev);

  /*
   * 客户端安装包发布记录。文件本体落在 RELEASES_DIR，库里只存元信息。
   * 唯一键是「渠道 + 版本 + 平台 + 架构」：同一格子重复发布视为覆盖，
   * 这样客户端查「某平台最新版」时不会拿到两条同版本记录。
   */
  CREATE TABLE IF NOT EXISTS releases (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    channel      TEXT    NOT NULL DEFAULT 'stable',
    version      TEXT    NOT NULL,          -- 客户端版本号，x.y.z
    platform     TEXT    NOT NULL,          -- win | mac | linux
    arch         TEXT    NOT NULL,          -- x64 | arm64 | ...
    file_name    TEXT    NOT NULL,          -- 展示用的原始文件名
    file_path    TEXT    NOT NULL,          -- 相对 RELEASES_DIR 的路径
    size         INTEGER NOT NULL,
    sha256       TEXT    NOT NULL,
    notes        TEXT,                      -- 更新说明，纯文本
    downloads    INTEGER NOT NULL DEFAULT 0,
    published_at INTEGER NOT NULL,
    published_ip TEXT,
    UNIQUE (channel, version, platform, arch)
  );
  CREATE INDEX IF NOT EXISTS idx_releases_channel ON releases (channel, platform, arch);
`);

/**
 * 老库兼容：CREATE TABLE IF NOT EXISTS 不会给已存在的表补列，
 * 所以升级后必须显式检查并按需 ALTER，否则旧数据的库会直接报 "no such column"。
 */
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  return true;
}
const migratedCols = [
  ensureColumn('users', 'role', "role TEXT NOT NULL DEFAULT 'user'"),
  ensureColumn('users', 'status', "status TEXT NOT NULL DEFAULT 'active'"),
  ensureColumn('users', 'last_login_at', 'last_login_at INTEGER'),
  ensureColumn('users', 'note', 'note TEXT'),
  ensureColumn('users', 'updated_at', 'updated_at INTEGER'),
].filter(Boolean).length;
if (migratedCols) console.log(`[migrate] users 表补齐 ${migratedCols} 个新列`);

// 水位自愈：数据库被外部工具重建 / 迁移后，保证 rev 不低于已有数据的最大值
db.exec('UPDATE rev_counter SET rev = MAX(rev, COALESCE((SELECT MAX(rev) FROM entities), 0)) WHERE id = 1;');

const stmt = {
  insertUser: db.prepare('INSERT INTO users (email, password_hash, salt, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'),
  findUser: db.prepare('SELECT * FROM users WHERE email = ?'),
  findUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
  touchLogin: db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?'),
  setPassword: db.prepare('UPDATE users SET password_hash = ?, salt = ?, updated_at = ? WHERE id = ?'),
  setStatus: db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?'),
  setNote: db.prepare('UPDATE users SET note = ?, updated_at = ? WHERE id = ?'),
  setRole: db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?'),
  deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
  deleteUserEntities: db.prepare('DELETE FROM entities WHERE user_id = ?'),
  countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
  countActiveUsers: db.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'active'"),
  listUsers: db.prepare(`
    SELECT
      u.id, u.email, u.role, u.status, u.created_at, u.last_login_at, u.note, u.updated_at,
      (SELECT COUNT(*) FROM entities e WHERE e.user_id = u.id AND e.deleted = 0) AS entities,
      (SELECT COUNT(*) FROM entities e WHERE e.user_id = u.id AND e.deleted = 1) AS deleted_entities,
      (SELECT COUNT(*) FROM tokens t WHERE t.user_id = u.id AND t.expires_at > ?)       AS active_tokens,
      (SELECT MAX(t.created_at) FROM tokens t WHERE t.user_id = u.id)                   AS last_token_at,
      (SELECT MAX(e.updated_at) FROM entities e WHERE e.user_id = u.id AND e.deleted = 0) AS last_data_at
    FROM users u
    WHERE (? = '' OR u.email LIKE '%' || ? || '%')
      AND (? = '' OR u.status = ?)
    ORDER BY u.id ASC
    LIMIT ? OFFSET ?
  `),
  countActiveTokens: db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE user_id = ? AND expires_at > ?'),
  purgeUserTokens: db.prepare('DELETE FROM tokens WHERE user_id = ?'),
  serverTotals: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users)                              AS users,
      (SELECT COUNT(*) FROM users WHERE status = 'active')       AS active_users,
      (SELECT COUNT(*) FROM entities WHERE deleted = 0)          AS entities,
      (SELECT COUNT(*) FROM entities WHERE deleted = 1)          AS deleted_entities,
      (SELECT COUNT(*) FROM tokens WHERE expires_at > ?)         AS tokens
  `),
  insertAudit: db.prepare('INSERT INTO admin_audit (at, action, target_user_id, target_email, detail, ip) VALUES (?, ?, ?, ?, ?, ?)'),
  listAudit: db.prepare('SELECT * FROM admin_audit ORDER BY id DESC LIMIT ?'),

  /* ---- 客户端安装包发布 ---- */
  insertRelease: db.prepare(`
    INSERT INTO releases (channel, version, platform, arch, file_name, file_path, size, sha256, notes, downloads, published_at, published_ip)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `),
  overwriteRelease: db.prepare(`
    UPDATE releases SET file_name = ?, file_path = ?, size = ?, sha256 = ?, notes = ?, published_at = ?, published_ip = ?
    WHERE id = ?
  `),
  findReleaseById: db.prepare('SELECT * FROM releases WHERE id = ?'),
  findReleaseByKey: db.prepare('SELECT * FROM releases WHERE channel = ? AND version = ? AND platform = ? AND arch = ?'),
  deleteRelease: db.prepare('DELETE FROM releases WHERE id = ?'),
  bumpDownloads: db.prepare('UPDATE releases SET downloads = downloads + 1 WHERE id = ?'),
  listReleases: db.prepare('SELECT * FROM releases ORDER BY id DESC LIMIT ? OFFSET ?'),
  listReleasesByChannel: db.prepare('SELECT * FROM releases WHERE channel = ?'),
  listChannels: db.prepare('SELECT DISTINCT channel FROM releases ORDER BY channel ASC'),
  countReleases: db.prepare('SELECT COUNT(*) AS n FROM releases'),
  totalReleaseBytes: db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM releases'),

  insertToken: db.prepare('INSERT INTO tokens (token, user_id, created_at, expires_at, device) VALUES (?, ?, ?, ?, ?)'),
  findToken: db.prepare('SELECT * FROM tokens WHERE token = ?'),
  deleteToken: db.prepare('DELETE FROM tokens WHERE token = ?'),
  purgeTokens: db.prepare('DELETE FROM tokens WHERE expires_at < ?'),

  getRev: db.prepare('SELECT rev FROM rev_counter WHERE id = 1'),
  bumpRev: db.prepare('UPDATE rev_counter SET rev = rev + 1 WHERE id = 1'),

  findEntity: db.prepare('SELECT * FROM entities WHERE user_id = ? AND kind = ? AND id = ?'),
  upsertEntity: db.prepare(`
    INSERT INTO entities (user_id, kind, id, data, deleted, updated_at, rev)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, kind, id) DO UPDATE SET
      data = excluded.data, deleted = excluded.deleted, updated_at = excluded.updated_at, rev = excluded.rev
  `),
  pullSince: db.prepare('SELECT kind, id, data, deleted, updated_at, rev FROM entities WHERE user_id = ? AND rev > ? ORDER BY rev ASC LIMIT ?'),
  countEntities: db.prepare('SELECT COUNT(*) AS n FROM entities WHERE user_id = ? AND deleted = 0'),
  maxRevForUser: db.prepare('SELECT COALESCE(MAX(rev), 0) AS rev FROM entities WHERE user_id = ?'),
};

function nextRev() {
  stmt.bumpRev.run();
  return stmt.getRev.get().rev;
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization, x-admin-token',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
};

function send(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': body.length });
  res.end(body);
}

function fail(res, status, message, code) {
  send(res, status, code ? { ok: false, message, code } : { ok: false, message });
}

function readJSON(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(Object.assign(new Error('请求体不是合法 JSON: ' + e.message), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/* --------------------------- 版本号与文件名 --------------------------- */

/**
 * 解析 x.y.z（可带 -beta.1 之类的预发布后缀）。
 * 不追求完整 semver 规范（不处理 build metadata），发布自用客户端够用。
 */
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' };
}

/**
 * a 比 b 新返回 >0，相同返回 0，更旧返回 <0。
 * 任一侧不是合法版本号时返回 0（「无法比较」按相等处理，宁可不提示更新也不误报）。
 */
function compareVersion(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] - y[k];
  }
  // 预发布版永远小于同号正式版：1.2.0-beta < 1.2.0
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * 落盘文件名清洗：只取 basename，剔掉路径分隔符、控制字符与引号。
 * 客户端给的 X-File-Name 属于不可信输入，绝不能直接拼进文件路径。
 */
function sanitizeFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/["'`<>|:*?]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned.slice(0, 120);
}

/**
 * 文件名传递：管理页把文件名 base64url 编码后放进 query。
 *
 * 但 Buffer.from(v, 'base64url') 对任何输入都不抛错 —— 非法字符被静默忽略，
 * 明文文件名会被解成一堆乱码字节。于是「直接调接口时按常理传明文名」得到的
 * 结果是：发布成功、返回 200、文件名却是一串乱码，一个错都不报。而兜底名也
 * 轮不到（乱码是非空的）。所以这里改成往返校验：
 *
 *   1. 只含 base64url 字符集（含 . 空格 - 之外的符号即判定为明文，直接返回）；
 *   2. 解出来再编码必须与原文逐字相同；
 *   3. 解出来必须是可打印文本（无控制字符）。
 *
 * 三条都满足才认为是编码形式，否则原样当作文件名。这样既不影响管理页，
 * 也让 name 直接传明文的老实人拿到正确结果。
 */
function decodeFileNameHeader(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (!/^[A-Za-z0-9_-]+$/.test(v)) return v;   // 含 . / 空格 等 → 一定是明文
  try {
    const buf = Buffer.from(v, 'base64url');
    if (buf.toString('base64url') !== v) return v;              // 不是规范的 base64url
    const text = buf.toString('utf8');
    if (!text || /[\u0000-\u001f\u007f]/.test(text)) return v;  // 解出来不是可打印文本
    return text;
  } catch {
    return v;
  }
}

/** Content-Disposition 里的 ASCII 兜底名 */
function asciiFileName(name) {
  return String(name || 'download.bin').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/** 归一化客户端地址：IPv4-mapped IPv6（::ffff:127.0.0.1）统一还原成 IPv4 */
function clientIp(req) {
  let ip = (req.socket && req.socket.remoteAddress) || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip || 'unknown';
}

/** 是否来自本机回环 */
function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || /^127\./.test(ip);
}

/**
 * 解析并校验 Authorization: Bearer xxx。
 * @returns {{ok:true,userId:number,token:string,device:string,email:string}
 *          |{ok:false,reason:'missing'|'invalid'|'expired'|'disabled'}}
 */
function authenticate(req) {
  const auth = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return { ok: false, reason: 'missing' };
  const token = m[1].trim();
  const row = stmt.findToken.get(token);
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.expires_at < Date.now()) {
    stmt.deleteToken.run(token);
    return { ok: false, reason: 'expired' };
  }
  const user = stmt.findUserById.get(row.user_id);
  if (!user) {
    stmt.deleteToken.run(token);
    return { ok: false, reason: 'invalid' };
  }
  if (user.status !== 'active') {
    // 账号被管理员禁用/删除后，令牌必须立即失效，不能等到自然过期
    stmt.deleteToken.run(token);
    return { ok: false, reason: 'disabled' };
  }
  return { ok: true, userId: row.user_id, token, device: row.device || '', email: user.email };
}

/** 401 的可读文案 + 机器可读 code，客户端据此决定是否弹登录框 */
const AUTH_FAIL = {
  missing: { status: 401, code: 'AUTH_REQUIRED', message: '未登录或令牌已失效，请重新登录' },
  invalid: { status: 401, code: 'AUTH_INVALID', message: '登录凭证无效，请重新登录' },
  expired: { status: 401, code: 'AUTH_EXPIRED', message: '登录已过期，请重新登录' },
  disabled: { status: 403, code: 'ACCOUNT_DISABLED', message: '该账号已被管理员禁用' },
};

function failAuth(res, reason) {
  const spec = AUTH_FAIL[reason] || AUTH_FAIL.invalid;
  send(res, spec.status, { ok: false, message: spec.message, code: spec.code });
}

/** 简单滑动窗口限流，防止登录接口被暴力破解 */
const rateBuckets = new Map();
function rateLimit(key, max = 20, windowMs = 60_000) {
  const now = Date.now();
  const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  return bucket.count <= max;
}

/** 只读检查是否已达上限，不自增（用于"只在失败时计数"的场景） */
function rateLimited(key, max) {
  const bucket = rateBuckets.get(key);
  if (!bucket) return false;
  if (Date.now() > bucket.resetAt) return false;
  return bucket.count >= max;
}

/* ------------------------------------------------------------------ *
 * 管理端安全策略
 * ------------------------------------------------------------------ *
 * 目标：管理端只有服务主人自己能用。这里用「四道锁」，任意一道不过都拿不到数据：
 *
 *   1. 不暴露存在性 —— 管理端未启用时，/admin 与 /api/admin/* 一律返回 404，
 *      外观与其它未知路径完全一致，扫描者无法判断这台机器有没有管理端。
 *   2. 强令牌 —— 32 字节随机管理令牌，经 X-Admin-Token 头传递，
 *      用 crypto.timingSafeEqual 恒定时间比较（先比长度），杜绝时序侧信道。
 *   3. 来源限制 —— ADMIN_LOCAL_ONLY 默认开启，仅回环地址可访问。远程访问必须
 *      同时显式 ADMIN_LOCAL_ONLY=0 且把来源 IP 写进 ADMIN_ALLOW 白名单。
 *   4. 独立限流 —— 管理端单独计数（120 次/分钟/IP）。令牌是 32 字节随机值，
 *      暴力猜解本就不现实；限流真正的用途是防扫描、防审计表被灌爆，被拒绝的
 *      请求还会按 动作+IP 每分钟只记一条。
 *
 * 另外：管理令牌只存在于进程内存、环境变量或权限 0600 的文件中，绝不写进数据库。
 * 因此数据库泄露 ≠ 管理端泄露；反过来删库也不影响管理端登录。
 * ------------------------------------------------------------------ */
const ADMIN_DISABLED = process.env.ADMIN_DISABLED === '1';
const ADMIN_LOCAL_ONLY = process.env.ADMIN_LOCAL_ONLY !== '0';
const ADMIN_ALLOW = String(process.env.ADMIN_ALLOW || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const ADMIN_TOKEN_FILE = path.resolve(
  process.env.ADMIN_TOKEN_FILE || path.join(path.dirname(DB_FILE), 'admin-token.txt')
);

const adminToken = (() => {
  if (ADMIN_DISABLED) return '';
  const fromEnv = String(process.env.ADMIN_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  try {
    if (fs.existsSync(ADMIN_TOKEN_FILE)) {
      const saved = fs.readFileSync(ADMIN_TOKEN_FILE, 'utf8').trim();
      if (saved) return saved;
    }
    const generated = crypto.randomBytes(32).toString('base64url');
    fs.mkdirSync(path.dirname(ADMIN_TOKEN_FILE), { recursive: true });
    fs.writeFileSync(ADMIN_TOKEN_FILE, generated + '\n', { mode: 0o600 });
    // writeFileSync 的 mode 只在新建文件时生效；文件已存在（比如上一次留下的是
    // 0644）不会被收紧，所以这里显式再 chmod 一次。Windows 上 mode 不生效，
    // 只能靠目录 ACL，属于平台限制。
    try { fs.chmodSync(ADMIN_TOKEN_FILE, 0o600); } catch { /* Windows / 无权限，忽略 */ }
    return generated;
  } catch (e) {
    console.error('[admin] 管理令牌初始化失败，管理端已关闭：', e.message);
    return '';
  }
})();

const ADMIN_ENABLED = !ADMIN_DISABLED && !!adminToken;
const ADMIN_TOKEN_FROM_ENV = !!String(process.env.ADMIN_TOKEN || '').trim();

/** 来源是否被允许访问管理端 */
function adminSourceAllowed(req) {
  const ip = clientIp(req);
  if (isLoopback(ip)) return true;
  if (ADMIN_LOCAL_ONLY) return false;
  return ADMIN_ALLOW.some((rule) =>
    rule.endsWith('*') ? ip.startsWith(rule.slice(0, -1)) : ip === rule
  );
}

/** 恒定时间比对管理令牌 */
function adminTokenMatches(req) {
  const given = String(req.headers['x-admin-token'] || '').trim();
  if (!given || !adminToken) return false;
  return safeEqual(given, adminToken);
}

/** 管理操作审计（失败不影响主流程，但会打到 stderr） */
function audit(req, action, { userId = null, email = null, detail = null } = {}) {
  try {
    stmt.insertAudit.run(
      Date.now(),
      action,
      userId,
      email,
      detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail),
      clientIp(req)
    );
  } catch (e) {
    console.error('[admin] 审计写入失败：', e.message);
  }
}

/**
 * 被拒绝的请求做去重审计：按 动作+IP 每 windowMs 只落一条。
 * 否则远程扫描能让审计表被刷爆（这是限流之外的第二层保护）。
 */
const auditDenyMarks = new Map();
function auditDenied(req, action, detail) {
  const key = `${action}|${clientIp(req)}`;
  const now = Date.now();
  if ((auditDenyMarks.get(key) || 0) > now - 60_000) return;
  auditDenyMarks.set(key, now);
  audit(req, action, { detail });
  if (auditDenyMarks.size > 5000) {
    for (const [k, t] of auditDenyMarks) if (t < now - 300_000) auditDenyMarks.delete(k);
  }
}

/* ------------------------------------------------------------------ *
 * 业务处理
 * ------------------------------------------------------------------ */
/** 注册/改密共用的输入校验，返回错误文案或 null */
function validateCredentials(email, password, minLen = 6) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '邮箱格式不正确';
  if (String(password).length < minLen) return `密码至少 ${minLen} 位`;
  if (String(password).length > 200) return '密码过长（上限 200 字符）';
  return null;
}

/** 统一的账号创建入口：普通注册与管理端代建都走这里 */
function createUser({ email, password, role = 'user', note = null }) {
  const salt = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  const info = stmt.insertUser.run(email, hashPassword(password, salt), salt, now, now);
  const id = Number(info.lastInsertRowid);
  if (note) stmt.setNote.run(String(note).slice(0, 200), now, id);
  if (role === 'admin') stmt.setRole.run('admin', now, id);
  return stmt.findUserById.get(id);
}

async function handleRegister(req, res) {
  if (!rateLimit('register:' + clientIp(req), 10, 60_000)) {
    return fail(res, 429, '注册过于频繁，请稍后再试', 'RATE_LIMITED');
  }

  const body = await readJSON(req, 64 * 1024);
  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  const invalid = validateCredentials(email, password);
  if (invalid) return fail(res, 400, invalid);
  if (stmt.findUser.get(email)) return fail(res, 409, '该邮箱已注册', 'EMAIL_TAKEN');

  const user = createUser({ email, password, role: 'user' });
  const token = issueToken(user.id, body.device);
  stmt.touchLogin.run(Date.now(), Date.now(), user.id);
  send(res, 200, { ok: true, token, user: { id: user.id, email, role: user.role } });
}

async function handleLogin(req, res) {
  const ip = clientIp(req);
  if (!rateLimit('login:' + ip, 120, 60_000)) {
    return fail(res, 429, '尝试过于频繁，请稍后再试', 'RATE_LIMITED');
  }

  const body = await readJSON(req, 64 * 1024);
  const email = normalizeEmail(body.email);
  const password = String(body.password || '');

  /*
   * 账号维度只统计"失败"次数，且只在失败时自增。
   * 如果连成功登录也计数，攻击者只要拿别人的邮箱狂发登录请求，
   * 就能把受害者锁在门外（用限流做拒绝服务）。只算失败就堵掉了这条路，
   * 对密码爆破的防护力度不变。
   */
  const failKey = 'login-fail:' + email;
  if (rateLimited(failKey, 20)) {
    return fail(res, 429, '该账号失败次数过多，请稍后再试', 'RATE_LIMITED');
  }

  const user = stmt.findUser.get(email);
  if (!user || !safeEqual(user.password_hash, hashPassword(password, user.salt))) {
    rateLimit(failKey, 20, 300_000);
    return fail(res, 401, '邮箱或密码不正确', 'BAD_CREDENTIALS');
  }
  if (user.status !== 'active') {
    return fail(res, 403, '该账号已被管理员禁用', 'ACCOUNT_DISABLED');
  }
  const now = Date.now();
  const token = issueToken(user.id, body.device);
  stmt.touchLogin.run(now, now, user.id);
  send(res, 200, { ok: true, token, user: { id: user.id, email: user.email, role: user.role } });
}

function issueToken(userId, device) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  stmt.insertToken.run(token, userId, now, now + TOKEN_TTL_DAYS * 86400_000, String(device || '').slice(0, 64));
  stmt.purgeTokens.run(now);
  return token;
}

function handleLogout(req, res, auth) {
  stmt.deleteToken.run(auth.token);
  send(res, 200, { ok: true });
}

/**
 * 推送本地变更
 * body: { entities: [{kind,id,updatedAt,deleted,data}], clientRev }
 *
 * 冲突策略：按 updatedAt 后写覆盖。
 * 若服务端版本的 updatedAt 更新（说明另一台设备刚改过），则拒绝本次写入并回报冲突，
 * 客户端拿到冲突后会用服务端版本覆盖本地，保证最终一致。
 */
async function handlePush(req, res, auth) {
  const body = await readJSON(req);
  const incoming = Array.isArray(body.entities) ? body.entities : [];
  if (incoming.length > 5000) return fail(res, 400, '单次推送实体数不能超过 5000');

  const applied = [];
  const conflicts = [];
  const userId = auth.userId;

  // 用一条事务包裹，保证 rev 分配与写入原子
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const ent of incoming) {
      const kind = String(ent.kind || '');
      const id = String(ent.id || '');
      if (!kind || !id) continue;
      const updatedAt = Number(ent.updatedAt) || Date.now();
      const deleted = ent.deleted ? 1 : 0;

      const existing = stmt.findEntity.get(userId, kind, id);
      if (existing && existing.updated_at > updatedAt) {
        // 服务端更新 —— 判定为冲突，连同服务端版本一起回传，
        // 客户端可直接覆盖本地，省掉一次额外的定向拉取
        conflicts.push({
          kind,
          id,
          serverUpdatedAt: existing.updated_at,
          serverRev: existing.rev,
          serverDeleted: !!existing.deleted,
          serverData: existing.data ? JSON.parse(existing.data) : null,
        });
        continue;
      }
      if (existing && existing.updated_at === updatedAt && existing.deleted === deleted) {
        continue; // 无变化，跳过，避免水位空涨
      }

      const rev = nextRev();
      const data = deleted ? null : JSON.stringify(ent.data ?? null);
      stmt.upsertEntity.run(userId, kind, id, data, deleted, updatedAt, rev);
      applied.push({ kind, id, rev });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  send(res, 200, {
    ok: true,
    applied: applied.length,
    appliedList: applied,
    conflicts,
    rev: stmt.getRev.get().rev,
    serverTime: Date.now(),
  });
}

/** 拉取大于 since 水位的变更 */
function handlePull(req, res, auth, query) {
  const since = Number(query.get('since') || 0) || 0;
  const limit = Math.min(Number(query.get('limit') || 2000) || 2000, 5000);
  const rows = stmt.pullSince.all(auth.userId, since, limit);
  const entities = rows.map((r) => ({
    kind: r.kind,
    id: r.id,
    deleted: !!r.deleted,
    updatedAt: r.updated_at,
    rev: r.rev,
    data: r.data ? JSON.parse(r.data) : null,
  }));
  const lastRev = entities.length ? entities[entities.length - 1].rev : since;
  send(res, 200, {
    ok: true,
    entities,
    rev: lastRev,
    globalRev: stmt.getRev.get().rev,
    hasMore: entities.length === limit,
    serverTime: Date.now(),
  });
}

function handleStats(res, auth) {
  const count = stmt.countEntities.get(auth.userId).n;
  const rev = stmt.maxRevForUser.get(auth.userId).rev;
  send(res, 200, { ok: true, entities: count, rev, email: auth.email });
}

/* ------------------------------------------------------------------ *
 * 管理端业务
 * ------------------------------------------------------------------ */
/** users 查询行 → 对外 JSON（绝不外泄 password_hash / salt） */
function userRowToJson(r) {
  return {
    id: r.id,
    email: r.email,
    role: r.role || 'user',
    status: r.status || 'active',
    createdAt: r.created_at || 0,
    updatedAt: r.updated_at || r.created_at || 0,
    lastLoginAt: r.last_login_at || 0,
    lastTokenAt: r.last_token_at || 0,
    lastDataAt: r.last_data_at || 0,
    note: r.note || '',
    entities: r.entities || 0,
    deletedEntities: r.deleted_entities || 0,
    activeTokens: r.active_tokens || 0,
  };
}

/** 取单个用户的完整信息（含统计），用于写操作后回显 */
function userJsonById(id) {
  const r = db.prepare(`SELECT
      u.id, u.email, u.role, u.status, u.created_at, u.last_login_at, u.note, u.updated_at,
      (SELECT COUNT(*) FROM entities e WHERE e.user_id = u.id AND e.deleted = 0) AS entities,
      (SELECT COUNT(*) FROM entities e WHERE e.user_id = u.id AND e.deleted = 1) AS deleted_entities,
      (SELECT COUNT(*) FROM tokens t WHERE t.user_id = u.id AND t.expires_at > ?) AS active_tokens,
      (SELECT MAX(t.created_at) FROM tokens t WHERE t.user_id = u.id) AS last_token_at,
      (SELECT MAX(e.updated_at) FROM entities e WHERE e.user_id = u.id AND e.deleted = 0) AS last_data_at
    FROM users u WHERE u.id = ?`).get(Date.now(), id);
  return r ? userRowToJson(r) : null;
}

function adminOverview(req, res) {
  const now = Date.now();
  const totals = stmt.serverTotals.get(now);
  let dbSize = 0;
  for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
    try {
      if (fs.existsSync(f)) dbSize += fs.statSync(f).size;
    } catch { /* ignore */ }
  }
  send(res, 200, {
    ok: true,
    version: VERSION,
    snapshot: IS_SNAPSHOT,
    uptimeSec: Math.floor((now - STARTED_AT) / 1000),
    serverTime: now,
    dbFile: DB_FILE,
    dbSizeBytes: dbSize,
    rev: stmt.getRev.get().rev,
    tokenTtlDays: TOKEN_TTL_DAYS,
    totals: {
      users: totals.users,
      activeUsers: totals.active_users,
      entities: totals.entities,
      deletedEntities: totals.deleted_entities,
      activeTokens: totals.tokens,
    },
    admin: {
      localOnly: ADMIN_LOCAL_ONLY,
      allow: ADMIN_ALLOW,
      tokenFromEnv: ADMIN_TOKEN_FROM_ENV,
      tokenFile: ADMIN_TOKEN_FROM_ENV ? null : ADMIN_TOKEN_FILE,
    },
    source: clientIp(req),
  });
}

function adminListUsers(req, res, query) {
  const q = String(query.get('q') || '').trim();
  const rawStatus = String(query.get('status') || '').trim();
  const status = rawStatus === 'active' || rawStatus === 'disabled' ? rawStatus : '';
  const limit = Math.min(Math.max(Number(query.get('limit') || 50) || 50, 1), 500);
  const offset = Math.max(Number(query.get('offset') || 0) || 0, 0);
  const rows = stmt.listUsers.all(Date.now(), q, q, status, status, limit, offset);
  send(res, 200, {
    ok: true,
    total: stmt.countUsers.get().n,
    limit,
    offset,
    users: rows.map(userRowToJson),
  });
}

async function adminCreateUser(req, res) {
  const body = await readJSON(req, 64 * 1024);
  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  const invalid = validateCredentials(email, password);
  if (invalid) return fail(res, 400, invalid);
  if (stmt.findUser.get(email)) return fail(res, 409, '该邮箱已注册', 'EMAIL_TAKEN');

  const user = createUser({
    email,
    password,
    role: body.role === 'admin' ? 'admin' : 'user',
    note: body.note,
  });
  audit(req, 'user.create', { userId: user.id, email, detail: { role: user.role } });
  send(res, 200, { ok: true, user: userJsonById(user.id) });
}

async function adminUpdateUser(req, res, id) {
  const user = stmt.findUserById.get(id);
  if (!user) return fail(res, 404, '用户不存在');

  const body = await readJSON(req, 64 * 1024);
  const changes = [];

  if (body.password !== undefined) {
    const pwd = String(body.password || '');
    if (pwd.length < 6) return fail(res, 400, '密码至少 6 位');
    const salt = crypto.randomBytes(16).toString('hex');
    stmt.setPassword.run(hashPassword(pwd, salt), salt, Date.now(), id);
    // 改密即强制下线：否则旧令牌还能继续用，改密等于没改
    const revoked = stmt.purgeUserTokens.run(id).changes;
    changes.push('password-reset', `revoked-tokens=${revoked}`);
  }

  if (body.status !== undefined) {
    const status = body.status === 'disabled' ? 'disabled' : 'active';
    if (status !== user.status) {
      stmt.setStatus.run(status, Date.now(), id);
      changes.push(`status=${status}`);
      if (status === 'disabled') {
        const revoked = stmt.purgeUserTokens.run(id).changes;
        changes.push(`revoked-tokens=${revoked}`);
      }
    }
  }

  if (body.role !== undefined) {
    const role = body.role === 'admin' ? 'admin' : 'user';
    if (role !== user.role) {
      stmt.setRole.run(role, Date.now(), id);
      changes.push(`role=${role}`);
    }
  }

  if (body.note !== undefined) {
    stmt.setNote.run(String(body.note || '').slice(0, 200), Date.now(), id);
    changes.push('note');
  }

  if (!changes.length) return send(res, 200, { ok: true, changed: false, user: userJsonById(id) });

  audit(req, 'user.update', { userId: id, email: user.email, detail: changes });
  send(res, 200, { ok: true, changed: true, changes, user: userJsonById(id) });
}

function adminDeleteUser(req, res, id) {
  const user = stmt.findUserById.get(id);
  if (!user) return fail(res, 404, '用户不存在');

  let removed = 0;
  let revoked = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    removed = stmt.deleteUserEntities.run(id).changes;
    revoked = stmt.purgeUserTokens.run(id).changes;
    stmt.deleteUser.run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  audit(req, 'user.delete', {
    userId: id,
    email: user.email,
    detail: { removedEntities: removed, revokedTokens: revoked },
  });
  send(res, 200, {
    ok: true,
    deleted: { id, email: user.email, entities: removed, tokens: revoked },
  });
}

function adminRevokeTokens(req, res, id) {
  const user = stmt.findUserById.get(id);
  if (!user) return fail(res, 404, '用户不存在');
  const revoked = stmt.purgeUserTokens.run(id).changes;
  audit(req, 'user.revoke-tokens', { userId: id, email: user.email, detail: { revoked } });
  send(res, 200, { ok: true, revoked });
}

function adminListAudit(req, res, query) {
  const limit = Math.min(Math.max(Number(query.get('limit') || 100) || 100, 1), 500);
  send(res, 200, {
    ok: true,
    items: stmt.listAudit.all(limit).map((r) => ({
      id: r.id,
      at: r.at,
      action: r.action,
      targetUserId: r.target_user_id,
      targetEmail: r.target_email,
      detail: r.detail,
      ip: r.ip,
    })),
  });
}

/* ------------------------------------------------------------------ *
 * 客户端安装包发布
 *
 * 权限划分：
 *   - 查询最新版本 / 下载  → 需要「同步账号令牌」（未登录不给用）
 *   - 上传 / 列表 / 删除   → 走管理端那套独立鉴权（管理令牌 + 来源限制）
 * 安装包本体不落库，只存元信息 + sha256，文件放在 RELEASES_DIR。
 * ------------------------------------------------------------------ */
const RELEASE_PLATFORMS = new Set(['win', 'mac', 'linux']);
const RELEASE_ARCHES = new Set(['x64', 'arm64', 'ia32', 'armv7l']);

function releaseRowToJson(row) {
  return {
    id: row.id,
    channel: row.channel,
    version: row.version,
    platform: row.platform,
    arch: row.arch,
    fileName: row.file_name,
    size: row.size,
    sha256: row.sha256,
    notes: row.notes || '',
    downloads: row.downloads,
    publishedAt: row.published_at,
  };
}

/**
 * 取某渠道 + 平台 + 架构下的最新版本。
 * 不能靠 SQL 排序 —— 版本号是文本，'1.10.0' < '1.9.0'，必须逐条用 compareVersion 比。
 * 发布量级只有几十条，全量过一遍完全无压力。
 */
function pickLatestRelease(channel, platform, arch) {
  let best = null;
  for (const row of stmt.listReleasesByChannel.all(channel)) {
    if (platform && row.platform !== platform) continue;
    if (arch && row.arch !== arch) continue;
    if (!best || compareVersion(row.version, best.version) > 0) best = row;
  }
  return best;
}

/** GET /api/releases/latest?platform=win&arch=x64&channel=stable&current=1.0.0 */
function handleReleaseLatest(req, res, query) {
  const platform = String(query.get('platform') || '').trim().toLowerCase();
  const arch = String(query.get('arch') || '').trim().toLowerCase();
  const channel = String(query.get('channel') || DEFAULT_CHANNEL).trim() || DEFAULT_CHANNEL;
  const current = String(query.get('current') || '').trim();

  if (platform && !RELEASE_PLATFORMS.has(platform)) {
    return fail(res, 400, '不支持的平台：' + platform, 'BAD_PLATFORM');
  }
  if (arch && !RELEASE_ARCHES.has(arch)) {
    return fail(res, 400, '不支持的架构：' + arch, 'BAD_ARCH');
  }

  const best = pickLatestRelease(channel, platform, arch);
  if (!best) {
    // 服务端还没发布过任何版本，对客户端来说就是「已是最新」，不是错误
    return send(res, 200, {
      ok: true,
      channel,
      current: current || null,
      latest: null,
      upToDate: true,
      updateAvailable: false,
      checkedAt: Date.now(),
    });
  }

  // 客户端没报当前版本时，只如实返回「最新是哪个」，不做新旧判断
  const upToDate = current ? compareVersion(best.version, current) <= 0 : null;
  return send(res, 200, {
    ok: true,
    channel,
    current: current || null,
    latest: { ...releaseRowToJson(best), downloadUrl: `/api/releases/download/${best.id}` },
    upToDate,
    updateAvailable: upToDate === false,
    channelCount: stmt.listReleasesByChannel.all(channel).length,
    checkedAt: Date.now(),
  });
}

/** GET /api/releases/download/:id —— 流式返回安装包 */
function handleReleaseDownload(req, res, id) {
  const row = stmt.findReleaseById.get(id);
  if (!row) return fail(res, 404, '安装包不存在', 'NOT_FOUND');

  const full = path.resolve(RELEASES_DIR, row.file_path);
  // 双保险：即使库被外部改脏，也不允许把 RELEASES_DIR 之外的文件读出去
  if (full !== RELEASES_DIR && !full.startsWith(RELEASES_DIR + path.sep)) {
    return fail(res, 500, '安装包路径非法', 'BAD_PATH');
  }

  let st;
  try {
    st = fs.statSync(full);
  } catch {
    return fail(res, 410, '安装包文件已丢失，请在管理端重新发布', 'GONE');
  }

  stmt.bumpDownloads.run(row.id);
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': st.size,
    // filename 用 ASCII 兜底、filename* 用 RFC 5987，中文文件名两边都不乱码
    'content-disposition':
      `attachment; filename="${asciiFileName(row.file_name)}"; ` +
      `filename*=UTF-8''${encodeURIComponent(row.file_name)}`,
    'x-release-version': row.version,
    'x-release-platform': row.platform,
    'x-release-arch': row.arch,
    'x-release-sha256': row.sha256,
    'cache-control': 'no-store',
  });
  const stream = fs.createReadStream(full);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/**
 * PUT /api/admin/releases?version=&platform=&arch=&channel=&notes=[&name=]
 * body 就是安装包的原始字节流。
 *
 * 没用 multipart/form-data，是因为零依赖下手写 boundary 切分容易出错，
 * 而「原始字节流 + query 带元信息」在自用场景下更直白，也能边收边算 sha256。
 */
async function adminUploadRelease(req, res, url) {
  const q = url.searchParams;
  const version = String(q.get('version') || '').trim();
  const channel = String(q.get('channel') || DEFAULT_CHANNEL).trim() || DEFAULT_CHANNEL;
  const platform = String(q.get('platform') || '').trim().toLowerCase();
  const arch = String(q.get('arch') || '').trim().toLowerCase();
  const notes = String(q.get('notes') || '').slice(0, 20000);

  if (!parseVersion(version)) {
    return fail(res, 400, '版本号必须形如 1.2.3（可带 -beta.1 之类的预发布后缀）', 'BAD_VERSION');
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(channel)) {
    return fail(res, 400, '渠道名只能是小写字母、数字和 . _ -', 'BAD_CHANNEL');
  }
  if (!RELEASE_PLATFORMS.has(platform)) {
    return fail(res, 400, '平台必须是 win / mac / linux 之一', 'BAD_PLATFORM');
  }
  if (!RELEASE_ARCHES.has(arch)) {
    return fail(res, 400, '架构不在允许列表内', 'BAD_ARCH');
  }

  // 文件名通过 query 以 base64url 传递：中文名塞进 URL 或 Header 都容易出事
  const declared = decodeFileNameHeader(q.get('name'));
  const safeName =
    sanitizeFileName(declared) || `MyApiTools-${version}-${platform}-${arch}${platform === 'win' ? '.exe' : ''}`;

  const relDir = path.join(channel, version);
  const relPath = path.join(relDir, safeName);
  const absDir = path.join(RELEASES_DIR, relDir);
  const absPath = path.join(RELEASES_DIR, relPath);

  // 先按 Content-Length 拦一道：正常上传都会带这个头，能不读 body 就拒掉
  const declaredLen = Number(req.headers['content-length'] || 0);
  if (declaredLen > RELEASE_MAX_BYTES) {
    return fail(res, 413, `安装包超过上限 ${RELEASE_MAX_MB} MB`, 'TOO_LARGE');
  }

  fs.mkdirSync(absDir, { recursive: true });

  const hash = crypto.createHash('sha256');
  const ws = fs.createWriteStream(absPath);
  let size = 0;
  let tooBig = false;
  let failure = null;

  try {
    await new Promise((resolve, reject) => {
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > RELEASE_MAX_BYTES) {
          // 超限后不再落盘，但要把剩余数据读完才回 413：
          // 直接 destroy 会把响应一起掐断，客户端只能看到「连接被重置」
          tooBig = true;
          return;
        }
        hash.update(chunk);
        // 磁盘慢时暂停请求流，避免整包堆在内存里
        if (!ws.write(chunk)) {
          req.pause();
          ws.once('drain', () => req.resume());
        }
      });
      req.on('end', resolve);
      req.on('error', reject);
      req.on('aborted', () => reject(Object.assign(new Error('上传中断'), { status: 499 })));
      ws.on('error', reject);
    });
  } catch (e) {
    failure = e;
  }

  // 无论成功与否都要等写流真正关闭：Windows 上句柄没释放就删不掉半截文件
  const closed = new Promise((resolve) => {
    if (ws.closed) return resolve();
    ws.once('close', resolve);
    setTimeout(resolve, 3000);
  });
  if (failure || tooBig) {
    try { ws.destroy(); } catch { /* ignore */ }
  } else {
    ws.end();
  }
  await closed;

  if (failure) {
    try { fs.rmSync(absPath, { force: true }); } catch { /* ignore */ }
    return fail(res, failure.status || 500, '上传失败：' + failure.message, 'UPLOAD_FAILED');
  }
  if (tooBig) {
    try { fs.rmSync(absPath, { force: true }); } catch { /* ignore */ }
    return fail(res, 413, `安装包超过上限 ${RELEASE_MAX_MB} MB`, 'TOO_LARGE');
  }
  if (!size) {
    try { fs.rmSync(absPath, { force: true }); } catch { /* ignore */ }
    return fail(res, 400, '上传内容为空', 'EMPTY_BODY');
  }

  const sha256 = hash.digest('hex');
  const now = Date.now();
  const ip = clientIp(req);
  const existing = stmt.findReleaseByKey.get(channel, version, platform, arch);

  let id;
  if (existing) {
    // 同格子重复发布按「覆盖」处理，顺手把旧文件删掉，免得磁盘无限增长
    if (existing.file_path !== relPath) {
      try { fs.rmSync(path.resolve(RELEASES_DIR, existing.file_path), { force: true }); } catch { /* ignore */ }
    }
    stmt.overwriteRelease.run(safeName, relPath, size, sha256, notes || existing.notes, now, ip, existing.id);
    id = existing.id;
  } else {
    const r = stmt.insertRelease.run(
      channel, version, platform, arch, safeName, relPath, size, sha256, notes || null, now, ip
    );
    id = Number(r.lastInsertRowid);
  }

  audit(req, existing ? 'release.overwrite' : 'release.publish', {
    detail: `${channel}/${version} ${platform}-${arch} ${safeName} (${size} 字节)`,
  });

  return send(res, existing ? 200 : 201, {
    ok: true,
    replaced: !!existing,
    release: releaseRowToJson(stmt.findReleaseById.get(id)),
  });
}

function adminListReleases(req, res, query) {
  const limit = Math.min(Math.max(Number(query.get('limit') || 100) || 100, 1), 500);
  const offset = Math.max(Number(query.get('offset') || 0) || 0, 0);
  send(res, 200, {
    ok: true,
    total: stmt.countReleases.get().n,
    totalBytes: stmt.totalReleaseBytes.get().n,
    maxMb: RELEASE_MAX_MB,
    defaultChannel: DEFAULT_CHANNEL,
    channels: stmt.listChannels.all().map((r) => r.channel),
    releasesDir: RELEASES_DIR,
    releases: stmt.listReleases.all(limit, offset).map(releaseRowToJson),
  });
}

function adminDeleteRelease(req, res, id) {
  const row = stmt.findReleaseById.get(id);
  if (!row) return fail(res, 404, '发布记录不存在', 'NOT_FOUND');

  stmt.deleteRelease.run(id);
  const abs = path.resolve(RELEASES_DIR, row.file_path);
  try { fs.rmSync(abs, { force: true }); } catch { /* ignore */ }
  // 顺手清掉空掉的版本目录，失败无所谓
  try { fs.rmdirSync(path.dirname(abs)); } catch { /* ignore */ }

  audit(req, 'release.delete', {
    detail: `${row.channel}/${row.version} ${row.platform}-${row.arch} ${row.file_name}`,
  });
  send(res, 200, { ok: true, deleted: releaseRowToJson(row) });
}

/* --------------------------- 管理端页面 --------------------------- */
let adminHtmlCache = null;
function serveAdminPage(res) {
  try {
    if (adminHtmlCache === null) {
      adminHtmlCache = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
    }
  } catch (e) {
    return fail(res, 500, '管理页面文件缺失：' + e.message);
  }
  const body = Buffer.from(adminHtmlCache, 'utf8');
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    // 管理页面自己带脚本，这里禁止被任何页面 iframe 嵌套，防点击劫持
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
  });
  res.end(body);
}

/**
 * 管理端路由统一入口。
 * 注意：所有"不通过"的分支都返回 404（除了已经通过来源校验后的令牌错误），
 * 目的是让扫描者无法区分"没有管理端"和"没通过校验"。
 */
async function handleAdminRoute(req, res, p, url) {
  // 锁 1：管理端未启用 → 与未知路径完全一致
  if (!ADMIN_ENABLED) return fail(res, 404, '未知接口', 'NOT_FOUND');

  // 锁 4：先限流（内存计数，不落库），避免扫描流量灌满审计表
  if (!rateLimit('admin:' + clientIp(req), 120, 60_000)) {
    return fail(res, 429, '尝试过于频繁，请稍后再试', 'RATE_LIMITED');
  }

  // 锁 3：来源限制（默认只允许本机回环）
  if (!adminSourceAllowed(req)) {
    auditDenied(req, 'admin.denied-source', p);
    return fail(res, 404, '未知接口', 'NOT_FOUND');
  }

  // 管理页面本体不含任何数据，先放行让用户输入令牌；数据接口一律校验令牌
  if (p === '/admin') {
    if (req.method !== 'GET') return fail(res, 405, '方法不支持');
    return serveAdminPage(res);
  }

  // 锁 2：管理令牌
  if (!adminTokenMatches(req)) {
    auditDenied(req, 'admin.bad-token', `${req.method} ${p}`);
    return fail(res, 401, '管理令牌不正确', 'ADMIN_TOKEN_INVALID');
  }

  if (p === '/api/admin/whoami') {
    if (req.method !== 'GET') return fail(res, 405, '方法不支持');
    return send(res, 200, {
      ok: true,
      version: VERSION,
      snapshot: IS_SNAPSHOT,
      serverTime: Date.now(),
      localOnly: ADMIN_LOCAL_ONLY,
      allow: ADMIN_ALLOW,
      source: clientIp(req),
    });
  }

  if (p === '/api/admin/overview') {
    if (req.method !== 'GET') return fail(res, 405, '方法不支持');
    return adminOverview(req, res);
  }

  if (p === '/api/admin/users') {
    if (req.method === 'GET') return adminListUsers(req, res, url.searchParams);
    if (req.method === 'POST') return await adminCreateUser(req, res);
    return fail(res, 405, '方法不支持');
  }

  if (p === '/api/admin/audit') {
    if (req.method !== 'GET') return fail(res, 405, '方法不支持');
    return adminListAudit(req, res, url.searchParams);
  }

  // 客户端安装包：上传走 PUT 原始字节流，元信息全在 query 里
  if (p === '/api/admin/releases') {
    if (req.method === 'GET') return adminListReleases(req, res, url.searchParams);
    if (req.method === 'PUT' || req.method === 'POST') return await adminUploadRelease(req, res, url);
    return fail(res, 405, '方法不支持');
  }

  let m = /^\/api\/admin\/users\/(\d+)$/.exec(p);
  if (m) {
    const id = Number(m[1]);
    if (req.method === 'PATCH') return await adminUpdateUser(req, res, id);
    if (req.method === 'DELETE') return adminDeleteUser(req, res, id);
    return fail(res, 405, '方法不支持');
  }

  m = /^\/api\/admin\/users\/(\d+)\/tokens\/revoke$/.exec(p);
  if (m) {
    if (req.method !== 'POST') return fail(res, 405, '方法不支持');
    return adminRevokeTokens(req, res, Number(m[1]));
  }

  m = /^\/api\/admin\/releases\/(\d+)$/.exec(p);
  if (m) {
    if (req.method !== 'DELETE') return fail(res, 405, '方法不支持');
    return adminDeleteRelease(req, res, Number(m[1]));
  }

  return fail(res, 404, '未知接口', 'NOT_FOUND');
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, JSON_HEADERS);
    return res.end();
  }

  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return fail(res, 400, '非法请求路径');
  }
  const p = url.pathname.replace(/\/+$/, '') || '/';

  try {
    if (p === '/' || p === '/api/health') {
      if (req.method !== 'GET') return fail(res, 405, '方法不支持');
      return send(res, 200, {
        ok: true,
        name: 'MyApiTools 配置同步服务',
        version: VERSION,
        snapshot: IS_SNAPSHOT,
        scope: '仅存储与同步请求配置，不参与任何接口调用',
        serverTime: Date.now(),
      });
    }

    if (p === '/api/auth/register' && req.method === 'POST') return await handleRegister(req, res);
    if (p === '/api/auth/login' && req.method === 'POST') return await handleLogin(req, res);

    // 管理端：独立的一套鉴权，与用户令牌完全分离
    if (p === '/admin' || p.startsWith('/api/admin/')) {
      return await handleAdminRoute(req, res, p, url);
    }

    if (
      p.startsWith('/api/sync') ||
      p.startsWith('/api/releases') ||
      p === '/api/auth/logout' ||
      p === '/api/auth/me'
    ) {
      const auth = authenticate(req);
      if (!auth.ok) return failAuth(res, auth.reason);

      if (p === '/api/auth/me' && req.method === 'GET') {
        const row = stmt.findToken.get(auth.token);
        const u = stmt.findUserById.get(auth.userId);
        return send(res, 200, {
          ok: true,
          user: { id: auth.userId, email: auth.email, role: u ? u.role : 'user', status: u ? u.status : 'active' },
          expiresAt: row ? row.expires_at : 0,
          serverTime: Date.now(),
        });
      }
      if (p === '/api/auth/logout' && req.method === 'POST') return handleLogout(req, res, auth);
      if (p === '/api/sync/push' && req.method === 'POST') return await handlePush(req, res, auth);
      if (p === '/api/sync/pull' && req.method === 'GET') return handlePull(req, res, auth, url.searchParams);
      if (p === '/api/sync/stats' && req.method === 'GET') return handleStats(res, auth);

      // 客户端更新检查与安装包下载：登录后才能用，避免版本号与安装包被随意拉取
      if (p === '/api/releases/latest' && req.method === 'GET') {
        return handleReleaseLatest(req, res, url.searchParams);
      }
      const dl = /^\/api\/releases\/download\/(\d+)$/.exec(p);
      if (dl) {
        if (req.method !== 'GET') return fail(res, 405, '方法不支持');
        return handleReleaseDownload(req, res, Number(dl[1]));
      }
    }

    return fail(res, 404, `未知接口 ${req.method} ${p}`, 'NOT_FOUND');
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error('[error]', e);
    return fail(res, status, e.message || '服务端异常');
  }
});

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */
if (IS_INIT_ONLY) {
  console.log(`[init] 数据库已就绪: ${DB_FILE}`);
  process.exit(0);
}

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? '0.0.0.0（本机可用 127.0.0.1）' : HOST;
  const pad = (k, v) => console.log(`  ${k.padEnd(10, ' ')}: ${v}`);
  console.log('');
  console.log('  MyApiTools 配置同步服务已启动');
  console.log('  ---------------------------------------------');
  pad('版本', IS_SNAPSHOT ? `${VERSION}（开发快照版）` : VERSION);
  pad('监听地址', `http://${shown}:${PORT}`);
  pad('数据文件', DB_FILE);
  pad('令牌有效期', `${TOKEN_TTL_DAYS} 天`);
  pad('功能范围', '仅存储 / 同步请求配置，不代理任何接口调用');
  pad('客户端发布', `${stmt.countReleases.get().n} 个安装包 · 默认渠道 ${DEFAULT_CHANNEL} · 单包上限 ${RELEASE_MAX_MB}MB`);
  pad('安装包目录', RELEASES_DIR);
  console.log('  ---------------------------------------------');
  if (!ADMIN_ENABLED) {
    pad('管理端', ADMIN_DISABLED ? '已按 ADMIN_DISABLED 关闭（路由返回 404）' : '不可用（令牌初始化失败）');
  } else {
    pad('管理端', `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/admin`);
    pad('访问范围', ADMIN_LOCAL_ONLY
      ? '仅本机回环地址（远程一律 404）'
      : ADMIN_ALLOW.length
        ? `已放开远程，白名单：${ADMIN_ALLOW.join(', ')}`
        : '已放开远程，但白名单为空 —— 除回环外一律 404');
    pad('管理令牌', ADMIN_TOKEN_FROM_ENV
      ? '来自环境变量 ADMIN_TOKEN'
      : `见文件 ${ADMIN_TOKEN_FILE}（${process.platform === 'win32' ? 'Windows 不强制 0600，请确认目录权限' : '权限 0600'}，请勿提交到版本库）`);
  }
  console.log('  ---------------------------------------------');

  // 快照版是「内容可能随时被覆盖」的构建，跑在正式环境上会很难解释
  // （同一个版本号，昨天和今天的行为不一样），所以启动时主动说清楚。
  if (IS_SNAPSHOT) {
    console.log(`  ! 当前跑的是开发快照版 ${VERSION}（-dev）—— 内容可能随时被覆盖更新，别当正式版用。`);
    console.log('    要发正式版：把 server/package.json 的版本号去掉 -dev 后缀，再用 build-push 推。');
    console.log('  ---------------------------------------------');
  }

  // 这是一个静默失效的坑：ADMIN_LOCAL_ONLY=0 只是「解除回环限制」，
  // 真正决定能不能进的是 ADMIN_ALLOW 白名单 —— 白名单为空时它是空集，
  // 除回环外所有来源都会被回 404。表现和「管理端没启用」一模一样，
  // 排查起来极其费劲（容器部署默认就会踩到），所以这里主动喊一声。
  if (ADMIN_ENABLED && !ADMIN_LOCAL_ONLY && ADMIN_ALLOW.length === 0) {
    console.log('  ! 管理端远程访问已放开但白名单为空，除回环地址外一律返回 404。');
    console.log('    要允许全部来源：ADMIN_ALLOW=*        要指定来源：ADMIN_ALLOW=172.*,10.0.0.5');
    console.log('    容器部署通常填 *（真正的边界是宿主端口只绑 127.0.0.1）。');
    console.log('  ---------------------------------------------');
  }

  console.log('');
});

function shutdown(sig) {
  console.log(`\n收到 ${sig}，正在关闭...`);
  server.close(() => {
    try { db.close(); } catch { /* ignore */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
