import type { CapabilityId } from '../policy/capabilities.js';
import { CAPABILITY_LABELS } from '../policy/capabilities.js';

const REASON_LABELS: Record<string, string> = {
  scope_disabled: '已在当前作用域关闭',
  not_configured: '未配置服务',
  provider_not_found: '服务不存在',
  provider_not_authorized: '账号未授权该服务',
  model_not_found: '模型不存在',
  capability_unsupported: '模型不支持该能力',
  adapter_not_found: '适配器未注册',
  adapter_unsupported: '适配器不支持该能力',
  media_transport_unavailable: '服务不允许当前媒体传输方式',
  cloud_media_blocked: '账号未允许媒体上传到云端',
  model_no_image_input: '对话模型不能直接接收图片',
  cross_provider_fallback_disabled: '未允许跨服务回退',
  execution_plan_stale: '服务配置已变化，请重新发起',
  credential_stale: '服务凭据已变化，请重新发起'
};

export function capabilityNotice(capability: CapabilityId, reason: string, detail?: string): string {
  const explanation = REASON_LABELS[reason] ?? reason;
  return `${CAPABILITY_LABELS[capability]}暂不可用：${explanation}。${detail && !detail.includes('credential') ? detail : ''}`.trim();
}
