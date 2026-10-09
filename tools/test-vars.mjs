/**
 * 变量解析与请求编译验证
 *   node tools/test-vars.mjs
 *
 * state.js 在模块顶层会读取 window.bridge，这里先打桩再动态导入。
 */

globalThis.window = { bridge: { store: { load: async () => ({}), patch: async () => ({}) } } };

const { state } = await import('../renderer/js/state.js');
const { buildVariableMap, resolveString, resolveDeep, compileRequest, previewUrl, availableVariables } = await import('../renderer/js/vars.js');

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}

/* ---------- 准备状态 ---------- */
state.workspace = {
  collections: [],
  requests: [],
  environments: [
    {
      id: 'e1',
      name: '测试环境',
      variables: [
        { key: 'host', value: 'https://api.example.com', enabled: true },
        { key: 'token', value: 'env-token', enabled: true },
        { key: 'dead', value: 'x', enabled: false },
        { key: 'path', value: '/v1/users', enabled: true },
        { key: 'chain', value: '{{host}}/chained', enabled: true },
      ],
    },
    { id: 'e2', name: '生产环境', variables: [{ key: 'host', value: 'https://prod.example.com', enabled: true }] },
  ],
  globals: [
    { key: 'host', value: 'https://global.example.com', enabled: true },
    { key: 'ua', value: 'GlobalAgent/1.0', enabled: true },
    { key: 'shared', value: 'global-value', enabled: true },
  ],
  history: [],
  settings: {
    timeout: 30000, followRedirects: true, verifyTls: true, maxRedirects: 10,
    concurrency: 5, historyLimit: 300, activeEnvId: 'e1',
  },
};

/* ---------- 优先级 ---------- */
console.log('\n【变量优先级】');
{
  const map = buildVariableMap();
  eq('环境变量覆盖全局同名变量', map.get('host'), 'https://api.example.com');
  eq('全局独有变量可见', map.get('ua'), 'GlobalAgent/1.0');
  eq('禁用的变量不进入变量表', map.has('dead'), false);
}
{
  const map = buildVariableMap([{ key: 'host', value: 'https://request.example.com', enabled: true }]);
  eq('请求级变量优先级最高', map.get('host'), 'https://request.example.com');
}
{
  state.workspace.settings.activeEnvId = null;
  const map = buildVariableMap();
  eq('未选环境时回落到全局变量', map.get('host'), 'https://global.example.com');
  state.workspace.settings.activeEnvId = 'e1';
}

/* ---------- 字符串替换 ---------- */
console.log('\n【{{变量}} 替换】');
{
  const map = buildVariableMap();
  eq('基本替换', resolveString('{{host}}/api', map).value, 'https://api.example.com/api');
  eq('同一串多次替换', resolveString('{{host}}{{path}}', map).value, 'https://api.example.com/v1/users');
  eq('花括号内允许空格', resolveString('{{ host }}', map).value, 'https://api.example.com');
  eq('嵌套变量递归展开', resolveString('{{chain}}', map).value, 'https://api.example.com/chained');
  eq('env. 前缀别名可用', resolveString('{{env.host}}', map).value, 'https://api.example.com');
  const r = resolveString('{{host}}/{{missing}}/{{alsoMissing}}', map);
  eq('未定义变量保留原文', r.value, 'https://api.example.com/{{missing}}/{{alsoMissing}}');
  eq('未定义变量被收集（去重）', r.unresolved.length, 2);
  eq('不含占位符的串原样返回', resolveString('https://x.com/a', map).value, 'https://x.com/a');
  eq('空值不炸', resolveString('', map).value, '');
  eq('非字符串入参安全转换', resolveString(123, map).value, '123');
}

/* ---------- 动态变量 ---------- */
console.log('\n【内置动态变量】');
{
  const map = buildVariableMap();
  const ts = resolveString('{{$timestamp}}', map).value;
  ok('$timestamp 是 13 位数字', /^\d{13}$/.test(ts));
  ok('$timestamp 接近当前时间', Math.abs(Number(ts) - Date.now()) < 5000);
  ok('$uuid 形状正确', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(resolveString('{{$uuid}}', map).value));
  ok('$isoTimestamp 是 ISO 串', /^\d{4}-\d{2}-\d{2}T/.test(resolveString('{{$isoTimestamp}}', map).value));
  const i1 = resolveString('{{$randomInt}}', map).value;
  ok('$randomInt 落在范围内', Number(i1) >= 0 && Number(i1) < 1000000);
  eq('$randomString 长度可指定', resolveString('{{$randomString 8}}', map).value.length, 8);
  eq('$datetime 支持格式参数', resolveString('{{$datetime YYYY-MM-DD}}', map).value.length, 10);
  ok('未知 $ 变量原样保留', resolveString('{{$nope}}', map).value === '{{$nope}}');
  ok('动态变量不报未定义', resolveString('{{$uuid}}', map).unresolved.length === 0);
}

/* ---------- 深层层替换 ---------- */
console.log('\n【嵌套结构替换】');
{
  const map = buildVariableMap();
  const r = resolveDeep(
    { url: '{{host}}', list: ['{{token}}', 'plain', { deep: '{{ua}}' }], n: 5, b: true, nil: null },
    map
  );
  eq('对象字段替换', r.value.url, 'https://api.example.com');
  eq('数组元素替换', r.value.list[0], 'env-token');
  eq('数组内对象替换', r.value.list[2].deep, 'GlobalAgent/1.0');
  eq('非字符串类型保持不变', r.value.n, 5);
  eq('布尔值保持不变', r.value.b, true);
  eq('null 保持不变', r.value.nil, null);
}

/* ---------- 请求编译 ---------- */
console.log('\n【请求编译】');
{
  const req = {
    method: 'post',
    url: '{{host}}{{path}}',
    params: [
      { key: 'page', value: '1', enabled: true },
      { key: 'q', value: '{{token}}', enabled: true },
      { key: 'skip', value: 'x', enabled: false },
    ],
    headers: [
      { key: 'X-Trace', value: '{{$uuid}}', enabled: true },
      { key: 'Skip-Me', value: '1', enabled: false },
    ],
    body: { mode: 'json', content: '{"t":"{{token}}"}' },
    auth: { type: 'none' },
    options: {},
  };
  const { descriptor, resolvedUrl, unresolved } = compileRequest(req);
  eq('方法统一大写', descriptor.method, 'POST');
  eq('URL 路径变量已替换', resolvedUrl.startsWith('https://api.example.com/v1/users?'), true);
  ok('查询参数已拼接', resolvedUrl.includes('page=1'));
  ok('查询参数值完成变量替换', resolvedUrl.includes('q=env-token'));
  ok('禁用的查询参数未拼接', !resolvedUrl.includes('skip='));
  ok('请求头变量已替换', /^[0-9a-f-]{36}$/.test(descriptor.headers.find(([k]) => k === 'X-Trace')[1]));
  ok('禁用的请求头未带上', !descriptor.headers.some(([k]) => k === 'Skip-Me'));
  eq('请求体变量已替换', JSON.parse(descriptor.body.content).t, 'env-token');
  eq('无未定义变量', unresolved.length, 0);
}
{
  const req = {
    method: 'GET', url: '127.0.0.1:8080/api/test', params: [], headers: [], body: { mode: 'none' },
    auth: { type: 'none' }, options: {},
  };
  const { descriptor } = compileRequest(req);
  eq('裸地址自动补 http://', descriptor.url, 'http://127.0.0.1:8080/api/test');
}
{
  const req = {
    method: 'GET', url: 'https://x.com/a', params: [{ key: 'b', value: '2', enabled: true }],
    headers: [], body: { mode: 'none' }, auth: { type: 'none' }, options: {},
  };
  const { descriptor } = compileRequest(req);
  eq('URL 原有查询串与新增参数合并', descriptor.url, 'https://x.com/a?b=2');
}
{
  const req = {
    method: 'GET', url: 'https://x.com/a', params: [{ key: 'k', value: '中文 空格&符号', enabled: true }],
    headers: [], body: { mode: 'none' }, auth: { type: 'none' }, options: {},
  };
  const { descriptor } = compileRequest(req);
  ok('查询参数特殊字符被正确编码', descriptor.url.includes('k=%E4%B8%AD%E6%96%87'));
}
{
  const req = { method: 'GET', url: 'https://x.com', params: [], headers: [], body: { mode: 'none' }, auth: { type: 'none' }, options: {} };
  const { descriptor } = compileRequest(req);
  ok('默认补 User-Agent 之外不塞多余头', descriptor.headers.length === 0);
}
{
  const req = {
    method: 'GET', url: 'https://x.com', params: [], headers: [], body: { mode: 'none' },
    auth: { type: 'bearer', token: '{{token}}' }, options: {},
  };
  const { descriptor } = compileRequest(req);
  eq('Bearer 认证变量已替换', descriptor.headers.find(([k]) => k === 'Authorization')[1], 'Bearer env-token');
}
{
  const req = {
    method: 'GET', url: 'https://x.com', params: [], headers: [{ key: 'Authorization', value: 'manual', enabled: true }],
    body: { mode: 'none' }, auth: { type: 'bearer', token: 'auto' }, options: {},
  };
  const { descriptor } = compileRequest(req);
  const auths = descriptor.headers.filter(([k]) => k.toLowerCase() === 'authorization');
  eq('手写 Authorization 优先，不被认证配置覆盖', auths.length, 1);
  eq('保留手写值', auths[0][1], 'manual');
}
{
  const req = {
    method: 'GET', url: 'https://x.com', params: [], headers: [], body: { mode: 'none' },
    auth: { type: 'basic', username: '中文用户', password: 'p' }, options: {},
  };
  const { descriptor } = compileRequest(req);
  const v = descriptor.headers.find(([k]) => k === 'Authorization')[1];
  const decoded = Buffer.from(v.replace('Basic ', ''), 'base64').toString('utf8');
  eq('Basic 认证 UTF-8 凭据编码正确', decoded, '中文用户:p');
}
{
  const req = {
    method: 'GET', url: 'https://x.com', params: [], headers: [], body: { mode: 'none' },
    auth: { type: 'apikey', key: 'X-Api-Key', value: 'k1', in: 'query' }, options: {},
  };
  const { descriptor } = compileRequest(req);
  ok('API Key 放在 query 时进入 URL', descriptor.url.includes('X-Api-Key=k1'));
  ok('API Key 放在 query 时不重复放进头', !descriptor.headers.some(([k]) => k === 'X-Api-Key'));
}
{
  const req = { method: 'GET', url: 'https://x.com', params: [], headers: [], body: { mode: 'none' }, auth: { type: 'none' }, options: { timeout: 1234, verifyTls: false } };
  const { descriptor } = compileRequest(req);
  eq('请求级超时生效', descriptor.timeout, 1234);
  eq('请求级证书校验开关生效', descriptor.verifyTls, false);
}
{
  const req = { method: 'GET', url: 'https://x.com', params: [], headers: [], body: { mode: 'none' }, auth: { type: 'none' }, options: {} };
  const { descriptor } = compileRequest(req);
  eq('未设超时时回落全局设置', descriptor.timeout, 30000);
}
{
  let threw = false;
  try { compileRequest({ method: 'GET', url: '', params: [], headers: [], body: { mode: 'none' }, auth: { type: 'none' }, options: {} }); }
  catch { threw = true; }
  ok('空地址编译报错（由调用方捕获展示）', threw);
}
{
  const req = { method: 'GET', url: '{{host}}/x', params: [{ key: 'a', value: '{{nope}}', enabled: true }], headers: [], body: { mode: 'none' }, auth: { type: 'none' }, options: {} };
  const { unresolved } = compileRequest(req);
  eq('未定义变量在编译结果中被上报', unresolved.join(','), 'nope');
}
{
  const req = { method: 'GET', url: 'https://x.com/{{missing}}', params: [], headers: [], body: { mode: 'none' }, auth: { type: 'none' }, options: {} };
  eq('previewUrl 对未定义变量不抛异常', previewUrl(req), 'https://x.com/{{missing}}');
}

/* ---------- 变量清单 ---------- */
console.log('\n【变量清单】');
{
  const list = availableVariables();
  ok('包含环境变量', list.some((v) => v.name === 'host' && v.from === '测试环境'));
  ok('包含全局变量', list.some((v) => v.name === 'ua' && v.from === '全局'));
  ok('包含内置动态变量', list.some((v) => v.from === '内置' && v.name === '$uuid'));
}

console.log('\n---------------------------------------------');
console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
console.log('---------------------------------------------\n');
process.exit(fail === 0 ? 0 : 1);
