import type Database from "better-sqlite3";
import { z } from "zod";
import { imageServiceConfigSchema } from "../../domain/image-service.js";
import { parseResourceConfig } from "../../domain/resource.js";
import { normalizeVoiceBaseUrl } from "../../domain/voice.js";
import { voiceServiceConfigSchema, type VoiceServiceConfig } from "../../domain/voice-service.js";
import { canonicalJson, sha256, type TransferRow, type TransferTables } from "./role-transfer-data.js";
import type { RoleTransferCredentialFilter } from "./role-transfer-credentials.js";

const GROUP = {
  chat_model: "model", memory_model: "model", mcp: "mcp", skill: "skill", voice: "voice", image: "image",
} as const;

export const transferBindingSchema = z.object({
  key: z.string().min(1),
  capability: z.enum(["chat_model", "memory_model", "mcp", "skill", "voice", "image"]),
  category: z.enum(["model", "mcp", "skill", "voice", "image"]),
  sourceResourceId: z.string().min(1),
  modelName: z.string().nullable(),
  enabled: z.boolean(),
}).strict();

export type RoleTransferBinding = z.infer<typeof transferBindingSchema>;
type Capability = RoleTransferBinding["capability"];

interface BindingTarget {
  resourceId: string;
  modelName: string | null;
  voice: VoiceServiceConfig | null;
}

export interface RoleTransferBindings {
  readonly unresolved: readonly RoleTransferBinding[];
  readonly targetFingerprint: string;
  readonly targets: ReadonlyMap<string, BindingTarget>;
  readonly packageDigest: string;
}

const UNBOUND = "role-transfer:unbound:";
const LEGACY_VOICE = "legacy-voice";

function bindingKey(capability: Capability, sourceResourceId: string): string {
  return `${capability}:${sha256(sourceResourceId)}`;
}

function makeBinding(capability: Capability, currentId: string, modelName: string | null, enabled: boolean): RoleTransferBinding {
  let sourceResourceId = currentId;
  if (currentId.startsWith(UNBOUND)) {
    const encoded = currentId.slice(UNBOUND.length + 2);
    sourceResourceId = Buffer.from(encoded, "base64url").toString("utf8");
    enabled = currentId[UNBOUND.length] === "1";
  }
  return { key: bindingKey(capability, sourceResourceId), capability, category: GROUP[capability], sourceResourceId, modelName, enabled };
}

export function captureTransferBindings(db: Database.Database, roleId: string, credentials: RoleTransferCredentialFilter): RoleTransferBinding[] {
  const manifest: RoleTransferBinding[] = [];
  const rows = db.prepare("SELECT role_id, resource_id, model_name, enabled, capability FROM role_bindings").all() as {
    role_id: string; resource_id: string; model_name: string | null; enabled: number; capability: Capability;
  }[];
  for (const row of rows) {
    if (row.role_id !== roleId) throw new Error("ROLE_TRANSFER_ROLE_OWNERSHIP_MISMATCH");
    manifest.push(makeBinding(row.capability, row.resource_id, row.model_name, row.enabled === 1));
  }
  const voice = db.prepare("SELECT service_id, enabled FROM role_voice_settings WHERE role_id = ?").get(roleId) as
    { service_id: string | null; enabled: number } | undefined;
  if (voice) manifest.push(makeBinding("voice", voice.service_id || LEGACY_VOICE, null, voice.enabled === 1));
  const image = db.prepare("SELECT service_id, model_path FROM role_scene_image_settings WHERE role_id = ?").get(roleId) as
    { service_id: string; model_path: string } | undefined;
  if (image) manifest.push(makeBinding("image", image.service_id, image.model_path || null, true));
  for (const binding of manifest) {
    if (credentials.text(binding.sourceResourceId) !== binding.sourceResourceId ||
        (binding.modelName !== null && credentials.text(binding.modelName) !== binding.modelName)) {
      throw new Error("ROLE_TRANSFER_CREDENTIAL_IN_BINDING");
    }
  }
  return manifest.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

export function validateTransferBindings(bindings: RoleTransferBinding[], tables: TransferTables): void {
  const keys = new Set<string>();
  const singleton = new Set<string>();
  for (const binding of bindings) {
    const { key, capability, category, sourceResourceId, modelName } = binding;
    const validModelName = category === "model" ? Boolean(modelName?.trim())
      : category === "image" ? modelName === null || Boolean(modelName.trim()) : modelName === null;
    if (keys.has(key) || key !== bindingKey(capability, sourceResourceId) || category !== GROUP[capability] ||
        sourceResourceId.startsWith(UNBOUND) || !validModelName ||
        (capability !== "mcp" && capability !== "skill" && singleton.has(capability))) {
      throw new Error("ROLE_TRANSFER_BINDING_INVALID");
    }
    keys.add(key);
    singleton.add(capability);
  }
  if (singleton.has("voice") !== (tables.role_voice_settings.length === 1) ||
      singleton.has("image") !== (tables.role_scene_image_settings.length === 1)) {
    throw new Error("ROLE_TRANSFER_BINDING_INVALID");
  }
}

export function resolveTransferTargets(
  app: Database.Database | null,
  bindings: readonly RoleTransferBinding[],
  packageDigest: string,
  mapping: Readonly<Record<string, string>>,
): RoleTransferBindings {
  const knownKeys = new Set(bindings.map(({ key }) => key));
  if (Object.keys(mapping).some((key) => !knownKeys.has(key))) throw new Error("ROLE_TRANSFER_MAPPING_KEY_UNKNOWN");
  const targets = new Map<string, BindingTarget>();
  const unresolved: RoleTransferBinding[] = [];
  const assignments = new Set<string>();
  const fingerprintData: unknown[] = [];
  for (const binding of bindings) {
    if (!Object.hasOwn(mapping, binding.key)) {
      unresolved.push(binding);
      continue;
    }
    const resourceId = mapping[binding.key];
    if (typeof resourceId !== "string" || resourceId === "" || resourceId.startsWith(UNBOUND) || !app) {
      throw new Error("ROLE_TRANSFER_TARGET_RESOURCE_INVALID");
    }
    const assignment = `${binding.capability}:${resourceId}`;
    if (assignments.has(assignment)) throw new Error("ROLE_TRANSFER_DUPLICATE_MAPPING");
    assignments.add(assignment);
    const target = resolveTarget(app, binding, resourceId);
    targets.set(binding.key, target.target);
    fingerprintData.push([binding.key, resourceId, target.facts]);
  }
  return { unresolved, targets, packageDigest, targetFingerprint: sha256(canonicalJson(fingerprintData)) };
}

function resolveTarget(app: Database.Database, binding: RoleTransferBinding, resourceId: string): { target: BindingTarget; facts: unknown } {
  const { category } = binding;
  const table = category === "voice" ? "voice_services" : category === "image" ? "image_services" : "resources";
  const pk = table === "resources" ? "resource_id" : "service_id";
  const row = app.prepare(`SELECT * FROM ${table} WHERE ${pk} = ?`).get(resourceId) as TransferRow | undefined;
  if (!row || (table === "resources" && row.kind !== category)) throw new Error("ROLE_TRANSFER_TARGET_KIND_MISMATCH");
  if (table === "resources" && app.prepare("SELECT 1 FROM resource_deletions WHERE resource_id = ?").get(resourceId)) {
    throw new Error("ROLE_TRANSFER_TARGET_RESOURCE_PENDING_DELETION");
  }

  let voice: VoiceServiceConfig | null = null;
  let modelName = binding.modelName;
  try {
    const config: unknown = JSON.parse(String(row.config_json));
    if (category === "voice") {
      const parsed = voiceServiceConfigSchema.parse(config);
      voice = { protocol: parsed.protocol, baseUrl: normalizeVoiceBaseUrl(parsed.baseUrl),
        ...(parsed.defaultEngine === undefined ? {} : { defaultEngine: parsed.defaultEngine }) };
    } else if (category === "image") {
      const service = imageServiceConfigSchema.parse(config);
      modelName ??= service.modelName ?? null;
    } else {
      const parsed = parseResourceConfig(category, config);
      if (category === "model" && typeof parsed.modelName === "string") modelName = parsed.modelName;
    }
  } catch {
    throw new Error("ROLE_TRANSFER_TARGET_RESOURCE_INVALID");
  }
  if (category === "image" && modelName === null) throw new Error("ROLE_TRANSFER_TARGET_IMAGE_MODEL_REQUIRED");
  const secret = (category === "model" || category === "image") ? app.prepare(
    "SELECT ciphertext, key_version, updated_at FROM resource_secrets WHERE resource_id = ?",
  ).get(resourceId) : null;
  return { target: { resourceId, modelName, voice }, facts: { row, secret: secret ?? null } };
}

function unboundId(binding: RoleTransferBinding): string {
  return `${UNBOUND}${binding.enabled ? 1 : 0}:${Buffer.from(binding.sourceResourceId).toString("base64url")}`;
}

export function targetTransferSettings(
  tables: TransferTables,
  manifest: RoleTransferBinding[],
  targets: ReadonlyMap<string, BindingTarget>,
): { general: TransferRow[]; voice: TransferRow[]; image: TransferRow[] } {
  const general: TransferRow[] = [];
  const voice: TransferRow[] = [];
  const image: TransferRow[] = [];
  const role = tables.roles[0]!;
  for (const binding of manifest) {
    const target = targets.get(binding.key);
    const id = target?.resourceId ?? unboundId(binding);
    const enabled = target && binding.enabled ? 1 : 0;
    if (binding.capability === "voice") {
      const connection = target?.voice;
      voice.push({ ...tables.role_voice_settings[0], service_id: id, enabled,
        engine: connection?.protocol ?? "indextts", protocol: connection?.protocol ?? "indextts",
        base_url: connection?.baseUrl ?? "", default_engine: connection?.defaultEngine ?? null,
        capabilities_json: null, engines_json: null });
    } else if (binding.capability === "image") {
      image.push({ ...tables.role_scene_image_settings[0], service_id: id, model_path: target?.modelName ?? binding.modelName ?? "",
        workflow_json: null, output_node_id: null });
    } else {
      general.push({ role_id: role.role_id ?? null, capability: binding.capability, resource_id: id,
        model_name: target?.modelName ?? binding.modelName, enabled, created_at: role.created_at ?? null, updated_at: role.updated_at ?? null });
    }
  }
  return { general, voice, image };
}
