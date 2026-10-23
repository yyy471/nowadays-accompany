import { InvalidSpecError } from '../core/errors.js';

export type ChatKind = 'group' | 'private';

export interface ConversationRef {
  /** 接收方（机器人）账号 uin */
  accountId: string;
  kind: ChatKind;
  /** 群号（group）或对端 QQ 号（private） */
  peerId: string;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function assertIdentifier(value: string, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new InvalidSpecError(`${label} must match ${IDENTIFIER} (got ${JSON.stringify(value)})`);
  }
  return value;
}

export function assertKind(kind: string): ChatKind {
  if (kind !== 'group' && kind !== 'private') throw new InvalidSpecError(`kind must be group or private (got ${kind})`);
  return kind;
}

export function conversationKey(ref: ConversationRef): string {
  return `${ref.accountId}/${ref.kind}/${ref.peerId}`;
}

export function parseConversationKey(key: string): ConversationRef {
  const parts = key.split('/');
  if (parts.length !== 3) throw new InvalidSpecError(`invalid conversation key: ${key}`);
  const [accountId, kind, peerId] = parts as [string, string, string];
  return {
    accountId: assertIdentifier(accountId, 'accountId'),
    kind: assertKind(kind),
    peerId: assertIdentifier(peerId, 'peerId')
  };
}

/** 防御式路径片段：标识符已受限，这里再兜一层，避免任何拼路径越界。 */
export function safePathSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '_');
  if (!cleaned) throw new InvalidSpecError('path segment is empty after sanitizing');
  return cleaned;
}
