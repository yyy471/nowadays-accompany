import crypto from 'node:crypto';
import type { Logger } from '../core/logger.js';
import type { Metrics } from '../core/metrics.js';
import type { ConversationRef } from '../routing/identity.js';
import { sleep } from '../core/concurrency.js';
import type { CredentialVault } from '../secrets/vault.js';
import type { ExtensionRegistry } from '../extensions/registry.js';
import type { SkillRuntime, SkillResolution } from '../extensions/registry.js';
import type { ToolDefinition } from '../extensions/types.js';
import { CAPABILITY_IDS, CAPABILITY_LABELS, type CapabilityId } from '../policy/capabilities.js';
import type { EffectivePolicy, PolicyService } from '../policy/policy.js';
import type { ConfigStore } from './config-store.js';
import {
  CapabilityUnavailableError,
  JobError,
  ProviderError,
  sanitizeErrorText,
  sanitizeUrl
} from './errors.js';
import {
  abortReason,
  throwIfAborted,
  type AudioGenerationRequest,
  type AudioGenerationResult,
  type ChatRequest,
  type ChatResponse,
  type ImageGenerationRequest,
  type ImageGenerationResult,
  type ImageObservation,
  type ProviderAdapter,
  type ProviderCallContext,
  type ProviderMedia,
  type ProviderTestResult,
  type VideoObservation
} from './contract.js';
import { EndpointLimiter, endpointKeyFor } from './limiter.js';
import type {
  CapabilityTarget,
  ProviderConfig,
  ProviderModelConfig,
  RuntimeConfigV2
} from './types.js';

export type CapabilityUnavailableReason =
  | 'scope_disabled'
  | 'not_configured'
  | 'provider_not_found'
  | 'provider_not_authorized'
  | 'model_not_found'
  | 'capability_unsupported'
  | 'adapter_not_found'
  | 'adapter_unsupported'
  | 'media_transport_unavailable'
  | 'cloud_media_blocked'
  | 'model_no_image_input'
  | 'cross_provider_fallback_disabled'
  | 'execution_plan_stale'
  | 'credential_stale';

export interface CapabilityRequirements {
  media?: 'image' | 'video';
  directVision?: boolean;
}

export interface FallbackStatus {
  providerId: string;
  modelId: string;
  valid: boolean;
  reason?: CapabilityUnavailableReason;
}

export interface ResolvedTarget {
  provider: ProviderConfig;
  model: ProviderModelConfig;
  adapter: ProviderAdapter;
  target: CapabilityTarget;
  cancelMode: ReturnType<ProviderAdapter['cancelMode']>;
  parameters: Record<string, unknown>;
  /** 排队任务只持有快照；执行前必须与当前 provider 版本一致。 */
  providerRevision: string;
  /** 原始密钥不进入计划，只记录按 ref 的凭据版本。 */
  credentialRevision?: number;
}

export interface CapabilityResolution {
  capability: CapabilityId;
  enabled: boolean;
  reason?: CapabilityUnavailableReason;
  detail?: string;
  source?: EffectivePolicy['capabilities'][CapabilityId]['source'];
  bindingSource?: EffectivePolicy['capabilities'][CapabilityId]['bindingSource'];
  providerId?: string;
  modelId?: string;
  location?: ProviderConfig['location'];
  credentialRef?: string;
  supportsTools: boolean;
  supportsImageInput: boolean;
  cancelMode?: ResolvedTarget['cancelMode'];
  fallback: FallbackStatus[];
  primary?: ResolvedTarget;
  fallbackTargets: ResolvedTarget[];
  agentEnabled: boolean;
  agentSource: EffectivePolicy['agentSource'];
  visionMode: EffectivePolicy['visionMode'];
  visionSource: EffectivePolicy['visionSource'];
}

export interface CapabilityDto {
  capability: CapabilityId;
  label: string;
  enabled: boolean;
  reason?: CapabilityUnavailableReason;
  detail?: string;
  source?: CapabilityResolution['source'];
  bindingSource?: CapabilityResolution['bindingSource'];
  providerId?: string;
  modelId?: string;
  location?: ProviderConfig['location'];
  supportsTools: boolean;
  supportsImageInput: boolean;
  cancelMode?: ResolvedTarget['cancelMode'];
  credentialRef?: string;
  fallback: FallbackStatus[];
}

export interface EffectiveCapabilitiesDto {
  accountId: string;
  conversation: ConversationRef;
  agentEnabled: boolean;
  agentSource: EffectivePolicy['agentSource'];
  visionMode: EffectivePolicy['visionMode'];
  visionSource: EffectivePolicy['visionSource'];
  replyMode: EffectivePolicy['replyMode'];
  allowCloudUpload: boolean;
  capabilities: CapabilityDto[];
  skills: SkillResolution;
}

export interface ExecutedResult<T> {
  result: T;
  resolution: CapabilityResolution;
  used: { providerId: string; modelId: string };
}

export interface ProviderRouterOptions {
  config: ConfigStore;
  policy: PolicyService;
  skills: SkillRuntime;
  extensions: ExtensionRegistry;
  vault: CredentialVault;
  adapters: ProviderAdapter[];
  logger: Logger;
  metrics?: Metrics;
  now?: () => number;
  onUsage?: (event: {
    accountId: string;
    capability: CapabilityId;
    providerId: string;
    modelId: string;
    ok: boolean;
    durationMs: number;
    code?: string;
    totalTokens?: number;
  }) => void;
}

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const TINY_MP4 = Buffer.from(
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMrbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAlV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAACAAAAAgAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAHNbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABeG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAThzdGJsAAAAuHN0c2QAAAAAAAAAAQAAAKhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAACAAIABIAAAASAAAAAAAAAABFUxhdmM2Mi4yOC4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAALmF2Y0MBQsAK/+EAFmdCwArZCWwEQAAAAwBAAAADAQPEiZIBAAVoy4PLIAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAABR4AAAAAAAAABhzdHRzAAAAAAAAAAEAAAACAAAgAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAACAAAAAQAAABxzdHN6AAAAAAAAAAAAAAACAAAChQAAAAoAAAAUc3RjbwAAAAAAAAABAAADWwAAAGJ1ZHRhAAAAWm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALWlsc3QAAAAlqXRvbwAAAB1kYXRhAAAAAQAAAABMYXZmNjIuMTIuMTAyAAAACGZyZWUAAAKXbWRhdAAAAnAGBf//bNxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjUgcjMyMjMgMDQ4MGNiMCAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjUgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0wIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDE6MHgxMTEgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWlnaHRwPTAga2V5aW50PTI1MCBrZXlpbnRfbWluPTIgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAANZYiEBTyYoAA/vyddeAAAAAZBmjgJeWA=',
  'base64'
);

export class ProviderRouter {
  readonly #config: ConfigStore;
  readonly #policy: PolicyService;
  readonly #skills: SkillRuntime;
  readonly #extensions: ExtensionRegistry;
  readonly #vault: CredentialVault;
  readonly #adapters = new Map<string, ProviderAdapter>();
  readonly #limiters = new Map<string, EndpointLimiter>();
  readonly #logger: Logger;
  readonly #metrics?: Metrics;
  readonly #now: () => number;
  readonly #onUsage?: ProviderRouterOptions['onUsage'];

  constructor(options: ProviderRouterOptions) {
    this.#config = options.config;
    this.#policy = options.policy;
    this.#skills = options.skills;
    this.#extensions = options.extensions;
    this.#vault = options.vault;
    this.#logger = options.logger;
    this.#metrics = options.metrics;
    this.#now = options.now ?? Date.now;
    this.#onUsage = options.onUsage;
    for (const adapter of options.adapters) this.#adapters.set(adapter.id, adapter);
  }

  get vaultKind(): string {
    return this.#vault.kind;
  }

  get vaultAvailable(): boolean {
    return this.#vault.available;
  }

  resolve(
    accountId: string,
    conversation: ConversationRef,
    capability: CapabilityId,
    requirements: CapabilityRequirements = {}
  ): CapabilityResolution {
    const config = this.#config.snapshot();
    const policy = this.#policy.resolveWithConfig(config, accountId, conversation);
    return this.#resolveWith(config, policy, capability, requirements);
  }

  async effective(accountId: string, conversation: ConversationRef): Promise<EffectiveCapabilitiesDto> {
    const config = this.#config.snapshot();
    const policy = this.#policy.resolveWithConfig(config, accountId, conversation);
    const capabilities: CapabilityDto[] = [];
    for (const capability of CAPABILITY_IDS) {
      const requirements: CapabilityRequirements =
        capability === 'image.understand' ? { media: 'image' } : capability === 'video.understand' ? { media: 'video' } : {};
      const resolution = this.#resolveWith(config, policy, capability, requirements);
      const dto = this.#toDto(resolution);
      const provider = config.providers.find((entry) => entry.id === resolution.providerId);
      if (provider?.credentialRef) dto.credentialRef = provider.credentialRef;
      capabilities.push(dto);
    }
    const availableTools = this.availableTools(accountId, conversation);
    const skills = this.#skills.resolve(
      policy,
      (capability) => this.#resolveWith(config, policy, capability, {}).enabled,
      new Set(availableTools.map((tool) => tool.id))
    );
    return {
      accountId,
      conversation,
      agentEnabled: policy.agentEnabled,
      agentSource: policy.agentSource,
      visionMode: policy.visionMode,
      visionSource: policy.visionSource,
      replyMode: policy.replyMode,
      allowCloudUpload: policy.allowCloudUpload,
      capabilities,
      skills
    };
  }

  availableTools(accountId: string, conversation: ConversationRef): ToolDefinition[] {
    const config = this.#config.snapshot();
    const policy = this.#policy.resolveWithConfig(config, accountId, conversation);
    return this.#extensions.listTools().filter((tool) => {
      if ((tool.id === 'builtin.image.generate' || tool.id === 'builtin.audio.generate') && !policy.accountPolicy.enabledTools?.includes(tool.id)) {
        return false;
      }
      if (!tool.capability) return true;
      return this.#resolveWith(config, policy, tool.capability, {}).enabled;
    });
  }

  async audioGenerate(
    accountId: string,
    conversation: ConversationRef,
    request: AudioGenerationRequest,
    signal: AbortSignal,
    parameters?: Record<string, unknown>,
    resolution?: CapabilityResolution,
    requiredToolId?: string,
    executionGuard?: () => boolean | Promise<boolean>
  ): Promise<ExecutedResult<AudioGenerationResult>> {
    throwIfAborted(signal);
    const resolved = resolution ?? this.resolve(accountId, conversation, 'audio.generate');
    return this.#executeWithFallback(
      accountId,
      conversation,
      'audio.generate',
      resolved,
      signal,
      {},
      async (target, context) => {
        if (!target.adapter.audioGenerate) {
          throw new ProviderError('adapter_unsupported', 'adapter does not implement audio generation', {
            providerId: target.provider.id,
            capability: 'audio.generate',
            retryable: false
          });
        }
        return target.adapter.audioGenerate(context, {
          ...request,
          parameters: mergeParameters(target.parameters, request.parameters, parameters)
        });
      },
      'request',
      requiredToolId,
      executionGuard
    );
  }

  async chat(
    accountId: string,
    conversation: ConversationRef,
    request: ChatRequest,
    signal: AbortSignal,
    resolution?: CapabilityResolution,
    requirements: CapabilityRequirements = {},
    executionGuard?: () => boolean | Promise<boolean>
  ): Promise<ExecutedResult<ChatResponse>> {
    throwIfAborted(signal);
    const resolved = resolution ?? this.resolve(accountId, conversation, 'chat', requirements);
    return this.#executeWithFallback(accountId, conversation, 'chat', resolved, signal, requirements, async (target, context) => {
      if (!target.adapter.chat) {
        throw new ProviderError('adapter_unsupported', 'adapter does not implement chat', {
          providerId: target.provider.id,
          capability: 'chat',
          retryable: false
        });
      }
      return target.adapter.chat(context, {
        ...request,
        parameters: mergeParameters(target.parameters, request.parameters)
      });
    }, 'request', undefined, executionGuard);
  }

  async imageUnderstand(
    accountId: string,
    conversation: ConversationRef,
    media: ProviderMedia,
    prompt: string,
    signal: AbortSignal,
    parameters?: Record<string, unknown>,
    resolution?: CapabilityResolution,
    executionGuard?: () => boolean | Promise<boolean>
  ): Promise<ExecutedResult<ImageObservation>> {
    this.#assertMediaAccount(accountId, media);
    throwIfAborted(signal);
    const resolved =
      resolution ?? this.resolve(accountId, conversation, 'image.understand', { media: 'image' });
    return this.#executeWithFallback(
      accountId,
      conversation,
      'image.understand',
      resolved,
      signal,
      { media: 'image' },
      async (target, context) => {
        if (!target.adapter.imageUnderstand) {
          throw new ProviderError('adapter_unsupported', 'adapter does not implement image understanding', {
            providerId: target.provider.id,
            capability: 'image.understand',
            retryable: false
          });
        }
        return target.adapter.imageUnderstand(context, media, prompt, mergeParameters(target.parameters, parameters));
      },
      'request',
      undefined,
      executionGuard
    );
  }

  async videoUnderstand(
    accountId: string,
    conversation: ConversationRef,
    media: ProviderMedia,
    prompt: string,
    signal: AbortSignal,
    onProgress: (state: 'submitted' | 'waiting_remote') => void,
    parameters?: Record<string, unknown>,
    resolution?: CapabilityResolution,
    executionGuard?: () => boolean | Promise<boolean>
  ): Promise<ExecutedResult<VideoObservation>> {
    this.#assertMediaAccount(accountId, media);
    throwIfAborted(signal);
    const resolved =
      resolution ?? this.resolve(accountId, conversation, 'video.understand', { media: 'video' });
    return this.#executeWithFallback(
      accountId,
      conversation,
      'video.understand',
      resolved,
      signal,
      { media: 'video' },
      async (target, context) => {
        if (!target.adapter.videoUnderstand) {
          throw new ProviderError('adapter_unsupported', 'adapter does not implement video understanding', {
            providerId: target.provider.id,
            capability: 'video.understand',
            retryable: false
          });
        }
        return target.adapter.videoUnderstand(
          context,
          media,
          prompt,
          mergeParameters(target.parameters, parameters),
          onProgress
        );
      },
      'video',
      undefined,
      executionGuard
    );
  }

  async imageGenerate(
    accountId: string,
    conversation: ConversationRef,
    request: ImageGenerationRequest,
    signal: AbortSignal,
    parameters?: Record<string, unknown>,
    resolution?: CapabilityResolution,
    requiredToolId?: string,
    executionGuard?: () => boolean | Promise<boolean>
  ): Promise<ExecutedResult<ImageGenerationResult>> {
    throwIfAborted(signal);
    const resolved = resolution ?? this.resolve(accountId, conversation, 'image.generate');
    return this.#executeWithFallback(
      accountId,
      conversation,
      'image.generate',
      resolved,
      signal,
      {},
      async (target, context) => {
        if (!target.adapter.imageGenerate) {
          throw new ProviderError('adapter_unsupported', 'adapter does not implement image generation', {
            providerId: target.provider.id,
            capability: 'image.generate',
            retryable: false
          });
        }
        return target.adapter.imageGenerate(context, {
          ...request,
          parameters: mergeParameters(target.parameters, request.parameters, parameters)
        });
      },
      'request',
      requiredToolId,
      executionGuard
    );
  }

  async credentialConfigured(providerId: string): Promise<boolean> {
    const provider = this.#config.provider(providerId);
    if (!provider?.credentialRef) return false;
    return this.#vault.has(provider.credentialRef);
  }

  adapterSupports(adapterId: string, capability: CapabilityId): boolean {
    return this.#adapters.get(adapterId)?.supports(capability) ?? false;
  }

  async testProvider(
    providerId: string,
    capability: CapabilityId,
    modelId?: string,
    confirmCost = false,
    executionGuard?: () => void | Promise<void>,
    draft?: { provider: ProviderConfig; credential?: string }
  ): Promise<ProviderTestResult> {
    const config = this.#config.snapshot();
    const provider = draft?.provider ?? config.providers.find((entry) => entry.id === providerId);
    if (!provider) throw new CapabilityUnavailableError(capability, 'provider_not_found', `provider ${providerId} not found`);
    const model = modelId
      ? provider.models.find((entry) => entry.id === modelId)
      : provider.models.find((entry) => entry.capabilities.includes(capability));
    if (!model) throw new CapabilityUnavailableError(capability, 'model_not_found', `model not found for ${capability}`);
    if (!model.capabilities.includes(capability)) {
      throw new CapabilityUnavailableError(capability, 'capability_unsupported', `model ${model.id} does not support ${capability}`);
    }
    const adapter = this.#adapters.get(provider.adapterId);
    if (!adapter) throw new CapabilityUnavailableError(capability, 'adapter_not_found', `adapter ${provider.adapterId} not registered`);
    if (!adapter.supports(capability)) {
      throw new CapabilityUnavailableError(capability, 'adapter_unsupported', `adapter ${provider.adapterId} does not support ${capability}`);
    }
    if ((provider.location === 'cloud' || capability === 'image.generate' || capability === 'audio.generate') && !confirmCost) {
      throw new JobError('cost_confirmation_required', `${CAPABILITY_LABELS[capability]} probes can incur cost; explicit confirmation is required`);
    }
    const credential = draft ? draft.credential : await this.#credentialFor(provider, capability);
    const limiter = this.#limiterFor(provider);
    const release = await limiter.acquire();
    const timeoutMs = capability === 'video.understand'
      ? Math.max(provider.timeouts.requestMs, provider.timeouts.pollTimeoutMs + 5_000)
      : provider.timeouts.requestMs;
    const context: ProviderCallContext = {
      provider,
      model,
      ...(credential ? { credential } : {}),
      signal: AbortSignal.timeout(Math.min(timeoutMs, 60_000)),
      logger: this.#logger,
      requestTimeoutMs: timeoutMs
    };
    try {
      await executionGuard?.();
      if (capability === 'chat') {
        if (!adapter.chat) throw new CapabilityUnavailableError(capability, 'adapter_unsupported', 'adapter does not implement chat');
        const result = await adapter.chat(context, {
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word: pong' }] }],
          parameters: { max_tokens: 16 }
        });
        return { ok: Boolean(result.text), ...(result.text ? { detail: `回复：${summarizeTestText(result.text)}` } : {}) };
      }
      if (capability === 'image.understand') {
        if (!adapter.imageUnderstand) {
          throw new CapabilityUnavailableError(capability, 'adapter_unsupported', 'adapter does not implement image understanding');
        }
        const result = await adapter.imageUnderstand(
          context,
          {
            mediaId: 'probe',
            accountId: 'probe',
            mimeType: 'image/png',
            bytes: TINY_PNG.length,
            kind: 'image',
            data: TINY_PNG
          },
          'Describe this image in one short sentence.',
          { max_tokens: 40 }
        );
        return { ok: Boolean(result.text), ...(result.text ? { detail: `识图结果：${summarizeTestText(result.text)}` } : {}) };
      }
      if (capability === 'image.generate') {
        if (!adapter.imageGenerate) {
          throw new CapabilityUnavailableError(capability, 'adapter_unsupported', 'adapter does not implement image generation');
        }
        const result = await adapter.imageGenerate(context, { prompt: 'a single small red dot', count: 1 });
        const image = result.images[0];
        const sample = image ? imageTestSample(image) : undefined;
        return {
          ok: result.images.length > 0,
          detail: `${result.images.length} 张图片已生成${image && !sample ? '；服务未返回可内嵌预览的图片字节' : ''}`,
          ...(sample ? { sample } : {})
        };
      }
      if (capability === 'audio.generate') {
        if (!adapter.audioGenerate) {
          throw new CapabilityUnavailableError(capability, 'adapter_unsupported', 'adapter does not implement audio generation');
        }
        const result = await adapter.audioGenerate(context, { text: '这是一条语音生成测试。', format: 'mp3', parameters: model.parameters });
        const sample = result.data.length <= 2 * 1024 * 1024 && isAudioTestMime(result.mimeType)
          ? { kind: 'audio' as const, mimeType: result.mimeType, base64: result.data.toString('base64') }
          : undefined;
        return {
          ok: result.data.length > 0,
          detail: `${result.data.length} 字节语音已生成${sample ? '' : '；当前结果超过预览限制或格式不支持预览'}`,
          ...(sample ? { sample } : {})
        };
      }
      if (capability === 'video.understand') {
        if (!adapter.videoUnderstand) {
          throw new CapabilityUnavailableError(capability, 'adapter_unsupported', 'adapter does not implement video understanding');
        }
        const result = await adapter.videoUnderstand(
          context,
          { mediaId: 'probe', accountId: 'probe', mimeType: 'video/mp4', bytes: TINY_MP4.length, kind: 'video', data: TINY_MP4 },
          'Summarize this short test clip in one sentence.',
          model.parameters
        );
        return { ok: Boolean(result.summary), ...(result.summary ? { detail: `视频结果：${summarizeTestText(result.summary)}` } : { detail: '视频服务已返回，但没有摘要文本' }) };
      }
      return adapter.test ? await adapter.test(context, capability, confirmCost) : { ok: false, detail: 'adapter does not provide a safe probe for this capability' };
    } finally {
      release();
    }
  }

  testDraft(provider: ProviderConfig, capability: CapabilityId, modelId: string, credential?: string, confirmCost = false): Promise<ProviderTestResult> {
    return this.testProvider(provider.id, capability, modelId, confirmCost, undefined, { provider, ...(credential ? { credential } : {}) });
  }

  async testAccountCapability(
    accountId: string,
    capability: CapabilityId,
    confirmCost = false
  ): Promise<ProviderTestResult> {
    const conversation: ConversationRef = { accountId, kind: 'private', peerId: '0' };
    const requirements: CapabilityRequirements = capability === 'image.understand'
      ? { media: 'image' }
      : capability === 'video.understand'
        ? { media: 'video' }
        : {};
    const selected = this.resolve(accountId, conversation, capability, requirements);
    if (!selected.enabled || !selected.primary) {
      throw new CapabilityUnavailableError(
        capability,
        selected.reason ?? 'not_configured',
        selected.detail ?? `${CAPABILITY_LABELS[capability]}不可用`
      );
    }
    const providerId = selected.primary.provider.id;
    const modelId = selected.primary.model.id;
    const requiresConfirmation = selected.primary.provider.location === 'cloud'
      || capability === 'image.generate'
      || capability === 'audio.generate';
    if (requiresConfirmation && !confirmCost) {
      throw new JobError('cost_confirmation_required', `${CAPABILITY_LABELS[capability]}探测可能产生费用，需要明确确认`);
    }
    const guard = (): void => {
      const current = this.resolve(accountId, conversation, capability, requirements);
      if (!current.enabled || current.primary?.provider.id !== providerId || current.primary.model.id !== modelId) {
        throw new CapabilityUnavailableError(capability, 'execution_plan_stale', '账号服务授权或绑定已变化，请重新读取后再测试');
      }
    };
    const startedAt = this.#now();
    const result = await this.testProvider(providerId, capability, modelId, confirmCost, guard);
    return {
      ...result,
      capability,
      providerId,
      modelId,
      durationMs: this.#now() - startedAt
    };
  }

  endpoints(): Array<ReturnType<EndpointLimiter['snapshot']>> {
    return [...this.#limiters.values()].map((limiter) => limiter.snapshot());
  }

  async #executeWithFallback<T>(
    accountId: string,
    conversation: ConversationRef,
    capability: CapabilityId,
    resolution: CapabilityResolution,
    signal: AbortSignal,
    requirements: CapabilityRequirements,
    operation: (target: ResolvedTarget, context: ProviderCallContext) => Promise<T>,
    timeoutKind: 'request' | 'video' = 'request',
    requiredToolId?: string,
    executionGuard?: () => boolean | Promise<boolean>
  ): Promise<ExecutedResult<T>> {
    if (!resolution.enabled || !resolution.primary) {
      throw new CapabilityUnavailableError(
        capability,
        resolution.reason ?? 'not_configured',
        `${CAPABILITY_LABELS[capability]}不可用: ${resolution.detail ?? resolution.reason ?? 'not_configured'}`
      );
    }
    const targets = [resolution.primary, ...resolution.fallbackTargets];
    let lastError: unknown;
    for (const [index, target] of targets.entries()) {
      try {
        const result = await this.#invoke(
          accountId,
          conversation,
          capability,
          target,
          signal,
          requirements,
          index > 0,
          operation,
          timeoutKind,
          requiredToolId,
          executionGuard
        );
        return { result, resolution, used: { providerId: target.provider.id, modelId: target.model.id } };
      } catch (error) {
        lastError = error;
        if (signal.aborted) throw abortReason(signal);
        if (error instanceof CapabilityUnavailableError) throw error;
        const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'provider_error';
        this.#logger.warn('provider call failed', {
          accountId,
          capability,
          providerId: target.provider.id,
          modelId: target.model.id,
          code,
          message: sanitizeErrorText(error instanceof Error ? error.message : String(error))
        });
        if (isUnknownOutcome(error)) {
          // 远端可能已经接单，自动切换目标会造成重复提交/计费。
          throw error;
        }
        if (!(error instanceof ProviderError) || !error.retryable) {
          // 认证、协议等非瞬态错误仍允许尝试显式 fallback；是否跨服务由解析阶段决定。
          continue;
        }
      }
    }
    throw lastError ?? new CapabilityUnavailableError(capability, 'not_configured', `${CAPABILITY_LABELS[capability]}不可用`);
  }

  async #invoke<T>(
    accountId: string,
    conversation: ConversationRef,
    capability: CapabilityId,
    planned: ResolvedTarget,
    signal: AbortSignal,
    requirements: CapabilityRequirements,
    isFallback: boolean,
    operation: (target: ResolvedTarget, context: ProviderCallContext) => Promise<T>,
    timeoutKind: 'request' | 'video',
    requiredToolId?: string,
    executionGuard?: () => boolean | Promise<boolean>
  ): Promise<T> {
    throwIfAborted(signal);
    let current = this.#currentTarget(accountId, conversation, capability, planned, requirements, isFallback);
    await this.#extensions.dispatch(
      'capability:before',
      {
        capability,
        accountId,
        kind: conversation.kind,
        peerId: conversation.peerId,
        providerId: current.provider.id,
        modelId: current.model.id
      },
      this.#now
    );
    const limiter = this.#limiterFor(current.provider);
    const release = await limiter.acquire(signal);
    const startedAt = this.#now();
    let lastUsed = current;
    try {
      throwIfAborted(signal);
      this.#assertToolAuthorized(accountId, conversation, capability, requiredToolId);
      await this.#assertExecutionGuard(capability, executionGuard);
      let attempt = 0;
      let lastError: unknown;
      while (attempt < current.provider.retry.maxAttempts) {
        attempt += 1;
        current = this.#currentTarget(accountId, conversation, capability, planned, requirements, isFallback);
        const credential = await this.#credentialFor(current.provider, capability);
        // 凭据读取是异步的；读取后再次确认计划没有被替换。
        current = this.#currentTarget(accountId, conversation, capability, planned, requirements, isFallback);
        lastUsed = current;
        // Credential lookup can yield while an administrator revokes tool access.
        this.#assertToolAuthorized(accountId, conversation, capability, requiredToolId);
        await this.#assertExecutionGuard(capability, executionGuard);
        const timeoutMs =
          timeoutKind === 'video'
            ? Math.max(current.provider.timeouts.requestMs, current.provider.timeouts.pollTimeoutMs + 10_000)
            : current.provider.timeouts.requestMs;
        const context: ProviderCallContext = {
          provider: current.provider,
          model: current.model,
          ...(credential ? { credential } : {}),
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
          logger: this.#logger,
          requestTimeoutMs: timeoutMs
        };
        try {
          const result = await operation(current, context);
          const durationMs = this.#now() - startedAt;
          this.#metrics?.inc('provider.calls', 1, {
            provider: current.provider.id,
            capability,
            ok: true
          });
          this.#onUsage?.({
            accountId,
            capability,
            providerId: current.provider.id,
            modelId: current.model.id,
            ok: true,
            durationMs
          });
          await this.#extensions.dispatch(
            'capability:after',
            {
              capability,
              accountId,
              kind: conversation.kind,
              peerId: conversation.peerId,
              providerId: current.provider.id,
              modelId: current.model.id
            },
            this.#now
          );
          return result;
        } catch (error) {
          lastError = this.#normalizeProviderError(error, current.provider.id, capability, signal, context.signal);
          if (signal.aborted) throw abortReason(signal);
          if (isUnknownOutcome(lastError)) throw lastError;
          if (!(lastError instanceof ProviderError) || !lastError.retryable || attempt >= current.provider.retry.maxAttempts) {
            throw lastError;
          }
          const backoff = Math.min(
            current.provider.retry.maxDelayMs,
            current.provider.retry.baseDelayMs * 2 ** (attempt - 1)
          );
          const delay = Math.max(backoff, lastError.retryAfterMs ?? 0);
          this.#metrics?.inc('provider.retries', 1, { provider: current.provider.id, capability });
          await sleep(delay, signal);
        }
      }
      throw lastError ?? new ProviderError('provider_error', 'provider call failed', {
        providerId: current.provider.id,
        capability,
        retryable: false
      });
    } catch (error) {
      this.#metrics?.inc('provider.calls', 1, {
        provider: lastUsed.provider.id,
        capability,
        ok: false,
        code: error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'unknown'
      });
      this.#onUsage?.({
        accountId,
        capability,
        providerId: lastUsed.provider.id,
        modelId: lastUsed.model.id,
        ok: false,
        durationMs: this.#now() - startedAt,
        code: error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'provider_error'
      });
      throw error;
    } finally {
      release();
    }
  }

  #assertToolAuthorized(
    accountId: string,
    conversation: ConversationRef,
    capability: CapabilityId,
    requiredToolId?: string
  ): void {
    if (!requiredToolId) return;
    const config = this.#config.snapshot();
    const policy = this.#policy.resolveWithConfig(config, accountId, conversation);
    if (!policy.accountPolicy.enabledTools?.includes(requiredToolId)) {
      throw new CapabilityUnavailableError(capability, 'tool_not_authorized', `tool ${requiredToolId} is not authorized for this account`);
    }
  }

  async #assertExecutionGuard(
    capability: CapabilityId,
    executionGuard?: () => boolean | Promise<boolean>
  ): Promise<void> {
    if (executionGuard && !(await executionGuard())) {
      throw new CapabilityUnavailableError(capability, 'role_binding_changed', 'conversation role binding changed before provider execution');
    }
  }

  #normalizeProviderError(
    error: unknown,
    providerId: string,
    capability: CapabilityId,
    outerSignal: AbortSignal,
    callSignal: AbortSignal
  ): unknown {
    if (outerSignal.aborted) return abortReason(outerSignal);
    if (error instanceof ProviderError) return error;
    if (error instanceof CapabilityUnavailableError) return error;
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      return new ProviderError('provider_timeout', `provider ${providerId} timed out`, {
        providerId,
        capability,
        retryable: true,
        cause: error
      });
    }
    if (callSignal.aborted) {
      return new ProviderError('provider_timeout', `provider ${providerId} timed out`, {
        providerId,
        capability,
        retryable: true,
        cause: error
      });
    }
    return new ProviderError('provider_error', sanitizeErrorText(error instanceof Error ? error.message : String(error)), {
      providerId,
      capability,
      retryable: false,
      cause: error
    });
  }

  async #credentialFor(provider: ProviderConfig, capability: CapabilityId): Promise<string | undefined> {
    if (!provider.credentialRef) return undefined;
    if (!this.#vault.available) {
      throw new ProviderError(
        'credential_store_unavailable',
        `credentialRef is configured for ${provider.id} but system credential protection is unavailable`,
        { providerId: provider.id, capability, retryable: false }
      );
    }
    const secret = await this.#vault.get(provider.credentialRef);
    if (!secret) {
      throw new ProviderError('credential_missing', `credential for ${provider.id} is not configured`, {
        providerId: provider.id,
        capability,
        retryable: false
      });
    }
    return secret;
  }

  /**
   * 旧 resolution 可能来自排队任务或模型调用前。这里返回的目标、凭据、限流与适配器全部来自
   * 当前配置，并且只在计划版本仍一致时放行；绝不能用当前配置校验、却拿旧快照执行。
   */
  #currentTarget(
    accountId: string,
    conversation: ConversationRef,
    capability: CapabilityId,
    planned: ResolvedTarget,
    requirements: CapabilityRequirements,
    isFallback: boolean
  ): ResolvedTarget {
    const config = this.#config.snapshot();
    const policy = this.#policy.resolveWithConfig(config, accountId, conversation);
    const state = policy.capabilities[capability];
    if (!state.enabled) {
      throw new CapabilityUnavailableError(
        capability,
        'scope_disabled',
        `${CAPABILITY_LABELS[capability]}已按当前策略关闭`
      );
    }
    if (!state.binding) {
      throw new CapabilityUnavailableError(
        capability,
        'not_configured',
        `${CAPABILITY_LABELS[capability]}当前没有绑定服务`
      );
    }
    const provider = config.providers.find((entry) => entry.id === planned.provider.id);
    if (!provider) {
      throw new CapabilityUnavailableError(capability, 'provider_not_found', `provider ${planned.provider.id} has been removed`);
    }
    if (!policy.accountPolicy.allowedProviders.includes(provider.id)) {
      throw new CapabilityUnavailableError(
        capability,
        'provider_not_authorized',
        `account ${accountId} is no longer authorized to use provider ${provider.id}`
      );
    }
    const model = provider.models.find((entry) => entry.id === planned.model.id);
    if (!model) {
      throw new CapabilityUnavailableError(capability, 'model_not_found', `model ${planned.model.id} has been removed`);
    }
    if (!model.capabilities.includes(capability)) {
      throw new CapabilityUnavailableError(
        capability,
        'capability_unsupported',
        `model ${model.id} no longer supports ${capability}`
      );
    }
    const adapter = this.#adapters.get(provider.adapterId);
    if (!adapter) {
      throw new CapabilityUnavailableError(capability, 'adapter_not_found', `adapter ${provider.adapterId} is not registered`);
    }
    if (!adapter.supports(capability)) {
      throw new CapabilityUnavailableError(
        capability,
        'adapter_unsupported',
        `adapter ${provider.adapterId} does not support ${capability}`
      );
    }
    const revision = providerRevision(provider);
    if (revision !== planned.providerRevision) {
      throw new CapabilityUnavailableError(
        capability,
        'execution_plan_stale',
        `provider ${provider.id} changed after this execution plan was created; resubmit the request`
      );
    }
    const credentialRevision = provider.credentialRef
      ? this.#vault.revision?.(provider.credentialRef)
      : undefined;
    if (
      planned.credentialRevision !== undefined &&
      credentialRevision !== undefined &&
      credentialRevision !== planned.credentialRevision
    ) {
      throw new CapabilityUnavailableError(
        capability,
        'credential_stale',
        `credential ${provider.credentialRef} changed after this execution plan was created; resubmit the request`
      );
    }
    const candidates = isFallback ? state.binding.fallback ?? [] : [state.binding];
    const match = candidates.find(
      (candidate) =>
        candidate.providerId === planned.target.providerId &&
        candidate.modelId === planned.target.modelId &&
        stableJson(candidate.parameters) === stableJson(planned.target.parameters)
    );
    if (!match) {
      throw new CapabilityUnavailableError(
        capability,
        'execution_plan_stale',
        `${CAPABILITY_LABELS[capability]}绑定已变化; resubmit the request`
      );
    }
    if (requirements.media) {
      if (!provider.mediaTransports.includes('inline')) {
        throw new CapabilityUnavailableError(
          capability,
          'media_transport_unavailable',
          `provider ${provider.id} no longer allows inline media`
        );
      }
      if (provider.location === 'cloud' && !policy.allowCloudUpload) {
        throw new CapabilityUnavailableError(
          capability,
          'cloud_media_blocked',
          `account ${accountId} has revoked media upload to cloud provider ${provider.id}`
        );
      }
    }
    if (requirements.directVision && !model.input.includes('image')) {
      throw new CapabilityUnavailableError(
        capability,
        'model_no_image_input',
        `model ${model.id} does not accept direct image input`
      );
    }
    if (isFallback && provider.id !== state.binding.providerId && !policy.crossProviderFallback) {
      throw new CapabilityUnavailableError(
        capability,
        'cross_provider_fallback_disabled',
        'cross-provider fallback has been disabled for this account'
      );
    }
    return {
      provider,
      model,
      adapter,
      target: match,
      cancelMode: adapter.cancelMode(capability),
      parameters: {
        ...model.parameters,
        ...(match.parameters ?? {})
      },
      providerRevision: revision,
      ...(credentialRevision !== undefined ? { credentialRevision } : {})
    };
  }

  #limiterFor(provider: ProviderConfig): EndpointLimiter {
    const key = endpointKeyFor(provider.baseUrl);
    let limiter = this.#limiters.get(key);
    if (!limiter) {
      limiter = new EndpointLimiter(key);
      this.#limiters.set(key, limiter);
    }
    const config = this.#config.snapshot();
    const sharing = config.providers.filter((entry) => endpointKeyFor(entry.baseUrl) === key);
    const maxConcurrent = Math.min(...sharing.map((entry) => entry.limits.maxConcurrent));
    const maxQueue = Math.min(...sharing.map((entry) => entry.limits.maxQueue));
    limiter.updateLimits(maxConcurrent, maxQueue);
    return limiter;
  }

  #resolveWith(
    config: RuntimeConfigV2,
    policy: EffectivePolicy,
    capability: CapabilityId,
    requirements: CapabilityRequirements
  ): CapabilityResolution {
    const state = policy.capabilities[capability];
    const base = {
      capability,
      agentEnabled: policy.agentEnabled,
      agentSource: policy.agentSource,
      visionMode: policy.visionMode,
      visionSource: policy.visionSource,
      supportsTools: false,
      supportsImageInput: false,
      fallback: [] as FallbackStatus[],
      fallbackTargets: [] as ResolvedTarget[]
    };
    if (!state.enabled) {
      return {
        ...base,
        enabled: false,
        reason: 'scope_disabled',
        detail: `${CAPABILITY_LABELS[capability]}已在${sourceLabel(state.source)}关闭`,
        source: state.source,
        ...(state.bindingSource ? { bindingSource: state.bindingSource } : {})
      };
    }
    const binding = state.binding;
    if (!binding) {
      return {
        ...base,
        enabled: false,
        reason: 'not_configured',
        detail: `${CAPABILITY_LABELS[capability]}未绑定服务`,
        source: state.source
      };
    }
    const primary = this.#validateTarget(config, policy, capability, binding, requirements, binding.providerId);
    const fallbackStatus: FallbackStatus[] = [];
    const fallbackTargets: ResolvedTarget[] = [];
    for (const target of binding.fallback ?? []) {
      const crossProvider = target.providerId !== binding.providerId;
      if (crossProvider && !policy.crossProviderFallback) {
        fallbackStatus.push({
          providerId: target.providerId,
          modelId: target.modelId,
          valid: false,
          reason: 'cross_provider_fallback_disabled'
        });
        continue;
      }
      const result = this.#validateTarget(config, policy, capability, target, requirements, binding.providerId);
      if (result.error) {
        fallbackStatus.push({
          providerId: target.providerId,
          modelId: target.modelId,
          valid: false,
          ...(result.reason ? { reason: result.reason } : {})
        });
      } else if (result.target) {
        fallbackStatus.push({ providerId: target.providerId, modelId: target.modelId, valid: true });
        fallbackTargets.push(result.target);
      }
    }
    const target = primary.target;
    if (!target) {
      return {
        ...base,
        enabled: false,
        reason: primary.reason ?? 'not_configured',
        detail: primary.error,
        source: state.source,
        bindingSource: state.bindingSource,
        fallback: fallbackStatus
      };
    }
    return {
      ...base,
      enabled: true,
      ...(state.source ? { source: state.source } : {}),
      ...(state.bindingSource ? { bindingSource: state.bindingSource } : {}),
      providerId: target.provider.id,
      modelId: target.model.id,
      location: target.provider.location,
      ...(target.provider.credentialRef ? { credentialRef: target.provider.credentialRef } : {}),
      supportsTools: target.model.supportsTools,
      supportsImageInput: target.model.input.includes('image'),
      cancelMode: target.cancelMode,
      fallback: fallbackStatus,
      primary: target,
      fallbackTargets
    };
  }

  #validateTarget(
    config: RuntimeConfigV2,
    policy: EffectivePolicy,
    capability: CapabilityId,
    target: CapabilityTarget,
    requirements: CapabilityRequirements,
    primaryProviderId: string
  ): { target?: ResolvedTarget; error?: string; reason?: CapabilityUnavailableReason } {
    const provider = config.providers.find((entry) => entry.id === target.providerId);
    if (!provider) {
      return { error: `provider ${target.providerId} is not configured`, reason: 'provider_not_found' };
    }
    if (!policy.accountPolicy.allowedProviders.includes(provider.id)) {
      return {
        error: `account ${policy.accountId} is not authorized to use provider ${provider.id}`,
        reason: 'provider_not_authorized'
      };
    }
    const model = provider.models.find((entry) => entry.id === target.modelId);
    if (!model) return { error: `model ${target.modelId} is not configured`, reason: 'model_not_found' };
    if (!model.capabilities.includes(capability)) {
      return { error: `model ${model.id} does not support ${capability}`, reason: 'capability_unsupported' };
    }
    const adapter = this.#adapters.get(provider.adapterId);
    if (!adapter) return { error: `adapter ${provider.adapterId} is not registered`, reason: 'adapter_not_found' };
    if (!adapter.supports(capability)) {
      return { error: `adapter ${provider.adapterId} does not support ${capability}`, reason: 'adapter_unsupported' };
    }
    if (requirements.media) {
      if (!provider.mediaTransports.includes('inline')) {
        return { error: `provider ${provider.id} does not allow inline media`, reason: 'media_transport_unavailable' };
      }
      if (provider.location === 'cloud' && !policy.allowCloudUpload) {
        return {
          error: `account ${policy.accountId} has not allowed media upload to cloud provider ${provider.id}`,
          reason: 'cloud_media_blocked'
        };
      }
    }
    if (requirements.directVision && !model.input.includes('image')) {
      return { error: `model ${model.id} does not accept direct image input`, reason: 'model_no_image_input' };
    }
    if (target.providerId !== primaryProviderId && provider.id !== primaryProviderId && !policy.crossProviderFallback) {
      return { error: 'cross-provider fallback is disabled', reason: 'cross_provider_fallback_disabled' };
    }
    const credentialRevision = provider.credentialRef
      ? this.#vault.revision?.(provider.credentialRef)
      : undefined;
    return {
      target: {
        provider,
        model,
        adapter,
        target,
        cancelMode: adapter.cancelMode(capability),
        parameters: {
          ...model.parameters,
          ...(target.parameters ?? {})
        },
        providerRevision: providerRevision(provider),
        ...(credentialRevision !== undefined ? { credentialRevision } : {})
      }
    };
  }

  #toDto(resolution: CapabilityResolution): CapabilityDto {
    return {
      capability: resolution.capability,
      label: CAPABILITY_LABELS[resolution.capability],
      enabled: resolution.enabled,
      ...(resolution.reason ? { reason: resolution.reason } : {}),
      ...(resolution.detail ? { detail: resolution.detail } : {}),
      ...(resolution.source ? { source: resolution.source } : {}),
      ...(resolution.bindingSource ? { bindingSource: resolution.bindingSource } : {}),
      ...(resolution.providerId ? { providerId: resolution.providerId } : {}),
      ...(resolution.modelId ? { modelId: resolution.modelId } : {}),
      ...(resolution.location ? { location: resolution.location } : {}),
      supportsTools: resolution.supportsTools,
      supportsImageInput: resolution.supportsImageInput,
      ...(resolution.cancelMode ? { cancelMode: resolution.cancelMode } : {}),
      ...(resolution.credentialRef ? { credentialRef: resolution.credentialRef } : {}),
      fallback: resolution.fallback
    };
  }

  #assertMediaAccount(accountId: string, media: ProviderMedia): void {
    if (media.accountId !== accountId) {
      throw new ProviderError('media_account_mismatch', 'media does not belong to this account', {
        providerId: 'media',
        retryable: false
      });
    }
  }
}

function providerRevision(provider: ProviderConfig): string {
  return crypto.createHash('sha256').update(JSON.stringify(provider)).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === undefined) return '';
  return JSON.stringify(value ?? {});
}

const UNKNOWN_OUTCOME_CODES = new Set([
  'provider_generate_unknown',
  'provider_submit_unknown',
  'provider_job_unknown'
]);

function isUnknownOutcome(error: unknown): boolean {
  return error instanceof ProviderError && UNKNOWN_OUTCOME_CODES.has(error.code);
}

function mergeParameters(...values: Array<Record<string, unknown> | undefined>): Record<string, unknown> {
  return Object.assign({}, ...values.filter((value): value is Record<string, unknown> => Boolean(value)));
}

function summarizeTestText(value: string): string {
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > 180 ? `${text.slice(0, 177)}…` : text;
}

function imageTestSample(image: ImageGenerationResult['images'][number]): ProviderTestResult['sample'] {
  const mimeType = image.mimeType ?? 'image/png';
  if (!/^image\/(?:png|jpeg|webp|gif)$/i.test(mimeType)) return undefined;
  const base64 = image.base64 ?? image.data?.toString('base64');
  if (!base64 || base64.length > 1_400_000) return undefined;
  const data = image.data ?? Buffer.from(base64, 'base64');
  if (data.length > 1_048_576) return undefined;
  return { kind: 'image', mimeType, base64: data.toString('base64') };
}

function isAudioTestMime(mimeType: string): boolean {
  return /^audio\/(?:mpeg|mp3|wav|x-wav|ogg|opus|aac|flac|mp4|webm)$/i.test(mimeType);
}

function sourceLabel(source: EffectivePolicy['capabilities'][CapabilityId]['source']): string {
  switch (source) {
    case 'account':
      return '账号配置';
    case 'kind':
      return '会话类型配置';
    case 'conversation':
      return '具体会话配置';
    default:
      return '默认配置';
  }
}

export { sanitizeUrl };
