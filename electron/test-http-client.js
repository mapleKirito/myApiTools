'use strict';

/**
 * HTTP 执行引擎验证
 *   node electron/test-http-client.js
 *
 * 起一个本地测试服务器，覆盖方法 / 头部 / 各类请求体 / gzip / 重定向 /
 * 超时 / 错误收敛 / 二进制 / 特殊字符编码等路径。
 */

const http = require('node:http');
const zlib = require('node:zlib');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sendRequest } = require('./http-client');

let pass = 0;
let fail = 0;

function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

function eq(name, actual, expected) {
  ok(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}

/* ------------------------------------------------------------------ */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const p = url.pathname;

    if (p === '/echo') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          method: req.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          headers: req.headers,
          bodyLength: body.length,
          body: body.toString('utf8'),
        })
      );
      return;
    }

    if (p === '/gzip') {
      const payload = Buffer.from(JSON.stringify({ hello: '压缩过的响应', n: 42 }), 'utf8');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-encoding': 'gzip' });
      res.end(zlib.gzipSync(payload));
      return;
    }

    if (p === '/brotli') {
      const payload = Buffer.from('brotli 内容', 'utf8');
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-encoding': 'br' });
      res.end(zlib.brotliCompressSync(payload));
      return;
    }

    if (p === '/gbk') {
      // GBK 编码的 "中文"
      const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
      res.writeHead(200, { 'content-type': 'text/plain; charset=gbk' });
      res.end(gbk);
      return;
    }

    if (p === '/binary') {
      const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(buf);
      return;
    }

    if (p === '/redirect/302') {
      res.writeHead(302, { location: '/echo' });
      res.end();
      return;
    }
    if (p === '/redirect/303') {
      res.writeHead(303, { location: '/echo' });
      res.end();
      return;
    }
    if (p === '/redirect/307') {
      res.writeHead(307, { location: '/echo' });
      res.end();
      return;
    }
    if (p === '/redirect/loop') {
      res.writeHead(302, { location: '/redirect/loop' });
      res.end();
      return;
    }
    if (p === '/redirect/chain/1') {
      res.writeHead(301, { location: '/redirect/chain/2' });
      res.end();
      return;
    }
    if (p === '/redirect/chain/2') {
      res.writeHead(302, { location: '/redirect/chain/3' });
      res.end();
      return;
    }
    if (p === '/redirect/chain/3') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('链条末端');
      return;
    }

    if (p === '/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('慢响应');
      }, 2500);
      return;
    }

    if (p === '/status/404') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: '没找到' }));
      return;
    }
    if (p === '/status/500') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('服务器炸了');
      return;
    }

    if (p === '/headers') {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'x-custom': 'value-one',
        'set-cookie': ['a=1; Path=/; HttpOnly', 'b=2; Path=/'],
      });
      res.end('ok');
      return;
    }

    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('根路径');
  });
});

/* ------------------------------------------------------------------ */
(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  console.log(`\n测试服务已启动：${BASE}\n`);

  /* ---------- 基础 ---------- */
  console.log('【基础请求】');
  {
    const r = await sendRequest({ method: 'GET', url: `${BASE}/echo?a=1&b=中文` });
    eq('状态码 200', r.status, 200);
    ok('标记为成功', r.ok === true);
    const data = JSON.parse(r.bodyText);
    eq('查询参数 a', data.query.a, '1');
    eq('查询参数中文正确编码', data.query.b, '中文');
    eq('自动带上 User-Agent', !!data.headers['user-agent'], true);
    ok('记录到总耗时', typeof r.duration === 'number' && r.duration >= 0);
    ok('识别为文本响应', r.textual === true);
  }

  /* ---------- 各方法 ---------- */
  console.log('\n【请求方法】');
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    const r = await sendRequest({ method, url: `${BASE}/echo` });
    eq(`${method} 状态码`, r.status, 200);
    if (method !== 'HEAD') {
      eq(`${method} 服务端收到的方法`, JSON.parse(r.bodyText).method, method);
    }
  }

  /* ---------- Header ---------- */
  console.log('\n【自定义请求头】');
  {
    const r = await sendRequest({
      method: 'GET',
      url: `${BASE}/echo`,
      headers: [
        ['X-Env', 'test'],
        ['X-Chinese', '中文头'],
        ['Accept-Language', 'zh-CN'],
      ],
    });
    const d = JSON.parse(r.bodyText);
    eq('自定义头生效', d.headers['x-env'], 'test');
    // HTTP 头按规范是 Latin-1，我们按 curl 的做法发 UTF-8 原始字节，
    // 服务端按 UTF-8 解码即可还原（这里用 latin1 还原原始字节再按 utf8 解）
    eq('中文头按 UTF-8 字节正确发出', Buffer.from(d.headers['x-chinese'], 'latin1').toString('utf8'), '中文头');
    eq('默认 Accept 未被覆盖', d.headers['accept'], '*/*');
  }
  {
    const r = await sendRequest({ url: `${BASE}/echo`, headers: { Cookie: 'sid=abc; theme=dark' } });
    eq('Cookie 头透传', JSON.parse(r.bodyText).headers.cookie, 'sid=abc; theme=dark');
  }
  {
    // 大小写与重复头
    const r = await sendRequest({ url: `${BASE}/echo`, headers: [['X-Dup', 'one'], ['x-dup', 'two']] });
    const d = JSON.parse(r.bodyText);
    ok('重复头被保留（数组或逗号合并）', JSON.stringify(d.headers['x-dup']).includes('one'));
  }
  {
    // CRLF 注入防护
    const r = await sendRequest({ url: `${BASE}/echo`, headers: [['X-Bad', 'a\r\nX-Injected: yes']] });
    const d = JSON.parse(r.bodyText);
    eq('换行被剥离，未注入新头', d.headers['x-injected'], undefined);
    ok('原头保留（换行转空格）', d.headers['x-bad'].includes('X-Injected: yes'));
  }
  {
    // 非法头名应被收敛为错误对象而不是抛穿
    const r = await sendRequest({ url: `${BASE}/echo`, headers: [['Bad Header Name', 'x']] });
    eq('非法头名收敛为失败结果', r.ok, false);
    eq('非法头名给出错误码', r.error.code, 'INVALID_HEADER_NAME');
  }

  /* ---------- 请求体 ---------- */
  console.log('\n【请求体】');
  {
    const r = await sendRequest({ method: 'POST', url: `${BASE}/echo`, body: { mode: 'json', content: '{"名字":"张三","n":1}' } });
    const d = JSON.parse(r.bodyText);
    eq('JSON 自动 Content-Type', d.headers['content-type'], 'application/json');
    eq('中文 JSON 未乱码', JSON.parse(d.body)['名字'], '张三');
  }
  {
    const r = await sendRequest({
      method: 'POST',
      url: `${BASE}/echo`,
      body: { mode: 'form-urlencoded', fields: [{ key: 'a', value: '1' }, { key: 'b', value: '中文 空格' }, { key: 'skip', value: 'x', enabled: false }] },
    });
    const d = JSON.parse(r.bodyText);
    eq('form-urlencoded Content-Type', d.headers['content-type'], 'application/x-www-form-urlencoded');
    eq('表单编码正确', d.body, 'a=1&b=%E4%B8%AD%E6%96%87+%E7%A9%BA%E6%A0%BC');
  }
  {
    const r = await sendRequest({
      method: 'POST',
      url: `${BASE}/echo`,
      body: {
        mode: 'form-data',
        fields: [
          { key: 'field1', value: '值一', type: 'text' },
          { key: 'field2', value: '带"引号"和\n换行', type: 'text' },
        ],
      },
    });
    const d = JSON.parse(r.bodyText);
    ok('multipart Content-Type 带 boundary', /^multipart\/form-data; boundary=/.test(d.headers['content-type']));
    ok('multipart 含字段名', d.body.includes('name="field1"'));
    ok('multipart 含中文值', d.body.includes('值一'));
    ok('multipart 正确闭合', d.body.trimEnd().endsWith('--'));
  }
  {
    const tmp = path.join(os.tmpdir(), `myapitools-upload-${Date.now()}.txt`);
    fs.writeFileSync(tmp, '文件内容 file-content-中文', 'utf8');
    const r = await sendRequest({
      method: 'POST',
      url: `${BASE}/echo`,
      body: { mode: 'form-data', fields: [{ key: 'upload', type: 'file', filePath: tmp }] },
    });
    const d = JSON.parse(r.bodyText);
    ok('multipart 文件用 filename 传出', d.body.includes(`filename="${path.basename(tmp)}"`));
    ok('multipart 文件内容已带上', d.body.includes('file-content-中文'));
    fs.rmSync(tmp, { force: true });
  }
  {
    const r = await sendRequest({ method: 'POST', url: `${BASE}/echo`, body: { mode: 'text', content: '纯文本体' } });
    const d = JSON.parse(r.bodyText);
    eq('text 模式 Content-Type', d.headers['content-type'], 'text/plain');
    eq('text 体内容正确', d.body, '纯文本体');
  }
  {
    const r = await sendRequest({ method: 'GET', url: `${BASE}/echo`, body: { mode: 'none' } });
    eq('无请求体时 content-length 不误发', JSON.parse(r.bodyText).bodyLength, 0);
  }

  /* ---------- 压缩 ---------- */
  console.log('\n【响应解压】');
  {
    const r = await sendRequest({ url: `${BASE}/gzip` });
    const d = JSON.parse(r.bodyText);
    eq('gzip 已自动解压', d.hello, '压缩过的响应');
    eq('gzip 解压后数字正确', d.n, 42);
  }
  {
    const r = await sendRequest({ url: `${BASE}/brotli` });
    eq('brotli 已自动解压', r.bodyText, 'brotli 内容');
  }

  /* ---------- 字符集 ---------- */
  console.log('\n【字符集】');
  {
    const r = await sendRequest({ url: `${BASE}/gbk` });
    eq('GBK 响应按声明字符集解码', r.bodyText, '中文');
  }

  /* ---------- 二进制 ---------- */
  console.log('\n【二进制响应】');
  {
    const r = await sendRequest({ url: `${BASE}/binary` });
    ok('识别为非文本', r.textual === false);
    ok('给出了 base64', typeof r.bodyBase64 === 'string' && r.bodyBase64.length > 0);
    ok('bodyText 给出可读提示', r.bodyText.includes('二进制内容'));
    eq('字节数正确', r.size, 11);
  }

  /* ---------- 状态码 ---------- */
  console.log('\n【状态码语义】');
  {
    const r = await sendRequest({ url: `${BASE}/status/404` });
    eq('404 状态码透出', r.status, 404);
    eq('4xx 标记为失败', r.ok, false);
    eq('404 响应体仍可读', JSON.parse(r.bodyText).error, '没找到');
  }
  {
    const r = await sendRequest({ url: `${BASE}/status/500` });
    eq('5xx 标记为失败', r.ok, false);
    eq('500 响应体仍可读', r.bodyText, '服务器炸了');
  }

  /* ---------- 重定向 ---------- */
  console.log('\n【重定向】');
  {
    const r = await sendRequest({ url: `${BASE}/redirect/302` });
    eq('302 默认跟随', r.status, 200);
    eq('记录了跳转链', r.redirects.length, 1);
    eq('最终地址正确', r.url.endsWith('/echo'), true);
  }
  {
    const r = await sendRequest({ method: 'POST', url: `${BASE}/redirect/302`, body: { mode: 'text', content: 'x' } });
    eq('302 后 POST 被改写为 GET', JSON.parse(r.bodyText).method, 'GET');
  }
  {
    const r = await sendRequest({ method: 'POST', url: `${BASE}/redirect/303`, body: { mode: 'text', content: 'x' } });
    eq('303 后改为 GET', JSON.parse(r.bodyText).method, 'GET');
  }
  {
    const r = await sendRequest({ method: 'POST', url: `${BASE}/redirect/307`, body: { mode: 'text', content: 'hello-307' } });
    eq('307 保持 POST', JSON.parse(r.bodyText).method, 'POST');
    eq('307 保持请求体', JSON.parse(r.bodyText).body, 'hello-307');
  }
  {
    const r = await sendRequest({ url: `${BASE}/redirect/302`, followRedirects: false });
    eq('关闭跟随后直接返回 302', r.status, 302);
    eq('关闭跟随后无跳转链', r.redirects.length, 0);
  }
  {
    const r = await sendRequest({ url: `${BASE}/redirect/loop`, maxRedirects: 3 });
    eq('循环重定向被拦截', r.ok, false);
    ok('给出超限提示', /重定向/.test(r.error.message));
  }
  {
    const r = await sendRequest({ url: `${BASE}/redirect/chain/1` });
    eq('多级跳转最终成功', r.status, 200);
    eq('多级跳转链完整记录', r.redirects.length, 2);
    eq('多级跳转终点内容正确', r.bodyText, '链条末端');
  }

  /* ---------- 超时与网络错误 ---------- */
  console.log('\n【超时与错误收敛】');
  {
    const started = Date.now();
    const r = await sendRequest({ url: `${BASE}/slow`, timeout: 600 });
    const elapsed = Date.now() - started;
    eq('超时被判定为失败', r.ok, false);
    eq('错误码为自定义超时', r.error.code, 'ETIMEDOUT_CUSTOM');
    ok('确实在超时点附近中断', elapsed < 1800, `实际耗时 ${elapsed}ms`);
    ok('给出了排查提示', typeof r.error.hint === 'string' && r.error.hint.length > 0);
  }
  {
    const r = await sendRequest({ url: 'http://127.0.0.1:1/nothing' });
    eq('连接被拒判为失败', r.ok, false);
    eq('错误码 ECONNREFUSED', r.error.code, 'ECONNREFUSED');
    ok('连接被拒给出人话提示', r.error.hint.includes('拒绝连接'));
  }
  {
    const r = await sendRequest({ url: 'http://this-host-should-not-exist.invalid/x' });
    eq('域名解析失败判为失败', r.ok, false);
    eq('错误码 ENOTFOUND', r.error.code, 'ENOTFOUND');
  }
  {
    const r = await sendRequest({ url: 'ftp://example.com/x' });
    eq('非 http(s) 协议被拒', r.error.code, 'INVALID_PROTOCOL');
  }
  {
    const r = await sendRequest({ url: '' });
    eq('空地址被拒', r.error.code, 'INVALID_URL');
  }
  {
    const r = await sendRequest({ url: 'not a url' });
    eq('非法地址被拒', r.error.code, 'INVALID_URL');
  }

  /* ---------- 响应头 ---------- */
  console.log('\n【响应头与 Cookie】');
  {
    const r = await sendRequest({ url: `${BASE}/headers` });
    const map = Object.fromEntries(r.headers.map(([k, v]) => [k.toLowerCase(), v]));
    eq('自定义响应头可见', map['x-custom'], 'value-one');
    const cookies = r.headers.filter(([k]) => k.toLowerCase() === 'set-cookie');
    ok('多条 Set-Cookie 未被合并丢失', cookies.length >= 1);
  }

  /* ---------- 耗时细分 ---------- */
  console.log('\n【耗时统计】');
  {
    const r = await sendRequest({ url: `${BASE}/echo` });
    ok('有总耗时', typeof r.timings.total === 'number');
    ok('有首字节耗时', typeof r.timings.firstByte === 'number');
    ok('有 TCP 连接耗时', typeof r.timings.connect === 'number');
    ok('IP 字面量不会伪造 DNS 耗时', r.timings.dns === undefined);
  }
  {
    // 用域名访问才会真正发生解析
    const host = `http://localhost:${server.address().port}/echo`;
    const r = await sendRequest({ url: host });
    eq('域名访问成功', r.status, 200);
    ok('域名访问记录到 DNS 耗时', typeof r.timings.dns === 'number');
  }

  /* ---------- 大数据量 ---------- */
  console.log('\n【大数据量】');
  {
    const big = 'x'.repeat(2 * 1024 * 1024);
    const r = await sendRequest({ method: 'POST', url: `${BASE}/echo`, body: { mode: 'text', content: big } });
    eq('2MB 请求体发送成功', r.status, 200);
    eq('服务端收到完整 2MB', JSON.parse(r.bodyText).bodyLength, big.length);
  }

  /* ---------- 收尾 ---------- */
  server.close();
  console.log('\n---------------------------------------------');
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  console.log('---------------------------------------------\n');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试过程异常：', e);
  server.close();
  process.exit(1);
});
