import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { parseExtensionSnapshot } from '../src/extensions/use-extensions';

test('旧快照缺失或返回 null 的 tools、ui 均可渲染扩展行', async () => {
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  try {
    const { ExtensionsPage } = await vite.ssrLoadModule('/src/extensions/ExtensionViews.tsx');
    for (const fields of [{}, { tools: null, ui: null }]) {
      const items = parseExtensionSnapshot(JSON.stringify([{ extId: 'legacy', version: 'v1', status: 'enabled', lastError: null, ...fields }]));
      assert.deepEqual([items[0].tools, items[0].ui], [[], []]);
      assert.match(renderToStaticMarkup(createElement(ExtensionsPage, { state: { items }, roles: [] })), /legacy/);
    }
  } finally { await vite.close(); }
});
