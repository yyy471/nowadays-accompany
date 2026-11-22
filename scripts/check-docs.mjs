#!/usr/bin/env node
/**
 * 仓库文档结构与链接巡检脚本：
 *   1. 体积与单行守卫：防止 AGENTS.md 超限截断，防止 STATUS.md / README.md 再现万字单行
 *   2. 目录纯净与分层检查：禁止在 docs/ 下存放 .log；禁止在 docs/ 根目录继续平铺 NNN-*.md
 *   3. 索引与编号检查：docs/ 全部 .md 文档均需在 docs/README.md 登记、specs/ 文档需在 specs/README.md 登记、全局无重复编号
 *   4. 链接完整性检查：核心文档与归档文档的本地相对链接有效性验证（核心文档额外检查标题锚点）
 *
 * 用法：node scripts/check-docs.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = path.join(root, 'docs');
const specsDir = path.join(docsDir, 'specs');
const archiveDir = path.join(docsDir, 'archive');

const MAX_AGENTS_BYTES = 12 * 1024;
const MAX_LINE_CHARS = 1000;
const ALLOWED_DEVDOC_ROOT_MD = new Set([
  'README.md',
  'STATUS.md',
  '161-digital-life-direction-decisions.md',
]);
// 201–204 保留 205 重构前已移除的 Blender / 早期静态书桌历史引用
const LEGACY_REMOVED_TARGETS = new Set([
  'desktop/desk-preview/tools/render_desk.py',
  'desktop/desk-preview/tools/render_portrait.py',
  'desktop/desk-preview/tools/package_assets.py',
  'tools/art-pipeline/render_desk.py',
  'tools/art-pipeline/render_portrait.py',
  'tools/art-pipeline/package_assets.py',
  'desktop/desk-preview/index.html',
]);
// 归档记录保留当时路径：退役目录不在现行结构中出现，但历史链接不要求复活目标。
const LEGACY_REMOVED_PREFIXES = ['prototypes/'];
const isLegacyRemoved = target => {
  const normalized = rel(target);
  return LEGACY_REMOVED_TARGETS.has(normalized) || LEGACY_REMOVED_PREFIXES.some(prefix => normalized.startsWith(prefix));
};

const errors = [];
const warnings = [];
const addError = (rule, file, message) => errors.push({ rule, file, message });
const addWarn = (rule, file, message) => warnings.push({ rule, file, message });

const rel = target => path.relative(root, target).split(path.sep).join('/');
const relDocs = target => path.relative(docsDir, target).split(path.sep).join('/');

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** GitHub-compatible Markdown heading slugifier (handles CJK + ASCII punctuation). */
function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const headingCache = new Map();
function getHeadingSlugs(filePath) {
  if (headingCache.has(filePath)) return headingCache.get(filePath);
  const slugs = new Set();
  const seen = new Map();
  let inFence = false;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const base = slugify(m[1]);
    if (!base) continue;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${count}`);
  }
  headingCache.set(filePath, slugs);
  return slugs;
}

function checkSizeAndLines(filePath, { maxBytes = Infinity, maxLineChars = MAX_LINE_CHARS } = {}) {
  if (!fs.existsSync(filePath)) {
    addError('docs/missing', rel(filePath), '缺少必需文档');
    return;
  }
  const stat = fs.statSync(filePath);
  if (stat.size > maxBytes) {
    addError('docs/size-limit', rel(filePath), `文件大小 ${stat.size} 字节超过上限 ${maxBytes} 字节`);
  }
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  lines.forEach((line, idx) => {
    if (line.length > maxLineChars) {
      addError('docs/long-line', rel(filePath), `第 ${idx + 1} 行长 ${line.length} 字符，超过上限 ${maxLineChars}`);
    }
  });
}

function checkLinks(filePath, { checkAnchors = false, allowLegacy = false } = {}) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  const dir = path.dirname(filePath);
  let inFence = false;
  const lines = text.split(/\r?\n/);
  lines.forEach((line, idx) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    // Strip inline code spans so patterns like `[text](url)` in prose examples aren't misread.
    const cleaned = line.replace(/`[^`]*`/g, '');
    for (const match of cleaned.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
      const inner = match[1].trim();
      if (inner.startsWith('<')) continue;
      const rawTarget = inner.replace(/\s+"[^"]*"$/, '').trim();
      if (!rawTarget || /^(https?:|mailto:)/i.test(rawTarget)) continue;
      if (rawTarget.startsWith('#')) {
        if (checkAnchors && filePath.endsWith('.md')) {
          const anchor = decodeURIComponent(rawTarget.slice(1));
          if (anchor && !/^L\d+(-L?\d+)?$/i.test(anchor)) {
            const slugs = getHeadingSlugs(filePath);
            if (!slugs.has(anchor.toLowerCase())) {
              addWarn('docs/anchor-mismatch', rel(filePath), `第 ${idx + 1} 行未匹配到页内标题锚点 #${anchor}`);
            }
          }
        }
        continue;
      }
      if (/^file:/i.test(rawTarget)) {
        addError('docs/broken-link', rel(filePath), `第 ${idx + 1} 行禁止使用本机 file:// 链接：${rawTarget}`);
        continue;
      }
      const hashIdx = rawTarget.indexOf('#');
      const pathAndLine = hashIdx >= 0 ? rawTarget.slice(0, hashIdx) : rawTarget;
      const relPart = pathAndLine.replace(/:\d+(?:-\d+)?$/, '');
      if (!relPart) continue;
      const anchor = hashIdx >= 0 ? decodeURIComponent(rawTarget.slice(hashIdx + 1)) : '';
      const resolved = path.resolve(dir, relPart);
      if (!fs.existsSync(resolved)) {
        if (allowLegacy && isLegacyRemoved(resolved)) continue;
        addError('docs/broken-link', rel(filePath), `第 ${idx + 1} 行目标不存在：${rawTarget}`);
        continue;
      }
      if (checkAnchors && anchor && resolved.endsWith('.md') && !/^L\d+(-L?\d+)?$/i.test(anchor)) {
        const slugs = getHeadingSlugs(resolved);
        if (!slugs.has(anchor.toLowerCase())) {
          addWarn('docs/anchor-mismatch', rel(filePath), `第 ${idx + 1} 行未匹配到标题锚点 #${anchor}（目标：${rel(resolved)}）`);
        }
      }
    }
  });
}

// 1. 体积与单行守卫
checkSizeAndLines(path.join(root, 'AGENTS.md'), { maxBytes: MAX_AGENTS_BYTES, maxLineChars: 600 });
checkSizeAndLines(path.join(root, 'README.md'));
checkSizeAndLines(path.join(root, 'apps', 'backend', 'README.md'));
checkSizeAndLines(path.join(docsDir, 'STATUS.md'));
checkSizeAndLines(path.join(docsDir, 'README.md'));

// 2. 禁止运行日志混入 docs/，禁止在 docs/ 根目录继续平铺编号文档
for (const file of walk(docsDir)) {
  if (/\.log$/i.test(file)) {
    addError('docs/no-logs', rel(file), '禁止在 docs/ 下存放 .log 文件，请放入被忽略的 test-results/');
  }
}

for (const entry of fs.readdirSync(docsDir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
  if (!ALLOWED_DEVDOC_ROOT_MD.has(entry.name)) {
    addError('docs/flat-root', `docs/${entry.name}`, 'docs/ 根目录仅保留 README.md、STATUS.md 与 161；长期规范请放入 specs/，阶段记录请放入 archive/');
  }
}

// 3. docs/ 全树索引与全局编号唯一性
const docsReadme = fs.readFileSync(path.join(docsDir, 'README.md'), 'utf8');
const seenNumbers = new Map();
for (const file of walk(docsDir).filter(f => f.endsWith('.md'))) {
  const r = relDocs(file);
  if (r === 'README.md') continue;
  if (!docsReadme.includes(r)) {
    addError('docs/unindexed', rel(file), `未在 docs/README.md 中以路径 ${r} 登记`);
  }
  const base = path.basename(file);
  const numMatch = /^(\d+)-/.exec(base);
  if (numMatch) {
    const num = numMatch[1];
    if (seenNumbers.has(num)) {
      addError('docs/duplicate-id', rel(file), `与 ${seenNumbers.get(num)} 编号 ${num} 冲突`);
    } else {
      seenNumbers.set(num, rel(file));
    }
  }
}

// 4. specs/ 索引检查
if (fs.existsSync(specsDir)) {
  const specsReadmePath = path.join(specsDir, 'README.md');
  if (!fs.existsSync(specsReadmePath)) {
    addError('docs/missing', 'docs/specs/README.md', '缺少规范总览索引');
  } else {
    const specsReadme = fs.readFileSync(specsReadmePath, 'utf8');
    for (const entry of fs.readdirSync(specsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md') {
        if (!specsReadme.includes(entry.name)) {
          addError('docs/unindexed', `docs/specs/${entry.name}`, '未在 docs/specs/README.md 中登记');
        }
      }
    }
  }
}

// 5. 核心文档与归档文档链接检查
const coreDocs = [
  path.join(root, 'AGENTS.md'),
  path.join(root, 'README.md'),
  path.join(root, 'apps', 'backend', 'README.md'),
  path.join(root, 'apps', 'desktop', 'ART-GENERATION-GUIDE.md'),
  path.join(docsDir, 'README.md'),
  path.join(docsDir, 'STATUS.md'),
  path.join(docsDir, '161-digital-life-direction-decisions.md'),
  ...(fs.existsSync(specsDir) ? walk(specsDir).filter(f => f.endsWith('.md')) : []),
];
const coreSet = new Set(coreDocs.map(p => path.resolve(p)));
const archiveDocs = fs.existsSync(archiveDir) ? walk(archiveDir).filter(f => f.endsWith('.md')) : [];

for (const doc of coreDocs) checkLinks(doc, { checkAnchors: true });
for (const doc of archiveDocs) {
  if (coreSet.has(path.resolve(doc))) continue;
  checkLinks(doc, { checkAnchors: false, allowLegacy: true });
}

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify({
    errors,
    warnings,
    checkedCoreDocs: coreDocs.length,
    checkedArchiveDocs: archiveDocs.length,
  }, null, 2)}\n`);
} else {
  for (const w of warnings) process.stdout.write(`[WARN] ${w.rule} ${w.file}: ${w.message}\n`);
  for (const e of errors) process.stderr.write(`[ERR]  ${e.rule} ${e.file}: ${e.message}\n`);
  process.stdout.write(`文档巡检：核心文档 ${coreDocs.length} 份、归档文档 ${archiveDocs.length} 份，错误 ${errors.length}，警告 ${warnings.length}\n`);
}

process.exitCode = errors.length > 0 ? 1 : 0;
