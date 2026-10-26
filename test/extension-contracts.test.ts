import { describe, expect, it } from 'vitest';
import { parseArtifactManifest } from '../src/artifacts/manifest.js';
import {
  builtinToolId,
  parseToolIdentity,
  pluginModelToolName,
  pluginSkillId,
  pluginToolId
} from '../src/extensions/contracts.js';
import { ExtensionRegistry } from '../src/extensions/registry.js';
import { validateToolInputSchema } from '../src/extensions/schema.js';

const emptySchema = { type: 'object', properties: {}, additionalProperties: false };

function pluginManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'demo',
    kind: 'plugin',
    revision: 'r1',
    entry: 'index.mjs',
    apiVersion: 1,
    ...overrides
  };
}

describe('plugin manifest declarations', () => {
  it('parses declared tools, hooks and skills with bounded defaults', () => {
    const parsed = parseArtifactManifest(pluginManifest({
      tools: [{
        id: 'lookup',
        description: 'Look up a deterministic local record.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', maxLength: 200 } },
          required: ['query'],
          additionalProperties: false
        }
      }],
      hooks: [{ name: 'beforeContext' }],
      skills: [{
        id: 'helper',
        name: 'Helper',
        instructions: 'Use lookup for deterministic data.',
        tools: ['lookup', 'builtin.image.generate']
      }]
    }), { strict: true });

    expect(parsed.tools).toEqual([{
      id: 'lookup',
      description: 'Look up a deterministic local record.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', maxLength: 200 } },
        required: ['query'],
        additionalProperties: false
      },
      effect: 'read',
      timeoutMs: 30_000,
      maxArgumentBytes: 16 * 1024,
      maxResultBytes: 8 * 1024
    }]);
    expect(parsed.hooks).toEqual([{ name: 'beforeContext', timeoutMs: 500 }]);
    expect(parsed.skills?.[0]).toMatchObject({
      id: 'helper',
      tools: ['lookup', 'builtin.image.generate']
    });
  });

  it('rejects undeclared tools, duplicate identities and non-plugin declarations', () => {
    expect(() => parseArtifactManifest(pluginManifest({
      tools: [{ id: 'lookup', description: 'lookup', inputSchema: emptySchema }],
      skills: [{ id: 'helper', name: 'Helper', instructions: 'Use it.', tools: ['missing'] }]
    }), { strict: true })).toThrow(/未在本插件中声明/);

    expect(() => parseArtifactManifest(pluginManifest({
      tools: [
        { id: 'lookup', description: 'first', inputSchema: emptySchema },
        { id: 'lookup', description: 'second', inputSchema: emptySchema }
      ]
    }), { strict: true })).toThrow(/重复 id/);

    expect(() => parseArtifactManifest(pluginManifest({
      hooks: [{ name: 'beforeContext' }, { name: 'beforeContext' }]
    }), { strict: true })).toThrow(/重复 hook/);

    expect(() => parseArtifactManifest({
      id: 'demo', kind: 'role-card', revision: 'r1', content: 'role', tools: []
    }, { strict: true })).toThrow(/只有插件/);
  });

  it('rejects unsupported schema keywords and malformed schema bounds', () => {
    expect(() => parseArtifactManifest(pluginManifest({
      tools: [{
        id: 'lookup',
        description: 'lookup',
        inputSchema: { type: 'object', properties: { q: { type: 'string', pattern: '^a' } } }
      }]
    }), { strict: true })).toThrow(/不是受支持的 schema 关键字/);

    expect(() => parseArtifactManifest(pluginManifest({
      tools: [{
        id: 'lookup',
        description: 'lookup',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['missing'] }
      }]
    }), { strict: true })).toThrow(/未声明字段/);

    expect(() => parseArtifactManifest(pluginManifest({
      tools: [{
        id: 'lookup',
        description: 'lookup',
        inputSchema: { type: 'object', properties: { q: { type: 'array', items: { type: 'string' }, minItems: 5, maxItems: 2 } } }
      }]
    }), { strict: true })).toThrow(/不能小于/);
  });

  it('bounds schema depth and serialized size', () => {
    let nested: Record<string, unknown> = { type: 'string' };
    for (let index = 0; index < 10; index += 1) {
      nested = { type: 'object', properties: { [`level${index}`]: nested }, additionalProperties: false };
    }
    expect(() => validateToolInputSchema(nested)).toThrow(/嵌套深度/);

    const manyEnumValues = Array.from({ length: 64 }, (_, index) => `${index}-${'x'.repeat(1_000)}`);
    expect(() => validateToolInputSchema({
      type: 'object',
      properties: { value: { type: 'string', enum: manyEnumValues } }
    })).toThrow(/字节上限/);
  });
});

describe('tool identity and registry', () => {
  it('round-trips identities and derives stable plugin model names', () => {
    const builtin = builtinToolId('image.generate');
    expect(parseToolIdentity(builtin)).toEqual({ kind: 'builtin', toolId: 'image.generate', id: builtin });
    const plugin = pluginToolId('public', 'demo', 'lookup');
    expect(parseToolIdentity(plugin)).toEqual({
      kind: 'plugin',
      source: 'public',
      pluginId: 'demo',
      toolId: 'lookup',
      id: plugin
    });
    expect(pluginSkillId('private', 'demo', 'helper')).toBe('private/plugin/demo/skill/helper');

    const long = pluginToolId('public', 'a'.repeat(64), 'b'.repeat(64));
    const identity = parseToolIdentity(long);
    expect(identity?.kind).toBe('plugin');
    if (identity?.kind !== 'plugin') throw new Error('expected plugin identity');
    const name = pluginModelToolName(identity);
    expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(name).toBe(pluginModelToolName(identity));
    expect(name.length).toBeLessThanOrEqual(64);
  });

  it('rejects duplicate full identities and model-name collisions', () => {
    const registry = new ExtensionRegistry();
    registry.registerTool({ id: 'builtin.echo', name: 'echo_tool', description: 'echo', inputSchema: emptySchema });
    registry.registerTool({ id: 'public/plugin/a.b/c', description: 'first', inputSchema: emptySchema });
    expect(registry.tool('public/plugin/a.b/c')?.name).toBe('p_public_a_b_c');

    expect(errorCode(() => registry.registerTool({
      id: 'public/plugin/a.b/c',
      description: 'duplicate',
      inputSchema: emptySchema
    }))).toBe('duplicate_tool');

    expect(errorCode(() => registry.registerTool({
      id: 'public/plugin/a_b/c',
      description: 'collision',
      inputSchema: emptySchema
    }))).toBe('duplicate_tool_name');

    expect(errorCode(() => registry.registerTool({
      id: 'public/plugin/demo/chat',
      name: 'echo_tool',
      description: 'collision with builtin',
      inputSchema: emptySchema
    }))).toBe('duplicate_tool_name');

    expect(() => registry.registerTool({
      id: 'builtin.unnamed',
      description: 'missing name',
      inputSchema: emptySchema
    })).toThrow(/必须显式声明/);

    expect(() => registry.registerTool({
      id: 'public/plugin/demo/chat',
      owner: { kind: 'plugin', source: 'private', pluginId: 'demo' },
      description: 'wrong owner',
      inputSchema: emptySchema
    })).toThrow(/owner/);
  });

  it('requires capability-less tools to be authorized by the caller resolver', () => {
    // Registry only validates definitions; hard authorization is asserted in the router tests.
    const registry = new ExtensionRegistry();
    registry.registerTool({ id: 'builtin.echo', name: 'echo_tool', description: 'echo', inputSchema: emptySchema });
    expect(registry.listTools()).toMatchObject([{
      id: 'builtin.echo',
      owner: { kind: 'builtin' },
      effect: 'read',
      timeoutMs: 30_000
    }]);
  });
});

function errorCode(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}
