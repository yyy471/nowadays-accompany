import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createTestCore } from './helpers.js';
import { silentLogger } from '../src/core/logger.js';
import type { Core } from '../src/core/core.js';

const roots: string[] = [];
const cores: Core[] = [];

afterEach(async () => {
  await Promise.allSettled(cores.splice(0).map((core) => core.stop()));
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('nowadays-skill-api-')) {
      throw new Error('Unexpected test root');
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

function definition(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: id.toUpperCase(), instructions: `BODY:${id}`, tools: [], ...overrides };
}

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-skill-api-'));
  roots.push(root);
  const core = await createTestCore({
    dataRoot: root,
    instances: [],
    api: { enabled: true, port: 0, token: 'skill-fixture' },
    logger: silentLogger()
  }, ['10001', '10002']);
  cores.push(core);
  await core.start();
  const headers = { authorization: 'Bearer skill-fixture', 'content-type': 'application/json' };
  const base = core.status().apiUrl!;
  return { core, headers, base };
}

async function json(response: Response): Promise<any> {
  return response.json();
}

async function request(base: string, headers: Record<string, string>, pathname: string, init: RequestInit = {}) {
  const response = await fetch(`${base}${pathname}`, { ...init, headers });
  return { status: response.status, body: await json(response) };
}

it('serves public and private Skill CRUD with CAS, copy, impact and read-only preview', async () => {
  const { headers, base } = await setup();

  const empty = await request(base, headers, '/skills');
  expect(empty.status).toBe(200);
  expect(empty.body).toMatchObject({ ok: true, skills: [], limits: { maxSkills: 8, maxTotalInstructionsChars: 16_000 } });

  const created = await request(base, headers, '/skills', {
    method: 'POST',
    body: JSON.stringify({ skill: definition('draw'), expectedRevision: empty.body.revision })
  });
  expect(created.status).toBe(200);
  expect(created.body.skills).toEqual([expect.objectContaining({ id: 'draw', source: 'public' })]);

  const stale = await request(base, headers, '/skills', {
    method: 'POST',
    body: JSON.stringify({ skill: definition('stale'), expectedRevision: empty.body.revision })
  });
  expect(stale.status).toBe(409);
  expect(stale.body.code).toBe('skill_conflict');

  const impact = await request(base, headers, '/skills/draw/impact');
  expect(impact.body.impact).toMatchObject({ skillId: 'draw', exists: true, defaultEnabled: true });

  const preview = await request(base, headers, '/accounts/10001/skills/effective?kind=private&peerId=555');
  expect(preview.status).toBe(200);
  expect(preview.body.preview).toMatchObject({ included: ['draw'], excluded: [] });
  expect(preview.body.preview.skills).toEqual([
    expect.objectContaining({ id: 'draw', source: 'public', selected: true })
  ]);

  const privateEmpty = await request(base, headers, '/accounts/10001/skills/private');
  expect(privateEmpty.body).toMatchObject({ accountId: '10001', skills: [] });
  const copied = await request(base, headers, '/accounts/10001/skills/private', {
    method: 'POST',
    body: JSON.stringify({ copyFrom: 'draw', expectedRevision: privateEmpty.body.revision })
  });
  expect(copied.status).toBe(200);
  expect(copied.body).toMatchObject({ copied: true, replaced: false });
  expect(copied.body.skills.skills).toEqual([
    expect.objectContaining({ id: 'draw', source: 'private', overrides: 'public' })
  ]);

  const edited = await request(base, headers, '/accounts/10001/skills/private/draw', {
    method: 'PUT',
    body: JSON.stringify({
      skill: definition('draw', { instructions: 'PRIVATE BODY' }),
      expectedRevision: copied.body.skills.revision
    })
  });
  expect(edited.status).toBe(200);
  expect(edited.body.skills.skills[0].instructions).toBe('PRIVATE BODY');

  const overridePreview = await request(base, headers, '/accounts/10001/skills/effective?kind=private&peerId=555');
  expect(overridePreview.body.preview.skills).toEqual([
    expect.objectContaining({
      id: 'draw',
      source: 'private',
      overrides: 'public',
      selected: true,
      switchSource: 'default'
    })
  ]);
  const otherAccount = await request(base, headers, '/accounts/10002/skills/effective?kind=private&peerId=555');
  expect(otherAccount.body.preview.skills).toEqual([expect.objectContaining({ id: 'draw', source: 'public' })]);

  const capabilities = await request(base, headers, '/accounts/10001/effective?kind=private&peerId=555');
  expect(capabilities.body.effective.skills.available).toEqual([
    expect.objectContaining({ id: 'draw', source: 'private', instructions: 'PRIVATE BODY', available: true })
  ]);

  // A stale full-policy save from the legacy settings page must not erase Skill definitions.
  const policySave = await request(base, headers, '/accounts/10001/policy', {
    method: 'PUT',
    body: JSON.stringify({
      policy: { allowedProviders: [], crossProviderFallback: false, media: { allowCloudUpload: false } }
    })
  });
  expect(policySave.status).toBe(200);
  const preserved = await request(base, headers, '/accounts/10001/skills/private');
  expect(preserved.body.skills).toEqual([
    expect.objectContaining({ id: 'draw', source: 'private', instructions: 'PRIVATE BODY' })
  ]);

  const staleDelete = await request(base, headers, '/accounts/10001/skills/private/draw', {
    method: 'DELETE',
    body: JSON.stringify({ expectedRevision: privateEmpty.body.revision })
  });
  expect(staleDelete.status).toBe(409);

  const currentPublic = await request(base, headers, '/skills');
  const removed = await request(base, headers, '/skills/draw', {
    method: 'DELETE',
    body: JSON.stringify({ expectedRevision: currentPublic.body.revision })
  });
  expect(removed.status).toBe(200);
  expect(removed.body.impact.accounts).toEqual([
    { accountId: '10001', privateOverride: true, switches: [] }
  ]);
  const after = await request(base, headers, '/skills');
  expect(after.body.skills).toEqual([]);
  const fallback = await request(base, headers, '/accounts/10001/skills/effective?kind=private&peerId=555');
  expect(fallback.body.preview.skills).toEqual([
    expect.objectContaining({ id: 'draw', source: 'private', selected: true })
  ]);
  expect(fallback.body.preview.skills[0].overrides).toBeUndefined();
});

it('validates envelopes and missing definitions', async () => {
  const { headers, base } = await setup();
  const revision = (await request(base, headers, '/skills')).body.revision;

  const noRevision = await request(base, headers, '/skills', {
    method: 'POST',
    body: JSON.stringify({ skill: definition('draw') })
  });
  expect(noRevision.status).toBe(400);

  const overLimit = await request(base, headers, '/skills', {
    method: 'POST',
    body: JSON.stringify({ skill: definition('long', { instructions: 'x'.repeat(8_001) }), expectedRevision: revision })
  });
  expect(overLimit.status).toBe(400);

  const mismatch = await request(base, headers, '/skills/other', {
    method: 'PUT',
    body: JSON.stringify({ skill: definition('draw'), expectedRevision: revision })
  });
  expect(mismatch.status).toBe(400);
  expect(mismatch.body.code).toBe('invalid_skill');

  const missingScope = await request(base, headers, '/accounts/10001/skills/effective');
  expect(missingScope.status).toBe(400);
  expect(missingScope.body.code).toBe('invalid_scope');

  const privateList = await request(base, headers, '/accounts/10001/skills/private');
  const missingCopy = await request(base, headers, '/accounts/10001/skills/private', {
    method: 'POST',
    body: JSON.stringify({ copyFrom: 'missing', expectedRevision: privateList.body.revision })
  });
  expect(missingCopy.status).toBe(404);

  const missingDelete = await request(base, headers, '/skills/missing', {
    method: 'DELETE',
    body: JSON.stringify({ expectedRevision: revision })
  });
  expect(missingDelete.status).toBe(404);
  expect(missingDelete.body.code).toBe('skill_not_found');
});

it('accepts dotted skill ids on every public and private route', async () => {
  const { headers, base } = await setup();
  const created = await request(base, headers, '/skills', {
    method: 'POST',
    body: JSON.stringify({ skill: definition('my.skill'), expectedRevision: (await request(base, headers, '/skills')).body.revision })
  });
  expect(created.status).toBe(200);
  expect((await request(base, headers, '/skills/my.skill/impact')).body.impact).toMatchObject({ skillId: 'my.skill', exists: true });

  const privateList = await request(base, headers, '/accounts/10001/skills/private');
  const copied = await request(base, headers, '/accounts/10001/skills/private', {
    method: 'POST',
    body: JSON.stringify({ copyFrom: 'my.skill', expectedRevision: privateList.body.revision })
  });
  expect(copied.status).toBe(200);
  const edited = await request(base, headers, '/accounts/10001/skills/private/my.skill', {
    method: 'PUT',
    body: JSON.stringify({ skill: definition('my.skill', { instructions: 'EDITED' }), expectedRevision: copied.body.skills.revision })
  });
  expect(edited.status).toBe(200);
  const removedPrivate = await request(base, headers, '/accounts/10001/skills/private/my.skill', {
    method: 'DELETE',
    body: JSON.stringify({ expectedRevision: edited.body.skills.revision })
  });
  expect(removedPrivate.status).toBe(200);
  const removedPublic = await request(base, headers, '/skills/my.skill', {
    method: 'DELETE',
    body: JSON.stringify({ expectedRevision: (await request(base, headers, '/skills')).body.revision })
  });
  expect(removedPublic.status).toBe(200);
});

it('maps unavailable Skill issues to the legacy reason vocabulary in the capabilities view', async () => {
  const { headers, base } = await setup();
  const revision = (await request(base, headers, '/skills')).body.revision;
  const created = await request(base, headers, '/skills', {
    method: 'POST',
    body: JSON.stringify({ skill: definition('group-only', { kinds: ['group'] }), expectedRevision: revision })
  });
  expect(created.status).toBe(200);
  const capabilities = await request(base, headers, '/accounts/10001/effective?kind=private&peerId=555');
  expect(capabilities.body.effective.skills.unavailable).toEqual([
    expect.objectContaining({ id: 'group-only', reason: 'scope_mismatch' })
  ]);
});

it('reports scope availability and prompt selection separately in the capabilities view', async () => {
  const { headers, base } = await setup();
  let revision = (await request(base, headers, '/skills')).body.revision;
  for (let index = 0; index < 9; index += 1) {
    const saved = await request(base, headers, '/skills', {
      method: 'POST',
      body: JSON.stringify({ skill: definition(`skill-${index}`), expectedRevision: revision })
    });
    expect(saved.status).toBe(200);
    revision = saved.body.revision;
  }
  const capabilities = await request(base, headers, '/accounts/10001/effective?kind=private&peerId=555');
  const available = capabilities.body.effective.skills.available;
  expect(available).toHaveLength(9);
  expect(available.filter((skill: { selected?: boolean }) => skill.selected)).toHaveLength(8);
  expect(available.find((skill: { id: string }) => skill.id === 'skill-8')).toMatchObject({
    available: true,
    selected: false,
    selectionReason: 'skill_limit'
  });
  const preview = await request(base, headers, '/accounts/10001/skills/effective?kind=private&peerId=555');
  expect(preview.body.preview.included).toHaveLength(8);
  expect(preview.body.preview.excluded).toEqual([{ id: 'skill-8', reason: 'skill_limit' }]);
});

it('reports instructions_budget omissions through the capabilities view', async () => {
  const { headers, base } = await setup();
  let revision = (await request(base, headers, '/skills')).body.revision;
  for (const id of ['a', 'b', 'c']) {
    const saved = await request(base, headers, '/skills', {
      method: 'POST',
      body: JSON.stringify({ skill: definition(id, { instructions: id.repeat(6_000) }), expectedRevision: revision })
    });
    revision = saved.body.revision;
  }
  const capabilities = await request(base, headers, '/accounts/10001/effective?kind=private&peerId=555');
  const available = capabilities.body.effective.skills.available;
  expect(available).toHaveLength(3);
  expect(available.find((skill: { id: string }) => skill.id === 'a')).toMatchObject({ selected: true });
  expect(available.find((skill: { id: string }) => skill.id === 'b')).toMatchObject({ selected: true });
  expect(available.find((skill: { id: string }) => skill.id === 'c')).toMatchObject({
    available: true,
    selected: false,
    selectionReason: 'instructions_budget'
  });
});
