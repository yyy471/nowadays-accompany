/** Renderer-safe metadata; source paths and filesystem capabilities remain in main. */
export type ArtifactImportMode = 'directory' | 'tavern-card' | 'worldbook';

export interface ArtifactImportPreview {
  token: string;
  kind: 'plugin' | 'role-card' | 'worldbook';
  id: string;
  revision: string;
  name?: string;
  fileCount: number;
  totalBytes: number;
  targetPath: string;
  sourceFormat?: 'tavern-v1' | 'tavern-v2' | 'native' | 'tavern-array' | 'tavern-object' | 'unknown';
  warnings?: string[];
  contentPreview?: string;
  contentLength?: number;
}

export interface ArtifactImportResult {
  kind: 'plugin' | 'role-card' | 'worldbook';
  id: string;
  revision: string;
}
