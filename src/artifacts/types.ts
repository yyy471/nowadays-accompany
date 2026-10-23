export type ArtifactKind = 'plugin' | 'role-card';
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
  /** role-card：角色设定文本 */
  content?: string;
}

export interface ResolvedArtifact {
  ref: Required<ArtifactRef>;
  manifest: ArtifactManifest;
  dir: string;
}

export interface ResolvedRoleCard extends ResolvedArtifact {
  content: string;
}

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
