import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import * as React from 'react';
import { DraftRegistry } from '../desktop/renderer/src/lib/drafts/registry';
import { TransitionController } from '../desktop/renderer/src/lib/drafts/transition-controller';
vi.stubGlobal('React', React);
afterAll(() => vi.unstubAllGlobals());

const h = vi.hoisted(() => ({
  cells: [] as any[],
  index: 0,
  effects: [] as Array<() => any>,
  protection: null as any,
  api: vi.fn(),
  poll: null as any,
  confirm: null as any
}));

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: any) => {
    const index = h.index++;
    const cells = h.cells;
    if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
    return [cells[index], (value: any) => { cells[index] = typeof value === 'function' ? value(cells[index]) : value; }];
  },
  useRef: (value: any) => { const index = h.index++; return h.cells[index] ??= { current: value }; },
  useMemo: (fn: any) => { h.index++; return fn(); },
  useEffect: (effect: () => any, deps: unknown[]) => {
    const index = h.index++;
    const before = h.cells[index];
    if (!before || deps.some((dep, i) => !Object.is(dep, before[i]))) h.effects.push(effect);
    h.cells[index] = deps;
  }
}));

vi.mock('../desktop/renderer/src/components/DraftProtectionProvider', () => ({ useDraftProtection: () => h.protection }));
vi.mock('../desktop/renderer/src/api', () => ({
  api: (...args: any[]) => h.api(...args),
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    constructor(message: string, status = 400, code = 'http_error') { super(message); this.status = status; this.code = code; }
  }
}));
vi.mock('../desktop/renderer/src/hooks', () => ({
  errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
  usePoll: () => h.poll
}));
vi.mock('../desktop/renderer/src/ui', () => ({
  Button: 'Button',
  CancelButton: 'CancelButton',
  ConfirmButton: 'ConfirmButton',
  ControlButton: 'ControlButton',
  Modal: 'Modal',
  ErrorNote: 'ErrorNote',
  Field: 'Field',
  Input: 'Input',
  Checkbox: 'Checkbox',
  Textarea: 'Textarea',
  Card: 'Card',
  Empty: 'Empty',
  Icon: 'Icon',
  LoadingNote: 'LoadingNote',
  Select: 'Select',
  Tag: 'Tag',
  copyText: vi.fn(),
  useConfirm: () => h.confirm
}));

import { ExtensionsPage } from '../desktop/renderer/src/pages/Extensions';
import { PublicSkillLibrary } from '../desktop/renderer/src/components/PublicSkillLibrary';
import { SkillDefinitionEditor } from '../desktop/renderer/src/components/SkillDefinitionEditor';
import { ApiError } from '../desktop/renderer/src/api';

const PLUGIN_KEY = 'public/plugin/demo';
const PLUGIN_TOOL = `${PLUGIN_KEY}/query`;
const PLUGIN_SKILL = `${PLUGIN_KEY}/skill/helper`;

const catalog = {
  plugins: [{
    key: PLUGIN_KEY,
    source: 'public' as const,
    id: 'demo',
    revision: 'r1',
    configDigest: 'digest',
    name: 'Demo plugin',
    tools: [PLUGIN_TOOL],
    hooks: [],
    skills: [PLUGIN_SKILL],
    stateVersion: '1',
    accountSharedState: true
  }],
  tools: [
    {
      id: 'builtin.image.generate',
      name: 'generate_image',
      label: '生图',
      description: 'Generate images.',
      owner: { kind: 'builtin' as const },
      effect: 'action' as const,
      inputSchema: {},
      capability: 'image.generate' as const,
      timeoutMs: 30_000,
      maxArgumentBytes: 1_024,
      maxResultBytes: 1_024,
      handlerReady: true
    },
    {
      id: PLUGIN_TOOL,
      name: 'p_public_demo_query',
      description: 'Look up local data.',
      owner: { kind: 'plugin' as const, source: 'public' as const, pluginId: 'demo' },
      effect: 'read' as const,
      inputSchema: {},
      timeoutMs: 1_000,
      maxArgumentBytes: 1_024,
      maxResultBytes: 1_024,
      handlerReady: false,
      pluginKey: PLUGIN_KEY
    }
  ],
  hooks: [],
  skills: [
    { id: 'draw', name: 'Draw', instructions: 'DRAW', tools: [], source: 'public' as const, defaultEnabled: true },
    { id: PLUGIN_SKILL, name: 'Plugin helper', instructions: 'HELP', tools: [PLUGIN_TOOL], source: 'plugin' as const, pluginKey: PLUGIN_KEY, defaultEnabled: false }
  ]
};

function policy(accountId: string, overrides: Record<string, unknown> = {}): any {
  return {
    accountId,
    revision: accountId === '10001' ? 'rev1' : 'rev2',
    profileRevision: `profile-${accountId}`,
    configVersion: 1,
    authorizedTools: [],
    defaults: {},
    byKind: {},
    byConversation: {},
    catalog,
    runtime: {
      synced: true,
      readyPlugins: [],
      readyTools: [],
      plugins: [{ pluginKey: PLUGIN_KEY, revision: 'r1', ready: false, reason: 'plugin handshake failed', tools: [], hooks: [] }]
    },
    ...overrides
  };
}

const privateList = {
  accountId: '10001',
  revision: 'priv1',
  limits: { maxInstructionsChars: 8_000, maxTools: 8, maxSkills: 8, maxTotalInstructionsChars: 16_000 },
  skills: [{ id: 'draw', name: 'Draw private', instructions: 'PRIVATE DRAW', tools: [], source: 'private' as const, overrides: 'public' as const }]
};

const publicList = {
  revision: 'pub1',
  limits: { maxInstructionsChars: 8_000, maxTools: 8, maxSkills: 8, maxTotalInstructionsChars: 16_000 },
  skills: [{ id: 'draw', name: 'Draw', instructions: 'DRAW', tools: [], source: 'public' as const }]
};

const effective = {
  accountId: '10001',
  conversation: { accountId: '10001', kind: 'private', peerId: '555' },
  plugins: catalog.plugins,
  tools: [
    { tool: catalog.tools[0], enabled: false, authorized: true, switchSource: 'conversation', issues: [{ code: 'switch_off' }] },
    { tool: catalog.tools[1], enabled: false, authorized: true, switchSource: 'default', issues: [{ code: 'handler_not_ready' }] }
  ],
  hooks: [],
  skills: [
    { skill: catalog.skills[0], enabled: true, switchSource: 'default', issues: [], unavailableTools: [] },
    { skill: catalog.skills[1], enabled: false, switchSource: 'default', issues: [{ code: 'skill_tool_unavailable', detail: PLUGIN_TOOL }], unavailableTools: [PLUGIN_TOOL] }
  ],
  states: [{ pluginKey: PLUGIN_KEY, accountSharedState: true, enabled: false, switchSource: 'default' }]
};

const preview = {
  accountId: '10001',
  conversation: { accountId: '10001', kind: 'private', peerId: '555' },
  limits: { maxInstructionsChars: 8_000, maxTools: 8, maxSkills: 8, maxTotalInstructionsChars: 16_000 },
  instructionsChars: 4,
  runtimeMayTrim: true,
  skills: [{
    id: 'draw', name: 'Draw', source: 'public', enabled: true, issues: [], unavailableTools: [],
    instructions: 'DRAW', tools: [], switchSource: 'default', instructionsChars: 4, toolCount: 0, selected: true
  }],
  included: ['draw'],
  excluded: []
};

function accountsResponse() {
  return {
    accounts: ['10001', '10002'].map((accountId) => ({
      accountId,
      state: 'ready' as const,
      nickname: accountId,
      dir: '',
      slots: [],
      file: { version: 1 as const, plugins: [] }
    }))
  };
}

function artifactsResponse() {
  return {
    ok: true as const,
    current: { 'plugin:demo': 'r1' },
    artifacts: [{
      ref: { source: 'public' as const, id: 'demo', revision: 'r1' },
      manifest: { id: 'demo', kind: 'plugin' as const, revision: 'r1', name: 'Demo plugin', description: 'Demo', entry: 'index.mjs', apiVersion: 1 }
    }]
  };
}

function pageProps(overrides: Record<string, unknown> = {}) {
  return {
    accounts: accountsResponse(),
    accountsLoading: false,
    artifacts: artifactsResponse(),
    artifactsLoading: false,
    refresh: async () => {},
    onRetryArtifacts: async () => {},
    onGoSlots: () => {},
    ...overrides
  } as any;
}

function childValues(node: any): any[] {
  const values = [node.props?.children, node.props?.actions];
  return values.flatMap((value) => Array.isArray(value) ? value : [value]);
}
function find(node: any, predicate: (node: any) => boolean): any {
  if (!node || typeof node !== 'object') return;
  if (predicate(node)) return node;
  for (const child of childValues(node)) {
    const result = find(child, predicate);
    if (result) return result;
  }
}
function all(node: any, predicate: (node: any) => boolean): any[] {
  if (!node || typeof node !== 'object') return [];
  return [...(predicate(node) ? [node] : []), ...childValues(node).flatMap((child) => all(child, predicate))];
}
function textOf(node: any): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return '';
  const extra = [node.props?.title, node.props?.subtitle, node.props?.message].filter((value) => typeof value === 'string');
  return [...extra, ...childValues(node).map(textOf)].join(' ').replace(/\s+/g, ' ').trim();
}
function switchNodes(tree: any): any[] {
  return all(tree, n => typeof n.type === 'function' && n.props && 'inherited' in n.props && typeof n.props.onChange === 'function');
}
function run<T>(fn: () => T, cells = h.cells): T {
  h.cells = cells;
  h.index = 0;
  h.effects = [];
  const tree = fn();
  for (const effect of h.effects) effect();
  return tree;
}
async function settle() { for (let i = 0; i < 64; i += 1) await Promise.resolve(); }

function defaultApi(url: string): any {
  if (url === '/accounts/10001/extensions') return Promise.resolve({ extensions: policy('10001') });
  if (url === '/accounts/10002/extensions') return Promise.resolve({ extensions: policy('10002') });
  if (url === '/accounts/10001/skills/private') return Promise.resolve(privateList);
  if (url === '/accounts/10002/skills/private') return Promise.resolve({ ...privateList, accountId: '10002', revision: 'priv2', skills: [] });
  if (url === '/skills') return Promise.resolve(publicList);
  if (url.includes('/extensions/effective')) return Promise.resolve({ effective });
  if (url.includes('/skills/effective')) return Promise.resolve({ preview });
  if (url.endsWith('/extensions/policy')) return Promise.resolve({ extensions: policy('10001', { revision: 'rev-next' }) });
  return Promise.reject(new Error(`unexpected api ${url}`));
}

beforeEach(() => {
  h.cells = [];
  h.api.mockReset();
  h.api.mockImplementation(defaultApi);
  h.poll = { data: publicList, loading: false, refresh: vi.fn() };
  h.confirm = vi.fn(async () => true);
  const registry = new DraftRegistry();
  const controller = new TransitionController(registry);
  h.protection = {
    registry,
    requestTransition: vi.fn((options: any) => controller.request({ ...options, confirm: h.confirm }))
  };
});

async function renderLoaded(props = pageProps()) {
  let tree = run(() => ExtensionsPage(props));
  tree = run(() => ExtensionsPage(props));
  await settle();
  tree = run(() => ExtensionsPage(props));
  return tree;
}

it('edits inherited switches, authorizes tools and saves an exact policy patch', async () => {
  let tree = await renderLoaded();
  expect(find(tree, n => n.type === 'Select' && n.props.value === '10001')).toBeDefined();
  expect(all(tree, n => n.type === 'Tag').some((tag) => String(tag.props.children).includes('未就绪'))).toBe(true);
  expect(textOf(tree)).toContain('启动失败');

  const pluginSwitch = switchNodes(tree)[0];
  pluginSwitch.props.onChange('on');
  tree = run(() => ExtensionsPage(pageProps()));
  expect(h.protection.registry.snapshot().find((entry: any) => entry.id === 'extensions-policy:10001')).toMatchObject({ dirty: true });

  find(tree, n => n.type === 'ControlButton' && n.props.children === '工具授权').props.onClick();
  tree = run(() => ExtensionsPage(pageProps()));
  const authChecks = all(tree, n => n.type === 'Checkbox');
  authChecks[1].props.onChange({ target: { checked: true } });
  tree = run(() => ExtensionsPage(pageProps()));
  find(tree, n => n.type === 'Select' && n.props.value === 'defaults').props.onChange({ target: { value: 'conversation' } });
  tree = run(() => ExtensionsPage(pageProps()));
  find(tree, n => n.type === 'Input' && n.props.placeholder === '输入 QQ 号').props.onChange({ target: { value: '555' } });
  tree = run(() => ExtensionsPage(pageProps()));
  await settle();
  tree = run(() => ExtensionsPage(pageProps()));
  const toolSwitches = switchNodes(tree);
  toolSwitches[1].props.onChange('off');
  tree = run(() => ExtensionsPage(pageProps()));

  find(tree, n => n.type === 'ConfirmButton' && String(n.props.children).includes('保存扩展策略')).props.onClick();
  await settle();
  const save = h.api.mock.calls.find((call) => String(call[0]).endsWith('/extensions/policy'));
  expect(save).toBeDefined();
  const body = JSON.parse((save as any)[1].body);
  expect(body).toMatchObject({
    expectedRevision: 'rev1',
    expectedProfileRevision: 'profile-10001',
    patch: {
      defaults: { plugins: { [PLUGIN_KEY]: 'on' }, tools: { 'builtin.image.generate': 'inherit', [PLUGIN_TOOL]: 'inherit' } },
      byConversation: { 'private/555': { tools: { 'builtin.image.generate': 'inherit', [PLUGIN_TOOL]: 'off' } } }
    }
  });
  expect(body.patch.authorizedTools).toEqual([PLUGIN_TOOL]);
  expect(body.patch.defaults.skills.draw).toBe('inherit');
  expect(body.patch.defaults.state[PLUGIN_KEY]).toBe('inherit');

  tree = run(() => ExtensionsPage(pageProps()));
  expect(textOf(tree)).toContain('目标会话有效状态');
  expect(textOf(tree)).toContain('插件未就绪');
  expect(textOf(tree)).toContain('会话开关关闭');
});

it('blocks account switching while a policy draft is dirty and discards only after confirmation', async () => {
  let tree = await renderLoaded();
  switchNodes(tree)[0].props.onChange('on');
  tree = run(() => ExtensionsPage(pageProps()));
  h.confirm.mockResolvedValue(false);
  find(tree, n => n.type === 'Select' && n.props.value === '10001').props.onChange({ target: { value: '10002' } });
  await settle();
  tree = run(() => ExtensionsPage(pageProps()));
  expect(find(tree, n => n.type === 'Select' && n.props.value === '10001')).toBeDefined();
  expect(h.protection.requestTransition).toHaveBeenLastCalledWith(expect.objectContaining({
    scope: { kind: 'ids', ids: expect.arrayContaining(['extensions-policy:10001']) }
  }));

  h.confirm.mockResolvedValue(true);
  find(tree, n => n.type === 'Select' && n.props.value === '10001').props.onChange({ target: { value: '10002' } });
  await settle();
  tree = run(() => ExtensionsPage(pageProps()));
  await settle();
  tree = run(() => ExtensionsPage(pageProps()));
  expect(find(tree, n => n.type === 'Select' && n.props.value === '10002')).toBeDefined();
  expect(h.api.mock.calls.some((call) => call[0] === '/accounts/10002/extensions')).toBe(true);
  tree = run(() => ExtensionsPage(pageProps()));
  expect(h.protection.registry.snapshot().find((entry: any) => entry.id === 'extensions-policy:10002')).toMatchObject({ dirty: false });
});

it('ignores a slow response for the previous account', async () => {
  let release!: (value: any) => void;
  h.api.mockImplementation((url: string) => {
    if (url === '/accounts/10001/extensions') return new Promise((resolve) => { release = resolve; });
    return defaultApi(url);
  });
  let tree = run(() => ExtensionsPage(pageProps()));
  tree = run(() => ExtensionsPage(pageProps()));
  await settle();
  tree = run(() => ExtensionsPage(pageProps()));
  find(tree, n => n.type === 'Select' && n.props.value === '10001').props.onChange({ target: { value: '10002' } });
  await settle();
  tree = run(() => ExtensionsPage(pageProps()));
  expect(find(tree, n => n.type === 'Select' && n.props.value === '10002')).toBeDefined();

  release({ extensions: policy('10001', { authorizedTools: ['builtin.image.generate'], revision: 'stale' }) });
  await settle();
  tree = run(() => ExtensionsPage(pageProps()));
  find(tree, n => n.type === 'ControlButton' && n.props.children === '工具授权').props.onClick();
  tree = run(() => ExtensionsPage(pageProps()));
  expect(all(tree, n => n.type === 'Checkbox')[0].props.checked).toBe(false);
  expect(find(tree, n => n.type === 'Select' && n.props.value === '10002')).toBeDefined();
});

it('shows skill sources, private editing and read-only prompt selection', async () => {
  let tree = await renderLoaded();
  find(tree, n => n.type === 'ControlButton' && n.props.children === 'Skill').props.onClick();
  tree = run(() => ExtensionsPage(pageProps()));
  expect(textOf(tree)).toContain('覆盖公用');
  find(tree, n => n.type === 'Input' && n.props.placeholder === '对方 QQ').props.onChange({ target: { value: '555' } });
  tree = run(() => ExtensionsPage(pageProps()));
  await settle();
  tree = run(() => ExtensionsPage(pageProps()));
  expect(textOf(tree)).toContain('已注入 1 个 Skill');

  h.api.mockResolvedValueOnce({ skills: { ...privateList, revision: 'priv2', skills: [...privateList.skills, { id: 'new-skill', name: 'New', instructions: 'NEW', tools: [], source: 'private' }] } });
  find(tree, n => n.type === 'Select' && n.props['aria-label'] === '选择公用 Skill').props.onChange({ target: { value: 'draw' } });
  tree = run(() => ExtensionsPage(pageProps()));
  find(tree, n => n.type === 'Button' && n.props.children === '复制到账号').props.onClick();
  await settle();
  const copy = h.api.mock.calls.find((call) => call[1]?.method === 'POST' && String(call[0]).endsWith('/skills/private'));
  expect(copy).toBeDefined();
  expect(JSON.parse((copy as any)[1].body)).toEqual({ copyFrom: 'draw', expectedRevision: 'priv1' });
});

it('saves a new private Skill with the current private revision and draft protection', async () => {
  h.api.mockResolvedValueOnce({ skills: { ...privateList, revision: 'priv2', skills: [...privateList.skills, { id: 'group-summary', name: 'Summary', instructions: 'SUMMARIZE', tools: [], source: 'private' }] } });
  const onSaved = vi.fn();
  const onCancel = vi.fn();
  const cells: any[] = [];
  const render = () => run(() => SkillDefinitionEditor({
    scope: 'private',
    accountId: '10001',
    revision: 'priv1',
    onSaved,
    onCancel
  }), cells);
  let tree = render();
  find(tree, n => n.type === 'Input' && n.props.placeholder === '例如 group-summary').props.onChange({ target: { value: 'group-summary' } });
  tree = render();
  all(tree, n => n.type === 'Input' && n.props.maxLength === 200)[0].props.onChange({ target: { value: 'Summary' } });
  tree = render();
  find(tree, n => n.type === 'Textarea').props.onChange({ target: { value: 'SUMMARIZE' } });
  tree = render();
  expect(h.protection.registry.snapshot().find((entry: any) => entry.id === 'skill-private:10001:new')).toMatchObject({ dirty: true });

  find(tree, n => n.type === 'ConfirmButton').props.onClick();
  await settle();
  expect(h.api).toHaveBeenCalledOnce();
  expect(h.api.mock.calls[0][0]).toBe('/accounts/10001/skills/private');
  expect(JSON.parse(h.api.mock.calls[0][1].body)).toEqual({
    skill: { id: 'group-summary', name: 'Summary', instructions: 'SUMMARIZE', tools: [], enabled: false },
    expectedRevision: 'priv1'
  });
  expect(onSaved).toHaveBeenCalledOnce();
  expect(onSaved.mock.calls[0][0]).toMatchObject({ revision: 'priv2' });
});

it('keeps the draft and explains a CAS conflict instead of overwriting', async () => {
  let tree = await renderLoaded();
  switchNodes(tree)[0].props.onChange('on');
  tree = run(() => ExtensionsPage(pageProps()));
  h.api.mockImplementation((url: string) => url.endsWith('/extensions/policy')
    ? Promise.reject(new ApiError('扩展策略已被修改，请刷新后重试。', 409, 'extension_conflict'))
    : defaultApi(url));
  find(tree, n => n.type === 'ConfirmButton' && String(n.props.children).includes('保存扩展策略')).props.onClick();
  await settle();
  tree = run(() => ExtensionsPage(pageProps()));
  expect(textOf(tree)).toContain('扩展策略已被修改');
  expect(textOf(tree)).toContain('配置已在其他窗口变化');
  expect(h.protection.registry.snapshot().find((entry: any) => entry.id === 'extensions-policy:10001')).toMatchObject({ dirty: true });
});

it('reports a plugin reload failure with its reason', async () => {
  const tree = await renderLoaded();
  h.api.mockImplementation((url: string, init?: RequestInit) => url.endsWith('/extensions/reload') && init?.method === 'POST'
    ? Promise.resolve({ reload: { plugins: [{ pluginKey: PLUGIN_KEY, revision: 'r1', ready: false, reason: 'worker crashed', tools: [], hooks: [] }] } })
    : defaultApi(url));
  find(tree, n => n.type === 'Button' && n.props.children === '重载插件').props.onClick();
  await settle();
  const after = run(() => ExtensionsPage(pageProps()));
  expect(textOf(after)).toContain('启动失败');
  expect(textOf(after)).toContain('worker crashed');
});

it('manages public Skills with impact before deletion and copy to an account', async () => {
  h.api.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/skills' && !init?.method) return Promise.resolve(publicList);
    if (url === '/skills/draw/impact') return Promise.resolve({ impact: { skillId: 'draw', exists: true, defaultEnabled: true, defaultScopesAffected: true, accounts: [{ accountId: '10001', privateOverride: true, switches: [{ scope: 'defaults', value: 'on' }] }] } });
    if (url === '/skills/draw' && init?.method === 'DELETE') return Promise.resolve({ removed: true, impact: { skillId: 'draw', exists: false, defaultEnabled: true, defaultScopesAffected: true, accounts: [{ accountId: '10001', privateOverride: true, switches: [] }] } });
    if (url === '/accounts/10001/skills/private' && init?.method === 'POST') return Promise.resolve({ copied: true, replaced: true });
    if (url === '/accounts/10001/skills/private') return Promise.resolve(privateList);
    return defaultApi(url);
  });
  const props = { accounts: accountsResponse() } as any;
  let tree = run(() => PublicSkillLibrary(props));
  tree = run(() => PublicSkillLibrary(props));
  await settle();
  tree = run(() => PublicSkillLibrary(props));

  find(tree, n => n.type === 'Button' && n.props.children === '删除').props.onClick();
  await settle();
  expect(h.confirm).toHaveBeenCalledWith(expect.objectContaining({
    description: expect.stringContaining('10001')
  }));
  const remove = h.api.mock.calls.find((call) => call[1]?.method === 'DELETE');
  expect(remove).toBeDefined();
  expect(JSON.parse((remove as any)[1].body)).toEqual({ expectedRevision: 'pub1' });

  find(tree, n => n.type === 'Select' && n.props['aria-label'] === '选择公用 Skill').props.onChange({ target: { value: 'draw' } });
  find(tree, n => n.type === 'Select' && n.props['aria-label'] === '复制目标账号').props.onChange({ target: { value: '10001' } });
  tree = run(() => PublicSkillLibrary(props));
  find(tree, n => n.type === 'Button' && n.props.children === '复制为私有').props.onClick();
  await settle();
  const copy = h.api.mock.calls.find((call) => call[1]?.method === 'POST' && String(call[0]).endsWith('/skills/private'));
  expect(copy).toBeDefined();
  expect(JSON.parse((copy as any)[1].body)).toEqual({ copyFrom: 'draw', expectedRevision: 'priv1' });
});

it('reloads plugin workers without replacing policy or install drafts', async () => {
  let tree = await renderLoaded();
  switchNodes(tree)[0].props.onChange('on');
  tree = run(() => ExtensionsPage(pageProps()));
  all(tree, n => n.type === 'Checkbox')[0].props.onChange({ target: { checked: true } });
  tree = run(() => ExtensionsPage(pageProps()));
  expect(h.protection.registry.snapshot().find((entry: any) => entry.id === 'extensions-policy:10001')).toMatchObject({ dirty: true });
  expect(h.protection.registry.snapshot().find((entry: any) => entry.id === 'extensions-install:10001')).toMatchObject({ dirty: true });

  h.api.mockImplementation((url: string, init?: RequestInit) => url === '/accounts/10001/extensions/reload' && init?.method === 'POST'
    ? Promise.resolve({ reload: { plugins: [{ pluginKey: PLUGIN_KEY, revision: 'r1', ready: true, tools: [PLUGIN_TOOL], hooks: [] }] } })
    : defaultApi(url));
  find(tree, n => n.type === 'Button' && n.props.children === '重载插件').props.onClick();
  await settle();
  tree = run(() => ExtensionsPage(pageProps()));

  expect(switchNodes(tree)[0].props.value).toBe('on');
  expect(all(tree, n => n.type === 'Checkbox')[0].props.checked).toBe(true);
  expect(h.protection.registry.snapshot().find((entry: any) => entry.id === 'extensions-policy:10001')).toMatchObject({ dirty: true });
  expect(h.protection.registry.snapshot().find((entry: any) => entry.id === 'extensions-install:10001')).toMatchObject({ dirty: true });
  expect(h.protection.requestTransition).not.toHaveBeenCalled();
  expect(textOf(tree)).toContain('已就绪');
});

it('keeps policy and install drafts when a private Skill is copied', async () => {
  let tree = await renderLoaded();
  switchNodes(tree)[0].props.onChange('on');
  tree = run(() => ExtensionsPage(pageProps()));
  all(tree, n => n.type === 'Checkbox')[0].props.onChange({ target: { checked: true } });
  tree = run(() => ExtensionsPage(pageProps()));
  find(tree, n => n.type === 'ControlButton' && n.props.children === 'Skill').props.onClick();
  tree = run(() => ExtensionsPage(pageProps()));

  h.api.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/accounts/10001/skills/private' && init?.method === 'POST') {
      return Promise.resolve({ skills: { ...privateList, revision: 'priv2', skills: [...privateList.skills, { id: 'copied', name: 'Copied', instructions: 'COPY', tools: [], source: 'private', enabled: false }] }, copied: true, replaced: false });
    }
    return defaultApi(url);
  });
  find(tree, n => n.type === 'Select' && n.props['aria-label'] === '选择公用 Skill').props.onChange({ target: { value: 'draw' } });
  tree = run(() => ExtensionsPage(pageProps()));
  find(tree, n => n.type === 'Button' && n.props.children === '复制到账号').props.onClick();
  await settle();
  tree = run(() => ExtensionsPage(pageProps()));

  expect(h.protection.registry.snapshot().find((entry: any) => entry.id === 'extensions-policy:10001')).toMatchObject({ dirty: true });
  expect(h.protection.registry.snapshot().find((entry: any) => entry.id === 'extensions-install:10001')).toMatchObject({ dirty: true });
  find(tree, n => n.type === 'ControlButton' && n.props.children === '账号插件').props.onClick();
  tree = run(() => ExtensionsPage(pageProps()));
  expect(switchNodes(tree)[0].props.value).toBe('on');
  expect(all(tree, n => n.type === 'Checkbox')[0].props.checked).toBe(true);
});

it('keeps policy and install drafts when a private Skill is saved or deleted', async () => {
  let tree = await renderLoaded();
  switchNodes(tree)[0].props.onChange('on');
  tree = run(() => ExtensionsPage(pageProps()));
  all(tree, n => n.type === 'Checkbox')[0].props.onChange({ target: { checked: true } });
  tree = run(() => ExtensionsPage(pageProps()));
  find(tree, n => n.type === 'ControlButton' && n.props.children === 'Skill').props.onClick();
  tree = run(() => ExtensionsPage(pageProps()));

  h.api.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/accounts/10001/skills/private/draw' && init?.method === 'PUT') {
      return Promise.resolve({ skills: { ...privateList, revision: 'priv2', skills: [{ ...privateList.skills[0], name: 'Saved', instructions: 'SAVED' }] } });
    }
    if (url === '/accounts/10001/skills/private/draw' && init?.method === 'DELETE') {
      return Promise.resolve({ skills: { ...privateList, revision: 'priv3', skills: [] } });
    }
    return defaultApi(url);
  });

  find(tree, n => n.type === 'Button' && n.props.children === '编辑').props.onClick();
  tree = run(() => ExtensionsPage(pageProps()));
  const pageCells = h.cells;
  const editor = find(tree, n => n.type === SkillDefinitionEditor);
  expect(editor.props.revision).toBe('priv1');
  const editorCells: any[] = [];
  const renderEditor = () => run(() => (editor.type as any)(editor.props), editorCells);
  let editorTree = renderEditor();
  find(editorTree, n => n.type === 'Input' && n.props.maxLength === 200).props.onChange({ target: { value: 'Saved' } });
  editorTree = renderEditor();
  find(editorTree, n => n.type === 'Textarea').props.onChange({ target: { value: 'SAVED' } });
  editorTree = renderEditor();
  find(editorTree, n => n.type === 'ConfirmButton').props.onClick();
  await settle();
  tree = run(() => ExtensionsPage(pageProps()), pageCells);
  expect(h.protection.registry.snapshot().find((entry: any) => entry.id === 'extensions-policy:10001')).toMatchObject({ dirty: true });
  expect(h.protection.registry.snapshot().find((entry: any) => entry.id === 'extensions-install:10001')).toMatchObject({ dirty: true });

  find(tree, n => n.type === 'Button' && n.props.children === '删除').props.onClick();
  await settle();
  tree = run(() => ExtensionsPage(pageProps()), pageCells);
  expect(h.protection.registry.snapshot().find((entry: any) => entry.id === 'extensions-policy:10001')).toMatchObject({ dirty: true });
  expect(h.protection.registry.snapshot().find((entry: any) => entry.id === 'extensions-install:10001')).toMatchObject({ dirty: true });
});


it('guards every affected draft before a hard policy reload', async () => {
  let tree = await renderLoaded();
  switchNodes(tree)[0].props.onChange('on');
  tree = run(() => ExtensionsPage(pageProps()));
  all(tree, n => n.type === 'Checkbox')[0].props.onChange({ target: { checked: true } });
  tree = run(() => ExtensionsPage(pageProps()));
  find(tree, n => n.type === 'ControlButton' && n.props.children === 'Skill').props.onClick();
  tree = run(() => ExtensionsPage(pageProps()));
  find(tree, n => n.type === 'Button' && n.props.children === '编辑').props.onClick();
  tree = run(() => ExtensionsPage(pageProps()));
  const privateEditor = find(tree, n => n.type === SkillDefinitionEditor);
  expect(privateEditor).toBeDefined();
  expect(privateEditor.props.revision).toBe('priv1');

  h.confirm.mockResolvedValue(false);
  find(tree, n => n.type === 'Button' && n.props.children === '重新读取').props.onClick();
  await settle();
  tree = run(() => ExtensionsPage(pageProps()));
  expect(h.protection.requestTransition).toHaveBeenLastCalledWith(expect.objectContaining({
    scope: { kind: 'ids', ids: expect.arrayContaining(['extensions-policy:10001', 'extensions-install:10001', 'skill-private:10001:draw']) }
  }));
  expect(find(tree, n => n.type === SkillDefinitionEditor)).toBeDefined();
  expect(h.protection.registry.snapshot().find((entry: any) => entry.id === 'extensions-policy:10001')).toMatchObject({ dirty: true });
  expect(h.protection.registry.snapshot().find((entry: any) => entry.id === 'extensions-install:10001')).toMatchObject({ dirty: true });

  h.confirm.mockResolvedValue(true);
  find(tree, n => n.type === 'Button' && n.props.children === '重新读取').props.onClick();
  await settle();
  tree = run(() => ExtensionsPage(pageProps()));
  await settle();
  tree = run(() => ExtensionsPage(pageProps()));
  expect(find(tree, n => n.type === SkillDefinitionEditor)).toBeUndefined();
  expect(h.protection.registry.snapshot().find((entry: any) => entry.id === 'extensions-policy:10001')).toMatchObject({ dirty: false });
  expect(h.protection.registry.snapshot().find((entry: any) => entry.id === 'extensions-install:10001')).toMatchObject({ dirty: false });
});

it.each([false, true])('preserves enabled=%s when editing an existing public Skill', async (enabled) => {
  const initial = { id: 'draw', name: 'Draw', instructions: 'DRAW', tools: [], source: 'public' as const, enabled };
  h.api.mockResolvedValueOnce({ skills: { revision: 'pub2', skills: [{ ...initial, name: 'Renamed' }] } });
  const onSaved = vi.fn();
  const onCancel = vi.fn();
  const cells: any[] = [];
  const render = () => run(() => SkillDefinitionEditor({
    scope: 'public',
    revision: 'pub1',
    initial,
    onSaved,
    onCancel
  }), cells);
  let tree = render();
  find(tree, n => n.type === 'Input' && n.props.maxLength === 200).props.onChange({ target: { value: 'Renamed' } });
  tree = render();
  find(tree, n => n.type === 'ConfirmButton').props.onClick();
  await settle();
  const save = h.api.mock.calls.find((call) => call[1]?.method === 'PUT' && String(call[0]) === '/skills/draw');
  expect(save).toBeDefined();
  expect(JSON.parse((save as any)[1].body).skill.enabled).toBe(enabled);
});

it('pins the revision of an open public editor across refreshes and same-id recreation', async () => {
  h.poll = { data: structuredClone(publicList), loading: false, refresh: vi.fn() };
  h.api.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/skills' && !init?.method) return Promise.resolve(h.poll.data);
    if (url === '/skills/draw' && init?.method === 'PUT') return Promise.reject(new ApiError('公用 Skill 定义已变化，请刷新后重试。', 409, 'skill_conflict'));
    return defaultApi(url);
  });
  const props = { accounts: accountsResponse() } as any;
  let tree = run(() => PublicSkillLibrary(props));
  tree = run(() => PublicSkillLibrary(props));
  await settle();
  tree = run(() => PublicSkillLibrary(props));
  find(tree, n => n.type === 'Button' && n.props.children === '编辑').props.onClick();
  tree = run(() => PublicSkillLibrary(props));
  let editor = find(tree, n => n.type === SkillDefinitionEditor);
  expect(editor.props.revision).toBe('pub1');
  expect(editor.props.initial.instructions).toBe('DRAW');

  h.poll.data = {
    ...publicList,
    revision: 'pub2',
    skills: [{ ...publicList.skills[0], instructions: 'EXTERNAL BODY' }]
  };
  tree = run(() => PublicSkillLibrary(props));
  editor = find(tree, n => n.type === SkillDefinitionEditor);
  expect(editor.props.revision).toBe('pub1');

  const editorCells: any[] = [];
  const renderEditor = () => run(() => (editor.type as any)(editor.props), editorCells);
  let editorTree = renderEditor();
  find(editorTree, n => n.type === 'Input' && n.props.maxLength === 200).props.onChange({ target: { value: 'Local draft' } });
  editorTree = renderEditor();
  find(editorTree, n => n.type === 'ConfirmButton').props.onClick();
  await settle();
  editorTree = renderEditor();

  const save = h.api.mock.calls.find((call) => call[1]?.method === 'PUT' && String(call[0]) === '/skills/draw');
  expect(save).toBeDefined();
  expect(JSON.parse((save as any)[1].body).expectedRevision).toBe('pub1');
  expect(textOf(editorTree)).toContain('公用 Skill 定义已变化');
  expect(find(editorTree, n => n.type === 'Input' && n.props.maxLength === 200).props.value).toBe('Local draft');
});

it('pins the revision of a new public editor when the list changes', async () => {
  h.poll = { data: structuredClone(publicList), loading: false, refresh: vi.fn() };
  h.api.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/skills' && !init?.method) return Promise.resolve(h.poll.data);
    if (url === '/skills' && init?.method === 'POST') return Promise.reject(new ApiError('公用 Skill 定义已变化，请刷新后重试。', 409, 'skill_conflict'));
    return defaultApi(url);
  });
  const props = { accounts: accountsResponse() } as any;
  let tree = run(() => PublicSkillLibrary(props));
  tree = run(() => PublicSkillLibrary(props));
  await settle();
  tree = run(() => PublicSkillLibrary(props));
  find(tree, n => n.type === 'Button' && n.props.children === '新建公用 Skill').props.onClick();
  tree = run(() => PublicSkillLibrary(props));
  let editor = find(tree, n => n.type === SkillDefinitionEditor);
  expect(editor.props.revision).toBe('pub1');
  expect(editor.props.initial).toBeUndefined();

  h.poll.data = { ...publicList, revision: 'pub2', skills: [...publicList.skills, { id: 'another', name: 'Another', instructions: 'A', tools: [], source: 'public' as const }] };
  tree = run(() => PublicSkillLibrary(props));
  editor = find(tree, n => n.type === SkillDefinitionEditor);
  expect(editor.props.revision).toBe('pub1');

  const editorCells: any[] = [];
  const renderEditor = () => run(() => (editor.type as any)(editor.props), editorCells);
  let editorTree = renderEditor();
  find(editorTree, n => n.type === 'Input' && n.props.placeholder === '例如 group-summary').props.onChange({ target: { value: 'new-skill' } });
  editorTree = renderEditor();
  find(editorTree, n => n.type === 'Input' && n.props.maxLength === 200).props.onChange({ target: { value: 'New skill' } });
  editorTree = renderEditor();
  find(editorTree, n => n.type === 'Textarea').props.onChange({ target: { value: 'NEW BODY' } });
  editorTree = renderEditor();
  find(editorTree, n => n.type === 'ConfirmButton').props.onClick();
  await settle();
  editorTree = renderEditor();

  const save = h.api.mock.calls.find((call) => call[1]?.method === 'POST' && String(call[0]) === '/skills');
  expect(save).toBeDefined();
  expect(JSON.parse((save as any)[1].body).expectedRevision).toBe('pub1');
  expect(JSON.parse((save as any)[1].body).skill.enabled).toBe(false);
  expect(textOf(editorTree)).toContain('公用 Skill 定义已变化');
  expect(find(editorTree, n => n.type === 'Input' && n.props.maxLength === 200).props.value).toBe('New skill');
});

it('uses live plugin readiness instead of the last successful handshake', async () => {
  const staleRuntime = {
    synced: true,
    readyPlugins: [],
    readyTools: [],
    plugins: [{ pluginKey: PLUGIN_KEY, revision: 'r1', ready: true, tools: [PLUGIN_TOOL], hooks: [] }]
  };
  h.api.mockImplementation((url: string) => url === '/accounts/10001/extensions'
    ? Promise.resolve({ extensions: policy('10001', { runtime: staleRuntime }) })
    : defaultApi(url));
  let tree = await renderLoaded();
  expect(textOf(tree)).toContain('已停止');
  expect(textOf(tree)).not.toContain('已就绪');
  expect(textOf(tree)).toContain('上次启动成功后 Worker 已停止');

  h.api.mockImplementation((url: string) => url === '/accounts/10001/extensions'
    ? Promise.resolve({ extensions: policy('10001', { runtime: { ...staleRuntime, readyPlugins: [PLUGIN_KEY], readyTools: [PLUGIN_TOOL] } }) })
    : defaultApi(url));
  find(tree, n => n.type === 'Button' && n.props.children === '刷新状态').props.onClick();
  await settle();
  tree = run(() => ExtensionsPage(pageProps()));
  expect(textOf(tree)).toContain('已就绪');
  expect(textOf(tree)).not.toContain('已停止');

  h.api.mockImplementation((url: string) => url === '/accounts/10001/extensions'
    ? Promise.resolve({ extensions: policy('10001', { runtime: { synced: false, readyPlugins: [], readyTools: [], plugins: [] } }) })
    : defaultApi(url));
  find(tree, n => n.type === 'Button' && n.props.children === '刷新状态').props.onClick();
  await settle();
  tree = run(() => ExtensionsPage(pageProps()));
  expect(textOf(tree)).toContain('未加载');
  expect(textOf(tree)).not.toContain('已就绪');
});
