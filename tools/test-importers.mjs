/**
 * 导入导出解析器验证
 *   node tools/test-importers.mjs
 *
 * importers.js 是纯函数模块（不依赖 window），可直接在 Node 里跑。
 */

import { importFromText, parseCurl, parsePostman, parseOpenApi, toCurl, toPostmanCollection } from '../renderer/js/importers.js';

let pass = 0;
let fail = 0;

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}

/* ===================== cURL ===================== */
console.log('\n【cURL 解析】');
{
  const r = parseCurl(`curl 'https://api.example.com/users?page=1&size=20' -H 'Accept: application/json' -H 'X-Token: abc'`);
  eq('方法默认 GET', r.method, 'GET');
  eq('URL 已剥离查询串', r.url, 'https://api.example.com/users');
  eq('查询参数拆出 2 个', r.params.length, 2);
  eq('查询参数 page', r.params[0].key, 'page');
  eq('查询参数 size 值', r.params[1].value, '20');
  eq('请求头 2 个', r.headers.length, 2);
  eq('请求头键名', r.headers[1].key, 'X-Token');
}
{
  const r = parseCurl(`curl -X POST https://api.example.com/login -H "Content-Type: application/json" -d '{"username":"admin","password":"123456"}'`);
  eq('显式方法 POST', r.method, 'POST');
  eq('识别为 JSON 体', r.body.mode, 'json');
  eq('JSON 体已格式化', r.body.content.includes('\n'), true);
  eq('JSON 内容可解析', JSON.parse(r.body.content).username, 'admin');
}
{
  const r = parseCurl(`curl 'https://x.com/api' -u 'user:p@ss:word' -k -L`);
  eq('Basic 认证用户名', r.auth.username, 'user');
  eq('Basic 认证密码含冒号正确切分', r.auth.password, 'p@ss:word');
  eq('-k 关闭证书校验', r.options.verifyTls, false);
  eq('-L 跟随重定向', r.options.followRedirects, true);
}
{
  const r = parseCurl(`curl 'https://x.com/upload' -F 'file=@/tmp/a.png' -F 'name=张三'`);
  eq('识别为 multipart', r.body.mode, 'form-data');
  eq('文件字段类型', r.body.fields[0].type, 'file');
  eq('文件路径', r.body.fields[0].filePath, '/tmp/a.png');
  eq('文本字段', r.body.fields[1].value, '张三');
}
{
  const r = parseCurl(`curl 'https://x.com/api' -d 'a=1&b=中文' -H 'Content-Type: application/x-www-form-urlencoded'`);
  eq('识别为 urlencoded', r.body.mode, 'form-urlencoded');
  eq('字段数', r.body.fields.length, 2);
  eq('中文值解码', r.body.fields[1].value, '中文');
}
{
  const r = parseCurl(`curl -I 'https://x.com/api' --max-time 5 -A 'MyAgent/1.0' -b 'sid=1;t=2'`);
  eq('HEAD 方法', r.method, 'HEAD');
  eq('超时转换为毫秒', r.options.timeout, 5000);
  eq('User-Agent 归入请求头', r.headers.find((h) => h.key === 'User-Agent').value, 'MyAgent/1.0');
  eq('Cookie 归入请求头', r.headers.find((h) => h.key === 'Cookie').value, 'sid=1;t=2');
}
{
  // 多行折行 + 双引号内转义
  const r = parseCurl(`curl -X POST 'https://x.com/a' \\
    -H "Content-Type: application/json" \\
    -d "{\\"k\\":\\"v\\"}"`);
  eq('折行命令方法正确', r.method, 'POST');
  eq('双引号转义还原', JSON.parse(r.body.content).k, 'v');
}
{
  // 无协议时不臆造，交由后续补全
  const r = parseCurl(`curl '127.0.0.1:8080/api/test'`);
  eq('裸地址保留', r.url, '127.0.0.1:8080/api/test');
}

/* ===================== Postman ===================== */
console.log('\n【Postman 解析】');
{
  const pm = {
    info: { name: '示例集合', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [
      {
        name: '用户',
        item: [
          {
            name: '获取用户',
            request: {
              method: 'GET',
              header: [{ key: 'Accept', value: 'application/json' }, { key: 'X-Skip', value: '1', disabled: true }],
              url: { raw: 'https://api.example.com/users?page=2', query: [{ key: 'page', value: '2' }] },
              auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{tk}}' }] },
            },
          },
          {
            name: '创建用户',
            request: {
              method: 'POST',
              url: { raw: 'https://api.example.com/users' },
              body: { mode: 'raw', raw: '{"n":1}', options: { raw: { language: 'json' } } },
            },
          },
        ],
      },
      {
        name: '健康检查',
        request: { method: 'GET', url: 'https://api.example.com/health' },
      },
    ],
  };
  const r = parsePostman(pm);
  eq('集合名', r.name, '示例集合');
  eq('文件夹数', r.collections.length, 1);
  eq('请求数', r.requests.length, 3);
  eq('文件夹名', r.collections[0].name, '用户');
  const get = r.requests.find((x) => x.name === '获取用户');
  eq('请求归属文件夹', get.collectionId, r.collections[0].id);
  eq('URL 剥离查询串', get.url, 'https://api.example.com/users');
  eq('查询参数保留', get.params[0].key, 'page');
  eq('禁用的头被标记', get.headers[1].enabled, false);
  eq('Bearer 认证解析', get.auth.token, '{{tk}}');
  const post = r.requests.find((x) => x.name === '创建用户');
  eq('raw JSON 识别为 json', post.body.mode, 'json');
  eq('raw 内容保留', JSON.parse(post.body.content).n, 1);
  const health = r.requests.find((x) => x.name === '健康检查');
  eq('根级请求 collectionId 为空', health.collectionId, null);
}
{
  const pm = {
    info: { name: 'x' },
    item: [{
      name: '表单',
      request: {
        method: 'POST',
        url: { raw: 'https://x.com/f' },
        body: { mode: 'formdata', formdata: [{ key: 'a', value: '1', type: 'text' }, { key: 'f', type: 'file', src: '/tmp/x.png' }] },
        auth: { type: 'basic', basic: [{ key: 'username', value: 'u' }, { key: 'password', value: 'p' }] },
      },
    }],
  };
  const r = parsePostman(pm);
  eq('formdata 模式', r.requests[0].body.mode, 'form-data');
  eq('文件字段还原', r.requests[0].body.fields[1].filePath, '/tmp/x.png');
  eq('Basic 用户名', r.requests[0].auth.username, 'u');
}

/* ===================== OpenAPI ===================== */
console.log('\n【OpenAPI 3 解析】');
{
  const oa = {
    openapi: '3.0.0',
    info: { title: '订单服务', version: '1.0' },
    servers: [{ url: 'https://api.example.com/v1' }],
    paths: {
      '/orders/{id}': {
        get: {
          tags: ['订单'],
          summary: '查询订单详情',
          parameters: [
            { name: 'id', in: 'path', required: true },
            { name: 'withItems', in: 'query', schema: { type: 'boolean', default: true } },
          ],
        },
        delete: { tags: ['订单'], summary: '删除订单', parameters: [{ name: 'id', in: 'path', required: true }] },
      },
      '/orders': {
        post: {
          tags: ['订单'],
          summary: '创建订单',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { productId: { type: 'integer', example: 100 }, remark: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
  };
  const r = parseOpenApi(oa);
  eq('标题', r.name, '订单服务');
  eq('按 tag 生成 1 个文件夹', r.collections.length, 1);
  eq('请求数', r.requests.length, 3);
  const get = r.requests.find((x) => x.name === '查询订单详情');
  eq('URL 拼接 server 前缀', get.url, 'https://api.example.com/v1/orders/{id}');
  eq('query 参数默认值带出', get.params.find((p) => p.key === 'withItems').value, 'true');
  eq('必填 query 默认启用', get.params.find((p) => p.key === 'withItems').enabled, true);
  eq('path 参数标记为不启用', get.params.find((p) => p.key === 'id').enabled, false);
  const post = r.requests.find((x) => x.name === '创建订单');
  eq('请求体为 json', post.body.mode, 'json');
  eq('按 schema example 生成示例', JSON.parse(post.body.content).productId, 100);
  ok('自动补 Content-Type 头', post.headers.some((h) => h.key === 'Content-Type' && h.value.includes('json')));
}
{
  const sw = {
    swagger: '2.0',
    info: { title: '老接口', version: '1' },
    host: 'legacy.example.com',
    basePath: '/api',
    schemes: ['https'],
    paths: { '/ping': { get: { summary: '心跳' } } },
  };
  const r = parseOpenApi(sw);
  eq('Swagger2 host/basePath 拼接', r.requests[0].url, 'https://legacy.example.com/api/ping');
  eq('Swagger2 无 tag 走默认分组', r.collections[0].name, '默认分组');
}

/* ===================== 自动识别 ===================== */
console.log('\n【格式自动识别】');
eq('识别 cURL', importFromText(`curl https://x.com`).format, 'cURL');
eq('识别 Postman', importFromText(JSON.stringify({ info: { name: 'a' }, item: [{ name: 'b', request: { method: 'GET', url: 'https://x.com' } }] })).format, 'Postman Collection');
eq('识别 OpenAPI', importFromText(JSON.stringify({ openapi: '3.0.0', info: { title: 't', version: '1' }, paths: {} })).format, 'OpenAPI 3.0.0');
eq('识别 Swagger', importFromText(JSON.stringify({ swagger: '2.0', info: { title: 't', version: '1' }, paths: {} })).format, 'Swagger 2.0');
{
  let threw = false;
  try { importFromText('这不是任何已知格式'); } catch { threw = true; }
  ok('无法识别时报错', threw);
}
{
  let threw = false;
  try { importFromText(''); } catch { threw = true; }
  ok('空内容报错', threw);
}

/* ===================== 导出 ===================== */
console.log('\n【导出】');
{
  const req = {
    method: 'POST',
    url: 'https://api.example.com/login',
    headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
    params: [],
    body: { mode: 'json', content: '{"u":"张三"}' },
    auth: { type: 'basic', username: 'u', password: 'p' },
    options: { verifyTls: false, followRedirects: true },
  };
  const curl = toCurl(req);
  ok('cURL 含 -X POST', curl.includes('-X POST'));
  ok('cURL 含请求头', curl.includes("-H 'Content-Type: application/json'"));
  ok('cURL 含 -u 认证', curl.includes("-u 'u:p'"));
  ok('cURL 含 -k', curl.includes('-k'));
  ok('cURL 单引号已转义（无裸引号截断）', curl.includes("'{\"u\":\"张三\"}'"));
}
{
  const cols = [{ id: 'c1', name: '分组', parentId: null, sort: 0 }];
  const reqs = [
    { id: 'r1', name: '登录', collectionId: 'c1', sort: 0, method: 'POST', url: 'https://x.com/login', headers: [{ key: 'A', value: '1', enabled: true }], params: [{ key: 'q', value: '1', enabled: true }], body: { mode: 'json', content: '{}' }, auth: { type: 'bearer', token: 't' } },
    { id: 'r2', name: '根级', collectionId: null, sort: 0, method: 'GET', url: 'https://x.com/', headers: [], params: [], body: { mode: 'none' }, auth: { type: 'none' } },
  ];
  const json = JSON.parse(toPostmanCollection('导出测试', cols, reqs));
  eq('导出 schema 正确', json.info.schema.includes('v2.1.0'), true);
  eq('导出顶层项数 2（1 文件夹 + 1 请求）', json.item.length, 2);
  const folder = json.item.find((x) => x.name === '分组');
  eq('文件夹内有 1 个请求', folder.item.length, 1);
  const login = folder.item[0].request;
  eq('请求方法', login.method, 'POST');
  eq('查询参数导出', login.url.query[0].key, 'q');
  eq('raw 请求体导出', login.body.mode, 'raw');
  eq('请求体语言标记', login.body.options.raw.language, 'json');
  eq('Bearer 认证导出', login.auth.bearer[0].value, 't');
}
{
  // 往返：Postman 导出后再导入，结构应保持
  const cols = [{ id: 'c1', name: '组', parentId: null, sort: 0 }];
  const reqs = [{ id: 'r1', name: 'X', collectionId: 'c1', sort: 0, method: 'PUT', url: 'https://x.com/y', headers: [{ key: 'H', value: 'v', enabled: true }], params: [{ key: 'p', value: '2', enabled: true }], body: { mode: 'text', content: 'hi' }, auth: { type: 'none' } }];
  const roundTrip = parsePostman(JSON.parse(toPostmanCollection('往返', cols, reqs)));
  eq('往返后请求数', roundTrip.requests.length, 1);
  eq('往返后方法', roundTrip.requests[0].method, 'PUT');
  eq('往返后 URL', roundTrip.requests[0].url, 'https://x.com/y');
  eq('往返后请求头', roundTrip.requests[0].headers[0].value, 'v');
  eq('往返后查询参数', roundTrip.requests[0].params[0].value, '2');
  eq('往返后文本体', roundTrip.requests[0].body.content, 'hi');
}

console.log('\n---------------------------------------------');
console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
console.log('---------------------------------------------\n');
process.exit(fail === 0 ? 0 : 1);
