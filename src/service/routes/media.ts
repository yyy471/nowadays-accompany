import { assertIdentifier } from '../../routing/identity.js';
import type { Route } from './types.js';

export function mediaRoutes(): Route {
  return async (ctx) => {
    const { core, request, response, pathname, requestId, sendJson, runAudited, remote } = ctx;

    const mediaListMatch = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/media$/.exec(pathname);
    if (mediaListMatch && request.method === 'GET') {
      const accountId = assertIdentifier(mediaListMatch[1] as string, 'accountId');
      sendJson(response, 200, { ok: true, media: await core.listMedia(accountId) });
      return true;
    }

    if (request.method === 'POST' && pathname === '/media/cleanup') {
      const remoteAddress = remote();
      const result = await runAudited(
        { action: 'cleanup_media', id: 'media', requestId, ...(remoteAddress ? { remote: remoteAddress } : {}) },
        () => core.cleanupMedia()
      );
      sendJson(response, 200, { ok: true, ...result });
      return true;
    }

    const mediaMatch = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/media\/([a-f0-9-]{36})$/.exec(pathname);
    if (mediaMatch) {
      const accountId = assertIdentifier(mediaMatch[1] as string, 'accountId');
      const mediaId = mediaMatch[2] as string;
      if (request.method === 'GET') {
        const media = await core.readMedia(accountId, mediaId);
        response.writeHead(200, {
          'content-type': media.ref.mimeType,
          'content-length': media.data.length,
          'cache-control': 'private, no-store',
          'content-disposition': 'inline',
          'x-content-type-options': 'nosniff',
          etag: `"${media.ref.sha256}"`
        });
        response.end(media.data);
        return true;
      }
      if (request.method === 'DELETE') {
        const remoteAddress = remote();
        const deleted = await runAudited(
          { action: 'delete_media', id: mediaId, requestId, ...(remoteAddress ? { remote: remoteAddress } : {}) },
          () => core.deleteMedia(accountId, mediaId)
        );
        sendJson(response, 200, { ok: true, deleted });
        return true;
      }
    }

    return false;
  };
}
