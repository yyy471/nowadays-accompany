import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const generatorUrl = pathToFileURL(path.resolve('desktop/scripts/generate-character-theme.mjs')).href;
const { compileTokens, compileWindowThemeTokens } = await import(generatorUrl);
const original = JSON.parse(await fs.readFile('devDoc/design/character-studio/tokens.json', 'utf8'));

describe('design token generation contract', () => {
  it('keeps native window colors generated from the same source as UI colors', async () => {
    const source = compileWindowThemeTokens(original);
    expect(source).toBe((await fs.readFile('desktop/window-theme-tokens.ts','utf8')).replaceAll('\r\n','\n'));
    const changed = structuredClone(original);changed.presets.nightwave.primitive.color.desk = '#112233';
    expect(compileWindowThemeTokens(changed)).toContain('"backgroundColor": "#112233"');
  });
  it('keeps generated CSS fresh, scoped, and every themed CSS reference resolvable', async () => {
    const generated = compileTokens(original);
    expect(generated).toBe((await fs.readFile('desktop/renderer/src/ui/character-tokens.css', 'utf8')).replaceAll('\r\n', '\n'));
    expect(generated).not.toContain(':root');
    const names = new Set([...generated.matchAll(/(--nd-[\w-]+):/g)].map(match => match[1]));
    for (const file of ['desktop/renderer/src/ui/character-theme.css', 'desktop/renderer/src/ui/navigation-appearance.css', 'desktop/renderer/src/ui/studio-appearance.css', 'desktop/renderer/src/ui/preset-appearance.css', 'desktop/renderer/src/styles/shell.css', 'desktop/renderer/src/styles/home.css', 'desktop/renderer/src/workbench/workbench.css']) {
      const text = await fs.readFile(file, 'utf8');
      for (const match of text.matchAll(/var\((--nd-[\w-]+)/g)) expect(names.has(match[1]), `${file}: ${match[1]}`).toBe(true);
    }
  });
  it('rejects missing references instead of silently falling back to unstyled controls', () => {
    const doc = structuredClone(original); doc.semantic.color.text = '@primitive.color.missing';
    expect(() => compileTokens(doc)).toThrow('Missing reference');
  });
  it('validates night overrides with the same layer/reference rules', () => {
    const doc = structuredClone(original); doc.presets.nightwave.primitive.color.ink = 'white; display:none';
    expect(() => compileTokens(doc)).toThrow('Unsafe token value');
    const unknown = structuredClone(original); unknown.presets.nightwave.primitive.color.unusedTypo = '#fff';
    expect(() => compileTokens(unknown)).toThrow('Unknown preset token');
    expect(compileTokens(original)).toContain('[data-ui-preset="nightwave"]');
  });
  it('rejects cyclic aliases', () => {
    const doc = structuredClone(original); doc.primitive.color.ink = '@semantic.color.text';
    expect(() => compileTokens(doc)).toThrow('Cyclic reference');
  });
  it('enforces layers and rejects values that could escape a generated declaration', () => {
    const doc = structuredClone(original); doc.component.button.background = '@primitive.color.navy';
    expect(() => compileTokens(doc)).toThrow('Component must reference semantic');
    const injected = structuredClone(original); injected.primitive.color.paper = 'white; } body { display:none';
    expect(() => compileTokens(injected)).toThrow('Unsafe token value');
  });
});
