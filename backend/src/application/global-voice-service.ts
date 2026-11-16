import { randomUUID } from "node:crypto";
import {
  AppError,
  InvalidVoiceServiceConfigError,
} from "../domain/errors.js";
import { normalizeVoiceBaseUrl, type VoiceProtocol } from "../domain/voice.js";
import {
  voiceServiceConfigSchema,
  type VoiceServiceConfig,
  type VoiceServiceProbeResult,
  type VoiceServiceRecord,
} from "../domain/voice-service.js";
import type { AppStore } from "../storage/app-store.js";
import { VoiceServiceStore } from "../storage/voice-service-store.js";
import { VoiceStore } from "../storage/voice-store.js";
import { UnifiedTtsClient } from "../tts/unified-tts-client.js";
import type { RoleAccess } from "./role-access.js";

export interface GlobalVoiceServiceOptions {
  now?: () => Date;
  probeTimeoutMs?: number;
}

export interface CreateVoiceServiceInput {
  name: string;
  config: unknown;
  enabled?: boolean | undefined;
}

export interface UpdateVoiceServiceInput {
  name?: string | undefined;
  enabled?: boolean | undefined;
  config?: unknown;
}

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/**
 * 全局语音服务目录管理（DL-152）。
 * 全局维护名称、启用态、协议、地址与可选默认引擎，角色仅引用服务 ID
 * 并在角色页管理各自音色来源、参考录音、语速／情感与试听。
 */
export class GlobalVoiceService {
  private readonly now: () => Date;
  private readonly probeTimeoutMs: number;

  constructor(
    private readonly appStore: AppStore,
    options: GlobalVoiceServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  }

  private get store(): VoiceServiceStore {
    return new VoiceServiceStore(this.appStore.db);
  }

  list(): VoiceServiceRecord[] {
    return this.store.list();
  }

  get(serviceId: string): VoiceServiceRecord {
    return this.store.get(serviceId);
  }

  findRecord(serviceId: string): VoiceServiceRecord | null {
    return this.store.find(serviceId);
  }

  create(input: CreateVoiceServiceInput): VoiceServiceRecord {
    const name = normalizeServiceName(input.name);
    const config = this.parseConfig(input.config);
    const serviceId = randomUUID();
    const now = this.now().toISOString();
    return this.store.create({
      serviceId,
      name,
      enabled: input.enabled ?? true,
      config,
      now,
    });
  }

  update(serviceId: string, input: UpdateVoiceServiceInput): VoiceServiceRecord {
    this.store.get(serviceId);
    const name =
      input.name === undefined ? undefined : normalizeServiceName(input.name);
    const config =
      input.config === undefined ? undefined : this.parseConfig(input.config);
    return this.store.update({
      serviceId,
      ...(name === undefined ? {} : { name }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(config === undefined ? {} : { config }),
      now: this.now().toISOString(),
    });
  }

  delete(serviceId: string): { serviceId: string; deleted: true } {
    this.store.get(serviceId);
    this.store.delete(serviceId);
    return { serviceId, deleted: true };
  }

  async probeSaved(
    serviceId: string,
    signal?: AbortSignal,
  ): Promise<VoiceServiceProbeResult> {
    const service = this.store.get(serviceId);
    return this.runProbe(service.config, signal);
  }

  async probeDraft(
    config: unknown,
    signal?: AbortSignal,
  ): Promise<VoiceServiceProbeResult> {
    const parsed = this.parseConfig(config);
    return this.runProbe(parsed, signal);
  }

  /**
   * 启动期自动迁移：将尚未关联全局服务、但在 role_voice_settings 存有端点的旧角色配置
   * 自动生成／合并为全局语音服务并回填 service_id，保留角色既有音色与启停状态。
   */
  backfillFromRoles(roleAccess: RoleAccess): void {
    const readyRoles = this.appStore
      .listRoleIndexes()
      .filter((role) => role.initStatus === "ready");
    if (readyRoles.length === 0) return;

    const now = this.now().toISOString();
    for (const role of readyRoles) {
      try {
        roleAccess.withStore(role.roleId, (storage) => {
          const voiceStore = new VoiceStore(storage.business.db, role.roleId);
          const settings = voiceStore.getSettings();
          if (settings === null || settings.serviceId !== null) return;
          let normalizedUrl: string;
          try {
            normalizedUrl = normalizeVoiceBaseUrl(settings.baseUrl);
          } catch {
            return;
          }
          let service = this.store.findByEndpoint(
            settings.protocol,
            normalizedUrl,
          );
          if (service === null) {
            const name = pickMigratedServiceName(
              normalizedUrl,
              settings.protocol,
              this.store.list(),
            );
            service = this.store.create({
              serviceId: randomUUID(),
              name,
              enabled: true,
              config: {
                protocol: settings.protocol,
                baseUrl: normalizedUrl,
                ...(settings.protocol === "nowadays-tts-v1" &&
                settings.defaultEngine
                  ? { defaultEngine: settings.defaultEngine }
                  : {}),
              },
              now,
            });
          }
          voiceStore.linkService(service.serviceId);
        });
      } catch {
        // 个别角色库异常不影响服务启动与其他角色迁移；仍可通过角色页重新选择服务。
      }
    }
  }

  private async runProbe(
    config: VoiceServiceConfig,
    signal?: AbortSignal,
  ): Promise<VoiceServiceProbeResult> {
    if (config.protocol !== "nowadays-tts-v1") {
      throw new AppError(
        400,
        "VOICE_PROBE_UNSUPPORTED",
        "旧 IndexTTS 协议没有探测接口，请在角色语音配置中用试听验证连接",
      );
    }
    const started = Date.now();
    const probe = await new UnifiedTtsClient(
      config.baseUrl,
      this.probeTimeoutMs,
    ).probe(signal);
    return {
      probe,
      elapsedMs: Date.now() - started,
    };
  }

  private parseConfig(input: unknown): VoiceServiceConfig {
    const parsed = voiceServiceConfigSchema.safeParse(input);
    if (!parsed.success) {
      throw new InvalidVoiceServiceConfigError(parsed.error.flatten());
    }
    const baseUrl = normalizeVoiceBaseUrl(parsed.data.baseUrl);
    return {
      protocol: parsed.data.protocol,
      baseUrl,
      ...(parsed.data.defaultEngine === undefined
        ? {}
        : { defaultEngine: parsed.data.defaultEngine }),
    };
  }
}

function normalizeServiceName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 200) {
    throw new InvalidVoiceServiceConfigError({ name: "服务名称需在 1～200 字之间" });
  }
  return trimmed;
}

function pickMigratedServiceName(
  baseUrl: string,
  protocol: VoiceProtocol,
  existing: VoiceServiceRecord[],
): string {
  const host = (() => {
    try {
      const parsed = new URL(baseUrl);
      return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost"
        ? `本机语音服务${parsed.port ? ` (${parsed.port})` : ""}`
        : parsed.host;
    } catch {
      return "语音服务";
    }
  })();
  const base =
    protocol === "indextts" ? `${host} · IndexTTS` : host;
  const used = new Set(existing.map((item) => item.name));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base} #${suffix}`)) {
    suffix += 1;
  }
  return `${base} #${suffix}`;
}
