import type { EngineeringSettings } from '../components/config/engineering-settings';

/** 扩展页对「后台工程模型池」未配置的提示，方案 B 保持独立工程池（DL-201）。 */
export type EngineeringPoolHint = {
  kind: 'empty' | 'disabled';
  title: string;
  detail: string;
  actionLabel: string;
};

export function resolveEngineeringPoolHint(settings: Pick<EngineeringSettings, 'enabled' | 'readiness' | 'members'> | null | undefined): EngineeringPoolHint | null {
  if (!settings) return null;
  if (settings.readiness === 'empty' || (settings.enabled && settings.members.length === 0)) {
    return {
      kind: 'empty',
      title: '尚未配置工程模型池',
      detail: '当前没有可用的工程模型，主角色暂无法在后台为你编写扩展。',
      actionLabel: '去设置配置工程池',
    };
  }
  if (settings.readiness === 'disabled' || !settings.enabled) {
    return {
      kind: 'disabled',
      title: '后台工程能力未开启',
      detail: '开启并配置独立工程模型池后，主角色才能在后台为你编写扩展。',
      actionLabel: '去设置开启工程',
    };
  }
  return null;
}
