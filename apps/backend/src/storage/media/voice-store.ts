import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  parseVoiceCapabilities,
  parseVoiceEngines,
} from "../../domain/voice-capabilities.js";
import type {
  VoiceCapabilities,
  VoiceEngineStatus,
  VoiceLanguage,
  VoiceProtocol,
  VoiceReferenceRecord,
  VoiceSettingsRecord,
  VoiceSource,
} from "../../domain/voice.js";

interface SettingsRow {
  role_id: string;
  service_id: string | null;
  engine: string;
  protocol: string;
  tts_engine: string | null;
  engines_json: string | null;
  default_engine: string | null;
  base_url: string;
  reference_asset_id: string | null;
  voice_source: string;
  reference_mode: string | null;
  reference_text: string | null;
  preset_voice_id: string | null;
  capabilities_json: string | null;
  reference_mode_confirmed: number;
  enabled: number;
  language: VoiceLanguage;
  speed: number;
  emo_alpha: number;
  created_at: string;
  updated_at: string;
}

interface AssetRow {
  asset_id: string;
  role_id: string;
  file_name: string;
  media_type: string;
  relative_path: string;
  created_at: string;
}

export interface NewVoiceReference {
  assetId?: string;
  fileName: string;
  mediaType: string;
  relativePath: string;
  createdAt: string;
}

export interface SaveVoiceSettingsInput {
  serviceId: string | null;
  protocol: VoiceProtocol;
  ttsEngine: string | null;
  engines: Record<string, VoiceEngineStatus> | null;
  defaultEngine: string | null;
  baseUrl: string;
  voiceSource: VoiceSource;
  language: VoiceLanguage;
  speed: number;
  emoAlpha: number;
  capabilities: VoiceCapabilities | null;
  referenceModeConfirmed: boolean;
  now: string;
}

export class VoiceStore {
  constructor(
    private readonly db: Database.Database,
    private readonly roleId: string,
  ) {}

  getSettings(): VoiceSettingsRecord | null {
    const row = this.db
      .prepare("SELECT * FROM role_voice_settings WHERE role_id = ?")
      .get(this.roleId) as SettingsRow | undefined;
    return row === undefined ? null : mapSettings(row);
  }

  saveSettings(input: SaveVoiceSettingsInput): VoiceSettingsRecord {
    const reference =
      input.voiceSource.kind === "reference" ? input.voiceSource : null;
    this.db
      .prepare(
        `INSERT INTO role_voice_settings
           (role_id, service_id, engine, protocol, tts_engine, engines_json,
            default_engine, base_url, reference_asset_id, voice_source,
            reference_mode, reference_text, preset_voice_id,
            capabilities_json, reference_mode_confirmed, language, speed,
            emo_alpha, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(role_id) DO UPDATE SET
           service_id = excluded.service_id,
           engine = excluded.engine,
           protocol = excluded.protocol,
           tts_engine = excluded.tts_engine,
           engines_json = excluded.engines_json,
           default_engine = excluded.default_engine,
           base_url = excluded.base_url,
           reference_asset_id = excluded.reference_asset_id,
           voice_source = excluded.voice_source,
           reference_mode = excluded.reference_mode,
           reference_text = excluded.reference_text,
           preset_voice_id = excluded.preset_voice_id,
           capabilities_json = excluded.capabilities_json,
           reference_mode_confirmed = excluded.reference_mode_confirmed,
           language = excluded.language,
           speed = excluded.speed,
           emo_alpha = excluded.emo_alpha,
           updated_at = excluded.updated_at`,
      )
      .run(
        this.roleId,
        input.serviceId,
        input.protocol,
        input.protocol,
        input.ttsEngine,
        input.engines === null ? null : JSON.stringify(input.engines),
        input.defaultEngine,
        input.baseUrl,
        reference?.referenceAssetId ?? null,
        input.voiceSource.kind,
        reference?.referenceMode ?? null,
        reference?.referenceText ?? null,
        input.voiceSource.kind === "preset"
          ? input.voiceSource.voiceId
          : null,
        input.capabilities === null
          ? null
          : JSON.stringify(input.capabilities),
        input.referenceModeConfirmed ? 1 : 0,
        input.language,
        input.speed,
        input.emoAlpha,
        input.now,
        input.now,
      );
    return this.getSettings()!;
  }

  /** 启动期迁移：把尚未绑定全局服务的旧角色配置关联到全局语音服务，不改时间戳。 */
  linkService(serviceId: string): void {
    this.db
      .prepare(
        `UPDATE role_voice_settings
            SET service_id = ?
          WHERE role_id = ? AND service_id IS NULL`,
      )
      .run(serviceId, this.roleId);
  }

  /** 启用或停用这份配置；没有配置时返回 null，由调用方报错。 */
  setEnabled(enabled: boolean, now: string): VoiceSettingsRecord | null {
    const changed = this.db
      .prepare(
        `UPDATE role_voice_settings
            SET enabled = ?, updated_at = ?
          WHERE role_id = ?`,
      )
      .run(enabled ? 1 : 0, now, this.roleId);
    return changed.changes === 0 ? null : this.getSettings();
  }

  addReference(input: NewVoiceReference): VoiceReferenceRecord {
    const assetId = input.assetId ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO voice_assets
           (asset_id, role_id, file_name, media_type, relative_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        assetId,
        this.roleId,
        input.fileName,
        input.mediaType,
        input.relativePath,
        input.createdAt,
      );
    return this.getReference(assetId)!;
  }

  getReference(assetId: string): VoiceReferenceRecord | null {
    const row = this.db
      .prepare("SELECT * FROM voice_assets WHERE asset_id = ? AND role_id = ?")
      .get(assetId, this.roleId) as AssetRow | undefined;
    return row === undefined ? null : mapReference(row);
  }

  listReferences(): VoiceReferenceRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM voice_assets WHERE role_id = ? ORDER BY created_at DESC, rowid DESC",
      )
      .all(this.roleId) as AssetRow[];
    return rows.map(mapReference);
  }

  deleteReference(assetId: string): boolean {
    return (
      this.db
        .prepare(
          "DELETE FROM voice_assets WHERE asset_id = ? AND role_id = ?",
        )
        .run(assetId, this.roleId).changes === 1
    );
  }
}

function mapSettings(row: SettingsRow): VoiceSettingsRecord {
  const protocol = normalizeProtocol(row.protocol);
  return {
    roleId: row.role_id,
    serviceId: row.service_id ?? null,
    engine: normalizeProtocol(row.engine),
    protocol,
    baseUrl: row.base_url,
    voiceSource: mapSource(row),
    referenceModeConfirmed: row.reference_mode_confirmed !== 0,
    enabled: row.enabled !== 0,
    language: row.language,
    speed: row.speed,
    emoAlpha: row.emo_alpha,
    capabilities: parseVoiceCapabilities(row.capabilities_json),
    ttsEngine: row.tts_engine,
    engines: parseVoiceEngines(row.engines_json),
    defaultEngine: row.default_engine,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSource(row: SettingsRow): VoiceSource {
  if (row.voice_source === "preset" && row.preset_voice_id !== null) {
    return { kind: "preset", voiceId: row.preset_voice_id };
  }
  return {
    kind: "reference",
    referenceAssetId: row.reference_asset_id,
    referenceMode: row.reference_mode,
    referenceText: row.reference_text,
  };
}

function normalizeProtocol(value: string): VoiceProtocol {
  return value === "nowadays-tts-v1" ? "nowadays-tts-v1" : "indextts";
}

function mapReference(row: AssetRow): VoiceReferenceRecord {
  return {
    assetId: row.asset_id,
    roleId: row.role_id,
    fileName: row.file_name,
    mediaType: row.media_type,
    relativePath: row.relative_path,
    createdAt: row.created_at,
  };
}
