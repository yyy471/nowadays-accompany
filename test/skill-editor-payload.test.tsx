import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createTestCore } from './helpers.js';
import { silentLogger } from '../src/core/logger.js';
import type { Core } from '../src/core/core.js';
import { fakeMediaProvider, fakeProvider, writePhase1Config } from './phase1-helpers.js';
import { skillPayloadOf, type SkillForm } from '../desktop/renderer/src/lib/skill-payload';

const roots: string[] = [];
const cores: Core[] = [];

afterEach(async () => {
  await Promise.allSettled(cores.splice(0).map((core) => core.stop()));
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

async function setup(): Promise<Core> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-skill-payload-'));
  roots.push(root);
  await writePhase1Config(root, {
    providers: [fakeProvider('chat'), fakeMediaProvider('media')]
  });
  const core = await createTestCore({ dataRoot: root, instances: [], logger: silentLogger('skill-payload') }, ['10001', '10002']);
  cores.push(core);
  await core.start();
  return core;
}

function form(overrides: Partial<SkillForm> = {}): SkillForm {
  return {
    id: 'draw',
    name: 'Draw',
    description: '',
    instructions: 'DRAW BODY',
    tools: '',
    kinds: [],
    peers: '',
    ...overrides
  };
}

it('keeps a disabled definition disabled through real editor payload saves', async () => {
  const core = await setup();
  const created = await core.savePublicSkill(skillPayloadOf(form()), core.listPublicSkills().revision);
  expect(created.skills[0]).toMatchObject({ id: 'draw', enabled: false });
  const before = await core.previewSkills('10001', { accountId: '10001', kind: 'private', peerId: '42' });
  expect(before.included).toEqual([]);
  expect(before.skills.find((skill) => skill.id === 'draw')).toMatchObject({ enabled: false, selected: false });

  const initial = created.skills[0]!;
  const renamed = await core.savePublicSkill(skillPayloadOf(form({ name: 'Renamed' }), initial), created.revision);
  expect(renamed.skills[0]).toMatchObject({ name: 'Renamed', instructions: 'DRAW BODY', enabled: false });
  const stillDisabled = await core.previewSkills('10001', { accountId: '10001', kind: 'private', peerId: '42' });
  expect(stillDisabled.included).toEqual([]);

  const view = await core.getExtensionPolicy('10001');
  await core.updateExtensionPolicy('10001', {
    expectedRevision: view.revision,
    patch: { defaults: { skills: { draw: 'on' } } }
  });
  const enabledByScope = await core.previewSkills('10001', { accountId: '10001', kind: 'private', peerId: '42' });
  expect(enabledByScope.included).toEqual(['draw']);

  const editAgain = await core.savePublicSkill(
    skillPayloadOf(form({ name: 'Renamed again' }), renamed.skills[0]!),
    renamed.revision
  );
  expect(editAgain.skills[0]).toMatchObject({ name: 'Renamed again', enabled: false });
  expect((await core.previewSkills('10001', { accountId: '10001', kind: 'private', peerId: '42' })).included).toEqual(['draw']);
});

it('keeps an enabled definition enabled and copies stay off until the account scope enables them', async () => {
  const core = await setup();
  const created = await core.savePublicSkill({ ...skillPayloadOf(form({ id: 'summary', name: 'Summary', instructions: 'SUMMARY' })), enabled: true }, core.listPublicSkills().revision);
  expect(created.skills[0]).toMatchObject({ id: 'summary', enabled: true });

  const edited = await core.savePublicSkill(
    skillPayloadOf(form({ id: 'summary', name: 'Summary v2', instructions: 'SUMMARY' }), created.skills[0]!),
    created.revision
  );
  expect(edited.skills[0]).toMatchObject({ name: 'Summary v2', enabled: true });
  expect((await core.previewSkills('10001', { accountId: '10001', kind: 'private', peerId: '42' })).included).toContain('summary');

  const privateBefore = core.listPrivateSkills('10001');
  const copied = await core.copyPublicSkillToPrivate('10001', 'summary', privateBefore.revision);
  expect(copied.skills.skills.find((skill) => skill.id === 'summary')).toMatchObject({ source: 'private', enabled: false });
  expect((await core.previewSkills('10001', { accountId: '10001', kind: 'private', peerId: '42' })).included).not.toContain('summary');

  const privateEdited = await core.savePrivateSkill(
    '10001',
    skillPayloadOf(form({ id: 'summary', name: 'Private summary', instructions: 'SUMMARY' }), copied.skills.skills.find((skill) => skill.id === 'summary')),
    copied.skills.revision
  );
  expect(privateEdited.skills.skills.find((skill) => skill.id === 'summary')).toMatchObject({ name: 'Private summary', enabled: false });
});
