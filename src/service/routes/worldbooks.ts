import type { Route } from './types.js';

export function worldbookRoutes(): Route {
  return async ctx => {
    const { request, pathname, core, sendJson, response, url } = ctx;
    if (pathname === '/worldbooks' && request.method === 'GET') {
      const query: Record<string, unknown> = {};
      for (const key of ['id', 'offset', 'limit']) if (url.searchParams.has(key)) query[key] = key === 'id' ? url.searchParams.get(key) : Number(url.searchParams.get(key));
      sendJson(response, 200, { ok: true, ...await core.listWorldbooks(query) }); return true;
    }
    const match = /^\/worldbooks\/([^/]+)\/revisions\/([^/]+)$/.exec(pathname);
    if (match && request.method === 'GET') {
      sendJson(response, 200, { ok: true, ...await core.getWorldbook(match[1]!, match[2]!) }); return true;
    }
    if (pathname === '/worldbooks/preview' && request.method === 'POST') {
      const body = await ctx.readJson(request);
      sendJson(response, 200, { ok: true, evaluation: await core.previewWorldbookDraft(body) }); return true;
    }
    if (pathname === '/worldbooks/revisions' && request.method === 'POST') {
      const body = await ctx.readJson(request);
      const result = await ctx.runAudited({ action: 'save_worldbook', id: 'worldbook', requestId: ctx.requestId,
        ...(ctx.remote() ? { remote: ctx.remote() } : {}) }, () => core.saveWorldbook(body));
      sendJson(response, result.created ? 201 : 200, { ok: true, ...result }); return true;
    }
    return false;
  };
}
