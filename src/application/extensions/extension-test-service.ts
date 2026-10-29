import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  ExtensionSkillTestInput,
  ExtensionSkillTestPreview,
  ExtensionSkillTestToolView,
  ExtensionTestCall,
  ExtensionTestResult,
  ExtensionTestScope,
  ExtensionTestStage,
  ExtensionToolTestInput
} from '../../contracts/extension-access.js';
import type { ResolvedPlugin, ResolvedProfile, ResolvedRoleCard } from '../../artifacts/types.js';
import { AccompanyError, InvalidSpecError } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import type { AgentMessageContext, AgentRequestObservation } from '../../host/contract.js';
import { messageText } from '../../routing/message.js';
import type { ConversationRef } from '../../routing/identity.js';
import { assertIdentifier, assertKind } from '../../routing/identity.js';
import type { CapabilityId } from '../../policy/capabilities.js';
import type { ConfigStore } from '../../providers/config-store.js';
import type { ProviderRouter } from '../../providers/router.js';
import type { MediaService } from '../../media/service.js';
import type { MediaJobService } from '../../jobs/service.js';
import type { TurnScheduler } from '../../agent/scheduler.js';
import { createAgentEngine, type AgentToolRunner, type AgentTurnEvent } from '../../agent/engine.js';
import { MediaToolHost } from '../../agent/media-tool-host.js';
import type { ExtensionRegistry } from '../../extensions/registry.js';
import { AccountPluginRuntime, type PluginRuntimeStatus } from '../../extensions/runtime/account-runtime.js';
import type { ToolBatchContext } from '../../extensions/execution/executor.js';
import { TOOL_CONCURRENCY_LIMITS, ToolConcurrencyLimiter } from '../../extensions/execution/limiter.js';
import { parseToolIdentity, pluginKey as toPluginKey, pluginToolId } from '../../extensions/contracts.js';
import { skillInstructionsWithConfig } from '../../extensions/skill-render.js';
import { SKILL_PROMPT_LIMITS, selectSkillsForPrompt } from '../../extensions/skill-selection.js';
import type { EffectiveIssue } from '../../extensions/effective.js';
import type { ExtensionTurnSnapshot } from './extension-tool-service.js';
import { ExtensionPolicyService } from './extension-policy-service.js';
import { ExtensionToolService } from './extension-tool-service.js';
import { defaultAccountPolicy } from '../../providers/types.js';

export interface ExtensionTestServiceOptions {
  config: ConfigStore;
  registry: ExtensionRegistry;
  providers: ProviderRouter;
  media: MediaService;
  jobs: MediaJobService;
  scheduler: TurnScheduler;
  /** Shared production execution budget; manual tests must not create a separate unlimited pool. */
  toolLimiter: ToolConcurrencyLimiter;
  accountDir: (accountId: string) => string;
  profile: (accountId: string) => Promise<ResolvedProfile>;
  logger: Logger;
  /** Root for short-lived test state; each run gets an isolated child directory. */
  testRoot: string;
  maxHistoryMessages: number;
  maxHistoryChars: number;
  maxObservedMedia: number;
  now?: () => number;
}

const TEST_PEER_ID = 'extension-test';
const MAX_INPUT_CHARS = 16_000;
const MAX_ROLE_CHARS = 12_000;

interface TestEnvironment {
  profile: ResolvedProfile;
  stateDir: string;
  runtime: AccountPluginRuntime;
  statuses: PluginRuntimeStatus[];
  policy: ExtensionPolicyService;
  tools: ExtensionToolService;
}

class ExtensionTestFailure extends Error {
  readonly stage: ExtensionTestStage;
  readonly code: string;

  constructor(stage: ExtensionTestStage, code: string, message: string) {
    super(message);
    this.stage = stage;
    this.code = code;
  }
}

/**
 * Manual extension tests. They use the real plugin Worker protocol, unified ToolExecutor and the
 * production Agent turn loop, but never touch a QQ instance, real conversation history, worldbooks,
 * memories or the account's production plugin state.
 */
export class ExtensionTestService {
  readonly #options: ExtensionTestServiceOptions;
  readonly #now: () => number;
  readonly #session = new AbortController();
  readonly #runtimes = new Set<AccountPluginRuntime>();
  readonly #active = new Set<Promise<unknown>>();
  readonly #environmentLimiter = new ToolConcurrencyLimiter(TOOL_CONCURRENCY_LIMITS);
  #closed = false;

  constructor(options: ExtensionTestServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#session.abort(new AccompanyError('extension_test_closed', '扩展测试服务正在关闭。'));
    await Promise.allSettled([...this.#runtimes].map((runtime) => runtime.close()));
    await Promise.allSettled([...this.#active]);
    this.#environmentLimiter.close();
  }

  async previewSkill(accountId: string, input: ExtensionSkillTestInput): Promise<ExtensionSkillTestPreview> {
    validateAccount(accountId);
    const request = parseSkillInput(input);
    const profile = await this.#profile(accountId);
    const scope = request.scope;
    const conversation = conversationOf(accountId, scope);
    const policy = this.#policy(profile, declaredReadiness(profile));
    const effective = await policy.effective(accountId, conversation, this.#capabilityEnabled(accountId, conversation));
    const status = effective.skills.find((entry) => entry.skill.id === request.skillId);
    if (!status) throw new AccompanyError('skill_not_found', `Skill ${request.skillId} 不存在。`);
    const config = status.config ?? {};
    const renderedInstructions = skillInstructionsWithConfig(status.skill.instructions, config);
    const tools: ExtensionSkillTestToolView[] = effective.tools.map((entry) => ({
      id: entry.tool.id,
      name: entry.tool.name,
      description: entry.tool.description,
      owner: entry.tool.owner.kind,
      effect: entry.tool.effect,
      available: entry.enabled,
      issues: entry.issues.map((issue) => ({ ...issue })),
      handlerStatus: entry.tool.owner.kind === 'builtin' ? 'ready' : 'unverified'
    }));
    return {
      accountId,
      scope,
      input: request.input,
      skill: {
        id: status.skill.id,
        name: status.skill.name,
        source: status.skill.source,
        enabled: status.enabled,
        issues: status.issues.map((issue) => ({ ...issue })),
        unavailableTools: [...status.unavailableTools],
        instructions: status.skill.instructions,
        renderedInstructions,
        config: structuredClone(config)
      },
      tools
    };
  }

  async testTool(accountId: string, input: ExtensionToolTestInput): Promise<ExtensionTestResult> {
    validateAccount(accountId);
    const request = parseToolInput(input);
    const startedAt = this.#now();
    return this.#runActive(async () => {
      let scopedProfile: ResolvedProfile;
      try {
        const profile = await this.#profile(accountId);
        scopedProfile = await this.#scopedProfileForTool(profile, accountId, request.scope, request.toolId);
      } catch (error) {
        if (error instanceof AccompanyError && error.code === 'tool_not_found') throw error;
        return failure(startedAt, error);
      }
      let environment: TestEnvironment;
      try {
        environment = await this.#openScopedEnvironment(scopedProfile);
      } catch (error) {
        return failure(startedAt, error);
      }
      try {
        const status = await this.#toolStatus(environment, accountId, request.scope, request.toolId);
        const conversation = conversationOf(accountId, request.scope);
        const context = this.#context(
          environment.profile,
          conversation,
          request.scope,
          '你是一位扩展测试助手。',
          '',
          request.toolId
        );
        const mediaHost = this.#mediaHost(accountId);
        const batch = await environment.tools.executeBatch(
          [{ callId: `test-tool-${crypto.randomUUID()}`, name: request.toolId, arguments: request.arguments }],
          {
            accountId,
            conversation,
            messageId: `extension-test-${crypto.randomUUID()}`,
            turn: 0,
            toolIdsByModelName: new Map([[request.toolId, request.toolId]]),
            signal: this.#session.signal,
            guard: () => true,
            remainingCalls: 1,
            contextEpoch: `test:${crypto.randomUUID()}`,
            extraHandlers: mediaHost.handlers(context)
          }
        );
        const result = batch.results[0];
        const durationMs = Math.max(0, this.#now() - startedAt);
        if (!result) {
          return {
            status: 'error',
            durationMs,
            calls: [],
            tools: [request.toolId],
            stage: 'invoke',
            code: 'tool_no_result',
            message: '工具执行器没有返回结果。',
            delivery: 'skipped'
          };
        }
        const call: ExtensionTestCall = {
          toolId: request.toolId,
          arguments: request.arguments,
          result
        };
        const jobIds = result.jobId ? [result.jobId] : undefined;
        return {
          status: result.status,
          durationMs,
          calls: [call],
          tools: [request.toolId],
          ...(jobIds ? { jobIds } : {}),
          ...(result.status === 'error' || result.status === 'unknown'
            ? {
                stage: stageForToolResult(result.errorCode),
                ...(result.errorCode ? { code: result.errorCode } : {}),
                ...(result.text ? { message: result.text } : {})
              }
            : {}),
          delivery: 'skipped'
        };
      } catch (error) {
        if (error instanceof ExtensionTestFailure) {
          return {
            status: 'error',
            durationMs: Math.max(0, this.#now() - startedAt),
            calls: [],
            tools: [request.toolId],
            stage: error.stage,
            code: error.code,
            message: error.message,
            delivery: 'skipped'
          };
        }
        throw error;
      } finally {
        await this.#closeEnvironment(environment);
      }
    });
  }

  async testSkill(accountId: string, input: ExtensionSkillTestInput): Promise<ExtensionTestResult> {
    validateAccount(accountId);
    const request = parseSkillInput(input);
    const startedAt = this.#now();
    return this.#runActive(async () => {
      let scopedProfile: ResolvedProfile;
      try {
        const profile = await this.#profile(accountId);
        scopedProfile = await this.#scopedProfileForSkill(profile, accountId, request);
      } catch (error) {
        if (error instanceof AccompanyError && error.code === 'skill_not_found') throw error;
        return failure(startedAt, error);
      }
      let environment: TestEnvironment;
      try {
        environment = await this.#openScopedEnvironment(scopedProfile);
      } catch (error) {
        return failure(startedAt, error);
      }
      try {
        const conversation = conversationOf(accountId, request.scope);
        const effective = await environment.policy.effective(
          accountId,
          conversation,
          this.#capabilityEnabled(accountId, conversation)
        );
        const skill = effective.skills.find((entry) => entry.skill.id === request.skillId);
        if (!skill) throw new AccompanyError('skill_not_found', `Skill ${request.skillId} 在测试运行时就绪后不再可用。`);
        if (!skill.enabled) {
          const issue = skill.issues[0];
          return {
            status: 'error',
            durationMs: Math.max(0, this.#now() - startedAt),
            calls: [],
            stage: 'load',
            ...(issue?.code ? { code: issue.code } : { code: 'skill_unavailable' }),
            message: issueMessage(skill.issues),
            delivery: 'skipped'
          };
        }
        return await this.#runSkillTurn(accountId, scopedProfile, environment, request, startedAt);
      } catch (error) {
        if (error instanceof ExtensionTestFailure) {
          return {
            status: 'error',
            durationMs: Math.max(0, this.#now() - startedAt),
            calls: [],
            stage: error.stage,
            code: error.code,
            message: error.message,
            delivery: 'skipped'
          };
        }
        throw error;
      } finally {
        await this.#closeEnvironment(environment);
      }
    });
  }

  async #runSkillTurn(
    accountId: string,
    profile: ResolvedProfile,
    environment: TestEnvironment,
    request: ParsedSkillInput,
    startedAt: number
  ): Promise<ExtensionTestResult> {
    const conversation = conversationOf(accountId, request.scope);
    const calls: ExtensionTestCall[] = [];
    let actualRequest: AgentRequestObservation | undefined;
    const skillId = request.skillId;
    const runner: AgentToolRunner = {
      executeBatch: async (requests: Array<{ callId?: string; name: string; arguments: unknown }>, context: ToolBatchContext) => {
        const batch = await environment.tools.executeBatch(requests, context);
        for (const [index, call] of requests.entries()) {
          const result = batch.results[index];
          if (!result) continue;
          calls.push({
            toolId: context.toolIdsByModelName.get(call.name) ?? call.name,
            arguments: isRecord(call.arguments) ? call.arguments : {},
            result
          });
        }
        return batch;
      },
      captureTurn: async (targetAccountId, targetConversation) => {
        const snapshot = await environment.tools.captureTurn(targetAccountId, targetConversation);
        return filterSnapshot(snapshot, skillId);
      },
      isTurnSnapshotCurrent: (snapshot) => environment.tools.isTurnSnapshotCurrent(snapshot),
      isTurnPolicyCurrent: (snapshot) => environment.tools.isTurnPolicyCurrent(snapshot),
      excludeFailedPlugins: (snapshot, keys) => filterSnapshot(
        environment.tools.excludeFailedPlugins(snapshot, keys),
        skillId
      ),
      newHookBudget: () => environment.tools.newHookBudget(),
      beforeContext: (snapshot, input, budget) => environment.tools.beforeContext(snapshot, input, budget),
      afterTurn: (snapshot, input, budget) => environment.tools.afterTurn(snapshot, input, budget)
    };
    const events: AgentTurnEvent[] = [];
    const engine = createAgentEngine({
      instanceId: 'extension-test',
      accountId,
      profile,
      logger: this.#options.logger,
      sessionSignal: this.#session.signal,
      sessionEpoch: 1,
      hostEpoch: 1,
      profileFingerprint: profile.revision,
      providers: this.#options.providers,
      media: this.#options.media,
      jobs: this.#options.jobs,
      scheduler: this.#options.scheduler,
      extensions: this.#options.registry,
      tools: runner,
      maxHistoryMessages: this.#options.maxHistoryMessages,
      maxHistoryChars: this.#options.maxHistoryChars,
      maxObservedMedia: this.#options.maxObservedMedia,
      testMode: true,
      onTurn: (event) => { events.push(event); },
      ...(this.#options.now ? { now: this.#options.now } : {})
    });
    const context = this.#context(
      profile,
      conversation,
      request.scope,
      request.roleText ?? '你是一位扩展测试助手。请根据可用的 Skill 和工具完成用户请求。',
      request.input,
      request.skillId,
      (observation) => { actualRequest = observation; }
    );
    const reply = await engine.onMessage(context, context.message);
    const replyText = reply ? messageText(reply.segments).trim() : '';
    const durationMs = Math.max(0, this.#now() - startedAt);
    const offeredTools = actualRequest?.toolIds ?? [];
    const injected = actualRequest?.skillIds.includes(skillId) === true;
    const failed = events.find((event) => event.status === 'failed' || event.status === 'unavailable' || event.status === 'busy');
    const jobIds = calls.flatMap((call) => (call.result.jobId ? [call.result.jobId] : []));
    if (!injected) {
      return {
        status: 'error',
        durationMs,
        ...(replyText ? { reply: replyText } : {}),
        calls,
        tools: offeredTools,
        stage: 'load',
        code: 'skill_not_injected',
        message: '目标 Skill 未进入本次测试上下文。',
        delivery: 'skipped'
      };
    }
    if (failed) {
      return {
        status: 'error',
        durationMs,
        ...(replyText ? { reply: replyText } : {}),
        calls,
        tools: offeredTools,
        ...(jobIds.length > 0 ? { jobIds } : {}),
        stage: 'model',
        ...(failed.code ? { code: failed.code } : { code: failed.status }),
        message: replyText || '模型调用未完成。',
        delivery: 'skipped'
      };
    }
    if (!replyText && calls.length === 0) {
      return {
        status: 'error',
        durationMs,
        calls,
        tools: offeredTools,
        stage: 'model',
        code: 'empty_reply',
        message: '模型没有返回可用内容。',
        delivery: 'skipped'
      };
    }
    const failedCall = calls.find((call) => call.result.status === 'error');
    if (failedCall) {
      return {
        status: 'error',
        durationMs,
        ...(replyText ? { reply: replyText } : {}),
        calls,
        tools: offeredTools,
        ...(jobIds.length > 0 ? { jobIds } : {}),
        stage: stageForToolResult(failedCall.result.errorCode),
        ...(failedCall.result.errorCode ? { code: failedCall.result.errorCode } : {}),
        ...(failedCall.result.text ? { message: failedCall.result.text } : {}),
        delivery: 'skipped'
      };
    }
    const unknown = calls.some((call) => call.result.status === 'unknown');
    const submitted = calls.some((call) => call.result.status === 'submitted');
    return {
      status: unknown ? 'unknown' : submitted ? 'submitted' : 'ok',
      durationMs,
      ...(replyText ? { reply: replyText } : {}),
      calls,
      tools: offeredTools,
      ...(jobIds.length > 0 ? { jobIds } : {}),
      delivery: 'skipped'
    };
  }

  async #toolStatus(
    environment: TestEnvironment,
    accountId: string,
    scope: ExtensionTestScope,
    toolId: string
  ): Promise<void> {
    const identity = parseToolIdentity(toolId);
    if (!identity) throw new InvalidSpecError('toolId 必须是完整的工具身份。');
    if (identity.kind === 'plugin') {
      const key = toPluginKey(identity.source!, identity.pluginId!);
      const status = environment.statuses.find((entry) => entry.pluginKey === key);
      if (status && !status.ready) {
        throw new ExtensionTestFailure(startupStage(status.reason), status.reason ?? 'plugin_runtime_failed', `插件 ${key} 未能启动。`);
      }
    }
    await this.#assertToolEnabled(environment.policy, accountId, scope, toolId);
  }

  async #assertToolEnabled(
    policy: ExtensionPolicyService,
    accountId: string,
    scope: ExtensionTestScope,
    toolId: string
  ): Promise<void> {
    const conversation = conversationOf(accountId, scope);
    const effective = await policy.effective(accountId, conversation, this.#capabilityEnabled(accountId, conversation));
    const status = effective.tools.find((entry) => entry.tool.id === toolId);
    if (!status) throw new AccompanyError('tool_not_found', `工具 ${toolId} 未安装或未声明。`);
    if (!status.enabled) {
      throw new ExtensionTestFailure('load', status.issues[0]?.code ?? 'tool_unavailable', issueMessage(status.issues));
    }
  }

  async #scopedProfileForTool(
    profile: ResolvedProfile,
    accountId: string,
    scope: ExtensionTestScope,
    toolId: string
  ): Promise<ResolvedProfile> {
    const identity = parseToolIdentity(toolId);
    if (!identity) throw new InvalidSpecError('toolId 必须是完整的工具身份。');
    const plugins = identity.kind === 'plugin'
      ? profile.plugins.filter((plugin) => resolvedPluginKey(plugin) === toPluginKey(identity.source!, identity.pluginId!))
      : [];
    if (identity.kind === 'plugin' && plugins.length === 0) {
      throw new AccompanyError('tool_not_found', `工具 ${toolId} 未安装或未声明。`);
    }
    const scoped = { ...profile, plugins };
    await this.#assertToolEnabled(this.#policy(scoped, declaredReadiness(scoped)), accountId, scope, toolId);
    return scoped;
  }

  async #scopedProfileForSkill(
    profile: ResolvedProfile,
    accountId: string,
    request: ParsedSkillInput
  ): Promise<ResolvedProfile> {
    const conversation = conversationOf(accountId, request.scope);
    const policy = this.#policy(profile, declaredReadiness(profile));
    const effective = await policy.effective(accountId, conversation, this.#capabilityEnabled(accountId, conversation));
    const status = effective.skills.find((entry) => entry.skill.id === request.skillId);
    if (!status) throw new AccompanyError('skill_not_found', `Skill ${request.skillId} 不存在。`);
    if (!status.enabled) {
      throw new ExtensionTestFailure('load', status.issues[0]?.code ?? 'skill_unavailable', issueMessage(status.issues));
    }
    const rendered = skillInstructionsWithConfig(status.skill.instructions, status.config);
    const selection = selectSkillsForPrompt(
      [{ id: status.skill.id, name: status.skill.name, source: status.skill.source, instructions: rendered, tools: status.skill.tools }],
      { maxTotalInstructionsChars: SKILL_PROMPT_LIMITS.maxTotalInstructionsChars }
    );
    if (selection.included.length === 0) {
      const reason = selection.excluded[0]?.reason ?? 'instructions_budget';
      throw new ExtensionTestFailure('load', reason, 'Skill 正文与配置超出当前注入预算。');
    }
    const neededPluginKeys = new Set<string>();
    if (status.skill.pluginKey) neededPluginKeys.add(status.skill.pluginKey);
    for (const tool of effective.tools) if (tool.enabled && tool.tool.pluginKey) neededPluginKeys.add(tool.tool.pluginKey);
    for (const hook of effective.hooks) if (hook.enabled && hook.hook.pluginKey) neededPluginKeys.add(hook.hook.pluginKey);
    return { ...profile, plugins: profile.plugins.filter((plugin) => neededPluginKeys.has(resolvedPluginKey(plugin))) };
  }

  async #openScopedEnvironment(profile: ResolvedProfile): Promise<TestEnvironment> {
    const release = await this.#environmentLimiter.acquire(profile.accountId, this.#session.signal);
    try {
      return await this.#openEnvironment(profile);
    } finally {
      release();
    }
  }

  async #openEnvironment(profile: ResolvedProfile): Promise<TestEnvironment> {
    const stateDir = path.join(this.#options.testRoot, crypto.randomUUID());
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const runtime = new AccountPluginRuntime({
      accountId: profile.accountId,
      logger: this.#options.logger,
      accountDir: stateDir,
      accountPolicy: () => this.#options.config.snapshot().accountPolicies[profile.accountId] ?? defaultAccountPolicy()
    });
    this.#runtimes.add(runtime);
    try {
      const statuses = await runtime.sync(profile.plugins);
      const readyPlugins = new Set(statuses.filter((status) => status.ready).map((status) => status.pluginKey));
      const readyTools = new Set(runtime.readyTools());
      const policy = this.#policy(profile, { readyPlugins, readyTools, statuses });
      const tools = new ExtensionToolService({
        policy,
        accountDir: () => stateDir,
        logger: this.#options.logger,
        capabilityEnabled: (accountId, conversation) => this.#capabilityEnabled(accountId, conversation),
        runtime: () => runtime,
        limiter: this.#options.toolLimiter,
        ...(this.#options.now ? { now: this.#options.now } : {})
      });
      return { profile, stateDir, runtime, statuses, policy, tools };
    } catch (error) {
      this.#runtimes.delete(runtime);
      await runtime.close().catch(() => {});
      await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
      if (error instanceof AccompanyError && error.code === 'extension_test_closed') throw error;
      throw new ExtensionTestFailure('load', 'plugin_runtime_failed', error instanceof Error ? error.message : String(error));
    }
  }

  #policy(
    profile: ResolvedProfile,
    readiness: {
      readyPlugins: ReadonlySet<string>;
      readyTools: ReadonlySet<string>;
      statuses?: PluginRuntimeStatus[];
    }
  ): ExtensionPolicyService {
    return new ExtensionPolicyService({
      config: this.#options.config,
      registry: this.#options.registry,
      profiles: async () => profile,
      readyPlugins: () => readiness.readyPlugins,
      readyTools: () => readiness.readyTools,
      pluginRuntime: () => ({ synced: true, plugins: readiness.statuses ?? [] })
    });
  }

  #mediaHost(accountId: string): MediaToolHost {
    return new MediaToolHost({
      accountId,
      providers: this.#options.providers,
      media: this.#options.media,
      jobs: this.#options.jobs,
      logger: this.#options.logger,
      deliveryMode: 'skip'
    });
  }

  #context(
    profile: ResolvedProfile,
    conversation: ConversationRef,
    scope: ExtensionTestScope,
    roleText: string,
    text: string,
    invocationId: string,
    observeAgentRequest?: (observation: AgentRequestObservation) => void
  ): AgentMessageContext {
    const roleCard: ResolvedRoleCard = {
      ref: { source: 'private', id: 'extension-test-role', revision: 'r1' },
      manifest: { id: 'extension-test-role', kind: 'role-card', revision: 'r1', content: roleText },
      dir: this.#options.testRoot,
      content: roleText
    };
    const turnId = `extension-test-${crypto.randomUUID()}`;
    const context: AgentMessageContext = {
      instanceId: 'extension-test',
      accountId: profile.accountId,
      profile,
      logger: this.#options.logger,
      signal: this.#session.signal,
      sessionSignal: this.#session.signal,
      sessionEpoch: 1,
      hostEpoch: 1,
      profileFingerprint: profile.revision,
      conversation,
      roleBinding: {
        revision: `test:${turnId}`,
        contextEpoch: `test:${turnId}`,
        card: roleCard
      },
      voiceDeliverySupport: 'unsupported',
      message: {
        type: 'message',
        instanceId: 'extension-test',
        kind: scope.kind,
        peerId: scope.peerId,
        senderId: 'extension-test-user',
        messageId: turnId,
        at: this.#now(),
        segments: text ? [{ type: 'text', data: { text } }] : [],
        selfEcho: false
      },
      turnId,
      invocationMessageId: invocationId ? `${turnId}:${invocationId}` : `${turnId}:invoke`,
      isRoleBindingCurrent: async () => true,
      isTurnCurrent: async () => true,
      setExtensionGuard: () => {},
      setAfterTurnHandler: () => {},
      ...(observeAgentRequest ? { observeAgentRequest } : {}),
      markExtractable: () => {},
      send: async () => ({}),
      deliver: async () => ({}),
      enqueueConversation: async (task) => { await task(); },
      resolveConfig: () => ({}),
      history: async () => [],
      state: () => ({
        read: async <T = Record<string, unknown>>() => ({}) as T,
        write: async () => {}
      })
    };
    return context;
  }

  async #closeEnvironment(environment: TestEnvironment): Promise<void> {
    this.#runtimes.delete(environment.runtime);
    await environment.tools.close().catch(() => {});
    await environment.runtime.close().catch(() => {});
    await fs.rm(environment.stateDir, { recursive: true, force: true }).catch(() => {});
  }

  #capabilityEnabled(accountId: string, conversation: ConversationRef) {
    return (capability: CapabilityId): boolean =>
      this.#options.providers.resolve(accountId, conversation, capability).enabled;
  }

  async #profile(accountId: string): Promise<ResolvedProfile> {
    try {
      return await this.#options.profile(accountId);
    } catch (error) {
      throw new AccompanyError(
        'profile_unavailable',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  #runActive<T>(task: () => Promise<T>): Promise<T> {
    if (this.#closed) {
      throw new AccompanyError('extension_test_closed', '扩展测试服务已关闭。');
    }
    const run = task();
    this.#active.add(run);
    return run.finally(() => { this.#active.delete(run); });
  }
}

interface ParsedSkillInput {
  skillId: string;
  input: string;
  scope: ExtensionTestScope;
  roleText?: string;
}

interface ParsedToolInput {
  toolId: string;
  arguments: Record<string, unknown>;
  scope: ExtensionTestScope;
}

function parseSkillInput(input: ExtensionSkillTestInput): ParsedSkillInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InvalidSpecError('测试请求必须是对象。');
  if (typeof input.skillId !== 'string' || !input.skillId) throw new InvalidSpecError('skillId 是必填项。');
  if (typeof input.input !== 'string' || !input.input.trim()) throw new InvalidSpecError('input 必须是非空文本。');
  if (input.input.length > MAX_INPUT_CHARS) throw new InvalidSpecError(`input 最多 ${MAX_INPUT_CHARS} 字符。`);
  if (input.roleText !== undefined && (typeof input.roleText !== 'string' || input.roleText.length > MAX_ROLE_CHARS)) {
    throw new InvalidSpecError(`roleText 必须是不超过 ${MAX_ROLE_CHARS} 字符的文本。`);
  }
  return {
    skillId: input.skillId,
    input: input.input,
    scope: scopeOf(input.scope),
    ...(input.roleText !== undefined ? { roleText: input.roleText } : {})
  };
}

function parseToolInput(input: ExtensionToolTestInput): ParsedToolInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InvalidSpecError('测试请求必须是对象。');
  if (typeof input.toolId !== 'string' || !input.toolId) throw new InvalidSpecError('toolId 是必填项。');
  if (!isRecord(input.arguments)) throw new InvalidSpecError('arguments 必须是 JSON 对象。');
  return {
    toolId: input.toolId,
    arguments: input.arguments,
    scope: scopeOf(input.scope)
  };
}

function scopeOf(raw: ExtensionTestScope | undefined): ExtensionTestScope {
  if (raw === undefined) return { kind: 'private', peerId: TEST_PEER_ID };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InvalidSpecError('scope 必须是会话作用域对象。');
  if (raw.kind !== 'private' && raw.kind !== 'group') throw new InvalidSpecError('scope.kind 必须是 private 或 group。');
  return { kind: assertKind(raw.kind), peerId: assertIdentifier(raw.peerId, 'peerId') };
}

function conversationOf(accountId: string, scope: ExtensionTestScope): ConversationRef {
  return { accountId, kind: scope.kind, peerId: scope.peerId };
}

function resolvedPluginKey(plugin: ResolvedPlugin): string {
  return toPluginKey(plugin.ref.source as 'public' | 'private', plugin.ref.id);
}

function declaredReadiness(profile: ResolvedProfile): { readyPlugins: Set<string>; readyTools: Set<string> } {
  const readyPlugins = new Set<string>();
  const readyTools = new Set<string>();
  for (const plugin of profile.plugins) {
    const key = toPluginKey(plugin.ref.source as 'public' | 'private', plugin.ref.id);
    readyPlugins.add(key);
    for (const tool of plugin.manifest.tools ?? []) {
      readyTools.add(pluginToolId(plugin.ref.source as 'public' | 'private', plugin.ref.id, tool.id));
    }
  }
  return { readyPlugins, readyTools };
}

function filterSnapshot(snapshot: ExtensionTurnSnapshot, skillId: string): ExtensionTurnSnapshot {
  return { ...snapshot, skills: snapshot.skills.filter((skill) => skill.id === skillId) };
}

function stageForToolResult(code: string | undefined): ExtensionTestStage {
  if (!code) return 'invoke';
  if (code === 'handler_not_ready' || code === 'tool_unavailable' || code === 'tool_not_authorized'
    || code === 'plugin_switch_off' || code === 'switch_off' || code === 'plugin_context_epoch_missing') {
    return 'load';
  }
  return 'invoke';
}

function startupStage(reason: string | undefined): ExtensionTestStage {
  if (reason?.startsWith('plugin_init')) return 'init';
  return 'load';
}

function issueMessage(issues: EffectiveIssue[]): string {
  const first = issues[0];
  if (!first) return 'Skill 或工具当前不可用。';
  const detail = first.detail ? `（${first.detail}）` : '';
  const labels: Record<string, string> = {
    plugin_switch_off: '插件已在当前作用域关闭。',
    switch_off: '该资源已在当前作用域关闭。',
    unauthorized: '账号未授权该工具。',
    handler_not_ready: '工具没有可执行的处理器。',
    capability_unavailable: '依赖的模型能力不可用。',
    requires_unavailable: 'Skill 依赖的能力不可用。',
    skill_tool_unavailable: 'Skill 引用的工具不可用。',
    kind_scope: 'Skill 不适用于当前会话类型。',
    peer_scope: 'Skill 不适用于当前会话。'
  };
  return `${labels[first.code] ?? 'Skill 或工具当前不可用。'}${detail}`;
}

function failure(startedAt: number, error: unknown): ExtensionTestResult {
  const durationMs = Math.max(0, Date.now() - startedAt);
  if (error instanceof ExtensionTestFailure) {
    return {
      status: 'error',
      durationMs,
      calls: [],
      stage: error.stage,
      code: error.code,
      message: error.message,
      delivery: 'skipped'
    };
  }
  if (error instanceof AccompanyError) {
    return {
      status: 'error',
      durationMs,
      calls: [],
      stage: 'load',
      code: error.code,
      message: error.message,
      delivery: 'skipped'
    };
  }
  return {
    status: 'error',
    durationMs,
    calls: [],
    stage: 'load',
    code: 'extension_test_failed',
    message: error instanceof Error ? error.message : String(error),
    delivery: 'skipped'
  };
}

function validateAccount(accountId: string): void {
  assertIdentifier(accountId, 'accountId');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
