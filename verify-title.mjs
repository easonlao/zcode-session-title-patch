#!/usr/bin/env node
/**
 * 从补丁后的 zcode.cjs 里抽出真实的标题提示词与上下文构造器，
 * 用真实会话数据跑一遍，再把结果发给模型，检查标题是否符合新规范。
 *
 * 用法: node verify-title.mjs <patched-zcode.cjs> [sessionId] [providerId]
 *
 * 位置全部按代码结构识别（见 patch.mjs 的 detect），ZCode 升级后压缩名变了也能跑。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { detect, buildSnippet, MARKER } from './patch.mjs';

const bundlePath = process.argv[2];
const wantSession = process.argv[3];
if (!bundlePath) {
  console.error('usage: node verify-title.mjs <patched-zcode.cjs> [sessionId] [providerId]');
  process.exit(1);
}

const src = fs.readFileSync(bundlePath, 'utf8');
const S = detect(src);
if (!S) {
  console.error('识别失败：这版 zcode.cjs 的标题代码结构已变化，先更新 patch.mjs 的识别规则。');
  process.exit(1);
}
console.log('结构: 提示词变量=' + S.promptVar + '  归一化=' + S.normalizer + '  构造器=' + S.builderName + '  实现=' + S.fnName);

// ---- 1. 抽出提示词 ----
const pStart = src.indexOf(S.promptVar + '=`');
const pFrom = pStart + S.promptVar.length + 2;
const pEnd = src.indexOf('`', pFrom);
const prompt = src.slice(pFrom, pEnd);
if (!prompt.includes(MARKER)) throw new Error('提示词不是补丁版，请先运行 node patch.mjs');
console.log('== prompt head ==\n' + prompt.split('\n').slice(0, 3).join('\n'));
console.log('(prompt length: ' + prompt.length + ' chars)\n');

// ---- 2. 抽上下文构造器 ----
const tFrom = src.indexOf(`async function ${S.builderName}(e,t){`);
if (tFrom === -1) throw new Error('patched context builder not found');
const tail = 'content:JSON.stringify(n)}]}';
const tTail = src.indexOf(tail, tFrom);
if (tTail === -1) throw new Error('patched context builder tail not found');
const builderSrc = src.slice(tFrom, tTail + tail.length);
console.log('== builder extracted (' + builderSrc.length + ' chars) ==');
console.log(builderSrc.slice(0, 240) + ' …\n');

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

// ---- 4. 执行 bundle 里的构造器 ----
// 用 bundle 里真实的归一化实现：抽出函数体，把里面引用的截断常量替换成实际值
const nRe = new RegExp(
  `function ${S.normalizer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\(e\\)\\{let t=e\\.trim\\(\\)\\.replace\\(\\/\\\\s\\+\\/g," "\\);return t\\.length>([A-Za-z_$][\\w$]*)\\?t\\.slice\\(0,\\1\\):t\\}`,
);
const nSrc = nRe.exec(src);
if (!nSrc) throw new Error('normalizer not found');
const limitVar = nSrc[1];
const limitMatch = new RegExp(`${limitVar}=(\\d+)`).exec(src);
const limitReplacer = limitMatch ? new RegExp(`\\b${limitVar}\\b`, 'g') : null;
const normalizerSrc = limitReplacer ? nSrc[0].replace(limitReplacer, limitMatch[1]) : nSrc[0];
const normalizer = new Function('return ' + normalizerSrc + `; return ${S.normalizer};`)();
console.log('归一化截断长度: ' + (limitMatch ? limitMatch[1] : '未识别（沿用变量）'));

const factory = new Function(
  'prompt',
  'normalizer',
  'goalSource',
  'return ' + builderSrc.replace(new RegExp('\\b' + S.promptVar + '\\b', 'g'), 'prompt').replace(
    new RegExp('\\b' + S.normalizer + '\\b', 'g'),
    'normalizer',
  ).replace(new RegExp('\\b' + S.goalSource + '\\b', 'g'), 'goalSource') + '; return ' + S.builderName + ';',
);
const buildContext = factory(prompt, normalizer, S.goalSource);

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
  workingDirectory: session.directory,
  sessionStore: {
    getSession: async () => ({ title: session.title, titleSource: session.title_source ?? 'first_input' }),
    messages: async () => messages,
  },
};
const built = await buildContext.call(fakeThis, latestInput, { querySource: 'session_title' });
const payload = built[1].content;
console.log('== payload sent to model ==');
console.log('payload length: ' + payload.length + ' chars, keys: ' + Object.keys(JSON.parse(payload)).join(','));
const parsedPayload = JSON.parse(payload);
console.log('recent_turns: ' + parsedPayload.recent_turns.length + ' entries');
console.log(payload.length > 1200 ? payload.slice(0, 1200) + ' …' : payload);
console.log('');

// ---- 5. 辅助调用档位检查 ----
const aux = new Function('return ' + S.auxNew + `; return ${S.auxNew.match(/^function ([A-Za-z_$][\w$]*)/)[1]};`)();
const levelCases = [
  ['off,low,medium,high,max', ['off', 'low', 'medium', 'high', 'max'], 'low'],
  ['disabled,low,high', ['disabled', 'low', 'high'], 'low'],
  ['low,high', ['low', 'high'], 'low'],
  ['off,max', ['off', 'max'], 'max'],
  ['off,disabled', ['off', 'disabled'], 'disabled'],
];
console.log('\n== 辅助调用档位 ==');
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
  console.log(
    'checks -> 分隔符「｜」: ' +
      title.includes('｜') +
      ' / 类别 emoji: ' +
      /\p{Extended_Pictographic}/u.test(title) +
      ' / 长度: ' +
      [...title].length,
  );
}

// ---- 7. 守卫逻辑单测 ----
const guardFactory = new Function('normalizer', 'return ' + S.guardNew.replace(new RegExp('\\b' + S.normalizer + '\\b', 'g'), 'normalizer') + `; return ${S.guardNew.match(/^function ([A-Za-z_$][\w$]*)/)[1]};`);
const guard = guardFactory(normalizer);
const base = () => ({ config: { titleGeneration: {}, taskType: 'interactive' }, sessionStore: {}, turnNumber: 0 });
const guardCases = [
  ['第 0 轮 长输入', base(), '帮我重构日志模块并统一输出', true],
  ['第 0 轮 短输入', base(), '你好', true],
  ['第 5 轮 短输入「继续」（是否调用交给跳过规则判断）', { ...base(), turnNumber: 5 }, '继续', true],
  ['空输入（应跳过）', base(), '   ', false],
  ['子会话（应跳过）', { ...base(), config: { titleGeneration: {}, taskType: 'interactive', parentSessionId: 'sess_x' } }, '帮我做点事', false],
  ['关闭开关（应跳过）', { ...base(), config: { titleGeneration: { enabled: false }, taskType: 'interactive' } }, '帮我做点事', false],
];
console.log('\n== guard (是否允许尝试) ==');
let guardOk = true;
for (const [label, rt, input, want] of guardCases) {
  const got = guard(rt, input);
  if (got !== want) guardOk = false;
  console.log('  ' + (got ? 'run ' : 'skip') + '  (want ' + (want ? 'run' : 'skip') + ')  ' + label);
}

// ---- 8. 跳过规则（插在实现函数体开头的那段） ----
const snippet = buildSnippet(S);
console.log('\n== skip rules snippet ==\n' + snippet + '\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const snippetForTest = snippet.replace(new RegExp('\\b' + S.sessionSource + '\\b', 'g'), 'sessionSource');
const decide = new AsyncFunction('e', 't', 'normalizer', 'sessionSource', snippetForTest + '; return {decision:"run"};');
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
console.log('== skip rules ==');
let snippetOk = true;
for (const [label, rt, input, want] of snippetCases) {
  const out = await decide.call(rt, input, { querySource: S.sessionSource }, normalizer, S.sessionSource);
  const got = out ? 'run' : 'skip';
  const pass = got === want;
  if (!pass) snippetOk = false;
  console.log('  ' + (pass ? 'ok  ' : 'FAIL') + '  ' + got.padEnd(5) + '(want ' + want + ')  ' + label);
}
console.log('\nSUMMARY  guard=' + (guardOk ? 'ok' : 'FAIL') + '  aux=' + (auxOk ? 'ok' : 'FAIL') + '  skip_rules=' + (snippetOk ? 'ok' : 'FAIL'));
