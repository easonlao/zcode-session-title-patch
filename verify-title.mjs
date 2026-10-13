#!/usr/bin/env node
/**
 * 从补丁后的 zcode.cjs 里抽出真实的 kFa 提示词与 TFa 上下文构造器，
 * 用真实会话数据跑一遍，再把结果发给模型，检查标题是否符合新规范。
 *
 * 用法: node verify-title.mjs <patched-zcode.cjs> [sessionId]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const bundlePath = process.argv[2];
const wantSession = process.argv[3];
if (!bundlePath) {
  console.error('usage: node verify-title.mjs <patched-zcode.cjs> [sessionId]');
  process.exit(1);
}

const src = fs.readFileSync(bundlePath, 'utf8');

// ---- 1. 抽出提示词 ----
const pStart = src.indexOf('kFa=`');
const pFrom = pStart + 5;
const pEnd = src.indexOf('`', pFrom);
const kFa = src.slice(pFrom, pEnd);
console.log('== prompt head ==\n' + kFa.split('\n').slice(0, 3).join('\n'));
console.log('(prompt length: ' + kFa.length + ' chars)\n');

// ---- 2. 抽出 TFa ----
const tFrom = src.indexOf('async function TFa(e,t){');
if (tFrom === -1) throw new Error('patched TFa not found');
const tail = 'content:JSON.stringify(n)}]}';
const tTail = src.indexOf(tail, tFrom);
if (tTail === -1) throw new Error('patched TFa tail not found');
const tEnd = tTail + tail.length;
const tfaSrc = src.slice(tFrom, tEnd);
console.log('== TFa extracted (' + tfaSrc.length + ' chars) ==');
console.log(tfaSrc.slice(0, 240) + ' …\n');

// ---- 3. 真实会话数据 ----
const db = new DatabaseSync(path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite'), { readOnly: true });
const session =
  (wantSession && db.prepare('select * from session where id = ?').get(wantSession)) ||
  db.prepare("select * from session where title_source='generated' and task_type='interactive' order by time_updated desc limit 1").get();
if (!session) throw new Error('no session found');
const rawMessages = db
  .prepare('select * from message where session_id = ? order by sequence is null, sequence, time_created, rowid')
  .all(session.id);
const rawParts = db
  .prepare('select * from part where session_id = ? order by message_id, sequence is null, sequence, time_created, id')
  .all(session.id);
const byMessage = new Map();
for (const p of rawParts) {
  const data = JSON.parse(p.data);
  const list = byMessage.get(p.message_id) ?? [];
  list.push(data);
  byMessage.set(p.message_id, list);
}
const messages = rawMessages.map((m) => ({ info: JSON.parse(m.data), parts: byMessage.get(m.id) ?? [] }));
console.log('session: ' + session.id + '  current title: ' + JSON.stringify(session.title) + ' (' + session.title_source + ')');
console.log('messages in store: ' + messages.length + '\n');

// ---- 4. 执行 bundle 里的 TFa ----
const qSe = (e) => {
  const t = String(e ?? '').trim().replace(/\s+/g, ' ');
  return t.length > 1200 ? t.slice(0, 1200) : t;
};
const $Se = 'goal_summary_title';
const qNo = 1200;
const WNo = 100;
const factory = new Function(
  'kFa',
  'qSe',
  '$Se',
  'qNo',
  'WNo',
  'return ' + tfaSrc + '; return TFa;',
);
const TFa = factory(kFa, qSe, $Se, qNo, WNo);

let latestInput = '';
for (let i = messages.length - 1; i >= 0; i--) {
  const info = messages[i].info ?? {};
  if (info.role !== 'user' || info.synthetic === true || info.visibility === 'model-only') continue;
  const text = (messages[i].parts ?? [])
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
  if (text.trim()) {
    latestInput = text;
    break;
  }
}

const fakeThis = {
  sessionId: session.id,
  config: { workingDirectory: session.directory },
  sessionStore: {
    getSession: async () => ({ title: session.title, titleSource: session.title_source ?? 'first_input' }),
    messages: async () => messages,
  },
};
const built = await TFa.call(fakeThis, latestInput, { querySource: 'session_title' });
const payload = built[1].content;
console.log('== payload sent to model ==');
console.log('payload length: ' + payload.length + ' chars, keys: ' + Object.keys(JSON.parse(payload)).join(','));
const parsedPayload = JSON.parse(payload);
console.log('recent_turns: ' + parsedPayload.recent_turns.length + ' entries');
console.log(payload.length > 1200 ? payload.slice(0, 1200) + ' …' : payload);
console.log('');

// ---- 5. 辅助调用档位（_P）检查 ----
const aFrom = src.indexOf('function _P(e){');
const aTail = 'Math.min(5e3,e.optionSpecs.maxOutputTokens.max)}}';
const aEnd = src.indexOf(aTail, aFrom) + aTail.length;
if (aFrom === -1 || aEnd === -1) throw new Error('auxiliaryModelOptions not found in bundle');
const auxSrc = src.slice(aFrom, aEnd);
const aux = new Function('return ' + auxSrc + '; return _P;')();
const levelCases = [
  ['off,low,medium,high,max', ['off', 'low', 'medium', 'high', 'max'], 'low'],
  ['disabled,low,high', ['disabled', 'low', 'high'], 'low'],
  ['low,high', ['low', 'high'], 'low'],
  ['off,max', ['off', 'max'], 'max'],
  ['off,disabled', ['off', 'disabled'], 'disabled'],
];
console.log('\n== 辅助调用档位 (_P) ==');
let auxOk = true;
let chosenLevel = null;
for (const [label, values, want] of levelCases) {
  const got = aux({ optionSpecs: { reasoningLevel: { values }, maxOutputTokens: { max: 64000 } } }).reasoningLevel;
  const pass = got === want;
  if (!pass) auxOk = false;
  if (label === levelCases[0][0]) chosenLevel = got;
  console.log('  ' + (pass ? 'ok  ' : 'FAIL') + '  ' + JSON.stringify(values) + ' -> ' + JSON.stringify(got) + ' (want ' + want + ')');
}

// ---- 6. 真调模型 ----
const cfgPath = path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
// 用哪个 provider 做这次真实调用：命令行第 3 个参数 > 环境变量 > 第一个带 apiKey 的 provider
const providerArg = [process.argv[4], process.env.ZCODE_TITLE_TEST_PROVIDER].find(Boolean);
const rules = cfg.config.providerConfigRules.providerRules;
const providerId = providerArg ?? rules.find((r) => r.config?.access?.apiKey)?.providerId;
const rule = rules.find((r) => r.providerId === providerId)?.config;
if (!rule?.access?.apiKey) {
  console.log('\n找不到可用的 provider（可用 ZCODE_TITLE_TEST_PROVIDER=<providerId> 指定），跳过真实模型调用。');
  process.exit(0);
}
console.log('使用 provider: ' + providerId);

const body = {
  model: rule.personalModelIds[0],
  messages: [
    { role: 'system', content: built[0].content },
    { role: 'user', content: payload },
  ],
  max_tokens: 3000,
  // 用补丁后 _P 选出的档位真打一次，验证网关接受
  ...(chosenLevel ? { reasoning_effort: chosenLevel } : {}),
};
console.log('sending reasoning_effort=' + JSON.stringify(chosenLevel));
const res = await fetch(rule.api.baseUrl + '/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + rule.access.apiKey },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(90000),
});
console.log('gateway status: ' + res.status);
const json = await res.json().catch(() => null);
const choice = json?.choices?.[0];
const text = choice?.message?.content ?? JSON.stringify(json).slice(0, 400);
console.log('finish_reason: ' + JSON.stringify(choice?.finish_reason) + '  usage: ' + JSON.stringify(json?.usage));
console.log('model raw output: ' + JSON.stringify(text));

let title = null;
try {
  title = JSON.parse(text.trim()).title;
} catch {
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      title = JSON.parse(m[0]).title;
    } catch {}
  }
}
console.log('\nparsed title: ' + JSON.stringify(title));
if (title) {
  const hasSep = title.includes('｜');
  const emoji = /\p{Extended_Pictographic}/u.test(title);
  console.log('checks -> 分隔符「｜」: ' + hasSep + ' / 类别 emoji: ' + emoji + ' / 长度: ' + [...title].length);
}

// ---- 6. 守卫逻辑（触发条件）单测 ----
const gFrom = src.indexOf('function FFa(e,t,n={}){');
const gTail = 'return qSe(t).length>0}';
const gEnd = src.indexOf(gTail, gFrom) + gTail.length;
const gSrc = src.slice(gFrom, gEnd);
const FFa = new Function('qSe', 'return ' + gSrc + '; return FFa;')(qSe);
const base = () => ({
  config: { titleGeneration: {}, taskType: 'interactive' },
  sessionStore: {},
  turnNumber: 0,
});
const guardCases = [
  ['第 0 轮 长输入', { ...base() }, '帮我重构日志模块并统一输出', true],
  ['第 0 轮 短输入', { ...base() }, '你好', true],
  ['第 5 轮 短输入「继续」（是否调用交给 xFa 判断）', { ...base(), turnNumber: 5 }, '继续', true],
  ['空输入（应跳过）', { ...base() }, '   ', false],
  ['子会话（应跳过）', { ...base(), config: { titleGeneration: {}, taskType: 'interactive', parentSessionId: 'sess_x' } }, '帮我做点事', false],
  ['关闭开关（应跳过）', { ...base(), config: { titleGeneration: { enabled: false }, taskType: 'interactive' } }, '帮我做点事', false],
];
console.log('\n== guard (是否允许尝试) ==');
let guardOk = true;
for (const [label, rt, text, want] of guardCases) {
  const got = FFa(rt, text);
  if (got !== want) guardOk = false;
  console.log('  ' + (got ? 'run ' : 'skip') + '  (want ' + (want ? 'run' : 'skip') + ')  ' + label);
}

// ---- 7. xFa 内的判断片段（决定要不要调模型、用哪个档位） ----
const sFrom = src.indexOf('if(t.querySource===aAn){');
const sEnd = src.indexOf('/*titlepatch*/', sFrom) + '/*titlepatch*/'.length;
if (sFrom === -1 || sEnd === -1) throw new Error('titlepatch snippet not found in bundle');
const snippet = src.slice(sFrom, sEnd);
console.log('\n== xFa snippet ==\n' + snippet + '\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const decide = new AsyncFunction(
  'e',
  't',
  'n',
  'qSe',
  'aAn',
  snippet + '; return {decision:"run",level:(n.options||{}).reasoningLevel};',
);
const sel = { providerId: 'p', modelId: 'm', options: { reasoningLevel: 'disabled' } };
const withSession = (titleSource) => ({
  sessionId: 's1',
  sessionStore: { getSession: async () => ({ title: 't', titleSource }) },
});
const snippetCases = [
  ['手动改名(custom) + 长输入 → 不覆盖', withSession('custom'), '继续把剩下的接口也改掉', 'skip'],
  ['手动改名(custom) + 短输入 → 不覆盖', withSession('custom'), '好的', 'skip'],
  ['已有标题(generated) + 短输入「继续」→ 跳过', withSession('generated'), '继续', 'skip'],
  ['已有标题(generated) + 长输入 → 重新评估', withSession('generated'), '再把登录页的样式也统一了', 'run'],
  ['还没标题(first_input) + 短输入 → 补一次', withSession('first_input'), '还是没效果', 'run'],
  ['还没标题(first_input) + 长输入 → 生成', withSession('first_input'), '帮我优化数据同步脚本', 'run'],
];
console.log('== xFa 判断 ==');
let snippetOk = true;
for (const [label, rt, input, want] of snippetCases) {
  const out = await decide.call(rt, input, { querySource: 'session_title' }, { ...sel, options: { ...sel.options } }, qSe, 'session_title');
  const got = out && out.decision === 'run' ? 'run' : 'skip';
  const pass = got === want;
  if (!pass) snippetOk = false;
  console.log('  ' + (pass ? 'ok  ' : 'FAIL') + '  ' + got.padEnd(5) + '(want ' + want + ')  ' + label);
}
console.log('\nSUMMARY  guard=' + (guardOk ? 'ok' : 'FAIL') + '  aux=' + (auxOk ? 'ok' : 'FAIL') + '  snippet=' + (snippetOk ? 'ok' : 'FAIL'));
