/**
 * 新装首启的起手三步（DL-201 · UX-02）。
 * 纯计算：把首页静默读取到的快照收敛成非阻塞引导的展示状态，便于单测。
 */
export interface OnboardingSnapshot {
  hasRole: boolean;
  roleId: string;
  hasEnabledModelService: boolean;
  hasChatBinding: boolean;
  roleActive: boolean;
}

export type OnboardingStepId = 'model-service' | 'role-binding' | 'conversation';

export interface OnboardingStep {
  id: OnboardingStepId;
  index: 1 | 2 | 3;
  title: string;
  detail: string;
  done: boolean;
  current: boolean;
  actionLabel: string;
  disabled: boolean;
}

export interface OnboardingState {
  visible: boolean;
  completedCount: number;
  steps: OnboardingStep[];
}

/** 配齐模型服务 + 当前角色绑定对话模型且启用后，引导自动收起。 */
export function deriveOnboardingState(snapshot: OnboardingSnapshot): OnboardingState {
  const step1Done = snapshot.hasEnabledModelService;
  const step2Done = snapshot.hasRole && snapshot.hasChatBinding && snapshot.roleActive;
  const visible = !(step1Done && step2Done);
  const completedCount = (step1Done ? 1 : 0) + (step2Done ? 1 : 0);
  return {
    visible,
    completedCount,
    steps: [
      {
        id: 'model-service',
        index: 1,
        title: '添加模型服务',
        detail: step1Done ? '已连接可用模型服务' : '先添加一个可用的对话模型服务',
        done: step1Done,
        current: !step1Done,
        actionLabel: step1Done ? '查看服务' : '去添加',
        disabled: false,
      },
      {
        id: 'role-binding',
        index: 2,
        title: '为角色绑定对话模型并启用',
        detail: !snapshot.hasRole ? '先创建一位角色'
          : step2Done ? '已绑定对话模型并启用'
          : snapshot.hasChatBinding ? '已绑定模型，启用角色后即可对话'
          : '选择对话模型并启用当前角色',
        done: step2Done,
        current: step1Done && !step2Done,
        actionLabel: !snapshot.hasRole ? '去创建' : step2Done ? '去调整' : '去配置',
        disabled: false,
      },
      {
        id: 'conversation',
        index: 3,
        title: '开始对话',
        detail: snapshot.hasRole ? '随时可以进入对话页开聊' : '创建角色后即可开始对话',
        done: false,
        current: false,
        actionLabel: '去对话',
        disabled: !snapshot.hasRole,
      },
    ],
  };
}

/**
 * 是否存在可用的对话模型绑定。
 * 后端的绑定记录既有 `chat_model`（角色绑定接口），也兼容更短的 `chat`。
 */
export function hasUsableChatBinding(items: Array<{ capability?: string; resourceId?: string; modelName?: string | null; enabled?: boolean }>): boolean {
  return items.some(item => (item.capability === 'chat' || item.capability === 'chat_model')
    && item.enabled !== false
    && Boolean(item.resourceId?.trim())
    && Boolean(item.modelName?.trim()));
}
