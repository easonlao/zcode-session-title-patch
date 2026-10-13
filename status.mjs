#!/usr/bin/env node
/**
 * 标题补丁自检：一眼看清补丁状态、标题现状、最近几次标题调用用了什么档位。
 * 用法: node status.mjs [zcode.cjs 路径]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const t = (v) => (v ? new Date(Number(v)).toISOString().replace('T', ' ').slice(0, 19) : '-');
const line = (s) => console.log(s);

// 1) 补丁状态（先看命令行参数，再按常见安装位置逐个试）
const candidates = [
  process.argv[2],
  'D:/Program Files/zcode/resources/glm/zcode.cjs',
  'C:/Program Files/zcode/resources/glm/zcode.cjs',
  process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA + '/Programs/zcode/resources/glm/zcode.cjs' : null,
  process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA + '/zcode/resources/glm/zcode.cjs' : null,
].filter(Boolean);
let bundle = null;
for (const c of candidates) {
  try {
    if (fs.existsSync(c)) {
      bundle = c;
      break;
    }
  } catch {}
}
if (!bundle) {
  line('补丁状态      : 找不到 zcode.cjs，可这样指定：node status.mjs "<路径>"');
} else {
  const c = fs.readFileSync(bundle, 'utf8');
  const patched = c.includes('ZCode 会话标题编辑器') && c.includes('let v=e.optionSpecs.reasoningLevel.values,b=new Set');
  line('补丁状态      : ' + (patched ? '已应用' : '未应用或版本不符'));
  line('zcode.cjs     : ' + bundle);
  line('bundle 修改于 : ' + fs.statSync(bundle).mtime.toISOString().replace('T', ' ').slice(0, 19));
}

// 2) 数据库
const dbPath = path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
const db = new DatabaseSync(dbPath, { readOnly: true });

line('\n== 最近 6 个会话的标题 ==');
const sessions = db
  .prepare('select id,title,title_source,time_title_updated from session order by time_updated desc limit 6')
  .all();
for (const s of sessions) {
  line('  ' + t(s.time_title_updated) + '  [' + String(s.title_source).padEnd(11) + ']  ' + String(s.title).slice(0, 46) + '  (' + s.id.slice(-8) + ')');
}

line('\n== 最近 6 次标题生成调用（variant 应该是 low/medium 之类，不该是 off/disabled）==');
const usage = db
  .prepare("select started_at,variant,status,substr(error_message,1,70) err from model_usage where query_source='session_title' order by rowid desc limit 6")
  .all();
for (const u of usage) {
  line('  ' + t(u.started_at) + '  variant=' + String(u.variant).padEnd(10) + ' ' + u.status.padEnd(9) + ' ' + (u.err || ''));
}
if (usage.length === 0) line('  （还没有任何标题调用记录）');

// 3) 日志
const logDir = path.join(os.homedir(), '.zcode', 'cli', 'log');
const logFile = fs
  .readdirSync(logDir)
  .filter((f) => /^zcode-.*\.jsonl$/.test(f))
  .sort()
  .pop();
const events = [];
for (const l of fs.readFileSync(path.join(logDir, logFile), 'utf8').split('\n')) {
  if (!l.includes('session_title_generation')) continue;
  try {
    const o = JSON.parse(l);
    events.push('  ' + String(o.timestamp).replace('T', ' ').slice(0, 19) + '  ' + o.event + (o.context?.errorMessage ? '  ' + String(o.context.errorMessage).slice(0, 70) : ''));
  } catch {}
}
line('\n== 最近 6 条标题生成事件（' + logFile + '）==');
events.slice(-6).forEach(line);
if (events.length === 0) line('  （没有失败记录）');
