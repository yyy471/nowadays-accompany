import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { InvalidSpecError, ProfileNotReadyError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import { writeJsonAtomic } from '../storage/atomic-write.js';
import type { LocalArtifactStore } from '../artifacts/local.js';
import type {
  AccountPluginEntry,
  AccountProfileFile,
  ArtifactRef,
  ArtifactSourceName,
  ResolvedPlugin,
  ResolvedProfile
} from '../artifacts/types.js';

const REF_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** QQ 目录里的 profile.json：账号插件可选；旧 roleCard 字段仅保留作迁移信息。 */
export class AccountProfileService {
  readonly #artifacts: LocalArtifactStore;
  readonly #logger?: Logger;

  constructor(artifacts: LocalArtifactStore, logger?: Logger) {
    this.#artifacts = artifacts;
    this.#logger = logger;
  }

  async load(accountDir: string): Promise<AccountProfileFile | undefined> {
    const file = path.join(accountDir, 'profile.json');
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new ProfileNotReadyError(`account profile is unreadable: ${file}`, { cause: error });
    }
    return parseProfile(raw, file);
  }

  async save(accountDir: string, raw: unknown): Promise<AccountProfileFile> {
    const profile = parseProfile(raw, path.join(accountDir, 'profile.json'));
    await writeJsonAtomic(path.join(accountDir, 'profile.json'), profile);
    return profile;
  }

  async resolve(accountDir: string, accountId: string): Promise<ResolvedProfile> {
    await fs.mkdir(accountDir, { recursive: true, mode: 0o700 });
    const profile = (await this.load(accountDir)) ?? { version: 1 as const, plugins: [] };

    const plugins: ResolvedPlugin[] = [];
    const resolvedRefs: Array<{ kind: 'plugin'; ref: ArtifactRef }> = [];
    for (const entry of profile.plugins ?? []) {
      if (entry.enabled === false) continue;
      const artifact = await this.#artifacts.resolve('plugin', entry, accountDir);
      if (!artifact) {
        throw new ProfileNotReadyError(
          `account ${accountId}: plugin ${entry.source}:${entry.id} cannot be resolved`
        );
      }
      const pluginEntry = await this.#artifacts.resolvePluginEntry(artifact);
      if (!pluginEntry) {
        throw new ProfileNotReadyError(
          `account ${accountId}: plugin ${entry.source}:${entry.id} has no loadable entry (${artifact.manifest.entry ?? 'missing'})`
        );
      }
      const apiVersion = artifact.manifest.apiVersion ?? 1;
      if (apiVersion !== 1) {
        throw new ProfileNotReadyError(
          `account ${accountId}: plugin ${entry.source}:${entry.id} uses unsupported apiVersion ${apiVersion}`
        );
      }
      plugins.push({
        ...artifact,
        entry: pluginEntry,
        apiVersion,
        config: entry.config ?? {}
      });
      resolvedRefs.push({ kind: 'plugin', ref: artifact.ref });
    }

    const revision = crypto
      .createHash('sha1')
      .update(
        JSON.stringify(
          resolvedRefs.map((item) => ({
            kind: item.kind,
            source: item.ref.source,
            id: item.ref.id,
            revision: (item.ref.revision ?? null) as string | null
          }))
        )
      )
      .digest('hex')
      .slice(0, 12);

    return {
      accountId,
      revision,
      plugins
    };
  }
}

function parseProfile(raw: unknown, file: string): AccountProfileFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidSpecError(`profile must be a json object: ${file}`);
  }
  const input = raw as Partial<AccountProfileFile> & { roleCard?: unknown; plugins?: unknown };
  if (input.version !== 1) throw new InvalidSpecError(`profile version must be 1: ${file}`);
  const roleCard = parseRef(input.roleCard, 'roleCard', file);
  const plugins = Array.isArray(input.plugins)
    ? input.plugins.map((entry, index) => parsePlugin(entry, `plugins[${index}]`, file))
    : [];
  return { version: 1, ...(roleCard ? { roleCard } : {}), plugins };
}

function parsePlugin(raw: unknown, label: string, file: string): AccountPluginEntry {
  const ref = parseRef(raw, label, file);
  if (!ref) throw new InvalidSpecError(`${label} must be an artifact ref: ${file}`);
  const input = raw as { enabled?: unknown; config?: unknown };
  return {
    ...ref,
    ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
    ...(input.config && typeof input.config === 'object' && !Array.isArray(input.config)
      ? { config: input.config as Record<string, unknown> }
      : {})
  };
}

function parseRef(raw: unknown, label: string, file: string): ArtifactRef | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const input = raw as Partial<ArtifactRef>;
  const source = input.source;
  if (source !== 'public' && source !== 'private') {
    throw new InvalidSpecError(`${label}.source must be public or private: ${file}`);
  }
  if (typeof input.id !== 'string' || !REF_ID.test(input.id)) {
    throw new InvalidSpecError(`${label}.id must match ${REF_ID}: ${file}`);
  }
  if (input.revision !== undefined && (typeof input.revision !== 'string' || !REF_ID.test(input.revision))) {
    throw new InvalidSpecError(`${label}.revision must match ${REF_ID}: ${file}`);
  }
  const ref: ArtifactRef = { source: source as ArtifactSourceName, id: input.id };
  if (input.revision !== undefined) ref.revision = input.revision;
  return ref;
}
