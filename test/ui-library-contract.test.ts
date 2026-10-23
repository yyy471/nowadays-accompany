import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

async function sources(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sources(file));
    else if (/\.tsx?$/.test(entry.name)) files.push(file);
  }
  return files;
}

describe('frontend component ownership', () => {
  it('keeps native form/button controls and system confirmations out of application pages', async () => {
    const root = path.join(process.cwd(), 'desktop', 'renderer', 'src');
    const violations: string[] = [];
    for (const file of await sources(root)) {
      const relative = path.relative(root, file).replaceAll('\\', '/');
      if (relative.startsWith('ui/')) continue;
      const source = ts.createSourceFile(file, await fs.readFile(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (node: ts.Node) => {
        const location = () => `${relative}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
        if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ['input', 'select', 'textarea', 'button'].includes(node.tagName.getText(source))) {
          violations.push(`${location()} uses native <${node.tagName.getText(source)}>`);
        }
        if (ts.isJsxAttribute(node) && node.name.getText(source) === 'className' && node.initializer
          && /\bbtn(?:-|\b)|\bsearch-box\b|\bicon-btn\b/.test(node.initializer.getText(source))) {
          violations.push(`${location()} hand-builds shared control classes`);
        }
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && ['window', 'globalThis'].includes(node.expression.expression.getText(source))
          && ['confirm', 'alert', 'prompt'].includes(node.expression.name.text)) {
          violations.push(`${location()} uses a system dialog`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(violations, 'Import controls and useConfirm from the shared ../ui entry instead.').toEqual([]);
  });
});
