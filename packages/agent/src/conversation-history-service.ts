import type {
  ConversationRecord,
  ConversationSummary,
  StoredMessage,
} from "../../contracts/src/index.js";
import { AppError } from "../../contracts/src/index.js";
import { ConversationRepository, type ProjectDatabase } from "../../database/src/index.js";

export interface ConversationHistoryResult {
  readonly conversation: ConversationRecord;
  readonly messages: readonly StoredMessage[];
}

export class ConversationHistoryService {
  private readonly repository: ConversationRepository;

  constructor(
    database: ProjectDatabase,
    private readonly projectId: string,
  ) {
    this.repository = new ConversationRepository(database);
  }

  listConversations(): ConversationSummary[] {
    return this.repository.listConversations(this.projectId);
  }

  getConversation(conversationId: string): ConversationRecord {
    // Return one conversation only after enforcing current-project ownership.
    const conversation = this.repository.getConversation(conversationId);
    if (conversation === null || conversation.projectId !== this.projectId) {
      throw new AppError("VALIDATION_ERROR", "指定的对话不属于当前项目。");
    }
    return conversation;
  }

  getRecentHistory(conversationId: string, limit = 20): ConversationHistoryResult {
    // Validate project ownership before returning a bounded visible history.
    const conversation = this.getConversation(conversationId);
    return {
      conversation,
      messages: this.repository.getRecentVisibleMessages(conversationId, limit),
    };
  }
}
