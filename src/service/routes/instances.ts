import { InvalidSpecError } from '../../core/errors.js';
import { assertIdentifier, assertKind } from '../../routing/identity.js';
import { textMessage, type OutboundMessage } from '../../routing/message.js';
import { HttpError } from '../http/errors.js';
import type { Route } from './types.js';

export function instanceRoutes(): Route {
  return async (ctx) => {
    const { core, request, response, pathname, requestId, readJson, sendJson, runAudited, findInstance, remote, logger } = ctx;

    if (request.method === 'GET' && pathname === '/instances') {
      sendJson(response, 200, { ok: true, instances: core.status().instances });
      return true;
    }

    const match = /^\/(?:instances|slots)\/([A-Za-z0-9_-]{1,64})\/(start|stop|send)$/.exec(pathname);
    if (!match || request.method !== 'POST') return false;
    const id = match[1] as string;
    const action = match[2] as 'start' | 'stop' | 'send';
    findInstance(id);
    const remoteAddress = remote();

    if (action === 'start' || action === 'stop') {
      const operation = runAudited({ action, id, requestId, ...(remoteAddress ? { remote: remoteAddress } : {}) }, async () => {
        if (action === 'start') await core.startInstance(id);
        else await core.stopInstance(id);
      });
      const preferAsync = String(request.headers.prefer ?? '').includes('respond-async');
      if (preferAsync) {
        void operation.catch((error: unknown) => {
          logger?.error('async control operation failed', {
            instanceId: id,
            action,
            requestId,
            message: error instanceof Error ? error.message : String(error)
          });
        });
        sendJson(response, 202, { ok: true, accepted: true, operationId: requestId });
        return true;
      }
      await operation;
      const instance = core.status().instances.find((item) => item.id === id);
      sendJson(response, 200, { ok: true, operationId: requestId, instance: instance ?? null, removed: !instance });
      return true;
    }

    const body = await readJson(request);
    const kind = assertKind(typeof body.kind === 'string' ? body.kind : '');
    const peerId = assertIdentifier(typeof body.peerId === 'string' ? body.peerId : '', 'peerId');
    const instance = findInstance(id);
    const accountId = instance.accountId ?? (typeof body.accountId === 'string' ? body.accountId : '');
    if (!accountId) throw new InvalidSpecError('instance has no account yet; pass accountId explicitly');
    const message: OutboundMessage =
      typeof body.text === 'string'
        ? textMessage(body.text)
        : Array.isArray(body.segments)
          ? { segments: body.segments as OutboundMessage['segments'] }
          : (() => {
              throw new HttpError(400, 'send requires text or segments', 'invalid_message');
            })();
    const headerKey = request.headers['idempotency-key'];
    const idempotencyKey =
      (Array.isArray(headerKey) ? headerKey[0] : headerKey) ??
      (typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined);
    const result = await runAudited({ action: 'send', id, requestId, ...(remoteAddress ? { remote: remoteAddress } : {}) }, () =>
      core.send(id, { accountId, kind, peerId }, message, {
        ...(idempotencyKey ? { idempotencyKey } : {}),
        operationId: requestId
      })
    );
    sendJson(response, 200, { ok: true, operationId: requestId, ...result });
    return true;
  };
}
