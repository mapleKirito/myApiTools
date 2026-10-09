'use strict';

/**
 * 语法校验（进程内解析，不启动子进程）
 *   node --experimental-vm-modules tools/check-syntax.js
 *
 * renderer/** 按 ES Module 解析，electron/** 与 server/** 按 CommonJS 解析。
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

let pass = 0;
let fail = 0;

function check(source, file, asModule) {
  try {
    if (asModule) {
      // eslint-disable-next-line no-new
      new vm.SourceTextModule(source, { identifier: file });
    } else {
      // eslint-disable-next-line no-new
      new vm.Script(source, { filename: file });
    }
    console.log(`  ✓ ${path.relative(ROOT, file).replace(/\\/g, '/')}`);
    pass++;
    return true;
  } catch (e) {
    console.log(`  ✗ ${path.relative(ROOT, file).replace(/\\/g, '/')}`);
    console.log(`    ${e.name}: ${e.message}`);
    fail++;
    return false;
  }
}

console.log('\n[ES Module] renderer/');
for (const file of walk(path.join(ROOT, 'renderer', 'js'))) {
  check(fs.readFileSync(file, 'utf8'), file, true);
}

console.log('\n[CommonJS] electron/ + server/ + tools/');
for (const dir of ['electron', 'server', 'tools']) {
  for (const file of walk(path.join(ROOT, dir))) {
    check(fs.readFileSync(file, 'utf8'), file, false);
  }
}

// 额外的静态一致性检查：ES Module 的相对导入是否都能解析到真实文件
console.log('\n[导入路径解析]');
const esmFiles = walk(path.join(ROOT, 'renderer', 'js'));
let missing = 0;
for (const file of esmFiles) {
  const src = fs.readFileSync(file, 'utf8');
  const re = /^\s*(?:import|export)\s[\s\S]*?from\s+['"](\.[^'"]+)['"]/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const spec = m[1];
    const resolved = path.resolve(path.dirname(file), spec);
    if (!fs.existsSync(resolved)) {
      console.log(`  ✗ ${path.relative(ROOT, file)} → ${spec}`);
      missing++;
    }
  }
}
if (!missing) console.log(`  ✓ ${esmFiles.length} 个模块的相对导入全部可解析`);
else fail += missing;

/*
 * 冒烟探针是「写在模板字符串里的代码」，它自身的语法不在上面的文件级检查范围内：
 * 少一个括号时 smoke-hook.js 照样能通过 CommonJS 解析，但运行时整个探针会
 * 静默失效（超时或提前返回），排查成本很高。这里把它们抠出来单独解析。
 */
console.log('\n[冒烟探针字符串]');
try {
  const hook = require(path.join(ROOT, 'tools', 'smoke-hook.js'));
  for (const name of ['PROBE', 'PROBE_AUTH', 'PROBE_EXPIRED', 'PROBE_SWITCH', 'PROBE_KEEP', 'PROBE_UPDATE']) {
    check(hook[name], path.join(ROOT, 'tools', `smoke-hook.js#${name}`), false);
  }
} catch (e) {
  console.log(`  ✗ 无法加载冒烟探针：${e.message}`);
  fail++;
}

console.log(`\n  语法校验：通过 ${pass}，失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
