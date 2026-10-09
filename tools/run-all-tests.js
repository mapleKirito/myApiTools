'use strict';

/**
 * 一键跑完全部测试
 *   npm test
 *
 * 各测试会各自启动临时服务 / 临时数据库，互不干扰。
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const SUITES = [
  { name: '语法与模块引用', file: 'tools/check-syntax.js', args: ['--experimental-vm-modules'], nodeArgs: true },
  { name: 'HTTP 执行引擎', file: 'electron/test-http-client.js' },
  { name: '变量解析与请求编译', file: 'tools/test-vars.mjs' },
  { name: '导入导出解析', file: 'tools/test-importers.mjs' },
  { name: '同步服务端', file: 'server/test-e2e.js' },
  { name: '双设备同步链路', file: 'tools/test-sync-client.js' },
  { name: '客户端更新链路', file: 'tools/test-update-client.js' },
];

const results = [];

for (const suite of SUITES) {
  console.log('\n' + '='.repeat(60));
  console.log(`  ▶ ${suite.name}  (${suite.file})`);
  console.log('='.repeat(60));

  const args = suite.nodeArgs ? [...suite.args, path.join(ROOT, suite.file)] : [path.join(ROOT, suite.file)];
  const started = Date.now();
  const res = spawnSync(process.execPath, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: undefined },
  });
  const ms = Date.now() - started;
  results.push({ name: suite.name, code: res.status, ms });
}

console.log('\n' + '='.repeat(60));
console.log('  汇总');
console.log('='.repeat(60));
let failed = 0;
for (const r of results) {
  const ok = r.code === 0;
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${r.name.padEnd(24, ' ')} ${String(r.ms + 'ms').padStart(9)}`);
}
console.log('='.repeat(60));
console.log(`  ${results.length - failed} / ${results.length} 个测试套件通过`);
console.log('='.repeat(60) + '\n');

console.log('提示：界面端到端测试请单独执行  npm run smoke\n');
process.exit(failed ? 1 : 0);
