#!/usr/bin/env node
/**
 * 样式令牌检查：renderer/src 下的 CSS 不得绕过设计令牌直接写
 *   ds/font-family   font-family / font 简写 / 字体自定义属性里的字体栈（必须 inherit 或 var(--nd-…)）
 *   ds/cubic-bezier  cubic-bezier(…) 曲线
 *   ds/duration      ms / s 时长与延迟（≤1ms 视为瞬时，除外）
 *   ds/color         十六进制 / rgb() / rgba() / hsl() 色值（rgba(var(--x-rgb), a) 这类只含变量的写法除外）
 *   ds/shadow        带模糊半径的 box-shadow（零模糊的描边环与 var(--nd-…) 令牌除外）
 *   ds/radius        border-radius 的 px 字面量（0、50%、百分比、var()、calc() 除外）
 * 令牌文件 ui/character-tokens.css 是生成物，整体不检查。
 *
 * 豁免（必须写原因）：
 *   /* ds-allow: ds/color, ds/shadow — 原因 *\/              作用于紧随其后的那一条声明或整条规则
 *   /* ds-allow-file: ds/color=12, ds/shadow=3 — 原因 *\/  作用于整个文件；等号后是现有数量上限，超过即报错（只减不增）
 * 用法：node check-design-tokens.mjs [--json] [--list-allow] [--root <renderer/src>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const rootArg = args.includes('--root') ? args[args.indexOf('--root') + 1] : null;
const rendererDir = path.resolve(here, '../desk-preview/renderer');
const srcDir = rootArg ? path.resolve(rootArg) : path.join(rendererDir, 'src');
const require = createRequire(path.join(rendererDir, 'package.json'));
const postcss = require('postcss');

export const RULES = ['ds/font-family', 'ds/cubic-bezier', 'ds/duration', 'ds/color', 'ds/shadow', 'ds/radius'];
const GENERATED = new Set(['ui/character-tokens.css']);

const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full);
  return entry.name.endsWith('.css') ? [full] : [];
});

/** 去掉 url(...) 与字符串，避免把 data URI、路径里的 # 当成色值。 */
const scrub = value => value.replace(/url\([^)]*\)/gi, 'url()').replace(/"[^"]*"|'[^']*'/g, '""');
const splitTop = (value, sep = ',') => {
  const parts = []; let depth = 0; let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i];
    if (c === '(') depth += 1; else if (c === ')') depth -= 1;
    else if (c === sep && depth === 0) { parts.push(value.slice(start, i)); start = i + 1; }
  }
  parts.push(value.slice(start));
  return parts.map(part => part.trim()).filter(Boolean);
};
const TIME = /(?<![\w.#-])(\d*\.?\d+)(ms|s)\b/g;
/** 0 与 ≤1ms 视为「瞬时」（reduced 兜底、动画归零），不算时长。 */
const isInstant = (amount, unit) => Number.parseFloat(amount) * (unit === 's' ? 1000 : 1) <= 1;

function checkDeclaration(decl) {
  const prop = decl.prop.toLowerCase();
  const raw = decl.value;
  const value = scrub(raw);
  const found = [];
  const add = (rule, message) => found.push({ rule, message });

  if (prop === 'font-family' || /^--[\w-]*(font|hand|title|mono|sans|display)[\w-]*$/.test(prop)) {
    const isStack = /\b(sans-serif|serif|monospace|system-ui)\b/i.test(value) || /""/.test(value);
    if (prop === 'font-family' ? !/^(inherit|initial|unset|var\(--nd-[\w-]+\))$/.test(value.trim()) && !decl.parent?.type?.includes('atrule') : isStack) add('ds/font-family', `字体栈写死：${raw.slice(0, 60)}`);
  }
  if (prop === 'font' && (/\b(sans-serif|serif|monospace|system-ui)\b/i.test(value) || /""/.test(value))) add('ds/font-family', `font 简写里写死字体栈：${raw.slice(0, 60)}`);
  if (/cubic-bezier\(/i.test(value)) add('ds/cubic-bezier', `曲线写死：${raw.match(/cubic-bezier\([^)]*\)/i)[0]}`);
  if (!/^(font|src)/.test(prop) && !/font-display/.test(prop)) {
    for (const m of value.matchAll(TIME)) if (!isInstant(m[1], m[2])) add('ds/duration', `时长写死：${m[0]}`);
  }
  for (const m of value.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) add('ds/color', `色值写死：${m[0]}`);
  for (const m of value.matchAll(/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*(?!var\()([^)]*)\)/gi)) {
    if (/^[\d.%\s,/-]/.test(m[2]) || /^(from|none)\b/.test(m[2])) add('ds/color', `色值写死：${m[0].slice(0, 40)}`);
  }
  if (prop === 'box-shadow') {
    for (const layer of splitTop(value)) {
      if (/^(none|inherit|initial|unset)$/i.test(layer) || /^var\(--nd-[\w-]*shadow[\w-]*\)$/.test(layer)) continue;
      const bare = layer.replace(/\b(inset)\b/gi, ' ').replace(/(?:rgba?|hsla?|color-mix|var)\((?:[^()]|\([^()]*\))*\)/gi, ' ').replace(/\b(currentcolor|transparent)\b/gi, ' ');
      const lengths = (bare.match(/-?\d*\.?\d+(?:px|em|rem)?/g) ?? []).map(Number.parseFloat);
      const blur = lengths.length >= 3 ? lengths[2] : 0;
      if (blur > 0) add('ds/shadow', `带模糊的投影写死：${layer.slice(0, 60)}`);
    }
  }
  if (prop === 'border-radius' || /^border-(top|bottom|start|end)-(left|right|start|end)-radius$/.test(prop)) {
    for (const m of value.replace(/var\((?:[^()]|\([^()]*\))*\)|calc\((?:[^()]|\([^()]*\))*\)/gi, ' ').matchAll(/(?<![\w.-])(-?\d*\.?\d+)px\b/g)) {
      if (Number.parseFloat(m[1]) !== 0) add('ds/radius', `圆角写死：${m[0]}`);
    }
  }
  return found;
}

/** 注释语法：ds-allow[-file]: ds/rule[=上限], ds/rule2 — 原因 */
function parseAllow(comment) {
  const m = /^\s*ds-allow(-file)?\s*:\s*([^—–]+?)\s*(?:[—–]+\s*(.+?))?\s*$/s.exec(comment.text);
  if (!m) return null;
  const rules = []; const max = {};
  for (const item of m[2].split(',').map(part => part.trim()).filter(Boolean)) {
    const [rule, limit] = item.split('=').map(part => part.trim());
    rules.push(rule); if (limit !== undefined) max[rule] = Number.parseInt(limit, 10);
  }
  return { file: Boolean(m[1]), rules, max, reason: (m[3] ?? '').trim() };
}

export function checkFile(file, cssText, relative = file) {
  const errors = []; const allowed = []; const fileAllow = new Map();
  const root = postcss.parse(cssText, { from: file });
  const at = node => ({ file: relative, line: node.source?.start?.line ?? 0 });
  const validate = (allow, node, needLimit) => {
    for (const rule of allow.rules) {
      if (!RULES.includes(rule)) errors.push({ ...at(node), rule: 'ds/exempt', message: `未知规则 ${rule}` });
      if (needLimit && !Number.isInteger(allow.max[rule])) errors.push({ ...at(node), rule: 'ds/exempt', message: `文件级豁免必须写出现有数量上限，如 ${rule}=12` });
    }
    if (allow.reason.length < 4) errors.push({ ...at(node), rule: 'ds/exempt', message: '豁免必须写明原因（— 之后）' });
  };
  root.walkComments(comment => {
    const allow = parseAllow(comment);
    if (!allow) return;
    validate(allow, comment, allow.file);
    if (!allow.file) return;
    const record = { ...at(comment), scope: 'file', rules: allow.rules, max: allow.max, reason: allow.reason, count: {} };
    allowed.push(record);
    for (const rule of allow.rules) fileAllow.set(rule, record);
  });
  const blockAllow = node => {
    for (let current = node; current && current.type !== 'root'; current = current.parent) {
      const prev = current.prev();
      if (prev?.type === 'comment') { const allow = parseAllow(prev); if (allow && !allow.file) return { allow, anchor: prev }; }
    }
    return null;
  };
  const used = new Map();
  root.walkDecls(decl => {
    for (const hit of checkDeclaration(decl)) {
      const record = fileAllow.get(hit.rule);
      if (record) { record.count[hit.rule] = (record.count[hit.rule] ?? 0) + 1; continue; }
      const ex = blockAllow(decl);
      if (ex && ex.allow.rules.includes(hit.rule)) { used.set(ex.anchor, (used.get(ex.anchor) ?? 0) + 1); continue; }
      errors.push({ ...at(decl), rule: hit.rule, message: `${decl.prop}: ${hit.message}` });
    }
  });
  for (const record of allowed) {
    for (const rule of record.rules) {
      const count = record.count[rule] ?? 0;
      if (count > record.max[rule]) errors.push({ file: relative, line: record.line, rule: 'ds/exempt', message: `${rule} 实际 ${count} 处，超过文件级豁免上限 ${record.max[rule]}；请用令牌或收紧豁免` });
    }
  }
  for (const [anchor, count] of used) { const allow = parseAllow(anchor); allowed.push({ ...at(anchor), scope: 'block', rules: allow.rules, max: {}, reason: allow.reason, count: { _: count } }); }
  return { errors, allowed };
}

export function run(dir = srcDir) {
  const results = { errors: [], allowed: [], files: 0 };
  for (const file of walk(dir).sort()) {
    const relative = path.relative(dir, file).split(path.sep).join('/');
    if (GENERATED.has(relative)) continue;
    const { errors, allowed } = checkFile(file, fs.readFileSync(file, 'utf8'), relative);
    results.errors.push(...errors); results.allowed.push(...allowed); results.files += 1;
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = run();
  if (flag('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    if (flag('--list-allow')) {
      for (const item of result.allowed) {
        const counts = item.scope === 'file' ? item.rules.map(rule => `${rule} ${item.count[rule] ?? 0}/${item.max[rule]}`).join(', ') : `${item.rules.join(',')} ×${item.count._}`;
        process.stdout.write(`${item.file}:${item.line} [${item.scope}] ${counts} — ${item.reason}\n`);
      }
    }
    const byRule = new Map();
    for (const e of result.errors) byRule.set(e.rule, (byRule.get(e.rule) ?? 0) + 1);
    if (!flag('--summary-only')) for (const e of result.errors) process.stdout.write(`${e.file}:${e.line} ${e.rule} ${e.message}\n`);
    const exempt = result.allowed.reduce((sum, item) => sum + Object.values(item.count).reduce((a, b) => a + b, 0), 0);
    process.stdout.write(`样式令牌检查：${result.files} 个 CSS，违规 ${result.errors.length}${[...byRule].map(([r, n]) => `（${r} ${n}）`).join('')}，豁免命中 ${exempt}\n`);
  }
  process.exitCode = result.errors.length ? 1 : 0;
}
