import type { ArtifactKind } from '../../artifacts/types.js';
import { HttpError } from '../http/errors.js';
import type { Route } from './types.js';

export function artifactRoutes(): Route {
  return async (ctx) => {
    const { core, request, response, pathname, requestId, readJson, sendJson, runAudited, remote } = ctx;

    if (request.method === 'GET' && pathname === '/artifacts') {
      const [artifacts, current] = await Promise.all([core.listPublicArtifacts(), core.artifactCatalog()]);
      sendJson(response, 200, {
        ok: true,
        current,
        artifacts: artifacts.map((artifact) => ({ ref: artifact.ref, manifest: artifact.manifest }))
      });
      return true;
    }

    if (request.method === 'GET' && pathname === '/deployments') {
      sendJson(response, 200, { ok: true, deployments: core.deployments() });
      return true;
    }

    if (request.method === 'POST' && pathname === '/artifacts/rollback') {
      const remoteAddress = remote();
      const deployment = await runAudited(
        { action: 'rollback_artifacts', id: 'artifacts', requestId, ...(remoteAddress ? { remote: remoteAddress } : {}) },
        () => core.rollbackArtifacts()
      );
      sendJson(response, 200, { ok: true, deployment });
      return true;
    }

    const artifactMatch = /^\/artifacts\/(plugin|role-card)\/([A-Za-z0-9._-]{1,64})\/deploy$/.exec(pathname);
    if (artifactMatch && request.method === 'POST') {
      const kind = artifactMatch[1] as ArtifactKind;
      const id = artifactMatch[2] as string;
      const body = await readJson(request);
      if (typeof body.revision !== 'string' || !body.revision) {
        throw new HttpError(400, 'revision is required', 'invalid_revision');
      }
      const remoteAddress = remote();
      const deployment = await runAudited(
        { action: 'deploy_artifact', id: `${kind}:${id}`, requestId, ...(remoteAddress ? { remote: remoteAddress } : {}) },
        () => core.deployArtifact(kind, id, body.revision as string)
      );
      sendJson(response, 200, { ok: true, deployment });
      return true;
    }

    return false;
  };
}
