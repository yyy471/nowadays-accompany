import type { InstanceSpec } from '../../instances/spec.js';
import { assertIdentifier } from '../../routing/identity.js';
import { HttpError } from '../http/errors.js';
import type { Route } from './types.js';

export function connectionRoutes(): Route {
  return async (ctx) => {
    const { core, request, response, pathname, requestId, readJson, sendJson, runAudited, remote, url } = ctx;

    if (request.method === 'GET' && pathname === '/slots') {
      sendJson(response, 200, {
        ok: true,
        slots: core.status().instances,
        specs: core.slotSpecs(),
        resumable: core.injectionResumeCandidates()
      });
      return true;
    }

    if (request.method === 'POST' && pathname === '/slots') {
      const body = await readJson(request);
      if (typeof body.id !== 'string') throw new HttpError(400, 'slot id is required', 'invalid_spec');
      const remoteAddress = remote();
      const instance = await runAudited(
        { action: 'add_slot', id: body.id, requestId, ...(remoteAddress ? { remote: remoteAddress } : {}) },
        () => core.addSlot(body as unknown as InstanceSpec)
      );
      sendJson(response, 201, { ok: true, instance });
      return true;
    }

    const slotMatch = /^\/slots\/([A-Za-z0-9_-]{1,64})$/.exec(pathname);
    if (slotMatch && request.method === 'DELETE') {
      const id = assertIdentifier(slotMatch[1] as string, 'slotId');
      const remoteAddress = remote();
      await runAudited(
        { action: 'remove_slot', id, requestId, ...(remoteAddress ? { remote: remoteAddress } : {}) },
        () => core.removeSlot(id)
      );
      sendJson(response, 200, { ok: true });
      return true;
    }

    if (request.method === 'GET' && pathname === '/injection/runtime') {
      sendJson(response, 200, { ok: true, runtime: await core.injectionStatus() });
      return true;
    }

    if (request.method === 'POST' && pathname === '/injection/connection/test') {
      const result = await core.testInjectionConnection();
      sendJson(response, 200, { ok: true, ...result });
      return true;
    }

    if (request.method === 'POST' && pathname === '/injection/resume') {
      const remoteAddress = remote();
      const result = await runAudited(
        { action: 'resume_snowluma_listening', id: 'snowluma', requestId, ...(remoteAddress ? { remote: remoteAddress } : {}) },
        () => core.resumeInjectionListening()
      );
      sendJson(response, 200, { ok: true, ...result });
      return true;
    }

    if (request.method === 'POST' && pathname === '/injection/runtime/retry') {
      const remoteAddress = remote();
      const runtime = await runAudited(
        { action: 'retry_snowluma_runtime', id: 'snowluma', requestId, ...(remoteAddress ? { remote: remoteAddress } : {}) },
        () => core.retrySnowLumaRuntime()
      );
      sendJson(response, 200, { ok: true, runtime });
      return true;
    }

    if (request.method === 'GET' && pathname === '/injection/processes') {
      const avatars = url.searchParams.get('avatars') === '1';
      sendJson(response, 200, { ok: true, processes: await core.injectionProcesses(avatars ? { avatars: true } : {}) });
      return true;
    }

    const injectionMatch = /^\/injection\/processes\/(\d{1,7})\/(inject-and-listen|listen|refresh|unload)$/.exec(pathname);
    if (injectionMatch && request.method === 'POST') {
      const pid = Number(injectionMatch[1]);
      if (!Number.isInteger(pid) || pid <= 0 || pid > 4_194_304) {
        throw new HttpError(400, 'invalid process id', 'injection_request_invalid');
      }
      const action = injectionMatch[2] as 'inject-and-listen' | 'listen' | 'refresh' | 'unload';
      const body = await readJson(request);
      if (!body.identity || typeof body.identity !== 'object' || Array.isArray(body.identity)) {
        throw new HttpError(400, 'identity is required', 'injection_request_invalid');
      }
      const identity = body.identity as Record<string, unknown>;
      if (identity.pid !== undefined && Number(identity.pid) !== pid) {
        throw new HttpError(400, 'identity pid does not match the path', 'injection_request_invalid');
      }
      const payload = { ...body, identity: { ...identity, pid } };
      const remoteAddress = remote();
      const operation = await runAudited(
        {
          action: `injection_${action}`,
          id: typeof body.slotId === 'string' ? body.slotId : String(pid),
          requestId,
          ...(remoteAddress ? { remote: remoteAddress } : {})
        },
        async () => {
          if (action === 'inject-and-listen') return core.injectAndListen(payload);
          if (action === 'listen') return core.listenInjection(payload);
          if (action === 'refresh') return core.refreshInjection(payload);
          return core.unloadInjection(payload);
        }
      );
      sendJson(response, 200, { ok: operation.state === 'succeeded', operation });
      return true;
    }

    const operationMatch = /^\/injection\/operations\/([A-Za-z0-9-]{1,80})$/.exec(pathname);
    if (operationMatch && request.method === 'GET') {
      const operation = core.injectionOperation(operationMatch[1] as string);
      if (!operation) throw new HttpError(404, 'unknown injection operation', 'injection_operation_not_found');
      sendJson(response, 200, { ok: true, operation });
      return true;
    }

    if (request.method === 'GET' && pathname === '/injection/settings') {
      sendJson(response, 200, { ok: true, settings: core.injectionSettings() });
      return true;
    }

    if (request.method === 'PUT' && pathname === '/injection/settings') {
      const body = await readJson(request);
      const password = body.password;
      if (password !== undefined && typeof password !== 'string') {
        throw new HttpError(400, 'password must be a string', 'invalid_settings');
      }
      const settings: Record<string, unknown> = {};
      if (body.runtimeDir !== undefined) {
        if (typeof body.runtimeDir !== 'string') throw new HttpError(400, 'runtimeDir must be a string', 'invalid_settings');
        settings.runtimeDir = body.runtimeDir;
      }
      if (body.baseUrl !== undefined) {
        if (typeof body.baseUrl !== 'string') throw new HttpError(400, 'baseUrl must be a string', 'invalid_settings');
        settings.baseUrl = body.baseUrl;
      }
      if (body.resumeLastListen !== undefined) {
        if (typeof body.resumeLastListen !== 'boolean') throw new HttpError(400, 'resumeLastListen must be a boolean', 'invalid_settings');
        settings.resumeLastListen = body.resumeLastListen;
      }
      const updated = await core.setInjectionSettings(settings, password);
      sendJson(response, 200, {
        ok: true,
        settings: updated.settings,
        runtime: updated.status,
        credentialConfigured: updated.status.passwordConfigured
      });
      return true;
    }

    if (request.method === 'DELETE' && pathname === '/injection/password') {
      sendJson(response, 200, { ok: true, ...(await core.clearInjectionPassword()) });
      return true;
    }

    return false;
  };
}
