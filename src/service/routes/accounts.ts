import type { ArtifactRef } from '../../artifacts/types.js';
import { assertIdentifier, assertKind, type ConversationRef } from '../../routing/identity.js';
import { HttpError } from '../http/errors.js';
import type { Route } from './types.js';
import { parseWorldbookSettings } from '../../worldbook/schema.js';

export function accountRoutes(): Route {
  return async (ctx) => {
    const { core, request, response, pathname, requestId, readJson, sendJson, runAudited, remote, url } = ctx;

    if (request.method === 'GET' && pathname === '/accounts') {
      const avatars = url.searchParams.get('avatars') === '1';
      const accounts = await core.listAccounts(avatars ? { avatars: true } : {});
      sendJson(response, 200, { ok: true, accounts });
      return true;
    }

    const privateArtifactsMatch = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/artifacts$/.exec(pathname);
    if (request.method === 'GET' && privateArtifactsMatch) {
      const accountId = assertIdentifier(privateArtifactsMatch[1] as string, 'accountId');
      const artifacts = await core.listAccountArtifacts(accountId);
      sendJson(response, 200, {
        ok: true,
        accountId,
        artifacts: artifacts.map((artifact) => ({ ref: artifact.ref, manifest: artifact.manifest }))
      });
      return true;
    }

    const roleBindingsMatch = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/role-bindings$/.exec(pathname);
    if (roleBindingsMatch && request.method === 'GET') {
      const accountId = assertIdentifier(roleBindingsMatch[1] as string, 'accountId');
      sendJson(response, 200, {
        ok: true,
        accountId,
        bindings: await core.listConversationRoleBindings(accountId)
      });
      return true;
    }

    const worldbookMatch = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/role-bindings\/(group|private)\/([A-Za-z0-9._-]{1,64})\/worldbook(\/preview)?$/.exec(pathname);
    if (worldbookMatch && ((worldbookMatch[4] && request.method === 'POST') || (!worldbookMatch[4] && request.method === 'PUT'))) {
      const conversation: ConversationRef = { accountId: assertIdentifier(worldbookMatch[1]!, 'accountId'), kind: assertKind(worldbookMatch[2]!), peerId: assertIdentifier(worldbookMatch[3]!, 'peerId') };
      const body = await readJson(request);
      if (worldbookMatch[4]) {
        if (typeof body.text !== 'string' || body.text.length > 16000) throw new HttpError(400, '测试文本必须是最多16000字符的文本。', 'invalid_body');
        sendJson(response, 200, { ok: true, evaluation: await core.previewConversationWorldbook(conversation, body.text) });
      } else {
        if (!body.worldbook || typeof body.worldbook !== 'object' || Array.isArray(body.worldbook)
          || typeof body.expectedRevision !== 'string' || !body.expectedRevision || body.expectedRevision.length > 128) throw new HttpError(400, 'worldbook和expectedRevision为必填项。', 'invalid_body');
        const remoteAddress = remote();
        const { expectedRevision, ...rawSettings } = body;
        const settings = parseWorldbookSettings(rawSettings);
        const binding = await runAudited({ action: 'configure_worldbook', id: `${conversation.accountId}/${conversation.kind}/${conversation.peerId}`, requestId,
          ...(remoteAddress ? { remote: remoteAddress } : {}) }, () => core.configureConversationWorldbook(conversation, settings.options, expectedRevision as string, settings.source));
        sendJson(response, 200, { ok: true, binding });
      }
      return true;
    }

    const roleBindingMatch = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/role-bindings\/(group|private)\/([A-Za-z0-9._-]{1,64})$/.exec(pathname);
    if (roleBindingMatch && ['PUT', 'DELETE'].includes(request.method ?? '')) {
      const accountId = assertIdentifier(roleBindingMatch[1] as string, 'accountId');
      const conversation: ConversationRef = {
        accountId,
        kind: assertKind(roleBindingMatch[2] as string),
        peerId: assertIdentifier(roleBindingMatch[3] as string, 'peerId')
      };
      let roleCard: ArtifactRef | null = null;
      if (request.method === 'PUT') {
        const body = await readJson(request);
        if (!body.roleCard || typeof body.roleCard !== 'object' || Array.isArray(body.roleCard)) {
          throw new HttpError(400, 'roleCard is required', 'invalid_role_card');
        }
        const candidate = body.roleCard as Partial<ArtifactRef>;
        if (
          (candidate.source !== 'public' && candidate.source !== 'private') ||
          typeof candidate.id !== 'string' ||
          (candidate.revision !== undefined && typeof candidate.revision !== 'string')
        ) {
          throw new HttpError(400, 'roleCard must be an artifact reference', 'invalid_role_card');
        }
        roleCard = {
          source: candidate.source,
          id: candidate.id,
          ...(candidate.revision ? { revision: candidate.revision } : {})
        };
      }
      const remoteAddress = remote();
      const binding = await runAudited(
        {
          action: request.method === 'PUT' ? 'set_conversation_role' : 'clear_conversation_role',
          id: `${accountId}/${conversation.kind}/${conversation.peerId}`,
          requestId,
          ...(remoteAddress ? { remote: remoteAddress } : {})
        },
        () => core.setConversationRoleBinding(conversation, roleCard)
      );
      sendJson(response, 200, { ok: true, accountId, conversation, binding: binding ?? null });
      return true;
    }

    const profileMatch = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/profile$/.exec(pathname);
    if (profileMatch) {
      const accountId = assertIdentifier(profileMatch[1] as string, 'accountId');
      if (request.method === 'GET') {
        const profile = await core.getAccountProfile(accountId);
        sendJson(response, 200, { ok: true, profile: profile ?? null });
        return true;
      }
      if (request.method === 'PUT') {
        const body = await readJson(request);
        const raw = body.profile && typeof body.profile === 'object' && !Array.isArray(body.profile)
          ? body.profile
          : body;
        const remoteAddress = remote();
        const result = await runAudited(
          { action: 'save_profile', id: accountId, requestId, ...(remoteAddress ? { remote: remoteAddress } : {}) },
          () => core.saveAccountProfile(accountId, raw)
        );
        sendJson(response, 200, { ok: true, ...result });
        return true;
      }
    }

    const displayMatch = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/display$/.exec(pathname);
    if (displayMatch) {
      const accountId = assertIdentifier(displayMatch[1] as string, 'accountId');
      if (request.method === 'GET') {
        sendJson(response, 200, { ok: true, display: await core.getAccountDisplay(accountId) });
        return true;
      }
      if (request.method === 'PUT') {
        const body = await readJson(request);
        const raw = body.display && typeof body.display === 'object' && !Array.isArray(body.display) ? body.display : body;
        const remoteAddress = remote();
        const display = await runAudited(
          { action: 'save_account_display', id: accountId, requestId, ...(remoteAddress ? { remote: remoteAddress } : {}) },
          () => core.saveAccountDisplay(accountId, raw)
        );
        sendJson(response, 200, { ok: true, display });
        return true;
      }
    }

    const reloadMatch = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/reload$/.exec(pathname);
    if (reloadMatch && request.method === 'POST') {
      const accountId = assertIdentifier(reloadMatch[1] as string, 'accountId');
      const remoteAddress = remote();
      const results = await runAudited(
        { action: 'reload_profile', id: accountId, requestId, ...(remoteAddress ? { remote: remoteAddress } : {}) },
        () => core.reloadAccount(accountId)
      );
      sendJson(response, 200, { ok: results.every((item) => item.ok), results });
      return true;
    }

    return false;
  };
}
