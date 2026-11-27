import { setTimeout as delay } from "node:timers/promises";
import { ConversationStore } from "../../storage/conversation/conversation-store.js";
import type { ConversationContext, StreamEventsInput } from "./conversation-internal-types.js";

/**
 * SSE 订阅与游标补读：持有活动流清理表，广播窗口事件直到客户端断开。
 */
export class ConversationStreamHub {
  constructor(private readonly ctx: ConversationContext) {}

  /** 关闭该角色的事件流：删除角色目录前释放角色库句柄。 */
  closeStreams(roleId: string): void {
    for (const [cleanup, streamRoleId] of [...this.ctx.state.activeStreams]) {
      if (streamRoleId === roleId) {
        cleanup();
      }
    }
  }

  async streamEvents(input: StreamEventsInput): Promise<void> {
    const lease = this.ctx.roleAccess.borrow(input.roleId);
    const storage = lease.storage;
    const store = new ConversationStore(
      storage.business.db,
      input.roleId,
      this.ctx.timeZone,
    );
    let cursor: number;
    try {
      cursor = input.after ?? store.latestEventId(input.windowId);
      if (input.after !== null) {
        store.validateCursor(input.windowId, input.after);
      }
    } catch (error) {
      lease.release();
      throw error;
    }
    let closed = false;
    let cleanupDone = false;
    const cleanup = (): void => {
      if (cleanupDone) {
        return;
      }
      cleanupDone = true;
      this.ctx.state.activeStreams.delete(cleanup);
      if (input.clientId !== null && input.clientId.length > 0) {
        this.ctx.inputStates.clearClient(
          input.roleId,
          input.windowId,
          input.clientId,
        );
        this.ctx.schedule(input.roleId);
      }
      lease.release();
      if (!input.response.writableEnded && !input.response.destroyed) {
        try {
          input.response.end();
          if (this.ctx.state.closed) {
            input.response.destroy();
          }
        } catch {
          // 客户端已经断开。
        }
      }
    };
    this.ctx.state.activeStreams.set(cleanup, input.roleId);
    input.request.once("close", () => {
      closed = true;
      cleanup();
    });
    input.request.once("aborted", () => {
      closed = true;
      cleanup();
    });
    input.response.once("close", () => {
      closed = true;
      cleanup();
    });
    input.response.once("error", () => {
      closed = true;
      cleanup();
    });
    try {
    input.response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store",
      connection: "keep-alive",
    });
    input.response.flushHeaders?.();
    if (input.sharesOnly) input.response.write(`id: ${cursor}\nevent: ready\ndata: {}\n\n`);
    let lastHeartbeat = Date.now();
      while (
        !closed &&
        !this.ctx.state.closed &&
        !input.response.destroyed &&
        !input.response.writableEnded
      ) {
        const events = store.listStreamEventsAfter(input.windowId, cursor, 200);
        if (events.length > 0) {
          for (const event of events) {
            cursor = event.streamEventId;
            if (input.sharesOnly) {
              if (event.type === "message_completed" && event.payload.source === "autonomy_share") {
                const notice = { source: "autonomy_share", roleId: input.roleId, windowId: input.windowId,
                  messageId: event.payload.replyMessageId, summary: event.payload.summary, homeAssetId: event.payload.homeAssetId };
                input.response.write(`id: ${cursor}\nevent: share\ndata: ${JSON.stringify(notice)}\n\n`);
              }
              continue;
            }
            const data = {
              streamEventId: event.streamEventId,
              type: event.type,
              ...event.payload,
            };
            input.response.write(
              `id: ${event.streamEventId}\nevent: execution\ndata: ${JSON.stringify(data)}\n\n`,
            );
          }
          continue;
        }
        if (Date.now() - lastHeartbeat >= 15_000) {
          lastHeartbeat = Date.now();
          input.response.write(": heartbeat\n\n");
        }
        await delay(100, undefined, { ref: false });
      }
    } finally {
      cleanup();
    }
  }
}
