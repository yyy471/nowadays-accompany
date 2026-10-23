import type { ReadOptions } from '../../storage/contract.js';
import { assertIdentifier, assertKind } from '../../routing/identity.js';
import type { Route } from './types.js';

export function conversationRoutes(): Route {
  return async (ctx) => {
    const { core, request, response, pathname, sendJson, url } = ctx;

    if (request.method === 'GET' && pathname === '/conversations') {
      const accountId = url.searchParams.get('accountId') ?? undefined;
      const conversations = await core.listConversations(accountId);
      sendJson(response, 200, { ok: true, conversations });
      return true;
    }

    const historyMatch =
      /^\/accounts\/([A-Za-z0-9_-]{1,64})\/conversations\/(group|private)\/([A-Za-z0-9._-]{1,64})\/messages$/.exec(
        pathname
      );
    if (historyMatch && request.method === 'GET') {
      const accountId = assertIdentifier(historyMatch[1] as string, 'accountId');
      const kind = assertKind(historyMatch[2] as string);
      const peerId = assertIdentifier(historyMatch[3] as string, 'peerId');
      const limitRaw = url.searchParams.get('limit');
      const limit = limitRaw === null ? 100 : Math.min(500, Math.max(1, Number(limitRaw) || 0));
      const afterRaw = url.searchParams.get('afterSeq');
      const beforeRaw = url.searchParams.get('beforeSeq');
      const options: ReadOptions = { limit };
      if (afterRaw !== null && Number.isFinite(Number(afterRaw))) options.afterSeq = Math.max(0, Number(afterRaw));
      if (beforeRaw !== null && Number.isFinite(Number(beforeRaw))) options.beforeSeq = Math.max(0, Number(beforeRaw));
      const messages = await core.readMessages(accountId, { accountId, kind, peerId }, options);
      sendJson(response, 200, { ok: true, accountId, conversation: { accountId, kind, peerId }, messages });
      return true;
    }

    return false;
  };
}
