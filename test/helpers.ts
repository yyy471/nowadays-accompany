import fs from 'node:fs/promises';
import path from 'node:path';
import { createCore, type Core, type CoreOptions } from '../src/core/core.js';

export const TEST_ROLE_CARD_ID = 'default';
export const TEST_ROLE_CARD_REVISION = 'r1';
export const TEST_ROLE_CARD_CONTENT = 'You are a helpful test assistant.';

export async function seedRoleCard(dataRoot: string, content = TEST_ROLE_CARD_CONTENT): Promise<void> {
  const dir = path.join(dataRoot, 'public', 'artifacts', 'role-card', TEST_ROLE_CARD_ID, TEST_ROLE_CARD_REVISION);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(dir, 'manifest.json'),
    `${JSON.stringify(
      {
        id: TEST_ROLE_CARD_ID,
        kind: 'role-card',
        revision: TEST_ROLE_CARD_REVISION,
        name: 'Default test role card',
        content
      },
      null,
      2
    )}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
  await fs.mkdir(path.join(dataRoot, 'public'), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(dataRoot, 'public', 'catalog.json'),
    `${JSON.stringify(
      { version: 1, artifacts: { [`role-card:${TEST_ROLE_CARD_ID}`]: TEST_ROLE_CARD_REVISION } },
      null,
      2
    )}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
}

export async function seedProfile(dataRoot: string, accountId: string): Promise<void> {
  const accountDir = path.join(dataRoot, 'accounts', accountId);
  await fs.mkdir(accountDir, { recursive: true, mode: 0o700 });
  const file = path.join(accountDir, 'profile.json');
  try {
    await fs.access(file);
    return;
  } catch {
    // 首次写入
  }
  await fs.writeFile(
    file,
    `${JSON.stringify(
      {
        version: 1,
        roleCard: { source: 'public', id: TEST_ROLE_CARD_ID },
        plugins: []
      },
      null,
      2
    )}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
}

/** 测试里替配置了 accountId 的槽位补齐最小的必填档案；额外账号用于动态换号测试。 */
export async function createTestCore(options: CoreOptions, extraAccounts: string[] = []): Promise<Core> {
  const root = path.resolve(options.dataRoot);
  await seedRoleCard(root);
  const accounts = new Set(extraAccounts);
  for (const spec of options.instances) {
    if (spec.accountId) accounts.add(spec.accountId);
  }
  for (const accountId of accounts) await seedProfile(root, accountId);
  return createCore(options);
}

/** Tests that expect automatic processing must bind each target conversation explicitly. */
export async function bindTestConversation(
  core: Core,
  accountId: string,
  kind: 'private' | 'group',
  peerId: string
): Promise<void> {
  await core.setConversationRoleBinding(
    { accountId, kind, peerId },
    { source: 'public', id: TEST_ROLE_CARD_ID, revision: TEST_ROLE_CARD_REVISION }
  );
}
