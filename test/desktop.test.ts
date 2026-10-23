import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Core } from '../src/core/core.js';
import { createTestCore } from './helpers.js';
import { FakeChannel } from '../src/channels/fake.js';
import { silentLogger } from '../src/core/logger.js';

const roots: string[] = [];
const cores: Core[] = [];

const TOKEN = 'desktop-token';

afterEach(async () => {
  await Promise.allSettled(cores.splice(0).map((core) => core.stop()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-desktop-'));
  roots.push(root);
  return root;
}

async function setupDesktop(): Promise<{ core: Core; url: string }> {
  const dataRoot = await tempRoot();
  const uiDir = path.join(dataRoot, 'ui');
  await fs.mkdir(path.join(uiDir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(uiDir, 'index.html'), '<!doctype html><div id="root">desktop</div>', 'utf8');
  await fs.writeFile(path.join(uiDir, 'assets', 'app.js'), 'console.log("desktop")', 'utf8');
  const core = await createTestCore({
    dataRoot,
    instances: [{ id: 'a', backend: 'fake', accountId: '10001' }],
    channelFactory: (context) => new FakeChannel(context, { selfId: context.spec.accountId }),
    api: { enabled: true, port: 0, token: TOKEN, uiDir },
    persistSlots: true,
    logger: silentLogger('desktop-test')
  });
  cores.push(core);
  await core.start();
  const url = core.status().apiUrl;
  if (!url) throw new Error('api url missing');
  return { core, url };
}

function auth(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
}

describe('desktop control plane', () => {
  it('persists slot specs across core restarts', async () => {
    const dataRoot = await tempRoot();
    const first = await createTestCore({
      dataRoot,
      instances: [],
      persistSlots: true,
      logger: silentLogger('desktop-slots')
    });
    cores.push(first);
    await first.addSlot({ id: 'alpha', backend: 'fake' });
    await first.addSlot({ id: 'beta', backend: 'snowluma', runtimeDir: 'D:/runtime' });
    await first.stop();

    const reopened = await createTestCore({
      dataRoot,
      instances: [],
      persistSlots: true,
      logger: silentLogger('desktop-slots')
    });
    cores.push(reopened);
    const specs = reopened.slotSpecs();
    expect(specs.map((spec) => spec.id)).toEqual(['alpha', 'beta']);
    expect(specs.find((spec) => spec.id === 'beta')?.runtimeDir).toBe('D:/runtime');

    await reopened.removeSlot('beta');
    await reopened.stop();

    const third = await createTestCore({
      dataRoot,
      instances: [],
      persistSlots: true,
      logger: silentLogger('desktop-slots')
    });
    cores.push(third);
    expect(third.slotSpecs().map((spec) => spec.id)).toEqual(['alpha']);
  });

  it('can start a fake slot without a custom channel factory', async () => {
    const dataRoot = await tempRoot();
    const core = await createTestCore(
      {
        dataRoot,
        instances: [],
        persistSlots: true,
        autoFakeChannel: true,
        logger: silentLogger('desktop-fake')
      },
      ['10001']
    );
    cores.push(core);
    await core.start();
    await core.addSlot({ id: 'demo', backend: 'fake', accountId: '10001' });
    const instance = core.status().instances.find((item) => item.id === 'demo');
    expect(instance?.state).toBe('online');
    expect(instance?.accountId).toBe('10001');
  });

  it('serves the UI without a token and keeps API routes protected', async () => {
    const { url } = await setupDesktop();
    const index = await fetch(`${url}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('desktop');
    expect(index.headers.get('content-security-policy')).toContain("default-src 'self'");

    const asset = await fetch(`${url}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('text/javascript');

    const fallback = await fetch(`${url}/dashboard/accounts`);
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toContain('desktop');

    const api = await fetch(`${url}/instances`);
    expect(api.status).toBe(401);
  });

  it('lists accounts with profile summaries and reads conversation history', async () => {
    const { core, url } = await setupDesktop();
    const accounts = await fetch(`${url}/accounts`, { headers: auth() });
    expect(accounts.status).toBe(200);
    const accountBody = (await accounts.json()) as {
      accounts: Array<{ accountId: string; state: string; slots: string[]; profile?: { revision: string } }>;
    };
    expect(accountBody.accounts).toHaveLength(1);
    expect(accountBody.accounts[0]).toMatchObject({ accountId: '10001', state: 'ready', slots: ['a'] });
    expect(accountBody.accounts[0]?.profile?.revision).toMatch(/^[0-9a-f]{12}$/);

    const sent = await fetch(`${url}/slots/a/send`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ kind: 'private', peerId: '20002', text: 'hello desktop' })
    });
    expect(sent.status).toBe(200);

    const history = await fetch(`${url}/accounts/10001/conversations/private/20002/messages?limit=20`, {
      headers: auth()
    });
    expect(history.status).toBe(200);
    const body = (await history.json()) as {
      messages: Array<{ direction: string; segments: Array<{ type: string; data: { text?: string } }> }>;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.direction).toBe('out');
    expect(body.messages[0]?.segments[0]?.data.text).toBe('hello desktop');

    const conversations = await fetch(`${url}/conversations?accountId=10001`, { headers: auth() });
    const conversationBody = (await conversations.json()) as { conversations: unknown[] };
    expect(conversationBody.conversations).toHaveLength(1);

    const artifacts = await fetch(`${url}/artifacts`, { headers: auth() });
    const artifactBody = (await artifacts.json()) as { current: Record<string, string> };
    expect(artifactBody.current['role-card:default']).toBe('r1');

    expect(core.status().instances[0]?.state).toBe('online');
  });
});
