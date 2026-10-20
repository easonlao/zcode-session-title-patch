#!/usr/bin/env node
/**
 * 调试插桩（只在分析时用）：
 *   1. 触发守卫打印判定输入
 *   2. openai-compatible 请求体打印 reasoning_effort
 * 用法: node debug-instrument.mjs <target-cjs>
 *
 * 守卫函数名按结构自动识别，ZCode 升级后不用改这里。
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { detect } from './patch.mjs';

const target = process.argv[2];
if (!target) {
  console.error('usage: node debug-instrument.mjs <target-cjs>');
  process.exit(1);
}

const MARK1 = 'globalThis.__TDBG_GUARD';
const MARK2 = 'globalThis.__TDBG_BODY';

let src = fs.readFileSync(target, 'utf8');

// 1) 守卫插桩：从补丁后的守卫里取函数名与归一化函数名
const S = detect(src);
if (!S) {
  console.error('识别失败：这版 zcode.cjs 的标题代码结构已变化。');
  process.exit(1);
}
const guardAnchor = `function ${S.guardName}(e,t,n={}){if(e.config.titleGeneration?.enabled===!1||!e.config.titleGeneration||!e.sessionStore||e.config.parentSessionId||e.config.taskType&&e.config.taskType!=="interactive")return!1;`;
if (!src.includes(MARK1) && src.includes(guardAnchor)) {
  src = src.replace(
    guardAnchor,
    guardAnchor +
      `try{globalThis.__TDBG_GUARD=globalThis.__TDBG_GUARD||[];globalThis.__TDBG_GUARD.push({cfg:!!e.config.titleGeneration,enabled:e.config.titleGeneration?.enabled,store:!!e.sessionStore,parent:!!e.config.parentSessionId,taskType:e.config.taskType,turn:e.turnNumber,bypass:!!n.bypassShortInputGuard,len:String(${S.normalizer}(t)||"").length})}catch{};` +
      MARK1 +
      ';',
  );
  console.log('guard instrumented (' + S.guardName + ')');
} else {
  console.log('guard: skipped (already instrumented or anchor missing)');
}

// 2) 请求体插桩
const bodyAnchor = 'reasoning_effort:j.reasoningEffort,';
if (!src.includes(MARK2) && src.includes(bodyAnchor)) {
  src = src.replace(
    bodyAnchor,
    'reasoning_effort:(globalThis.__TDBG_BODY=globalThis.__TDBG_BODY||[],globalThis.__TDBG_BODY.push({model:this.modelId,effort:j.reasoningEffort}),' +
      'console.error("[TDBG-BODY] "+JSON.stringify({model:this.modelId,effort:j.reasoningEffort})),j.reasoningEffort),',
  );
  console.log('body instrumented');
} else {
  console.log('body: skipped (already instrumented or anchor missing)');
}

const tmp = target + '.instrument-check.cjs';
fs.writeFileSync(tmp, src, 'utf8');
execFileSync(process.execPath, ['--check', tmp], { stdio: 'inherit' });
fs.rmSync(tmp, { force: true });
fs.writeFileSync(target, src, 'utf8');
console.log('written: ' + target);
