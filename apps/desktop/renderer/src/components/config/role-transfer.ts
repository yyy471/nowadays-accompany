/**
 * 单角色迁移向导的纯逻辑：关系文案、能力标签、候选资源与导入门禁。
 * 不发请求、不碰 DOM，便于在 node:test 里覆盖。
 */

export type TransferRelation = 'new' | 'same' | 'package-ahead' | 'local-ahead' | 'diverged' | 'unknown';
export type TransferChoice = 'local' | 'package';
export type TransferBindingCapability = 'chat_model' | 'memory_model' | 'mcp' | 'skill' | 'voice' | 'image';
export type TransferBindingCategory = 'model' | 'mcp' | 'skill' | 'voice' | 'image';

export interface TransferBinding {
  key: string;
  capability: TransferBindingCapability;
  category: TransferBindingCategory;
  sourceResourceId: string;
  modelName: string | null;
  enabled: boolean;
}

export interface TransferPreview {
  roleId: string;
  displayName: string | null;
  localActivityState: 'active' | 'stopping' | 'stopped' | null;
  token: string;
  relation: TransferRelation;
  requiresChoice: boolean;
  packageDigest: string;
  localFingerprint: string | null;
  packageFingerprint: string;
  registered: boolean;
  bindings: TransferBinding[];
  unresolved: TransferBinding[];
}

export interface TransferApplyResult {
  roleId: string;
  relation: TransferRelation;
  outcome: 'published' | 'kept-local' | 'unchanged';
}

/** 本机可映射到某个绑定的资源；空映射由界面显式提供「暂不映射」。 */
export interface TransferCandidate {
  id: string;
  name: string;
}

export interface TransferRelationMeta {
  label: string;
  detail: string;
  tone: 'ok' | 'dirty' | 'error' | 'off';
}

export function transferRelationMeta(relation: TransferRelation): TransferRelationMeta {
  switch (relation) {
    case 'new':
      return { label: '新角色', detail: '本机还没有这个角色，导入后会新建角色并完整写入进度。', tone: 'ok' };
    case 'same':
      return { label: '与本机一致', detail: '角色包和本机时间线一致，可以直接导入。', tone: 'ok' };
    case 'package-ahead':
      return { label: '角色包较新', detail: '角色包里有更新的时间线进度，导入后会补齐这些内容。', tone: 'dirty' };
    case 'local-ahead':
      return { label: '本机较新', detail: '本机时间线比角色包更新；导入前需要选择保留哪一份进度。', tone: 'dirty' };
    case 'diverged':
      return { label: '时间线已分化', detail: '本机和角色包各自记录了不同的进度，导入前需要选择保留哪一份。', tone: 'error' };
    case 'unknown':
    default:
      return { label: '无法比较', detail: '缺少足够信息比较时间线，请确认角色包来源后再导入。', tone: 'off' };
  }
}

const CAPABILITY_LABELS: Record<TransferBindingCapability, string> = {
  chat_model: '对话模型',
  memory_model: '记忆模型',
  mcp: 'MCP 工具',
  skill: 'Skill 知识',
  voice: '语音服务',
  image: '生图服务'
};

export function transferCapabilityLabel(capability: TransferBinding['capability']): string {
  return CAPABILITY_LABELS[capability] ?? capability;
}

export function candidatesForBinding(
  binding: TransferBinding,
  catalogs: {
    resources: Array<{ resourceId: string; kind: string; name: string }>;
    voiceServices: Array<{ serviceId: string; name: string }>;
    imageServices: Array<{ serviceId: string; name: string }>;
  }
): TransferCandidate[] {
  switch (binding.category) {
    case 'voice':
      return catalogs.voiceServices.map(item => ({ id: item.serviceId, name: item.name }));
    case 'image':
      return catalogs.imageServices.map(item => ({ id: item.serviceId, name: item.name }));
    case 'model':
    case 'mcp':
    case 'skill':
      return catalogs.resources
        .filter(item => item.kind === binding.category)
        .map(item => ({ id: item.resourceId, name: item.name }));
    default:
      return [];
  }
}

/** 导入门禁：先要有预检结果，再要求角色已停止；需要选择时间线时必须先选。 */
export function canApplyTransfer(
  preview: TransferPreview | null,
  choice: TransferChoice | null
): { allowed: boolean; reason: string } {
  if (!preview) return { allowed: false, reason: '请先预检角色包。' };
  if (preview.localActivityState && preview.localActivityState !== 'stopped') {
    return { allowed: false, reason: '请先停止角色活动后再导入。' };
  }
  if (preview.requiresChoice && !choice) {
    return { allowed: false, reason: '请选择要保留的时间线。' };
  }
  return { allowed: true, reason: '' };
}
