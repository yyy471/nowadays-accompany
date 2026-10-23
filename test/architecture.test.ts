import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const src = path.resolve(process.cwd(), 'src');

async function filesUnder(relative: string): Promise<string[]> {
  const root = path.join(src, relative);
  const result: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && /\.(ts|tsx|mts)$/.test(entry.name)) result.push(full);
    }
  };
  await walk(root);
  return result;
}

async function source(file: string): Promise<string> {
  return fs.readFile(file, 'utf8');
}

function importsOf(text: string): string[] {
  const specifiers: string[] = [];
  for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) specifiers.push(match[1] as string);
  for (const match of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(match[1] as string);
  return specifiers;
}

async function violations(
  relative: string,
  forbidden: (specifier: string) => boolean
): Promise<string[]> {
  const found: string[] = [];
  for (const file of await filesUnder(relative)) {
    const imports = importsOf(await source(file));
    for (const specifier of imports) {
      if (forbidden(specifier)) found.push(`${path.relative(src, file)} -> ${specifier}`);
    }
  }
  return found;
}

const facade = (specifier: string): boolean => /(^|\/)core\/core\.(js|ts)$/.test(specifier);
const ui = (specifier: string): boolean => specifier === 'electron' || specifier === 'react' || specifier.startsWith('react-dom');
const routing = (specifier: string): boolean => /(^|\/)service\//.test(specifier);
const domain = (specifier: string): boolean =>
  /(^|\/)(providers|injection|instances|media|jobs|artifacts|profiles|application)\//.test(specifier);

describe('architecture boundaries', () => {
  it('keeps application services independent of the Core facade, HTTP and UI', async () => {
    expect(await violations('application', (specifier) => facade(specifier) || routing(specifier) || ui(specifier))).toEqual([]);
  });

  it('keeps bootstrap free of the Core implementation and UI', async () => {
    expect(await violations('bootstrap', (specifier) => facade(specifier) || routing(specifier) || ui(specifier))).toEqual([]);
  });

  it('keeps HTTP infrastructure and routes free of the Core implementation', async () => {
    expect(await violations('service/http', facade)).toEqual([]);
    expect(await violations('service/routes', facade)).toEqual([]);
  });

  it('keeps platform primitives free of domain and application modules', async () => {
    expect(await violations('platform', (specifier) => facade(specifier) || routing(specifier) || domain(specifier))).toEqual([]);
  });

  it('keeps domain modules free of HTTP and UI implementations', async () => {
    for (const area of ['agent', 'instances', 'injection', 'providers', 'media', 'jobs', 'profiles', 'policy', 'artifacts', 'host', 'storage', 'routing', 'config', 'extensions', 'secrets']) {
      expect(await violations(area, (specifier) => routing(specifier) || ui(specifier) || facade(specifier))).toEqual([]);
    }
  });

  it('keeps contracts browser-safe and implementation-free', async () => {
    expect(await violations('contracts', (specifier) =>
      specifier.startsWith('node:') || ui(specifier) || facade(specifier) || routing(specifier)
    )).toEqual([]);
  });

  it('keeps the renderer free of Node and server imports', async () => {
    const renderer = path.resolve(process.cwd(), 'desktop/renderer/src');
    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        for (const specifier of importsOf(await fs.readFile(full, 'utf8'))) {
          if (specifier.startsWith('node:') || specifier === 'electron' || specifier.includes('/src/core/') || specifier.includes('/src/service/')) {
            found.push(`${path.relative(renderer, full)} -> ${specifier}`);
          }
        }
      }
    };
    await walk(renderer);
    expect(found).toEqual([]);
  });

  it('defines the control port and account DTO exactly once', async () => {
    const definitions: Record<string, string[]> = { CoreView: [], AccountSummary: [] };
    for (const area of ['application', 'contracts', 'core', 'service']) {
      for (const file of await filesUnder(area)) {
        const text = await source(file);
        for (const name of Object.keys(definitions)) {
          if (new RegExp(`interface\\s+${name}\\b`).test(text)) {
            definitions[name]!.push(path.relative(src, file).split(path.sep).join('/'));
          }
        }
      }
    }
    expect(definitions.CoreView).toEqual(['application/ports/control-api.ts']);
    expect(definitions.AccountSummary).toEqual(['contracts/accounts.ts']);
  });

  it('routes HTTP through the route table and static/SSE infrastructure', async () => {
    const server = await source(path.join(src, 'service/server.ts'));
    const imports = importsOf(server);
    expect(imports).toContain('./routes/index.js');
    expect(imports).toContain('./http/static.js');
    expect(imports).toContain('./http/sse.js');
    expect(server).not.toMatch(/request\.method === 'GET' && pathname ===/);
  });
});
