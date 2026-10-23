import { assertIdentifier } from '../../routing/identity.js';
import { HttpError } from '../http/errors.js';
import type { Route } from './types.js';

export function jobRoutes(): Route {
  return async (ctx) => {
    const { core, request, response, pathname, requestId, readJson, sendJson, runAudited, remote, url } = ctx;

    if (request.method === 'GET' && pathname === '/jobs') {
      const accountId = url.searchParams.get('accountId') ?? undefined;
      const state = url.searchParams.get('state') ?? undefined;
      let jobs = await core.listJobs(accountId);
      if (state) jobs = jobs.filter((job) => job.state === state);
      sendJson(response, 200, { ok: true, jobs });
      return true;
    }

    const jobMatch = /^\/jobs\/([A-Za-z0-9._-]{1,96})$/.exec(pathname);
    if (jobMatch && request.method === 'GET') {
      const jobId = jobMatch[1] as string;
      const accountId = url.searchParams.get('accountId');
      if (!accountId) throw new HttpError(400, 'accountId is required for job isolation', 'account_required');
      const job = await core.getJob(accountId, jobId);
      if (!job) throw new HttpError(404, `unknown job: ${jobId}`, 'job_not_found');
      sendJson(response, 200, { ok: true, job });
      return true;
    }

    const jobCancelMatch = /^\/jobs\/([A-Za-z0-9._-]{1,96})\/cancel$/.exec(pathname);
    if (jobCancelMatch && request.method === 'POST') {
      const jobId = jobCancelMatch[1] as string;
      const body = await readJson(request);
      if (typeof body.accountId !== 'string') {
        throw new HttpError(400, 'accountId is required for job isolation', 'account_required');
      }
      const accountId = assertIdentifier(body.accountId, 'accountId');
      const remoteAddress = remote();
      const job = await runAudited(
        { action: 'cancel_job', id: jobId, requestId, ...(remoteAddress ? { remote: remoteAddress } : {}) },
        () => core.cancelJob(accountId, jobId)
      );
      sendJson(response, 200, { ok: true, job });
      return true;
    }

    return false;
  };
}
