import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// 从仓库资产生成单文件HTML。正式React页面、生成token文件与业务接口均不修改。
const folder = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(folder, '../../../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const source = ts.createSourceFile('icons.tsx', read('desktop/renderer/src/ui/icons.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let icons;
function walk(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'ICONS') icons = node.initializer;
  ts.forEachChild(node, walk);
}
walk(source);
const symbols = icons.properties.map(property => `<symbol id="i-${property.name.getText(source).replaceAll("'", '')}" viewBox="0 0 24 24">${property.initializer.getText(source).replace(/^\(\s*|\s*\)$/g, '').replaceAll('<>', '').replaceAll('</>', '')}</symbol>`).join('');
const logo = theme => read(`desktop/renderer/src/assets/brand/fold-${theme}.svg`)
  .replace(/id="([^"]+)"/g, (_, id) => `id="${theme}-${id}"`)
  .replace(/url\(#([^)]+)\)/g, (_, id) => `url(#${theme}-${id})`)
  .replace('<svg ', '<svg aria-hidden="true" ');
const items = [['home', 'user', '桌面'], ['roles', 'accounts', '关系'], ['model-config', 'bolt', '模型'], ['artifacts', 'artifacts', '收藏'], ['more', 'more', '更多']]
  .map(([id, icon, name], index) => `<button type="button" class="ui-dock-item${index === 4 ? ' ui-dock-more' : ''}" data-page="${id}" ${index === 2 ? 'aria-current="page"' : ''}><span class="ui-dock-surface" aria-hidden="true"></span><span class="ui-dock-icon" aria-hidden="true"><svg class="icon"><use href="#i-${icon}"/></svg></span><span class="ui-dock-label">${name}</span></button>`).join('');
let html = fs.readFileSync(path.join(folder, 'index.template.html'), 'utf8');
for (const [key, value] of Object.entries({
  TOKENS: read('desktop/renderer/src/ui/character-tokens.css'),
  DOCK_CSS: read('desktop/renderer/src/ui/dock-notebook.css'),
  CSS: fs.readFileSync(path.join(folder, 'sample.css'), 'utf8'),
  JS: fs.readFileSync(path.join(folder, 'sample.js'), 'utf8'),
  ICONS: symbols, LOGO_LIGHT: logo('light'), LOGO_DARK: logo('dark'), DOCK_ITEMS: items
})) html = html.replace(`__${key}__`, () => value);
fs.writeFileSync(path.join(folder, 'index.html'), html);
console.log(`Model configuration HTML: ${Buffer.byteLength(html)} bytes`);
