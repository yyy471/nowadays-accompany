import type { Route } from './types.js';

export function systemRoutes(): Route {
  return ({ core, request, response, pathname, metrics, sse, sendJson, url }) => {
    if (request.method === 'GET' && pathname === '/health') {
      sendJson(response, 200, { ok: true, instances: core.status().instances.length });
      return true;
    }

    if (request.method === 'GET' && pathname === '/health/ready') {
      const instances = core.status().instances;
      const online = instances.filter((instance) => instance.state === 'online').length;
      const ready = instances.length === 0 || online > 0;
      sendJson(response, ready ? 200 : 503, {
        ok: ready,
        ready,
        instances: { total: instances.length, online }
      });
      return true;
    }

    if (request.method === 'GET' && pathname === '/metrics') {
      sendJson(response, 200, { ok: true, metrics: metrics.snapshot() });
      return true;
    }

    if (request.method === 'GET' && pathname === '/diagnostics') {
      sendJson(response, 200, { ok: true, ...(core.diagnostics() as Record<string, unknown>) });
      return true;
    }

    if (request.method === 'GET' && pathname === '/events') {
      sse.open(request, response, url);
      return true;
    }

    return false;
  };
}
