import type { EffectiveIssue } from '../extensions/effective.js';
import type { ToolInvocationResult } from '../extensions/contracts.js';
import type { CapabilityId } from '../policy/capabilities.js';
import type { ChatKind } from '../routing/identity.js';

export type ExtensionResourceKind = 'plugin' | 'skill';
export type ExtensionTargetSource = 'public' | 'private';

export interface ExtensionImportTarget {
  source: ExtensionTargetSource;
  /** Required when source is private. */
  accountId?: string;
}

export interface ExtensionImportScanEntry {
  kind: ExtensionResourceKind;
  /** Directory name under the fixed imports folder. */
  name: string;
  /** Absolute local path; the management surface only uses it to prefill preview/import. */
  sourceDirectory: string;
  status: 'ready' | 'invalid';
  error?: string;
  plugin?: ExtensionPluginImportPreview;
  skill?: ExtensionSkillImportPreview;
}

export interface ExtensionImportScanResult {
  pluginsDirectory: string;
  skillsDirectory: string;
  entries: ExtensionImportScanEntry[];
}

export interface ExtensionImportPreviewInput {
  kind: ExtensionResourceKind;
  sourceDirectory: string;
}

export interface ExtensionPluginImportPreview {
  kind: 'plugin';
  id: string;
  revision: string;
  name?: string;
  fileCount: number;
  totalBytes: number;
  targetPath: string;
  fingerprint: string;
}

export interface ExtensionSkillImportPreview {
  kind: 'skill';
  id: string;
  name: string;
  description?: string;
  instructions: string;
  tools: string[];
  requires?: CapabilityId[];
  kinds?: ChatKind[];
  peers?: string[];
  sourceFormat: 'skill-md';
  fileCount: number;
  totalBytes: number;
  warnings: string[];
}

export type ExtensionImportPreview = ExtensionPluginImportPreview | ExtensionSkillImportPreview;

export interface ExtensionImportInput {
  kind: ExtensionResourceKind;
  sourceDirectory: string;
  target: ExtensionImportTarget;
  /** Skill import uses the existing definition CAS; plugin import ignores it. */
  expectedRevision?: string;
}

export interface ExtensionImportResult {
  kind: ExtensionResourceKind;
  id: string;
  revision: string;
  target: ExtensionImportTarget;
  name?: string;
  warnings?: string[];
}

export type ExtensionConfigKind = 'plugin' | 'skill';

export interface ExtensionConfigView {
  kind: ExtensionConfigKind;
  id: string;
  accountId: string;
  config: Record<string, unknown>;
  revision: string;
}

export interface ExtensionConfigUpdateInput {
  config: Record<string, unknown>;
  expectedRevision: string;
}

export interface ExtensionConfigUpdateResult extends ExtensionConfigView {
  /** Present when a saved plugin config needed the affected account host to reload. */
  reload?: { ok: boolean; error?: string; instances: string[] };
}

export interface ExtensionTestScope {
  kind: ChatKind;
  peerId: string;
}

export interface ExtensionToolTestInput {
  toolId: string;
  arguments: Record<string, unknown>;
  scope?: ExtensionTestScope;
}

export interface ExtensionSkillTestInput {
  skillId: string;
  input: string;
  scope?: ExtensionTestScope;
  roleText?: string;
}

export type ExtensionTestStatus = 'ok' | 'error' | 'submitted' | 'unknown';
export type ExtensionTestStage = 'load' | 'init' | 'invoke' | 'model';

export interface ExtensionTestCall {
  toolId: string;
  arguments: Record<string, unknown>;
  result: ToolInvocationResult;
}

export interface ExtensionTestResult {
  status: ExtensionTestStatus;
  durationMs: number;
  reply?: string;
  calls: ExtensionTestCall[];
  /** Tools actually offered to the test model, or the requested direct tool. */
  tools?: string[];
  jobIds?: string[];
  stage?: ExtensionTestStage;
  code?: string;
  message?: string;
  /** Manual tests never deliver through QQ. */
  delivery: 'skipped';
}

export interface ExtensionToolTestResponse {
  test: ExtensionTestResult;
}

export interface ExtensionSkillTestToolView {
  id: string;
  name: string;
  description: string;
  owner: 'builtin' | 'plugin';
  effect: 'read' | 'action';
  available: boolean;
  issues: EffectiveIssue[];
  /** Preview only: the declared handler has not been verified by a test Worker. */
  handlerStatus: 'ready' | 'unverified';
}

export interface ExtensionSkillTestPreview {
  accountId: string;
  scope: ExtensionTestScope;
  input: string;
  skill: {
    id: string;
    name: string;
    source: 'public' | 'private' | 'plugin';
    enabled: boolean;
    issues: EffectiveIssue[];
    unavailableTools: string[];
    instructions: string;
    renderedInstructions: string;
    config: Record<string, unknown>;
  };
  tools: ExtensionSkillTestToolView[];
}

export interface ExtensionSkillTestResponse {
  test: ExtensionTestResult;
  preview?: ExtensionSkillTestPreview;
}
