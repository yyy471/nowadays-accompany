/**
 * 维护窗口内的模型调用领取（278 §2.1、283 §13 R01/R02）。
 *
 * 解析绑定后在同一步完成维护检查与在途登记：
 * - 维护中（含改绑后的新目标）等待窗口结束再重新解析；
 * - 最后一次检查与领取在同一个同步调用里，避免中间插入维护窗口；
 * - 等待期间被取消时返回 null，由调用方按取消处理。
 */
export interface ModelMaintenanceGate {
  isUnder(resourceId: string): boolean;
  wait(resourceId: string, signal?: AbortSignal): Promise<void>;
}

export interface ModelCallClaim {
  admitted: boolean;
  release: () => void;
}

export interface ClaimedModelBinding<T> {
  binding: T;
  release: () => void;
}

export async function resolveClaimedModelBinding<
  T extends { resourceId: string },
>(
  resolve: () => T,
  maintenance: ModelMaintenanceGate | null | undefined,
  claim: (resourceId: string) => ModelCallClaim,
  signal?: AbortSignal,
): Promise<ClaimedModelBinding<T> | null> {
  while (true) {
    if (isAborted(signal)) {
      return null;
    }
    const binding = resolve();
    if (maintenance?.isUnder(binding.resourceId) !== true) {
      const claimed = claim(binding.resourceId);
      if (claimed.admitted) {
        return { binding, release: claimed.release };
      }
    }
    if (maintenance === null || maintenance === undefined) {
      return null;
    }
    // 维护中或刚被新的维护窗口抢先：等结束后重新解析与领取。
    await maintenance.wait(binding.resourceId, signal);
    if (isAborted(signal)) {
      return null;
    }
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
