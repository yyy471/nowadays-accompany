import fs from 'node:fs/promises';
import path from 'node:path';
import { InvalidSpecError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import {
  artifactRefKey,
  type ArtifactKind,
  type ArtifactManifest,
  type ArtifactRef,
  type ResolvedArtifact
} from './types.js';

interface CatalogFile {
  version: 1;
  artifacts: Record<string, string>;
  /** Monotonic per-artifact context generation for follow-current references. */
  epochs?: Record<string, number>;
  savedAt?: number;
}

interface CatalogState {
  artifacts: Record<string, string>;
  epochs: Record<string, number>;
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function assertSegment(value: string, label: string): string {
  if (typeof value !== 'string' || !SEGMENT.test(value) || value === '.' || value === '..') {
    throw new InvalidSpecError(`${label} must match ${SEGMENT} (got ${JSON.stringify(value)})`);
  }
  return value;
}

function assertKind(kind: string): ArtifactKind {
  if (kind !== 'plugin' && kind !== 'role-card') {
    throw new InvalidSpecError(`artifact kind must be plugin or role-card (got ${kind})`);
  }
  return kind;
}

/**
 * 本地制品库：公用层是 <dataRoot>/public，私有制品在 <accountDir> 下。
 * 目录形如 <base>/artifacts/<kind>/<id>/<revision>/manifest.json，
 * <base>/catalog.json 指向当前生效 revision。
 */
export class LocalArtifactStore {
  readonly #publicRoot: string;
  readonly #logger?: Logger;

  constructor(publicRoot: string, logger?: Logger) {
    this.#publicRoot = path.resolve(publicRoot);
    this.#logger = logger;
  }

  get publicRoot(): string {
    return this.#publicRoot;
  }

  async resolve(kindInput: ArtifactKind, ref: ArtifactRef, accountDir?: string): Promise<ResolvedArtifact | undefined> {
    const kind = assertKind(kindInput);
    const id = assertSegment(ref.id, 'artifact id');
    const baseDir = ref.source === 'public' ? this.#publicRoot : accountDir;
    if (!baseDir) return undefined;
    const catalog = await this.readCatalog(baseDir);
    let revision = ref.revision;
    if (!revision) {
      revision = catalog[artifactRefKey(kind, id)];
      if (!revision) revision = await this.#latestRevision(baseDir, kind, id);
    }
    if (!revision) return undefined;
    assertSegment(revision, 'artifact revision');
    const dir = path.join(baseDir, 'artifacts', kind, id, revision);
    const manifest = await this.#readManifest(dir);
    if (!manifest) return undefined;
    if (manifest.id !== id || manifest.kind !== kind || manifest.revision !== revision) {
      this.#logger?.warn('artifact manifest does not match its path', { dir, id, kind, revision });
      return undefined;
    }
    if (kind === 'role-card' && (!manifest.content || !manifest.content.trim())) {
      this.#logger?.warn('role-card has no content', { dir });
      return undefined;
    }
    if (kind === 'plugin' && !manifest.entry) {
      this.#logger?.warn('plugin has no entry', { dir });
      return undefined;
    }
    return { ref: { source: ref.source, id, revision }, manifest, dir };
  }

  async listPublic(): Promise<ResolvedArtifact[]> {
    const result: ResolvedArtifact[] = [];
    const artifactsRoot = path.join(this.#publicRoot, 'artifacts');
    for (const kind of await safeReaddir(artifactsRoot)) {
      if (kind !== 'plugin' && kind !== 'role-card') continue;
      for (const id of await safeReaddir(path.join(artifactsRoot, kind))) {
        if (!SEGMENT.test(id)) continue;
        for (const revision of await safeReaddir(path.join(artifactsRoot, kind, id))) {
          if (!SEGMENT.test(revision)) continue;
          const dir = path.join(artifactsRoot, kind, id, revision);
          const manifest = await this.#readManifest(dir);
          if (!manifest) continue;
          result.push({ ref: { source: 'public', id, revision }, manifest, dir });
        }
      }
    }
    return result;
  }

  async readCatalog(baseDir: string): Promise<Record<string, string>> {
    return (await this.#readCatalogState(path.join(baseDir, 'catalog.json'))).state.artifacts;
  }

  async catalogEpoch(baseDir: string, kind: ArtifactKind, id: string): Promise<number> {
    const state = await this.#readCatalogState(path.join(baseDir, 'catalog.json'));
    return state.state.epochs[artifactRefKey(kind, id)] ?? 0;
  }

  async setPublicRevision(kind: ArtifactKind, id: string, revision: string): Promise<{ previous?: string; current: string }> {
    assertKind(kind);
    assertSegment(id, 'artifact id');
    assertSegment(revision, 'artifact revision');
    const artifactsRoot = path.join(this.#publicRoot, 'artifacts');
    const dir = path.join(artifactsRoot, kind, id, revision);
    const manifest = await this.#readManifest(dir);
    if (!manifest || manifest.id !== id || manifest.kind !== kind || manifest.revision !== revision) {
      throw new InvalidSpecError(`artifact ${kind}:${id}@${revision} does not exist or its manifest is invalid`);
    }
    const state = await this.#readCatalogState(path.join(this.#publicRoot, 'catalog.json'));
    const key = artifactRefKey(kind, id);
    const previous = state.state.artifacts[key];
    await this.#writeCatalog(path.join(this.#publicRoot, 'catalog.previous.json'), state.state.artifacts, state.state.epochs);
    const next = structuredClone(state.state);
    next.artifacts[key] = revision;
    if (previous !== revision) next.epochs[key] = (state.state.epochs[key] ?? 0) + 1;
    await this.#writeCatalog(path.join(this.#publicRoot, 'catalog.json'), next.artifacts, next.epochs);
    return { ...(previous ? { previous } : {}), current: revision };
  }

  async rollbackPublic(): Promise<{ restored: Record<string, string>; replaced: Record<string, string> }> {
    const current = await this.#readCatalogState(path.join(this.#publicRoot, 'catalog.json'));
    const replaced = current.state.artifacts;
    const previousFile = path.join(this.#publicRoot, 'catalog.previous.json');
    const previous = await this.#readCatalogState(previousFile);
    if (!previous.exists) throw new InvalidSpecError('no previous artifact catalog to roll back to');
    const restored = previous.state.artifacts;
    const epochs = { ...current.state.epochs };
    for (const key of new Set([...Object.keys(replaced), ...Object.keys(restored)])) {
      if (replaced[key] !== restored[key]) epochs[key] = (current.state.epochs[key] ?? previous.state.epochs[key] ?? 0) + 1;
    }
    await this.#writeCatalog(path.join(this.#publicRoot, 'catalog.json'), restored, epochs);
    await this.#writeCatalog(previousFile, replaced, current.state.epochs);
    return { restored, replaced };
  }

  async resolvePluginEntry(artifact: ResolvedArtifact): Promise<string | undefined> {
    if (!artifact.manifest.entry) return undefined;
    const entry = path.resolve(artifact.dir, artifact.manifest.entry);
    const relative = path.relative(artifact.dir, entry);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      this.#logger?.warn('plugin entry escapes its artifact directory', { dir: artifact.dir, entry: artifact.manifest.entry });
      return undefined;
    }
    try {
      const stat = await fs.stat(entry);
      return stat.isFile() ? entry : undefined;
    } catch {
      return undefined;
    }
  }

  async #latestRevision(baseDir: string, kind: ArtifactKind, id: string): Promise<string | undefined> {
    const dir = path.join(baseDir, 'artifacts', kind, id);
    const revisions = (await safeReaddir(dir)).filter((name) => SEGMENT.test(name)).sort();
    return revisions.at(-1);
  }

  async #readManifest(dir: string): Promise<ArtifactManifest | undefined> {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')) as Partial<ArtifactManifest>;
      if (
        typeof parsed.id !== 'string' ||
        (parsed.kind !== 'plugin' && parsed.kind !== 'role-card') ||
        typeof parsed.revision !== 'string'
      ) {
        return undefined;
      }
      return parsed as ArtifactManifest;
    } catch {
      return undefined;
    }
  }

  async #readCatalogState(file: string): Promise<{ state: CatalogState; exists: boolean }> {
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<CatalogFile>;
      const artifacts: Record<string, string> = {};
      for (const [key, revision] of Object.entries(raw.artifacts ?? {})) {
        if (typeof revision === 'string' && revision) artifacts[key] = revision;
      }
      const epochs: Record<string, number> = {};
      for (const [key, epoch] of Object.entries(raw.epochs ?? {})) {
        if (Number.isSafeInteger(epoch) && epoch >= 0) epochs[key] = epoch;
      }
      return { state: { artifacts, epochs }, exists: true };
    } catch {
      return { state: { artifacts: {}, epochs: {} }, exists: false };
    }
  }

  async #writeCatalog(file: string, artifacts: Record<string, string>, epochs: Record<string, number>): Promise<void> {
    const payload: CatalogFile = {
      version: 1,
      artifacts: Object.fromEntries(Object.entries(artifacts).sort(([left], [right]) => left.localeCompare(right))),
      epochs: Object.fromEntries(Object.entries(epochs).sort(([left], [right]) => left.localeCompare(right))),
      savedAt: Date.now()
    };
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, file);
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}
