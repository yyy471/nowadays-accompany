import type { AccountProfileFile, ProfileSummary } from '../artifacts/types.js';

/** 控制面返回的账号摘要；纯传输类型，不包含运行时对象。 */
export interface AccountSummary {
  accountId: string;
  dir: string;
  state: 'ready' | 'invalid';
  file?: AccountProfileFile;
  profile?: ProfileSummary;
  error?: string;
  slots: string[];
  /** 本地展示资料；没有 display.json 时省略。 */
  nickname?: string;
  signature?: string;
  /** 本地展示头像优先；缺失时回退到 QQ 公开头像。 */
  avatarDataUrl?: string;
  avatarSource?: 'local' | 'qq';
}
