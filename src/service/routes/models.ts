import { isCapabilityId, type CapabilityId } from '../../policy/capabilities.js';
import { inferProviderLocation } from '../../providers/setup.js';
import { assertIdentifier, assertKind, type ConversationRef } from '../../routing/identity.js';
import { HttpError } from '../http/errors.js';
import type { Route } from './types.js';

export function modelRoutes(): Route {
  return async (ctx) => {
    const { core, request, response, pathname, requestId, readJson, sendJson, runAudited, remote, url } = ctx;

    if (request.method === 'GET' && pathname === '/providers') {
      sendJson(response, 200, {
        ok: true,
        providers: await core.listProviders(),
        credentialStore: core.credentialStore()
      });
      return true;
    }

    if (request.method === 'POST' && ['/providers/simple', '/providers/models', '/providers/validate'].includes(pathname)) {
      const body = await readJson(request);
      const remoteAddress = remote();
      if (pathname === '/providers/models') {
        const models = await core.discoverModels(body);
        sendJson(response, 200, { ok: true, models });
      } else if (pathname === '/providers/validate') {
        const result = await runAudited(
          { action: 'validate_model', id: String(body.providerId ?? body.capability ?? 'draft'), requestId, ...(remoteAddress ? { remote: remoteAddress } : {}) },
          () => core.validateSimpleModel(body)
        );
        sendJson(response, 200, { ok: true, result });
      } else {
        const provider = await runAudited(
          { action: 'configure_model', id: String(body.providerId ?? body.capability ?? 'model'), requestId, ...(remoteAddress ? { remote: remoteAddress } : {}) },
          () => core.configureSimpleModel(body)
        );
        sendJson(response, 200, { ok: true, provider });
      }
      return true;
    }

    if (request.method === 'POST' && pathname === '/providers') {
      const body = await readJson(request);
      const { provider, secret } = providerPayload(body);
      const remoteAddress = remote();
      const saved = await runAudited(
        {
          action: 'upsert_provider',
          id: typeof provider.id === 'string' ? provider.id : 'provider',
          requestId,
          ...(remoteAddress ? { remote: remoteAddress } : {})
        },
        () => core.upsertProvider(provider, secret)
      );
      sendJson(response, 201, { ok: true, provider: saved });
      return true;
    }

    const impactMatch = /^\/providers\/([A-Za-z0-9._-]{1,64})\/impact$/.exec(pathname);
    if (impactMatch && request.method === 'GET') {
      sendJson(response, 200, { ok: true, ...core.providerRemovalImpact(impactMatch[1]!) });
      return true;
    }

    const providerMatch = /^\/providers\/([A-Za-z0-9._-]{1,64})$/.exec(pathname);
    if (providerMatch && request.method === 'PUT') {
      const id = providerMatch[1] as string;
      const body = await readJson(request);
      const { provider, secret } = providerPayload(body);
      if (provider.id !== undefined && provider.id !== id) {
        throw new HttpError(400, 'provider id does not match the URL', 'invalid_provider');
      }
      provider.id = id;
      const remoteAddress = remote();
      const saved = await runAudited(
        { action: 'upsert_provider', id, requestId, ...(remoteAddress ? { remote: remoteAddress } : {}) },
        () => core.upsertProvider(provider, secret)
      );
      sendJson(response, 200, { ok: true, provider: saved });
      return true;
    }

    if (providerMatch && request.method === 'DELETE') {
      const id = providerMatch[1] as string;
      const remoteAddress = remote();
      const result = await runAudited(
        { action: 'remove_provider', id, requestId, ...(remoteAddress ? { remote: remoteAddress } : {}) },
        () => core.deleteProvider(id)
      );
      sendJson(response, 200, { ok: true, ...result });
      return true;
    }

    const providerCredentialMatch = /^\/providers\/([A-Za-z0-9._-]{1,64})\/credential$/.exec(pathname);
    if (providerCredentialMatch && request.method === 'PUT') {
      const id = providerCredentialMatch[1] as string;
      const body = await readJson(request);
      if (typeof body.secret !== 'string' || body.secret.length === 0) {
        throw new HttpError(400, 'secret is required', 'invalid_credential');
      }
      const remoteAddress = remote();
      const provider = await runAudited(
        { action: 'set_provider_credential', id, requestId, ...(remoteAddress ? { remote: remoteAddress } : {}) },
        () => core.setProviderCredential(id, body.secret as string)
      );
      sendJson(response, 200, { ok: true, provider });
      return true;
    }

    if (providerCredentialMatch && request.method === 'DELETE') {
      const id = providerCredentialMatch[1] as string;
      const remoteAddress = remote();
      const provider = await runAudited(
        { action: 'delete_provider_credential', id, requestId, ...(remoteAddress ? { remote: remoteAddress } : {}) },
        () => core.deleteProviderCredential(id)
      );
      sendJson(response, 200, { ok: true, provider });
      return true;
    }

    const providerTestMatch = /^\/providers\/([A-Za-z0-9._-]{1,64})\/test$/.exec(pathname);
    if (providerTestMatch && request.method === 'POST') {
      const id = providerTestMatch[1] as string;
      const body = await readJson(request);
      const capability = parseCapability(body.capability);
      const modelId = typeof body.modelId === 'string' ? body.modelId : undefined;
      const confirmCost = body.confirmCost === true;
      const remoteAddress = remote();
      const result = await runAudited(
        { action: 'test_provider', id, requestId, ...(remoteAddress ? { remote: remoteAddress } : {}) },
        () => core.testProvider(id, capability, modelId, confirmCost)
      );
      sendJson(response, 200, { ok: true, result });
      return true;
    }

    const accountCapabilityTestMatch = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/capabilities\/test$/.exec(pathname);
    if (accountCapabilityTestMatch && request.method === 'POST') {
      const accountId = assertIdentifier(accountCapabilityTestMatch[1] as string, 'accountId');
      const body = await readJson(request);
      const capability = parseCapability(body.capability);
      const confirmCost = body.confirmCost === true;
      const remoteAddress = remote();
      const result = await runAudited(
        { action: 'test_account_capability', id: `${accountId}:${capability}`, requestId, ...(remoteAddress ? { remote: remoteAddress } : {}) },
        () => core.testAccountCapability(accountId, capability, confirmCost)
      );
      sendJson(response, 200, { ok: true, result });
      return true;
    }

    const policyMatch = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/policy$/.exec(pathname);
    if (policyMatch) {
      const accountId = assertIdentifier(policyMatch[1] as string, 'accountId');
      if (request.method === 'GET') {
        sendJson(response, 200, { ok: true, policy: core.getAccountPolicy(accountId) });
        return true;
      }
      if (request.method === 'PUT') {
        const body = await readJson(request);
        const raw = body.policy && typeof body.policy === 'object' && !Array.isArray(body.policy) ? body.policy : body;
        const remoteAddress = remote();
        const policy = await runAudited(
          { action: 'set_account_policy', id: accountId, requestId, ...(remoteAddress ? { remote: remoteAddress } : {}) },
          () => core.setAccountPolicy(accountId, raw)
        );
        sendJson(response, 200, { ok: true, policy });
        return true;
      }
    }

    const effectiveMatch = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/effective$/.exec(pathname);
    if (effectiveMatch && request.method === 'GET') {
      const accountId = assertIdentifier(effectiveMatch[1] as string, 'accountId');
      const kind = url.searchParams.get('kind') ?? 'private';
      const peerId = url.searchParams.get('peerId') ?? '0';
      const conversation: ConversationRef = {
        accountId,
        kind: assertKind(kind),
        peerId: assertIdentifier(peerId, 'peerId')
      };
      sendJson(response, 200, { ok: true, effective: await core.effectiveCapabilities(accountId, conversation) });
      return true;
    }

    const agentToggleMatch = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/agent$/.exec(pathname);
    if (agentToggleMatch && request.method === 'POST') {
      const accountId = assertIdentifier(agentToggleMatch[1] as string, 'accountId');
      const body = await readJson(request);
      if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be a boolean', 'invalid_body');
      const scope = parseScope(body);
      const remoteAddress = remote();
      const policy = await runAudited(
        { action: 'toggle_agent', id: accountId, requestId, ...(remoteAddress ? { remote: remoteAddress } : {}) },
        () => core.patchAgentEnabled(accountId, body.enabled as boolean, scope)
      );
      sendJson(response, 200, { ok: true, policy });
      return true;
    }

    const capabilityToggleMatch = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/capabilities\/([a-z.]+)$/.exec(pathname);
    if (capabilityToggleMatch && request.method === 'POST') {
      const accountId = assertIdentifier(capabilityToggleMatch[1] as string, 'accountId');
      const capability = parseCapability(capabilityToggleMatch[2]);
      const body = await readJson(request);
      if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be a boolean', 'invalid_body');
      const scope = parseScope(body);
      const remoteAddress = remote();
      const policy = await runAudited(
        { action: 'toggle_capability', id: accountId, requestId, ...(remoteAddress ? { remote: remoteAddress } : {}) },
        () => core.patchCapabilityEnabled(accountId, capability, body.enabled as boolean, scope)
      );
      sendJson(response, 200, { ok: true, policy });
      return true;
    }

    return false;
  };
}

function providerPayload(body: Record<string, unknown>): {
  provider: Record<string, unknown>;
  secret?: string;
} {
  const nested =
    body.provider && typeof body.provider === 'object' && !Array.isArray(body.provider)
      ? (body.provider as Record<string, unknown>)
      : undefined;
  let provider: Record<string, unknown>;
  let credential: unknown;
  if (nested) {
    provider = { ...nested };
    credential = body.credential ?? body.secret;
  } else {
    const { credential: rawCredential, secret: rawSecret, inferLocationFromUrl: _infer, ...rest } = body;
    provider = rest;
    credential = rawCredential ?? rawSecret;
  }
  if (body.inferLocationFromUrl !== undefined && typeof body.inferLocationFromUrl !== 'boolean') {
    throw new HttpError(400, 'inferLocationFromUrl must be a boolean', 'invalid_body');
  }
  if (body.inferLocationFromUrl === true) {
    if (typeof provider.baseUrl !== 'string') throw new HttpError(400, 'baseUrl must be a URL', 'invalid_body');
    try {
      provider.location = inferProviderLocation(provider.baseUrl);
    } catch {
      throw new HttpError(400, 'baseUrl must be a URL', 'invalid_body');
    }
  }
  return {
    provider,
    ...(typeof credential === 'string' && credential.length > 0 ? { secret: credential } : {})
  };
}

function parseCapability(value: unknown): CapabilityId {
  if (!isCapabilityId(value)) throw new HttpError(400, `unsupported capability ${String(value)}`, 'invalid_capability');
  return value;
}

function parseScope(body: Record<string, unknown>): { kind?: 'private' | 'group'; peerId?: string } {
  const kind = body.kind === undefined ? undefined : assertKind(String(body.kind));
  const peerId = body.peerId === undefined ? undefined : assertIdentifier(String(body.peerId), 'peerId');
  if (peerId && !kind) throw new HttpError(400, 'kind is required when peerId is provided', 'invalid_scope');
  return {
    ...(kind ? { kind } : {}),
    ...(peerId ? { peerId } : {})
  };
}
