const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

const scripts = path.resolve(__dirname, '../../scripts');
const rendererDir = path.resolve(__dirname, '../renderer');
// 检查脚本依赖 renderer 的 devDependency postcss；未安装依赖时跳过（与 CI 的 npm ci 流程一致）。
const hasPostcss = fs.existsSync(path.join(rendererDir, 'node_modules/postcss'));
const load = () => import(pathToFileURL(path.join(scripts, 'check-design-tokens.mjs')).href);
const rulesOf = result => result.errors.map(item => item.rule).sort();

test('令牌产物与 tokens.json 同步', () => {
  execFileSync(process.execPath, [path.join(scripts, 'generate-character-theme.mjs'), '--check'], { stdio: 'pipe' });
});

test('renderer 样式不绕过令牌（含文件级豁免上限）', { skip: !hasPostcss && '未安装 renderer 依赖' }, async () => {
  const { run } = await load();
  const result = run();
  assert.deepEqual(result.errors, [], result.errors.map(item => `${item.file}:${item.line} ${item.rule} ${item.message}`).join('\n'));
  assert.ok(result.files > 10);
});

test('六类原始值各自被拦截', { skip: !hasPostcss && '未安装 renderer 依赖' }, async () => {
  const { checkFile } = await load();
  const run = css => rulesOf(checkFile('x.css', css));
  assert.deepEqual(run('a{font-family:"Segoe UI",sans-serif}'), ['ds/font-family']);
  assert.deepEqual(run('a{font:12px/20px "WJ Hand",serif}'), ['ds/font-family']);
  assert.deepEqual(run('a{--sans:"Segoe UI",sans-serif}'), ['ds/font-family']);
  assert.deepEqual(run('a{transition:opacity .2s cubic-bezier(.2,.8,.2,1)}'), ['ds/cubic-bezier', 'ds/duration']);
  assert.deepEqual(run('a{animation:x 300ms ease;animation-delay:90ms}'), ['ds/duration', 'ds/duration']);
  assert.deepEqual(run('a{color:#fff;background:rgba(0,0,0,.4);border-color:hsl(10 20% 30%)}'), ['ds/color', 'ds/color', 'ds/color']);
  assert.deepEqual(run('a{box-shadow:0 6px 18px rgba(0,0,0,.2)}'), ['ds/color', 'ds/shadow']);
  assert.deepEqual(run('a{border-radius:12px 12px 4px 0}'), ['ds/radius', 'ds/radius', 'ds/radius']);
});

test('令牌写法与无害写法通过', { skip: !hasPostcss && '未安装 renderer 依赖' }, async () => {
  const { checkFile } = await load();
  const good = [
    'a{font-family:var(--nd-semantic-font-body);font:12px/20px var(--nd-semantic-font-hand)}',
    'a{font-family:inherit;transition:opacity var(--nd-semantic-motion-micro) var(--nd-semantic-motion-ease-out)}',
    'a{animation-duration:0.01ms!important;transition-duration:0s;animation-delay:calc(var(--i)*var(--nd-semantic-motion-stagger))}',
    'a{color:var(--nd-semantic-color-text);background:rgba(var(--paper-rgb),.65);box-shadow:var(--nd-semantic-shadow-rest)}',
    'a{box-shadow:0 0 0 2px var(--nd-semantic-color-focus);box-shadow:none;box-shadow:inset 0 0 0 1px var(--x)}',
    'a{border-radius:0;border-radius:50%;border-radius:var(--nd-semantic-radius-action);border-radius:calc(var(--r) - 2px)}',
    'a{background:url("data:image/svg+xml;utf8,<svg fill=\'%23fff\'/>")}',
    '@font-face{font-family:"WJ Hand";src:url(x.woff2)}'
  ];
  for (const css of good) assert.deepEqual(checkFile('x.css', css).errors, [], css);
});

test('豁免：块级需要原因，文件级需要数量上限并只减不增', { skip: !hasPostcss && '未安装 renderer 依赖' }, async () => {
  const { checkFile } = await load();
  const block = 'a{/* ds-allow: ds/color — 品牌色与主题无关 */color:#fff;background:#000}';
  assert.deepEqual(rulesOf(checkFile('x.css', block)), ['ds/color']); // 只豁免紧随其后的一条声明
  assert.deepEqual(checkFile('x.css', 'a{/* ds-allow: ds/color — 品牌色与主题无关 */color:#fff}').errors, []);
  assert.deepEqual(rulesOf(checkFile('x.css', 'a{/* ds-allow: ds/color */color:#fff}')), ['ds/exempt']);
  assert.deepEqual(rulesOf(checkFile('x.css', 'a{/* ds-allow: ds/nope — 原因写在这里 */color:#fff}')), ['ds/color', 'ds/exempt']);
  const file = n => `/* ds-allow-file: ds/color=${n} — 旧调板整体迁移前保留 */\na{color:#fff}b{color:#000}`;
  assert.deepEqual(checkFile('x.css', file(2)).errors, []);
  assert.deepEqual(rulesOf(checkFile('x.css', file(1))), ['ds/exempt']);
  assert.deepEqual(rulesOf(checkFile('x.css', '/* ds-allow-file: ds/color — 缺少上限 */\na{color:#fff}')), ['ds/exempt']);
});
