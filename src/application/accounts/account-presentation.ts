import type { QqAvatarCache } from '../../injection/qq-avatar.js';
import type { AccountDisplayProfile, AccountDisplayStore } from '../../profiles/display.js';

export interface PresentedAvatar {
  dataUrl: string;
  source: 'local' | 'qq';
}

export interface LocalPresentation {
  display?: AccountDisplayProfile;
  avatar?: PresentedAvatar;
}

export interface ProcessPresentation {
  /** 真实登录昵称；与本地展示名分开。 */
  nickname?: string;
  displayName?: string;
  avatarDataUrl?: string;
  avatarSource?: 'local' | 'qq';
}

/** 昵称与头像的展示组合入口；身份校验仍由接入流程负责。 */
export class AccountPresentation {
  readonly #displays: AccountDisplayStore;
  readonly #avatars: QqAvatarCache;

  constructor(options: { displays: AccountDisplayStore; avatars: QqAvatarCache }) {
    this.#displays = options.displays;
    this.#avatars = options.avatars;
  }

  /** 主页/账号列表：本地展示资料优先；需要时才解析远程头像。 */
  async local(accountId: string, accountDir: string, options: { avatars?: boolean } = {}): Promise<LocalPresentation> {
    const display = await this.#displays.load(accountDir).catch(() => undefined);
    const avatar = options.avatars ? await this.avatar(accountId, display?.avatarDataUrl) : undefined;
    return {
      ...(display ? { display } : {}),
      ...(avatar ? { avatar } : {})
    };
  }

  /** 进程卡片：真实昵称与本地展示名分开，头像可回退到 QQ 公开头像。 */
  async process(
    accountId: string,
    accountDir: string,
    realNickname: string | undefined,
    options: { avatars?: boolean } = {}
  ): Promise<ProcessPresentation> {
    const display = await this.#displays.load(accountDir).catch(() => undefined);
    const localAvatar = display?.avatarDataUrl;
    const avatar = options.avatars
      ? await this.avatar(accountId, localAvatar)
      : localAvatar ? { dataUrl: localAvatar, source: 'local' as const } : undefined;
    return {
      ...(realNickname ? { nickname: realNickname } : {}),
      ...(display?.nickname ? { displayName: display.nickname } : {}),
      ...(avatar ? { avatarDataUrl: avatar.dataUrl, avatarSource: avatar.source } : {})
    };
  }

  /** 所有账号头像共用：本地展示头像优先，缺失时回退 QQ 公开头像。 */
  async avatar(accountId: string, localAvatarDataUrl?: string): Promise<PresentedAvatar | undefined> {
    if (localAvatarDataUrl) return { dataUrl: localAvatarDataUrl, source: 'local' };
    const dataUrl = await this.#avatars.get(accountId);
    return dataUrl ? { dataUrl, source: 'qq' } : undefined;
  }
}
