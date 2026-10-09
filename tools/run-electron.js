'use strict';

/**
 * Electron 启动器
 *   node tools/run-electron.js            正常启动应用
 *   node tools/run-electron.js --smoke    启动端到端冒烟测试
 *
 * 直接 `electron .` 也能跑，但某些宿主环境（IDE 终端、CI、容器）会预设
 * ELECTRON_RUN_AS_NODE=1 或 NODE_OPTIONS，前者会让 electron.exe 退化成
 * 普通 Node 进程（表现为 require('electron').protocol 为 undefined），
 * 这里统一剥掉，保证启动行为稳定。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const smoke = process.argv.includes('--smoke');

let electronBin;
try {
  electronBin = require('electron');
} catch {
  console.error('未找到 electron，请先执行：npm install');
  process.exit(1);
}
if (typeof electronBin !== 'string') {
  console.error('请在普通 Node 环境下运行本脚本（不要用 electron 运行它）');
  process.exit(1);
}
if (!fs.existsSync(electronBin)) {
  console.error(`Electron 可执行文件不存在：${electronBin}\n请重新执行：npm install`);
  process.exit(1);
}

const args = ['.'];
if (smoke) {
  // 无 GPU 的环境（容器 / 受限沙箱）必须降级，否则 GPU 进程崩溃会拖垮应用
  args.push('--disable-gpu', '--disable-gpu-compositing', '--no-sandbox', '--disable-dev-shm-usage');
}

const env = { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined };
if (smoke) env.MYAPITOOLS_SMOKE = '1';

console.log(smoke ? '▶ 启动冒烟测试…\n' : '▶ 启动 MyApiTools…\n');

const child = spawn(electronBin, args, { cwd: root, env, stdio: 'inherit' });

child.on('exit', (code) => process.exit(code == null ? 0 : code));
child.on('error', (e) => {
  console.error('启动 Electron 失败：', e.message);
  process.exit(1);
});
