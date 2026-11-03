import type {
  ListMessagesResult,
  SubmitMessageInput,
  SubmitMessageResult,
} from "../storage/role-store.js";
import { RoleAccess } from "./role-access.js";

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
    after: number,
    limit: number,
  ): ListMessagesResult {
    return this.access.withStore(roleId, (storage) =>
      storage.business.listMessages(roleId, windowId, after, limit),
    );
  }
}
