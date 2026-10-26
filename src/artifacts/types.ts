import type { Worldbook } from '../worldbook/types.js';
import type { PluginHookDeclaration, PluginSkillDeclaration, PluginStateDeclaration, PluginToolDeclaration } from '../extensions/contracts.js';

export type ArtifactKind = 'plugin' | 'role-card' | 'worldbook';
export type ArtifactSourceName = 'public' | 'private';

export interface ArtifactRef {
  source: ArtifactSourceName;
  id: string;
  revision?: string;
}

export interface ArtifactManifest {
  id: string;
  kind: ArtifactKind;
  revision: string;
  name?: string;
  description?: string;
  /** plugin：相对制品目录的模块入口 */
  entry?: string;
  /** plugin：宿主协议版本 */
  apiVersion?: number;
  /** plugin：声明式工具；未声明的模块导出不能成为工具。 */
  tools?: PluginToolDeclaration[];
  /** plugin：声明式生命周期钩子。 */
  hooks?: PluginHookDeclaration[];
  /** plugin：插件提供的 Skill 声明。 */
  skills?: PluginSkillDeclaration[];
  /** plugin：插件状态命名空间版本；账号共享必须显声明并由账号启用。 */
  state?: PluginStateDeclaration;
  /** role-card：角色设定文本 */
  content?: string;
  /** role-card：随卡内置世界书；worldbook：独立世界书正文（必填由校验保证） */
  worldbook?: Worldbook;
}

export interface ResolvedArtifact {
  ref: Required<ArtifactRef>;
  manifest: ArtifactManifest;
  dir: string;
}

export interface ResolvedRoleCard extends ResolvedArtifact {
  content: string;
}

export interface ResolvedWorldbook extends ResolvedArtifact {
  worldbook: Worldbook;
}

/** Outcome of resolving a fixed independent worldbook; keeps missing/invalid/real I/O failure distinct. */
export type WorldbookResolution =
  | { status: 'ready'; worldbook: Worldbook; name?: string; ref: { source: 'public'; id: string; revision: string } }
  | { status: 'missing' }
  | { status: 'invalid' }
  | { status: 'error' };

export interface ResolvedPlugin extends ResolvedArtifact {
  entry: string;
  apiVersion: number;
  config: Record<string, unknown>;
}

export interface ResolvedProfile {
  accountId: string;
  /** Account-level profile revision; conversation roles are resolved per message. */
  revision: string;
  plugins: ResolvedPlugin[];
}

export interface AccountPluginEntry extends ArtifactRef {
  enabled?: boolean;
  config?: Record<string, unknown>;
}

export interface AccountProfileFile {
  version: 1;
  /** Legacy reference retained for migration display only; never used as a runtime fallback. */
  roleCard?: ArtifactRef;
  plugins?: AccountPluginEntry[];
}

export interface ProfileSummary {
  revision: string;
  roleCard?: Required<ArtifactRef>;
  plugins: Array<Required<ArtifactRef>>;
}

export function summarizeProfile(profile: ResolvedProfile): ProfileSummary {
  return {
    revision: profile.revision,
    plugins: profile.plugins.map((plugin) => plugin.ref)
  };
}

export function artifactRefKey(kind: ArtifactKind, id: string): string {
  return `${kind}:${id}`;
}
