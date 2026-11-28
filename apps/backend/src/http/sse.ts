import type { ServerResponse } from "node:http";

/** 与 `conversation-stream-hub` 保持相同的 15 秒心跳节奏。 */
export const SSE_HEARTBEAT_MS = 15_000;

export interface SseStream {
  /** 连接是否已结束（关闭、写入失败或主动释放）。 */
  readonly closed: boolean;
  /** 写入一帧已格式化的 SSE；返回 false 只代表背压或连接已关闭。 */
  write(frame: string): boolean;
  /**
   * 登记订阅清理。若流在登记前已关闭，立即执行清理，
   * 覆盖「响应已断开才开始订阅／登记」的竞态。
   */
  disposeWith(cleanup: () => void): void;
  /** 幂等释放订阅与心跳；关闭、结束、错误与写入失败共用同一出口。 */
  dispose(): void;
}

function runCleanup(cleanup: () => void): void {
  try {
    cleanup();
  } catch {
    // 单个订阅者的清理异常不应阻断其他清理或路由返回。
  }
}

/**
 * 长连接 SSE 的统一写入守卫：
 * - 写入前检查 `destroyed` / `writableEnded`，写入异常时自动释放；
 * - 写入返回 false 只表示背压，不据此退订；
 * - 定时发送 `: heartbeat`，`unref()` 不阻止进程退出，背压时跳过；
 * - 在 `close` / `finish` / `error` 任一终态路径上恰好释放一次。
 */
export function startSse(
  response: ServerResponse,
  heartbeatMs = SSE_HEARTBEAT_MS,
): SseStream {
  let closed = false;
  let heartbeat: NodeJS.Timeout | undefined;
  const cleanups = new Set<() => void>();

  const dispose = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    response.off("close", dispose);
    response.off("finish", dispose);
    response.off("error", dispose);
    for (const cleanup of [...cleanups]) runCleanup(cleanup);
    cleanups.clear();
  };

  const write = (frame: string): boolean => {
    if (closed || response.destroyed || response.writableEnded) {
      dispose();
      return false;
    }
    try {
      return response.write(frame);
    } catch {
      dispose();
      // 写入抛错说明连接已不可用；主动销毁且不传错误，避免未处理的 error 事件。
      if (!response.destroyed && !response.writableEnded) response.destroy();
      return false;
    }
  };

  response.once("close", dispose);
  response.once("finish", dispose);
  response.once("error", dispose);
  // 监听器注册前响应可能已经关闭，`once` 不会再触发，需要立即释放。
  if (response.destroyed || response.writableEnded) {
    dispose();
  } else if (heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      if (closed || response.destroyed || response.writableEnded) {
        dispose();
        return;
      }
      if (response.writableNeedDrain) return;
      write(": heartbeat\n\n");
    }, heartbeatMs);
    heartbeat.unref?.();
  }

  return {
    get closed() {
      return closed;
    },
    write,
    disposeWith(cleanup) {
      if (closed || response.destroyed || response.writableEnded) {
        dispose();
        runCleanup(cleanup);
        return;
      }
      cleanups.add(cleanup);
    },
    dispose,
  };
}
