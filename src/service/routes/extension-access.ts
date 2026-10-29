import type {
  ExtensionConfigKind,
  ExtensionImportInput,
  ExtensionImportPreviewInput,
  ExtensionSkillTestInput,
  ExtensionTestScope,
  ExtensionToolTestInput
} from '../../contracts/extension-access.js';
import { HttpError } from '../http/errors.js';
import type { Route } from './types.js';

const CONFIG = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/extensions\/config$/;
const TEST_TOOL = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/extensions\/tests\/tool$/;
const TEST_SKILL_PREVIEW = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/extensions\/tests\/skill-preview$/;
const TEST_SKILL = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/extensions\/tests\/skill$/;

/** File import, account JSON config and explicit manual extension tests. */
export function extensionAccessRoutes(): Route {
  return async (ctx) => {
    const { core, request, pathname, url, response, sendJson, runAudited, remote } = ctx;
    const audit = (action: string, id: string) => ({
      action,
      id,
      requestId: ctx.requestId,
      ...(remote() ? { remote: remote() } : {})
    });

    if (pathname === '/extensions/imports/scan') {
      if (request.method !== 'POST') return false;
      sendJson(response, 200, { ok: true, ...(await core.scanExtensionImports()) });
      return true;
    }

    if (pathname === '/extensions/imports/preview') {
      if (request.method !== 'POST') return false;
      const body = await ctx.readJson(request);
      sendJson(response, 200, { ok: true, preview: await core.previewExtensionImport(previewInput(body)) });
      return true;
    }

    if (pathname === '/extensions/imports') {
      if (request.method !== 'POST') return false;
      const body = await ctx.readJson(request);
      const input = importInput(body);
      const imported = await runAudited(
        audit('import_extension', `${input.kind}:${input.target.source}${input.target.accountId ? `:${input.target.accountId}` : ''}`),
        () => core.importExtension(input)
      );
      sendJson(response, 200, { ok: true, imported });
      return true;
    }

    const configMatch = CONFIG.exec(pathname);
    if (configMatch) {
      const accountId = configMatch[1] as string;
      const kind = configKind(url.searchParams.get('kind'));
      const id = url.searchParams.get('id');
      if (!id) throw new HttpError(400, 'id is required', 'invalid_extension_id');
      if (request.method === 'GET') {
        sendJson(response, 200, { ok: true, ...(await core.getExtensionConfig(accountId, kind, id)) });
        return true;
      }
      if (request.method === 'PUT') {
        const body = await ctx.readJson(request);
        if (typeof body.expectedRevision !== 'string' || !body.expectedRevision) {
          throw new HttpError(400, 'expectedRevision is required', 'invalid_revision');
        }
        if (!isRecord(body.config)) throw new HttpError(400, 'config must be a JSON object', 'invalid_config');
        const saved = await runAudited(audit('save_extension_config', `${accountId}:${kind}:${id}`),
          () => core.saveExtensionConfig(accountId, kind, id, {
            config: body.config as Record<string, unknown>,
            expectedRevision: body.expectedRevision as string
          }));
        sendJson(response, 200, { ok: true, ...saved });
        return true;
      }
      return false;
    }

    const toolMatch = TEST_TOOL.exec(pathname);
    if (toolMatch) {
      if (request.method !== 'POST') return false;
      const accountId = toolMatch[1] as string;
      const body = await ctx.readJson(request);
      const input = toolTestInput(body);
      const test = await runAudited(audit('test_extension_tool', `${accountId}:${input.toolId}`),
        () => core.testExtensionTool(accountId, input));
      sendJson(response, 200, { ok: true, test });
      return true;
    }

    const previewMatch = TEST_SKILL_PREVIEW.exec(pathname);
    if (previewMatch) {
      if (request.method !== 'POST') return false;
      const accountId = previewMatch[1] as string;
      const preview = await core.previewExtensionSkillTest(accountId, skillTestInput(await ctx.readJson(request)));
      sendJson(response, 200, { ok: true, preview });
      return true;
    }

    const skillMatch = TEST_SKILL.exec(pathname);
    if (skillMatch) {
      if (request.method !== 'POST') return false;
      const accountId = skillMatch[1] as string;
      const input = skillTestInput(await ctx.readJson(request));
      const test = await runAudited(audit('test_extension_skill', `${accountId}:${input.skillId}`),
        () => core.testExtensionSkill(accountId, input));
      sendJson(response, 200, { ok: true, test });
      return true;
    }

    return false;
  };
}

function previewInput(body: Record<string, unknown>): ExtensionImportPreviewInput {
  return {
    kind: importKind(body.kind),
    sourceDirectory: requiredString(body.sourceDirectory, 'sourceDirectory', 4_096)
  };
}

function importInput(body: Record<string, unknown>): ExtensionImportInput {
  if (!isRecord(body.target)) throw new HttpError(400, 'target must be an object', 'invalid_target');
  const source = body.target.source;
  if (source !== 'public' && source !== 'private') {
    throw new HttpError(400, 'target.source must be public or private', 'invalid_target');
  }
  const accountId = body.target.accountId;
  if (source === 'private' && typeof accountId !== 'string') {
    throw new HttpError(400, 'private target requires accountId', 'invalid_target');
  }
  if (accountId !== undefined && typeof accountId !== 'string') {
    throw new HttpError(400, 'target.accountId must be a string', 'invalid_target');
  }
  if (body.expectedRevision !== undefined && typeof body.expectedRevision !== 'string') {
    throw new HttpError(400, 'expectedRevision must be a string', 'invalid_revision');
  }
  return {
    kind: importKind(body.kind),
    sourceDirectory: requiredString(body.sourceDirectory, 'sourceDirectory', 4_096),
    target: { source, ...(accountId ? { accountId } : {}) },
    ...(typeof body.expectedRevision === 'string' ? { expectedRevision: body.expectedRevision } : {})
  };
}

function toolTestInput(body: Record<string, unknown>): ExtensionToolTestInput {
  const argumentsValue = body.arguments === undefined ? {} : body.arguments;
  if (!isRecord(argumentsValue)) throw new HttpError(400, 'arguments must be a JSON object', 'invalid_arguments');
  return {
    toolId: requiredString(body.toolId, 'toolId', 200),
    arguments: argumentsValue as Record<string, unknown>,
    ...(body.scope !== undefined ? { scope: scopeInput(body.scope) } : {})
  };
}

function skillTestInput(body: Record<string, unknown>): ExtensionSkillTestInput {
  return {
    skillId: requiredString(body.skillId, 'skillId', 200),
    input: requiredString(body.input, 'input', 16_000, true),
    ...(body.scope !== undefined ? { scope: scopeInput(body.scope) } : {}),
    ...(body.roleText !== undefined
      ? { roleText: requiredString(body.roleText, 'roleText', 12_000, true) }
      : {})
  };
}

function scopeInput(raw: unknown): ExtensionTestScope {
  if (!isRecord(raw)) throw new HttpError(400, 'scope must be an object', 'invalid_scope');
  if (raw.kind !== 'private' && raw.kind !== 'group') {
    throw new HttpError(400, 'scope.kind must be private or group', 'invalid_scope');
  }
  return { kind: raw.kind, peerId: requiredString(raw.peerId, 'scope.peerId', 64) };
}

function importKind(raw: unknown): 'plugin' | 'skill' {
  if (raw !== 'plugin' && raw !== 'skill') {
    throw new HttpError(400, 'kind must be plugin or skill', 'invalid_kind');
  }
  return raw;
}

function configKind(raw: string | null): ExtensionConfigKind {
  if (raw !== 'plugin' && raw !== 'skill') {
    throw new HttpError(400, 'kind must be plugin or skill', 'invalid_kind');
  }
  return raw;
}

function requiredString(value: unknown, label: string, max: number, allowWhitespace = false): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || (!allowWhitespace && !value.trim())) {
    throw new HttpError(400, `${label} must be a non-empty string of at most ${max} characters`, 'invalid_request');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
