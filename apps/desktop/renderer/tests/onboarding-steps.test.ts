import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveOnboardingState, hasUsableChatBinding, type OnboardingSnapshot } from '../src/components/home/onboarding-steps.ts';
import { resolveEngineeringPoolHint } from '../src/extensions/engineering-hint.ts';

const snapshot = (overrides: Partial<OnboardingSnapshot> = {}): OnboardingSnapshot => ({
  hasRole: true,
  roleId: 'role-1',
  hasEnabledModelService: false,
  hasChatBinding: false,
  roleActive: false,
  ...overrides,
});

test('起手引导：没有模型服务时停在第一步', () => {
  const state = deriveOnboardingState(snapshot());
  assert.equal(state.visible, true);
  assert.equal(state.completedCount, 0);
  const [first, second, third] = state.steps;
  assert.deepEqual(state.steps.map(step => step.index), [1, 2, 3]);
  assert.equal(first.done, false);
  assert.equal(first.current, true);
  assert.equal(first.actionLabel, '去添加');
  assert.equal(first.detail, '先添加一个可用的对话模型服务');
  assert.equal(second.done, false);
  assert.equal(second.current, false);
  assert.equal(third.disabled, false);
});

test('起手引导：有服务但未绑定对话模型时停在第二步', () => {
  const state = deriveOnboardingState(snapshot({ hasEnabledModelService: true }));
  assert.equal(state.visible, true);
  assert.equal(state.completedCount, 1);
  const [first, second] = state.steps;
  assert.equal(first.done, true);
  assert.equal(first.current, false);
  assert.equal(first.actionLabel, '查看服务');
  assert.equal(second.done, false);
  assert.equal(second.current, true);
  assert.equal(second.actionLabel, '去配置');
  assert.equal(second.detail, '选择对话模型并启用当前角色');
});

test('起手引导：已绑定对话模型但角色未启用时不收起', () => {
  const state = deriveOnboardingState(snapshot({ hasEnabledModelService: true, hasChatBinding: true, roleActive: false }));
  assert.equal(state.visible, true);
  assert.equal(state.completedCount, 1);
  const second = state.steps[1];
  assert.equal(second.done, false);
  assert.equal(second.current, true);
  assert.equal(second.detail, '已绑定模型，启用角色后即可对话');
});

test('起手引导：模型服务与对话绑定都配齐后自动收起', () => {
  const state = deriveOnboardingState(snapshot({ hasEnabledModelService: true, hasChatBinding: true, roleActive: true }));
  assert.equal(state.visible, false);
  assert.equal(state.completedCount, 2);
  const second = state.steps[1];
  assert.equal(second.done, true);
  assert.equal(second.current, false);
  assert.equal(second.actionLabel, '去调整');
  assert.equal(second.detail, '已绑定对话模型并启用');
});

test('起手引导：没有角色时第二步引导创建且对话不可用', () => {
  const state = deriveOnboardingState(snapshot({ hasRole: false, roleId: '' }));
  assert.equal(state.visible, true);
  assert.equal(state.completedCount, 0);
  const second = state.steps[1];
  assert.equal(second.done, false);
  assert.equal(second.actionLabel, '去创建');
  assert.equal(second.detail, '先创建一位角色');
  const third = state.steps[2];
  assert.equal(third.disabled, true);
  assert.equal(third.detail, '创建角色后即可开始对话');
});

test('对话绑定可用性：接受 chat_model 与 chat，忽略停用与缺失型号', () => {
  assert.equal(hasUsableChatBinding([{ capability: 'chat_model', resourceId: 'r', modelName: 'm', enabled: true }]), true);
  assert.equal(hasUsableChatBinding([{ capability: 'chat', resourceId: 'r', modelName: 'm' }]), true);
  assert.equal(hasUsableChatBinding([{ capability: 'memory_model', resourceId: 'r', modelName: 'm', enabled: true }]), false);
  assert.equal(hasUsableChatBinding([{ capability: 'chat_model', resourceId: 'r', modelName: 'm', enabled: false }]), false);
  assert.equal(hasUsableChatBinding([{ capability: 'chat_model', resourceId: 'r', modelName: '', enabled: true }]), false);
  assert.equal(hasUsableChatBinding([{ capability: 'chat_model', resourceId: '  ', modelName: 'm', enabled: true }]), false);
  assert.equal(hasUsableChatBinding([]), false);
});

const readyMember = { resourceId: 'r', modelName: 'm', enabled: true, resourceName: '模型', state: 'ready' as const, retryAfterSeconds: null };

test('工程池提示：未配置模型池时给出空池引导', () => {
  const hint = resolveEngineeringPoolHint({ enabled: true, readiness: 'empty', members: [] });
  assert.deepEqual(hint, {
    kind: 'empty',
    title: '尚未配置工程模型池',
    detail: '当前没有可用的工程模型，主角色暂无法在后台为你编写扩展。',
    actionLabel: '去设置配置工程池',
  });
  // 未启用但 enabled 为真却没有任何成员，同样视为空池。
  assert.equal(resolveEngineeringPoolHint({ enabled: true, readiness: 'unbound', members: [] })?.kind, 'empty');
});

test('工程池提示：工程关闭时提示开启', () => {
  assert.deepEqual(resolveEngineeringPoolHint({ enabled: false, readiness: 'disabled', members: [] }), {
    kind: 'disabled',
    title: '后台工程能力未开启',
    detail: '开启并配置独立工程模型池后，主角色才能在后台为你编写扩展。',
    actionLabel: '去设置开启工程',
  });
});

test('工程池提示：就绪、成员耗尽或尚未读取时不打扰', () => {
  assert.equal(resolveEngineeringPoolHint({ enabled: true, readiness: 'ready', members: [readyMember] }), null);
  assert.equal(resolveEngineeringPoolHint({ enabled: true, readiness: 'exhausted', members: [readyMember] }), null);
  assert.equal(resolveEngineeringPoolHint(null), null);
  assert.equal(resolveEngineeringPoolHint(undefined), null);
});
