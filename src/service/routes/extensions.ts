import { assertIdentifier, assertKind, type ConversationRef } from '../../routing/identity.js';
import type { ExtensionPolicyUpdateDto } from '../../contracts/extensions.js';
import { HttpError } from '../http/errors.js';
import type { Route } from './types.js';

const BASE = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/extensions$/;
const POLICY = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/extensions\/policy$/;
const EFFECTIVE = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/extensions\/effective$/;
const RELOAD = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/extensions\/reload$/;

/** Account extension catalog, scoped policy CAS, read-only effective state and explicit reload. */
export function extensionRoutes(): Route {
  return async ctx => {
    const { core, request, pathname, url, response, sendJson, runAudited, remote } = ctx;
    const audit = (action: string, id: string) => ({
      action,
      id,
      requestId: ctx.requestId,
      ...(remote() ? { remote: remote() } : {})
    });

    const baseMatch = BASE.exec(pathname);
    if (baseMatch) {
      if (request.method !== 'GET') return false;
      const accountId = assertIdentifier(baseMatch[1] as string, 'accountId');
      sendJson(response, 200, { ok: true, extensions: await core.getExtensionPolicy(accountId) });
      return true;
    }

    const policyMatch = POLICY.exec(pathname);
    if (policyMatch) {
      if (request.method !== 'PUT') return false;
      const accountId = assertIdentifier(policyMatch[1] as string, 'accountId');
      const input = policyUpdate(await ctx.readJson(request));
      const extensions = await runAudited(audit('update_extension_policy', accountId),
        () => core.updateExtensionPolicy(accountId, input));
      sendJson(response, 200, { ok: true, extensions });
      return true;
    }

    const effectiveMatch = EFFECTIVE.exec(pathname);
    if (effectiveMatch && request.method === 'GET') {
      const accountId = assertIdentifier(effectiveMatch[1] as string, 'accountId');
      const kind = url.searchParams.get('kind');
      const peerId = url.searchParams.get('peerId');
      if (!kind || !peerId) {
        throw new HttpError(400, 'kind and peerId are required for an effective extension view', 'invalid_scope');
      }
      const conversation: ConversationRef = {
        accountId,
        kind: assertKind(kind),
        peerId: assertIdentifier(peerId, 'peerId')
      };
      sendJson(response, 200, { ok: true, effective: await core.effectiveExtensions(accountId, conversation) });
      return true;
    }

    const reloadMatch = RELOAD.exec(pathname);
    if (reloadMatch) {
      if (request.method !== 'POST') return false;
      const accountId = assertIdentifier(reloadMatch[1] as string, 'accountId');
      const reload = await runAudited(audit('reload_extensions', accountId),
        () => core.reloadExtensions(accountId));
      sendJson(response, 200, { ok: true, reload });
      return true;
    }

    return false;
  };
}

function policyUpdate(body: Record<string, unknown>): ExtensionPolicyUpdateDto {
  if (typeof body.expectedRevision !== 'string' || body.expectedRevision.length === 0) {
    throw new HttpError(400, 'expectedRevision is required', 'invalid_revision');
  }
  if (body.expectedProfileRevision !== undefined && typeof body.expectedProfileRevision !== 'string') {
    throw new HttpError(400, 'expectedProfileRevision must be a string', 'invalid_revision');
  }
  const patch = body.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new HttpError(400, 'patch must be an object', 'invalid_policy');
  }
  return {
    expectedRevision: body.expectedRevision,
    ...(body.expectedProfileRevision ? { expectedProfileRevision: body.expectedProfileRevision } : {}),
    patch: patch as ExtensionPolicyUpdateDto['patch']
  };
}
