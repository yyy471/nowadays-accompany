import { assertIdentifier, assertKind, conversationKey, type ConversationRef } from '../../routing/identity.js';
import type { Route } from './types.js';

const BASE = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/memory\/(group|private)\/([A-Za-z0-9._-]{1,64})(\/.*)?$/;
const RECORD = /^\/records\/([A-Za-z0-9._-]{1,64})$/;

export function memoryRoutes(): Route {
  return async ctx => {
    const { request, pathname, url, core, response, sendJson, runAudited, remote } = ctx;
    const match = BASE.exec(pathname);
    if (!match) return false;
    const suffix = match[4] ?? '';
    if (suffix !== '' && suffix !== '/settings' && suffix !== '/records' && suffix !== '/preview' && suffix !== '/clear'
      && suffix !== '/extraction' && suffix !== '/extraction/activate' && suffix !== '/extraction/pause'
      && !RECORD.test(suffix)) return false;

    const conversation: ConversationRef = {
      accountId: assertIdentifier(match[1]!, 'accountId'),
      kind: assertKind(match[2]!),
      peerId: assertIdentifier(match[3]!, 'peerId')
    };
    const audit = (action: string) => ({
      action,
      id: conversationKey(conversation),
      requestId: ctx.requestId,
      ...(remote() ? { remote: remote() } : {})
    });

    if (suffix === '' || suffix === '/settings') {
      if (request.method === 'GET') {
        sendJson(response, 200, { ok: true, ...await core.memorySettings(conversation) });
        return true;
      }
      if (request.method === 'PUT') {
        const body = await ctx.readJson(request);
        sendJson(response, 200, { ok: true, ...await runAudited(audit('save_memory_settings'),
          () => core.saveMemorySettings(conversation, body)) });
        return true;
      }
      return false;
    }

    if (suffix === '/extraction') {
      if (request.method !== 'GET') return false;
      sendJson(response, 200, { ok: true, ...await core.memoryExtraction(conversation) });
      return true;
    }

    if (suffix === '/extraction/activate') {
      if (request.method !== 'POST') return false;
      const body = await ctx.readJson(request);
      sendJson(response, 200, { ok: true, ...await runAudited(audit('activate_memory_extraction'),
        () => core.activateMemoryExtraction(conversation, body)) });
      return true;
    }

    if (suffix === '/extraction/pause') {
      if (request.method !== 'POST') return false;
      const body = await ctx.readJson(request);
      sendJson(response, 200, { ok: true, ...await runAudited(audit('pause_memory_extraction'),
        () => core.pauseMemoryExtraction(conversation, body)) });
      return true;
    }

    if (suffix === '/preview') {
      if (request.method !== 'POST') return false;
      const body = await ctx.readJson(request);
      sendJson(response, 200, { ok: true, ...await core.previewMemory(conversation, body) });
      return true;
    }

    if (suffix === '/records') {
      if (request.method === 'GET') {
        const query: Record<string, unknown> = {};
        for (const key of ['offset', 'limit']) if (url.searchParams.has(key)) query[key] = Number(url.searchParams.get(key));
        sendJson(response, 200, { ok: true, ...await core.listMemoryRecords(conversation, query) });
        return true;
      }
      if (request.method === 'POST') {
        const body = await ctx.readJson(request);
        const result = await runAudited(audit('create_memory_record'), () => core.createMemoryRecord(conversation, body));
        sendJson(response, result.created === false ? 200 : 201, { ok: true, ...result });
        return true;
      }
      return false;
    }

    if (suffix === '/clear') {
      if (request.method !== 'POST') return false;
      const body = await ctx.readJson(request);
      sendJson(response, 200, { ok: true, ...await runAudited(audit('clear_memory_records'),
        () => core.clearMemoryRecords(conversation, body)) });
      return true;
    }

    const recordMatch = RECORD.exec(suffix);
    if (!recordMatch) return false;
    const recordId = recordMatch[1]!;
    if (request.method === 'GET') {
      sendJson(response, 200, { ok: true, ...await core.getMemoryRecord(conversation, recordId) });
      return true;
    }
    if (request.method === 'PUT') {
      const body = await ctx.readJson(request);
      sendJson(response, 200, { ok: true, ...await runAudited(audit('update_memory_record'),
        () => core.updateMemoryRecord(conversation, recordId, body)) });
      return true;
    }
    if (request.method === 'DELETE') {
      const body = await ctx.readJson(request);
      sendJson(response, 200, { ok: true, ...await runAudited(audit('delete_memory_record'),
        () => core.deleteMemoryRecord(conversation, recordId, body)) });
      return true;
    }
    return false;
  };
}
