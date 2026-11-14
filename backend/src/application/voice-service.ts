import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  AppError,
  VoiceReferenceInUseError,
  VoiceReferenceNotFoundError,
} from "../domain/errors.js";
import { VOICE_LANGUAGE_CODE_PATTERN } from "../domain/voice-capabilities.js";
import {
  VOICE_LANGUAGES,
  type SynthesizedAudio,
  type UploadedAudio,
  type VoiceCapabilities,
  type VoiceConfigView,
  type VoiceLanguage,
  type VoiceProbeResult,
  type VoiceProtocol,
  type VoiceReferenceRecord,
  type VoiceSettingsRecord,
  type VoiceSource,
} from "../domain/voice.js";
import type { RolePaths } from "../bootstrap/config.js";
import { ConversationStore } from "../storage/conversation-store.js";
import { VoiceStore } from "../storage/voice-store.js";
import {
  DEFAULT_TTS_TIMEOUT_MS,
  IndexTtsClient,
} from "../tts/indextts-client.js";
import {
  UnifiedTtsClient,
  type UnifiedTtsReferenceInput,
} from "../tts/unified-tts-client.js";
import { inspectAudio } from "./audio-inspect.js";
import type { RoleAccess } from "./role-access.js";

const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const MAX_PREVIEW_CHARS = 1000;
const MAX_SYNTHESIS_CHARS = 1000;
const DEFAULT_LANGUAGE: VoiceLanguage = "zh";
const DEFAULT_SPEED = 1;
const MIN_LEGACY_SPEED = 0.5;
const MAX_LEGACY_SPEED = 2;
const MIN_UNIFIED_SPEED = 0.1;
const MAX_UNIFIED_SPEED = 10;
const DEFAULT_EMO_ALPHA = 1;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

export interface VoiceServiceOptions {
  now?: () => Date;
  timeoutMs?: number;
  probeTimeoutMs?: number;
}

export interface VoiceSourceInputReference {
  kind: "reference";
  referenceAssetId?: string | null | undefined;
  referenceMode?: string | null | undefined;
  referenceText?: string | null | undefined;
}

export interface VoiceSourceInputPreset {
  kind: "preset";
  voiceId: string;
}

export type VoiceSourceInput =
  | VoiceSourceInputReference
  | VoiceSourceInputPreset;

export interface VoiceOverrides {
  protocol?: VoiceProtocol | undefined;
  baseUrl?: string | undefined;
  voiceSource?: VoiceSourceInput | undefined;
  referenceAssetId?: string | null | undefined;
  capabilities?: VoiceCapabilities | null | undefined;
  language?: VoiceLanguage | undefined;
  speed?: number | undefined;
  emoAlpha?: number | undefined;
}

export interface SaveVoiceInput {
  baseUrl: string;
  protocol?: VoiceProtocol | undefined;
  voiceSource?: VoiceSourceInput | undefined;
  referenceAssetId?: string | null | undefined;
  capabilities?: VoiceCapabilities | null | undefined;
  language?: VoiceLanguage | undefined;
  speed?: number | undefined;
  emoAlpha?: number | undefined;
  referenceFile?: UploadedAudio | undefined;
}

export interface VoicePreviewInput extends VoiceOverrides {
  emotion?: string;
  text: string;
  referenceFile?: UploadedAudio | undefined;
}

/** 参考音频列表项：只给配置页需要的字段，不暴露角色目录内的相对路径。 */
export interface VoiceReferenceView {
  assetId: string;
  fileName: string;
  mediaType: string;
  createdAt: string;
  inUse: boolean;
}

interface ResolvedLegacyVoice {
  protocol: "indextts";
  baseUrl: string;
  referencePath: string;
  language: VoiceLanguage;
  speed: number;
  emoAlpha: number;
}

interface ResolvedUnifiedVoice {
  protocol: "nowadays-tts-v1";
  baseUrl: string;
  source:
    | { kind: "reference"; reference: UnifiedTtsReferenceInput }
    | { kind: "preset"; voiceId: string };
  language: VoiceLanguage | null;
  speed: number | null;
}

type ResolvedVoice = ResolvedLegacyVoice | ResolvedUnifiedVoice;

export class VoiceService {
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly probeTimeoutMs: number;

  constructor(
    private readonly roleAccess: RoleAccess,
    options: VoiceServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  }

  getVoice(roleId: string): { voice: VoiceConfigView | null } {
    return this.roleAccess.withStore(roleId, (storage) => {
      const store = new VoiceStore(storage.business.db, roleId);
      const settings = store.getSettings();
      return {
        voice:
          settings === null
            ? null
            : toView(settings, referenceOf(store, settings)),
      };
    });
  }

  /**
   * 启用或停用角色语音。停用保留这份配置，只阻止新的对话语音合成；
   * 再次启用读同一份配置，保存新配置不改变启用状态（DL-149）。
   */
  setEnabled(roleId: string, enabled: boolean): { voice: VoiceConfigView } {
    return this.roleAccess.withStore(roleId, (storage) => {
      const store = new VoiceStore(storage.business.db, roleId);
      const settings = store.setEnabled(enabled, this.now().toISOString());
      if (settings === null) {
        throw new AppError(
          400,
          "VOICE_NOT_CONFIGURED",
          "尚未配置音色服务，无法启用或停用",
        );
      }
      return { voice: toView(settings, referenceOf(store, settings)) };
    });
  }

  saveVoice(roleId: string, input: SaveVoiceInput): { voice: VoiceConfigView } {
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const audioMeta =
      input.referenceFile === undefined
        ? null
        : validateUploadedAudio(input.referenceFile);
    if (audioMeta !== null && input.voiceSource?.kind === "preset") {
      throw new AppError(
        400,
        "INVALID_REQUEST",
        "上传参考音频时不能同时选择预置音色",
      );
    }
    return this.roleAccess.withStore(roleId, (storage) => {
      const store = new VoiceStore(storage.business.db, roleId);
      const existing = store.getSettings();
      const protocol = input.protocol ?? existing?.protocol ?? "indextts";
      const serviceChanged =
        existing !== null &&
        (existing.baseUrl !== baseUrl || existing.protocol !== protocol);
      const capabilities =
        protocol === "indextts"
          ? null
          : input.capabilities === undefined
            ? existing !== null &&
              existing.baseUrl === baseUrl &&
              existing.protocol === protocol
              ? existing.capabilities
              : null
            : input.capabilities;
      assertExplicitCapabilityParams(
        protocol,
        capabilities,
        input.language,
        input.speed,
      );

      const pendingAssetId = audioMeta === null ? null : randomUUID();
      const saveInput: SaveVoiceInput =
        pendingAssetId === null
          ? input
          : {
              ...input,
              voiceSource: {
                kind: "reference",
                referenceAssetId: pendingAssetId,
                ...(input.voiceSource?.kind === "reference" &&
                input.voiceSource.referenceMode !== undefined
                  ? { referenceMode: input.voiceSource.referenceMode }
                  : {}),
                ...(input.voiceSource?.kind === "reference" &&
                input.voiceSource.referenceText !== undefined
                  ? { referenceText: input.voiceSource.referenceText }
                  : {}),
              },
            };

      let source = savedSource(saveInput, existing, protocol, serviceChanged);
      const shortcutAvailable =
        !serviceChanged &&
        (existing === null ||
          existing.voiceSource.kind !== "reference" ||
          existing.voiceSource.referenceMode !== null ||
          existing.referenceModeConfirmed);
      source = applySingleReferenceMode(
        source,
        capabilities,
        shortcutAvailable,
      );
      assertSourceSupported(source, protocol, capabilities);
      const existingReference =
        audioMeta === null &&
        source.kind === "reference" &&
        source.referenceAssetId !== null
          ? store.getReference(source.referenceAssetId)
          : null;
      if (
        audioMeta === null &&
        source.kind === "reference" &&
        source.referenceAssetId !== null &&
        existingReference === null
      ) {
        throw new AppError(
          404,
          "VOICE_REFERENCE_NOT_FOUND",
          "参考音频不存在",
          { assetId: source.referenceAssetId },
        );
      }

      const settingsPayload = {
        protocol,
        baseUrl,
        voiceSource: source,
        capabilities,
        referenceModeConfirmed: resolveReferenceModeConfirmed(
          protocol,
          source,
          serviceChanged,
          existing,
        ),
        language: resolveSavedLanguage(
          protocol,
          capabilities,
          input.language ?? existing?.language,
        ),
        speed: resolveSavedSpeed(
          protocol,
          capabilities,
          input.speed ?? existing?.speed,
        ),
        emoAlpha: normalizeEmoAlpha(input.emoAlpha ?? existing?.emoAlpha),
        now: this.now().toISOString(),
      };

      if (audioMeta === null || pendingAssetId === null || input.referenceFile === undefined) {
        const settings = store.saveSettings(settingsPayload);
        return { voice: toView(settings, existingReference) };
      }

      const relativePath = `voice/${pendingAssetId}${audioMeta.extension}`;
      const absolutePath = path.join(storage.paths.roleDir, relativePath);
      fs.mkdirSync(storage.paths.voiceDir, { recursive: true });
      fs.writeFileSync(absolutePath, input.referenceFile.data, { flag: "wx" });
      try {
        return storage.business.db.transaction(() => {
          const reference = store.addReference({
            assetId: pendingAssetId,
            fileName: audioMeta.fileName,
            mediaType: audioMeta.mediaType,
            relativePath,
            createdAt: settingsPayload.now,
          });
          const settings = store.saveSettings(settingsPayload);
          return { voice: toView(settings, reference) };
        })();
      } catch (error) {
        fs.rmSync(absolutePath, { force: true });
        throw error;
      }
    });
  }

  importReference(
    roleId: string,
    audio: UploadedAudio,
  ): { reference: VoiceReferenceRecord } {
    const meta = validateUploadedAudio(audio);
    return this.roleAccess.withStore(roleId, (storage) => {
      const assetId = randomUUID();
      const relativePath = `voice/${assetId}${meta.extension}`;
      const absolutePath = path.join(storage.paths.roleDir, relativePath);
      fs.mkdirSync(storage.paths.voiceDir, { recursive: true });
      fs.writeFileSync(absolutePath, audio.data, { flag: "wx" });
      try {
        const reference = new VoiceStore(
          storage.business.db,
          roleId,
        ).addReference({
          assetId,
          fileName: meta.fileName,
          mediaType: meta.mediaType,
          relativePath,
          createdAt: this.now().toISOString(),
        });
        return { reference };
      } catch (error) {
        fs.rmSync(absolutePath, { force: true });
        throw error;
      }
    });
  }

  listReferences(roleId: string): { items: VoiceReferenceView[] } {
    return this.roleAccess.withStore(roleId, (storage) => {
      const store = new VoiceStore(storage.business.db, roleId);
      const settings = store.getSettings();
      const inUseId =
        settings?.voiceSource.kind === "reference"
          ? settings.voiceSource.referenceAssetId
          : null;
      return {
        items: store.listReferences().map((reference) => ({
          assetId: reference.assetId,
          fileName: reference.fileName,
          mediaType: reference.mediaType,
          createdAt: reference.createdAt,
          inUse: reference.assetId === inUseId,
        })),
      };
    });
  }

  /**
   * 删除未使用的参考音频。正在使用的先切换音源再删，避免角色配置悬空。
   * 数据库记录删除成功即视为删除完成；文件清理失败返回 fileRemoved=false，
   * 便于配置页提示重试，不把已删记录回滚成半删除状态。
   */
  deleteReference(
    roleId: string,
    assetId: string,
  ): { deleted: true; fileRemoved: boolean } {
    return this.roleAccess.withStore(roleId, (storage) => {
      const store = new VoiceStore(storage.business.db, roleId);
      const settings = store.getSettings();
      if (
        settings?.voiceSource.kind === "reference" &&
        settings.voiceSource.referenceAssetId === assetId
      ) {
        throw new VoiceReferenceInUseError(assetId);
      }
      const reference = store.getReference(assetId);
      if (reference === null) {
        throw new VoiceReferenceNotFoundError(assetId);
      }
      if (!store.deleteReference(assetId)) {
        throw new VoiceReferenceNotFoundError(assetId);
      }
      const absolutePath = resolveVoiceAssetPath(
        storage.paths.roleDir,
        reference.relativePath,
      );
      let fileRemoved = false;
      if (absolutePath !== null) {
        try {
          fs.rmSync(absolutePath, { force: true });
          fileRemoved = true;
        } catch {
          console.warn(
            `[voice] 参考音频文件未能清理：${absolutePath}`,
          );
        }
      }
      return { deleted: true, fileRemoved };
    });
  }

  async probe(
    roleId: string,
    baseUrl: string,
    signal?: AbortSignal,
  ): Promise<{ probe: VoiceProbeResult }> {
    this.roleAccess.requireReady(roleId);
    const normalized = normalizeBaseUrl(baseUrl);
    const probe = await new UnifiedTtsClient(
      normalized,
      this.probeTimeoutMs,
    ).probe(signal);
    return { probe };
  }

  async preview(
    roleId: string,
    input: VoicePreviewInput,
    signal?: AbortSignal,
  ): Promise<SynthesizedAudio> {
    const text = normalizePreviewText(input.text);
    const temporaryAudio =
      input.referenceFile === undefined
        ? undefined
        : {
            audio: input.referenceFile,
            ...validateUploadedAudio(input.referenceFile),
          };
    const { resolved, tempDir } = this.roleAccess.withStore(
      roleId,
      (storage) =>
        resolvePreviewVoice(
          storage.paths,
          storage.business.db,
          roleId,
          input,
          temporaryAudio,
        ),
    );
    try {
      return await this.synthesize(resolved, text, signal, input.emotion);
    } finally {
      if (tempDir !== undefined) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  }

  async synthesizeSegment(
    roleId: string,
    windowId: string,
    segmentId: string,
    signal?: AbortSignal,
    emotion?: string,
  ): Promise<SynthesizedAudio> {
    const { resolved, text } = this.roleAccess.withStore(roleId, (storage) => {
      const store = new VoiceStore(storage.business.db, roleId);
      // 停用只阻止新的对话语音合成；试听属于配置验证，仍可进行。
      const segment = new ConversationStore(
        storage.business.db,
        roleId,
      ).getSegment(windowId, segmentId);
      if (segment.kind !== "speech") {
        throw new AppError(
          400,
          "VOICE_SEGMENT_NOT_SPEAKABLE",
          "旁白句段不参与语音合成",
          { segmentId },
        );
      }
      const segmentText = segment.text.trim();
      if (segmentText.length === 0) {
        throw new AppError(400, "VOICE_SEGMENT_EMPTY", "句段没有可合成文字", {
          segmentId,
        });
      }
      // 停用只阻止新的对话语音合成；试听属于配置验证，仍可进行。
      if (store.getSettings()?.enabled === false) {
        throw new AppError(
          409,
          "VOICE_DISABLED",
          "角色语音已停用，启用后才能播放对话语音",
          { roleId },
        );
      }
      return {
        resolved: resolveVoice(storage.paths, storage.business.db, roleId, {}),
        text: segmentText,
      };
    });
    return this.synthesize(resolved, text, signal, emotion);
  }

  private synthesize(
    resolved: ResolvedVoice,
    text: string,
    signal: AbortSignal | undefined,
    emotion: string | undefined,
  ): Promise<SynthesizedAudio> {
    if (resolved.protocol === "indextts") {
      return new IndexTtsClient(resolved.baseUrl, this.timeoutMs).synthesize({
        text,
        language: resolved.language,
        referencePath: resolved.referencePath,
        speed: resolved.speed,
        emoAlpha: resolved.emoAlpha,
        ...(signal === undefined ? {} : { signal }),
      });
    }
    if ([...text].length > MAX_SYNTHESIS_CHARS) {
      throw new AppError(
        400,
        "VOICE_TEXT_TOO_LONG",
        "台词超过单次合成 1000 个 Unicode 码点的上限",
      );
    }
    return new UnifiedTtsClient(resolved.baseUrl, this.timeoutMs).synthesize({
      text,
      source: resolved.source,
      language: resolved.language,
      speed: resolved.speed,
      ...(emotion === undefined ? {} : { emotion }),
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

interface TemporaryAudioMeta {
  audio: UploadedAudio;
  fileName: string;
  extension: string;
  mediaType: string;
}

function validateUploadedAudio(audio: UploadedAudio): {
  fileName: string;
  extension: string;
  mediaType: string;
} {
  if (audio.data.length === 0) {
    throw new AppError(400, "AUDIO_FILE_EMPTY", "参考音频不能为空");
  }
  if (audio.data.length > MAX_AUDIO_BYTES) {
    throw new AppError(413, "AUDIO_TOO_LARGE", "参考音频超过 32 MiB 上限");
  }
  const inspected = inspectAudio(audio.data);
  if (inspected === null) {
    throw new AppError(
      400,
      "AUDIO_FORMAT_UNSUPPORTED",
      "参考音频需为 WAV、MP3、FLAC 或 OGG",
      { fileName: audio.fileName },
    );
  }
  const fileName =
    path.basename(audio.fileName).trim() || `reference${inspected.extension}`;
  return { fileName, ...inspected };
}

function resolvePreviewVoice(
  paths: RolePaths,
  db: Database.Database,
  roleId: string,
  input: VoiceOverrides,
  temporaryAudio?: TemporaryAudioMeta,
): { resolved: ResolvedVoice; tempDir?: string } {
  const store = new VoiceStore(db, roleId);
  const settings = store.getSettings();
  const protocol = input.protocol ?? settings?.protocol ?? "indextts";
  const baseUrl =
    input.baseUrl === undefined
      ? settings?.baseUrl
      : normalizeBaseUrl(input.baseUrl);
  if (baseUrl === undefined) {
    throw new AppError(400, "VOICE_NOT_CONFIGURED", "尚未配置音色服务");
  }
  const capabilities =
    protocol === "indextts"
      ? null
      : input.capabilities !== undefined
        ? input.capabilities
        : settings !== null &&
            settings.baseUrl === baseUrl &&
            settings.protocol === protocol
          ? settings.capabilities
          : null;
  assertExplicitCapabilityParams(
    protocol,
    capabilities,
    input.language,
    input.speed,
  );
  const serviceChanged =
    settings !== null &&
    (settings.baseUrl !== baseUrl || settings.protocol !== protocol);
  const source = resolveSource(input, settings, protocol, serviceChanged);
  if (temporaryAudio !== undefined && source.kind === "preset") {
    throw new AppError(
      400,
      "INVALID_REQUEST",
      "试听预置音色时不能附带临时参考音频",
    );
  }
  if (protocol === "indextts") {
    return resolveLegacyVoice(
      store,
      paths,
      baseUrl,
      source,
      input,
      settings,
      temporaryAudio,
    );
  }
  return {
    resolved: resolveUnifiedVoice(
      store,
      paths,
      baseUrl,
      source,
      input,
      settings,
      capabilities,
      temporaryAudio,
    ),
  };
}

function resolveVoice(
  paths: RolePaths,
  db: Database.Database,
  roleId: string,
  input: VoiceOverrides,
): ResolvedVoice {
  return resolvePreviewVoice(paths, db, roleId, input).resolved;
}

function resolveLegacyVoice(
  store: VoiceStore,
  paths: RolePaths,
  baseUrl: string,
  source: VoiceSource,
  input: VoiceOverrides,
  settings: VoiceSettingsRecord | null,
  temporaryAudio?: TemporaryAudioMeta,
): { resolved: ResolvedLegacyVoice; tempDir?: string } {
  if (source.kind === "preset") {
    throw new AppError(
      400,
      "VOICE_SOURCE_UNSUPPORTED",
      "IndexTTS 旧协议只支持参考音频音色",
    );
  }
  const language = normalizeLegacyLanguage(input.language ?? settings?.language);
  const speed = normalizeLegacySpeed(input.speed ?? settings?.speed);
  const emoAlpha = normalizeEmoAlpha(input.emoAlpha ?? settings?.emoAlpha);
  if (temporaryAudio !== undefined) {
    // IndexTTS 通过本地路径读取参考音频：只在系统临时目录落地并由调用方 finally 清理，不进 roleDir。
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nowadays-voice-preview-"),
    );
    const referencePath = path.join(
      tempDir,
      `reference${temporaryAudio.extension}`,
    );
    fs.writeFileSync(referencePath, temporaryAudio.audio.data);
    return {
      resolved: {
        protocol: "indextts",
        baseUrl,
        referencePath,
        language,
        speed,
        emoAlpha,
      },
      tempDir,
    };
  }
  if (source.referenceAssetId === null) {
    throw new AppError(400, "VOICE_REFERENCE_REQUIRED", "尚未导入参考音色");
  }
  const reference = store.getReference(source.referenceAssetId);
  if (reference === null) {
    throw new AppError(404, "VOICE_REFERENCE_NOT_FOUND", "参考音频不存在", {
      assetId: source.referenceAssetId,
    });
  }
  return {
    resolved: {
      protocol: "indextts",
      baseUrl,
      referencePath: resolveReferencePath(paths, reference),
      language,
      speed,
      emoAlpha,
    },
  };
}

function resolveUnifiedVoice(
  store: VoiceStore,
  paths: RolePaths,
  baseUrl: string,
  source: VoiceSource,
  input: VoiceOverrides,
  settings: VoiceSettingsRecord | null,
  capabilities: VoiceCapabilities | null,
  temporaryAudio?: TemporaryAudioMeta,
): ResolvedUnifiedVoice {
  const language = resolveUnifiedLanguage(
    capabilities,
    input.language ?? settings?.language,
  );
  const speed = resolveUnifiedSpeed(
    capabilities,
    input.speed ?? settings?.speed,
  );
  if (source.kind === "preset") {
    if (
      source.voiceId.trim().length === 0
    ) {
      throw new AppError(
        400,
        "VOICE_PRESET_VOICE_REQUIRED",
        "尚未选择预置音色",
      );
    }
    if (capabilities !== null && !capabilities.presetVoices) {
      throw new AppError(
        400,
        "VOICE_PRESET_UNSUPPORTED",
        "当前音色服务未声明预置音色",
      );
    }
    return {
      protocol: "nowadays-tts-v1",
      baseUrl,
      source: { kind: "preset", voiceId: source.voiceId },
      language,
      speed,
    };
  }
  if (temporaryAudio === undefined && source.referenceAssetId === null) {
    throw new AppError(400, "VOICE_REFERENCE_REQUIRED", "尚未导入参考音色");
  }
  const reference =
    temporaryAudio === undefined && source.referenceAssetId !== null
      ? store.getReference(source.referenceAssetId)
      : null;
  if (
    temporaryAudio === undefined &&
    source.referenceAssetId !== null &&
    reference === null
  ) {
    throw new AppError(404, "VOICE_REFERENCE_NOT_FOUND", "参考音频不存在", {
      assetId: source.referenceAssetId,
    });
  }
  const referencePath =
    reference === null ? null : resolveReferencePath(paths, reference);
  let mode = source.referenceMode;
  let modeDefinition: { requiresReferenceText: boolean } | null = null;
  if (capabilities !== null) {
    if (mode === null) {
      if (capabilities.referenceModes.length === 0) {
        throw new AppError(
          400,
          "VOICE_REFERENCE_MODE_UNSUPPORTED",
          "当前音色服务未声明参考音频模式",
        );
      }
      throw new AppError(
        400,
        "VOICE_REFERENCE_MODE_REQUIRED",
        "尚未选择参考音频模式",
      );
    }
    const found = capabilities.referenceModes.find(
      (candidate) => candidate.id === mode,
    );
    if (found === undefined) {
      throw new AppError(
        400,
        "VOICE_REFERENCE_MODE_INVALID",
        "参考音频模式不在服务声明的范围内",
        { referenceMode: mode },
      );
    }
    modeDefinition = found;
  } else if (mode === null) {
    throw new AppError(
      400,
      "VOICE_REFERENCE_MODE_REQUIRED",
      "尚未选择参考音频模式",
    );
  }
  const referenceText =
    modeDefinition === null || modeDefinition.requiresReferenceText
      ? source.referenceText?.trim() || null
      : null;
  if (
    modeDefinition?.requiresReferenceText === true &&
    referenceText === null
  ) {
    throw new AppError(
      400,
      "VOICE_REFERENCE_TEXT_REQUIRED",
      "当前参考模式需要录音原文",
    );
  }
  if (temporaryAudio !== undefined) {
    return {
      protocol: "nowadays-tts-v1",
      baseUrl,
      source: {
        kind: "reference",
        reference: {
          mode,
          text: referenceText,
          fileName: temporaryAudio.fileName,
          mediaType: temporaryAudio.mediaType,
          data: temporaryAudio.audio.data,
        },
      },
      language,
      speed,
    };
  }
  let data: Buffer;
  try {
    data = fs.readFileSync(referencePath!);
  } catch {
    throw new AppError(
      404,
      "VOICE_REFERENCE_FILE_MISSING",
      "参考音频文件缺失",
      { assetId: reference!.assetId },
    );
  }
  return {
    protocol: "nowadays-tts-v1",
    baseUrl,
    source: {
      kind: "reference",
      reference: {
        mode,
        text: referenceText,
        fileName: reference!.fileName,
        mediaType: reference!.mediaType,
        data,
      },
    },
    language,
    speed,
  };
}

function savedSource(
  input: SaveVoiceInput,
  existing: VoiceSettingsRecord | null,
  protocol: VoiceProtocol,
  serviceChanged: boolean,
): VoiceSource {
  if (input.voiceSource !== undefined) {
    return toStoredSource(
      input.voiceSource,
      protocol,
      existing?.voiceSource ?? null,
      serviceChanged,
    );
  }
  if (input.referenceAssetId !== undefined) {
    return toStoredSource(
      { kind: "reference", referenceAssetId: input.referenceAssetId },
      protocol,
      existing?.voiceSource ?? null,
      serviceChanged,
    );
  }
  if (existing === null) {
    return emptyReferenceSource();
  }
  if (!serviceChanged) {
    return existing.voiceSource;
  }
  if (existing.voiceSource.kind === "preset") {
    throw new AppError(
      400,
      "VOICE_SOURCE_REQUIRED",
      "切换音色服务后需要重新选择音色",
    );
  }
  return toStoredSource(
    {
      kind: "reference",
      referenceAssetId: existing.voiceSource.referenceAssetId,
      referenceMode: null,
    },
    protocol,
    existing.voiceSource,
    true,
  );
}

function resolveSource(
  input: VoiceOverrides,
  settings: VoiceSettingsRecord | null,
  protocol: VoiceProtocol,
  serviceChanged: boolean,
): VoiceSource {
  if (input.voiceSource !== undefined) {
    return toStoredSource(
      input.voiceSource,
      protocol,
      settings?.voiceSource ?? null,
      serviceChanged,
    );
  }
  if (input.referenceAssetId !== undefined) {
    return toStoredSource(
      { kind: "reference", referenceAssetId: input.referenceAssetId },
      protocol,
      settings?.voiceSource ?? null,
      serviceChanged,
    );
  }
  if (settings === null) {
    return emptyReferenceSource();
  }
  if (!serviceChanged) {
    return settings.voiceSource;
  }
  if (settings.voiceSource.kind === "preset") {
    throw new AppError(
      400,
      "VOICE_SOURCE_REQUIRED",
      "切换音色服务后需要重新选择音色",
    );
  }
  return toStoredSource(
    {
      kind: "reference",
      referenceAssetId: settings.voiceSource.referenceAssetId,
      referenceMode: null,
    },
    protocol,
    settings.voiceSource,
    true,
  );
}

function toStoredSource(
  input: VoiceSourceInput,
  protocol: VoiceProtocol,
  fallback: VoiceSource | null,
  serviceChanged: boolean,
): VoiceSource {
  if (input.kind === "preset") {
    return { kind: "preset", voiceId: input.voiceId.trim() };
  }
  const previous = fallback?.kind === "reference" ? fallback : null;
  const referenceAssetId =
    input.referenceAssetId === undefined
      ? (previous?.referenceAssetId ?? null)
      : input.referenceAssetId;
  const sameAsset =
    previous !== null &&
    referenceAssetId !== null &&
    referenceAssetId === previous.referenceAssetId;
  return {
    kind: "reference",
    referenceAssetId,
    referenceMode:
      protocol === "indextts"
        ? null
        : input.referenceMode !== undefined
          ? input.referenceMode?.trim() || null
          : serviceChanged
            ? null
            : (previous?.referenceMode ?? null),
    referenceText:
      protocol === "indextts"
        ? null
        : input.referenceText !== undefined
          ? input.referenceText?.trim() || null
          : sameAsset
            ? (previous?.referenceText ?? null)
            : null,
  };
}

function resolveReferenceModeConfirmed(
  protocol: VoiceProtocol,
  source: VoiceSource,
  serviceChanged: boolean,
  existing: VoiceSettingsRecord | null,
): boolean {
  if (protocol === "indextts" || source.kind === "preset") {
    return true;
  }
  if (source.referenceMode !== null) {
    return true;
  }
  if (serviceChanged) {
    return false;
  }
  return existing?.referenceModeConfirmed ?? true;
}

function applySingleReferenceMode(
  source: VoiceSource,
  capabilities: VoiceCapabilities | null,
  allowShortcut: boolean,
): VoiceSource {
  if (
    !allowShortcut ||
    source.kind !== "reference" ||
    source.referenceMode !== null ||
    capabilities === null ||
    capabilities.referenceModes.length !== 1
  ) {
    return source;
  }
  return {
    ...source,
    referenceMode: capabilities.referenceModes[0]!.id,
  };
}

function assertSourceSupported(
  source: VoiceSource,
  protocol: VoiceProtocol,
  capabilities: VoiceCapabilities | null,
): void {
  if (protocol === "indextts") {
    if (source.kind === "preset") {
      throw new AppError(
        400,
        "VOICE_SOURCE_UNSUPPORTED",
        "IndexTTS 旧协议只支持参考音频音色",
      );
    }
    return;
  }
  if (source.kind === "preset") {
    if (source.voiceId.trim().length === 0) {
      throw new AppError(
        400,
        "VOICE_PRESET_VOICE_REQUIRED",
        "尚未选择预置音色",
      );
    }
    if (capabilities !== null && !capabilities.presetVoices) {
      throw new AppError(
        400,
        "VOICE_PRESET_UNSUPPORTED",
        "当前音色服务未声明预置音色",
      );
    }
    return;
  }
  if (capabilities === null) {
    return;
  }
  if (capabilities.referenceModes.length === 0) {
    throw new AppError(
      400,
      "VOICE_REFERENCE_MODE_UNSUPPORTED",
      "当前音色服务未声明参考音频模式",
    );
  }
  if (
    source.referenceMode !== null &&
    !capabilities.referenceModes.some(
      (mode) => mode.id === source.referenceMode,
    )
  ) {
    throw new AppError(
      400,
      "VOICE_REFERENCE_MODE_INVALID",
      "参考音频模式不在服务声明的范围内",
      { referenceMode: source.referenceMode },
    );
  }
}

function assertExplicitCapabilityParams(
  protocol: VoiceProtocol,
  capabilities: VoiceCapabilities | null,
  language: VoiceLanguage | undefined,
  speed: number | undefined,
): void {
  if (protocol === "indextts") {
    if (language !== undefined) {
      normalizeLegacyLanguage(language);
    }
    if (speed !== undefined) {
      normalizeLegacySpeed(speed);
    }
    return;
  }
  const normalizedLanguage =
    language === undefined ? undefined : normalizeLanguageCode(language);
  const normalizedSpeed =
    speed === undefined ? undefined : normalizeUnifiedSpeed(speed);
  if (capabilities === null) {
    return;
  }
  if (
    normalizedLanguage !== undefined &&
    capabilities.languages.length > 0 &&
    !capabilities.languages.includes(normalizedLanguage)
  ) {
    throw new AppError(
      400,
      "VOICE_LANGUAGE_UNSUPPORTED",
      "语音语言不在服务声明的范围内",
      { language: normalizedLanguage },
    );
  }
  if (
    normalizedSpeed !== undefined &&
    capabilities.speed !== null &&
    (normalizedSpeed < capabilities.speed.min ||
      normalizedSpeed > capabilities.speed.max)
  ) {
    throw new AppError(
      400,
      "VOICE_SPEED_OUT_OF_RANGE",
      "语速不在服务声明的范围内",
      capabilities.speed,
    );
  }
}

function resolveSavedLanguage(
  protocol: VoiceProtocol,
  capabilities: VoiceCapabilities | null,
  value: VoiceLanguage | undefined,
): VoiceLanguage {
  if (protocol === "indextts") {
    return normalizeLegacyLanguage(value);
  }
  const language = normalizeLanguageCode(value);
  if (capabilities === null || capabilities.languages.length === 0) {
    return language;
  }
  return capabilities.languages.includes(language)
    ? language
    : capabilities.languages[0]!;
}

function resolveSavedSpeed(
  protocol: VoiceProtocol,
  capabilities: VoiceCapabilities | null,
  value: number | undefined,
): number {
  if (protocol === "indextts") {
    return normalizeLegacySpeed(value);
  }
  const speed = normalizeUnifiedSpeed(value);
  if (capabilities === null || capabilities.speed === null) {
    return speed;
  }
  return Math.min(capabilities.speed.max, Math.max(capabilities.speed.min, speed));
}

function resolveUnifiedLanguage(
  capabilities: VoiceCapabilities | null,
  value: VoiceLanguage | undefined,
): VoiceLanguage | null {
  if (capabilities === null || capabilities.languages.length === 0) {
    return null;
  }
  const language = normalizeLanguageCode(value);
  return capabilities.languages.includes(language) ? language : null;
}

function resolveUnifiedSpeed(
  capabilities: VoiceCapabilities | null,
  value: number | undefined,
): number | null {
  if (capabilities === null || capabilities.speed === null) {
    return null;
  }
  const speed = normalizeUnifiedSpeed(value);
  return Math.min(capabilities.speed.max, Math.max(capabilities.speed.min, speed));
}

function emptyReferenceSource(): VoiceSource {
  return {
    kind: "reference",
    referenceAssetId: null,
    referenceMode: null,
    referenceText: null,
  };
}

function resolveReferencePath(
  paths: RolePaths,
  reference: VoiceReferenceRecord,
): string {
  const root = path.resolve(paths.voiceDir);
  const target = path.resolve(paths.roleDir, reference.relativePath);
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new AppError(404, "VOICE_REFERENCE_NOT_FOUND", "参考音频不存在");
  }
  if (!fs.existsSync(target)) {
    throw new AppError(
      404,
      "VOICE_REFERENCE_FILE_MISSING",
      "参考音频文件缺失",
      { assetId: reference.assetId },
    );
  }
  return target;
}

function toView(
  settings: VoiceSettingsRecord,
  reference: VoiceReferenceRecord | null,
): VoiceConfigView {
  return {
    engine: settings.engine,
    protocol: settings.protocol,
    baseUrl: settings.baseUrl,
    voiceSource: settings.voiceSource,
    reference,
    capabilities: settings.capabilities,
    enabled: settings.enabled,
    language: settings.language,
    speed: settings.speed,
    emoAlpha: settings.emoAlpha,
    createdAt: settings.createdAt,
    updatedAt: settings.updatedAt,
  };
}

function referenceOf(
  store: VoiceStore,
  settings: VoiceSettingsRecord,
): VoiceReferenceRecord | null {
  return settings.voiceSource.kind === "reference" &&
    settings.voiceSource.referenceAssetId !== null
    ? store.getReference(settings.voiceSource.referenceAssetId)
    : null;
}

/** 只清理角色目录内的文件；异常记录返回 null，避免越界删除。 */
function resolveVoiceAssetPath(
  roleDir: string,
  relativePath: string,
): string | null {
  if (relativePath.length === 0) {
    return null;
  }
  const root = path.resolve(roleDir);
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    return null;
  }
  return target;
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new AppError(400, "VOICE_BASE_URL_REQUIRED", "音色服务地址不能为空");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AppError(400, "VOICE_BASE_URL_INVALID", "音色服务地址格式不正确");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError(400, "VOICE_BASE_URL_INVALID", "音色服务地址需为 HTTP 或 HTTPS");
  }
  if (url.username !== "" || url.password !== "") {
    throw new AppError(400, "VOICE_BASE_URL_INVALID", "音色服务地址不能包含账号信息");
  }
  if (url.href.includes("?") || url.href.includes("#")) {
    throw new AppError(
      400,
      "VOICE_BASE_URL_INVALID",
      "音色服务地址不能包含查询串或片段",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function normalizePreviewText(raw: string): string {
  const text = raw.trim();
  if (text.length === 0) {
    throw new AppError(400, "VOICE_PREVIEW_TEXT_REQUIRED", "试听文本不能为空");
  }
  if ([...text].length > MAX_PREVIEW_CHARS) {
    throw new AppError(400, "VOICE_PREVIEW_TEXT_TOO_LONG", "试听文本过长");
  }
  return text;
}

function normalizeLegacyLanguage(value: VoiceLanguage | undefined): string {
  if (value === undefined) {
    return DEFAULT_LANGUAGE;
  }
  if (!(VOICE_LANGUAGES as readonly string[]).includes(value)) {
    throw new AppError(
      400,
      "VOICE_LANGUAGE_INVALID",
      "旧协议仅支持 zh、en、ja、es、ar",
    );
  }
  return value;
}

function normalizeLanguageCode(value: VoiceLanguage | undefined): string {
  if (value === undefined) {
    return DEFAULT_LANGUAGE;
  }
  const language = value.trim();
  if (!VOICE_LANGUAGE_CODE_PATTERN.test(language)) {
    throw new AppError(400, "VOICE_LANGUAGE_INVALID", "语言代码格式不正确");
  }
  return language;
}

function normalizeLegacySpeed(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_SPEED;
  }
  if (
    !Number.isFinite(value) ||
    value < MIN_LEGACY_SPEED ||
    value > MAX_LEGACY_SPEED
  ) {
    throw new AppError(400, "VOICE_SPEED_INVALID", "语速需在 0.5 到 2 之间");
  }
  return value;
}

function normalizeUnifiedSpeed(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_SPEED;
  }
  if (
    !Number.isFinite(value) ||
    value < MIN_UNIFIED_SPEED ||
    value > MAX_UNIFIED_SPEED
  ) {
    throw new AppError(400, "VOICE_SPEED_INVALID", "语速需在 0.1 到 10 之间");
  }
  return value;
}

function normalizeEmoAlpha(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_EMO_ALPHA;
  }
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new AppError(
      400,
      "VOICE_EMO_ALPHA_INVALID",
      "情绪强度需在 0 到 1 之间",
    );
  }
  return value;
}
