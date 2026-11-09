import type {
  ConversationActiveReply,
  MessageDetail,
  MessageSegmentRecord,
} from "../domain/conversation.js";
import type {
  ListMessagesResult,
  SubmitMessageInput,
  SubmitMessageResult,
} from "../storage/role-store.js";
import { ConversationStore } from "../storage/conversation-store.js";
import { RoleAccess } from "./role-access.js";

export interface MessagePageResult extends ListMessagesResult {
  segments: MessageSegmentRecord[];
  activeReply: ConversationActiveReply | null;
  /** 与本次读取同一快照边界的 SSE 游标。 */
  cursor: number;
}

export class MessageService {
  constructor(private readonly access: RoleAccess) {}

  submit(
    roleId: string,
    windowId: string,
    input: SubmitMessageInput,
  ): SubmitMessageResult {
    return this.access.withStore(roleId, (storage) =>
      storage.business.submitMessage(roleId, windowId, input),
    );
  }

  list(
    roleId: string,
    windowId: string,
    after: number | null,
    limit: number,
    before: number | null = null,
  ): MessagePageResult {
    return this.access.withStore(roleId, (storage) => {
      const db = storage.business.db;
      // 消息、句段、未完成回复与游标在同一读事务内取得，避免快照与 SSE 之间漏事件。
      return db.transaction(() => {
        const page = storage.business.listMessagePage(roleId, windowId, {
          after,
          before,
          limit,
        });
        const store = new ConversationStore(db, roleId);
        return {
          ...page,
          segments: store.listMessageSegmentsForMessages(
            windowId,
            page.items.map((message) => message.messageId),
          ),
          activeReply: store.getActiveReply(windowId),
          cursor: store.latestEventId(windowId),
        };
      })();
    });
  }

  get(roleId: string, windowId: string, messageId: string): MessageDetail {
    return this.access.withStore(roleId, (storage) =>
      new ConversationStore(
        storage.business.db,
        roleId,
      ).getMessageDetail(windowId, messageId),
    );
  }
}
