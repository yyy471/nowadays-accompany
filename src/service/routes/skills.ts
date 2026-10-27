import { assertIdentifier, assertKind, type ConversationRef } from '../../routing/identity.js';
import { HttpError } from '../http/errors.js';
import type { Route } from './types.js';

const PUBLIC_IMPACT = /^\/skills\/([A-Za-z0-9._-]{1,64})\/impact$/;
const PUBLIC_SKILL = /^\/skills\/([A-Za-z0-9._-]{1,64})$/;
const PRIVATE_BASE = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/skills\/private(?:\/([A-Za-z0-9._-]{1,64}))?$/;
const PREVIEW = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/skills\/effective$/;

/** Public Skill definitions, account-private definitions and the read-only effective preview. */
export function skillRoutes(): Route {
  return async ctx => {
    const { core, request, pathname, url, response, sendJson, runAudited, remote } = ctx;
    const audit = (action: string, id: string) => ({
      action,
      id,
      requestId: ctx.requestId,
      ...(remote() ? { remote: remote() } : {})
    });

    if (pathname === '/skills') {
      if (request.method === 'GET') {
        sendJson(response, 200, { ok: true, ...core.listPublicSkills() });
        return true;
      }
      if (request.method === 'POST') {
        const body = await ctx.readJson(request);
        const expectedRevision = requireRevision(body);
        const saved = await runAudited(audit('save_public_skill', String(skillIdOf(body) ?? 'skill')),
          () => core.savePublicSkill(skillPayload(body), expectedRevision));
        sendJson(response, 200, { ok: true, ...saved });
        return true;
      }
      return false;
    }

    const impactMatch = PUBLIC_IMPACT.exec(pathname);
    if (impactMatch && request.method === 'GET') {
      sendJson(response, 200, { ok: true, impact: core.publicSkillImpact(impactMatch[1]!) });
      return true;
    }

    const publicMatch = PUBLIC_SKILL.exec(pathname);
    if (publicMatch) {
      const id = publicMatch[1] as string;
      if (request.method === 'PUT') {
        const body = await ctx.readJson(request);
        const expectedRevision = requireRevision(body);
        const payload = skillPayload(body);
        if (payload.id !== undefined && payload.id !== id) {
          throw new HttpError(400, 'skill id does not match the URL', 'invalid_skill');
        }
        payload.id = id;
        const saved = await runAudited(audit('save_public_skill', id),
          () => core.savePublicSkill(payload, expectedRevision));
        sendJson(response, 200, { ok: true, ...saved });
        return true;
      }
      if (request.method === 'DELETE') {
        const body = await ctx.readJson(request);
        const result = await runAudited(audit('delete_public_skill', id),
          () => core.deletePublicSkill(id, requireRevision(body)));
        sendJson(response, 200, { ok: true, ...result });
        return true;
      }
      return false;
    }

    const previewMatch = PREVIEW.exec(pathname);
    if (previewMatch && request.method === 'GET') {
      const accountId = assertIdentifier(previewMatch[1] as string, 'accountId');
      const kind = url.searchParams.get('kind');
      const peerId = url.searchParams.get('peerId');
      if (!kind || !peerId) {
        throw new HttpError(400, 'kind and peerId are required for an effective Skill preview', 'invalid_scope');
      }
      const conversation: ConversationRef = {
        accountId,
        kind: assertKind(kind),
        peerId: assertIdentifier(peerId, 'peerId')
      };
      sendJson(response, 200, { ok: true, preview: await core.previewSkills(accountId, conversation) });
      return true;
    }

    const privateMatch = PRIVATE_BASE.exec(pathname);
    if (privateMatch) {
      const accountId = assertIdentifier(privateMatch[1] as string, 'accountId');
      const id = privateMatch[2];
      if (!id) {
        if (request.method === 'GET') {
          sendJson(response, 200, { ok: true, ...core.listPrivateSkills(accountId) });
          return true;
        }
        if (request.method === 'POST') {
          const body = await ctx.readJson(request);
          const expectedRevision = requireRevision(body);
          const copyFrom = body.copyFrom;
          if (copyFrom !== undefined) {
            if (typeof copyFrom !== 'string' || !copyFrom) {
              throw new HttpError(400, 'copyFrom must be a skill id', 'invalid_skill');
            }
            const copied = await runAudited(audit('copy_public_skill', `${accountId}:${copyFrom}`),
              () => core.copyPublicSkillToPrivate(accountId, copyFrom, expectedRevision));
            sendJson(response, 200, { ok: true, ...copied });
            return true;
          }
          const payload = skillPayload(body);
          const saved = await runAudited(audit('save_private_skill', `${accountId}:${String(payload.id ?? 'skill')}`),
            () => core.savePrivateSkill(accountId, payload, expectedRevision));
          sendJson(response, 200, { ok: true, ...saved });
          return true;
        }
        return false;
      }
      if (request.method === 'PUT') {
        const body = await ctx.readJson(request);
        const expectedRevision = requireRevision(body);
        const payload = skillPayload(body);
        if (payload.id !== undefined && payload.id !== id) {
          throw new HttpError(400, 'skill id does not match the URL', 'invalid_skill');
        }
        payload.id = id;
        const saved = await runAudited(audit('save_private_skill', `${accountId}:${id}`),
          () => core.savePrivateSkill(accountId, payload, expectedRevision));
        sendJson(response, 200, { ok: true, ...saved });
        return true;
      }
      if (request.method === 'DELETE') {
        const body = await ctx.readJson(request);
        const result = await runAudited(audit('delete_private_skill', `${accountId}:${id}`),
          () => core.deletePrivateSkill(accountId, id, requireRevision(body)));
        sendJson(response, 200, { ok: true, ...result });
        return true;
      }
      return false;
    }

    return false;
  };
}

function requireRevision(body: Record<string, unknown>): string {
  if (typeof body.expectedRevision !== 'string' || body.expectedRevision.length === 0) {
    throw new HttpError(400, 'expectedRevision is required', 'invalid_revision');
  }
  return body.expectedRevision;
}

function skillPayload(body: Record<string, unknown>): Record<string, unknown> {
  if (body.skill !== undefined) {
    if (!body.skill || typeof body.skill !== 'object' || Array.isArray(body.skill)) {
      throw new HttpError(400, 'skill must be an object', 'invalid_skill');
    }
    return { ...(body.skill as Record<string, unknown>) };
  }
  const { expectedRevision: _revision, copyFrom: _copyFrom, ...skill } = body;
  return skill;
}

function skillIdOf(body: Record<string, unknown>): unknown {
  const payload = skillPayload(body);
  return payload.id;
}
