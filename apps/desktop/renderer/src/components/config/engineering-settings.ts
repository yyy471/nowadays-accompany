export type EngineeringThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type EngineeringMember = {
  resourceId: string; modelName: string; enabled: boolean;
  maxTokens?: number; contextWindow?: number; thinkingLevel?: EngineeringThinkingLevel;
};
type MemberState = 'ready' | 'disabled' | 'invalid' | 'maintenance' | 'cooldown';
export type MemberSummary = EngineeringMember & { resourceName: string | null; state: MemberState; retryAfterSeconds: number | null };
export type EngineeringSettings = {
  enabled: boolean;
  allowShell: boolean;
  mode: 'priority' | 'round_robin';
  members: MemberSummary[];
  readiness: 'disabled' | 'unbound' | 'empty' | 'exhausted' | 'ready';
};

export function isOrdinaryResource(item: { kind: string; adminSeatOnly?: boolean; config: Record<string, unknown> }) {
  return !(item.kind === 'mcp' && (item.adminSeatOnly || item.config.command === 'nowadays-pi'));
}

export function memberInputs(members: EngineeringMember[]): EngineeringMember[] {
  return members.map(({ resourceId, modelName, enabled, maxTokens, contextWindow, thinkingLevel }) => ({
    resourceId, modelName, enabled,
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  }));
}

export function moveMember(members: EngineeringMember[], index: number, direction: -1 | 1) {
  const target = index + direction;
  const next = memberInputs(members);
  if (next[index] && next[target]) [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function memberStatus(member: MemberSummary, elapsedSeconds: number) {
  if (member.state === 'cooldown') {
    const remaining = Math.max(0, (member.retryAfterSeconds ?? 0) - elapsedSeconds);
    return remaining ? `冷却中 · ${remaining} 秒` : '等待刷新';
  }
  return { ready: '可用', disabled: '已停用', invalid: '服务或型号无效', maintenance: '维护中' }[member.state];
}
