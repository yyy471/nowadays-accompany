#!/usr/bin/env node
// 给 nowadays-architecture.html 的标题打品牌字标补丁：
// 将 h1 与 <title> 中的 "nowadays" 统一为全大写 NOWADAYS，包裹 .brand-word，
// 应用 JetBrains Mono + 主题色渐变。脚本可重复执行（幂等）。
// 依赖模板内嵌的 JetBrains Mono 字体（400-800 可变权重），无需网络。
// 用法：node apply-brand-font.mjs [html路径]（默认同目录下 nowadays-architecture.html）。
// 注意：每次 archify finalize 重新生成 HTML 后需要重跑本脚本。

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRAND = 'NOWADAYS';
const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(here, process.argv[2] ?? 'nowadays-architecture.html');
let html = readFileSync(htmlPath, 'utf8');

// 1. 标题品牌词：统一大小写并包裹 .brand-word（兼容已打补丁/未打补丁两种状态）
const h1Pattern = /<h1>(?:<span class="brand-word">)?nowadays(?:<\/span>)?/;
if (!h1Pattern.test(html)) {
  console.error('未找到 <h1> 中的 nowadays，标题结构可能已变化，中止。');
  process.exit(1);
}
html = html.replace(h1Pattern, `<h1><span class="brand-word">${BRAND}</span>`);

// 2. 浏览器标签页标题同步大小写
html = html.replace(/<title>nowadays/, `<title>${BRAND}`);

// 3. 字标样式：先移除旧补丁样式块，再注入最新版（幂等）
const styleBlockPattern = /\n?<style>\n  \/\* 品牌字标补丁[\s\S]*?<\/style>\n<\/head>/;
const style = `<style>
  /* 品牌字标补丁（apply-brand-font.mjs 生成）：JetBrains Mono 全大写 + 主题色渐变 */
  .header h1 .brand-word {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-weight: 700;
    letter-spacing: 0.06em;
    background: linear-gradient(92deg, var(--frontend-stroke), var(--database-stroke) 55%, var(--cloud-stroke));
    -webkit-background-clip: text;
    background-clip: text;
    color: var(--frontend-stroke);
    -webkit-text-fill-color: transparent;
  }
</style>
</head>`;
if (styleBlockPattern.test(html)) {
  html = html.replace(styleBlockPattern, '\n</head>');
}
html = html.replace(/<\/head>/, style);

writeFileSync(htmlPath, html);
console.log(`已打补丁：${htmlPath}`);
