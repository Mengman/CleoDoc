import { z } from "zod";

import type { SessionRepository } from "../../../database/src/index.js";
import {
  compactionEvent,
  toolSuccess,
  type Tool,
  type ToolExecutionContext,
  type ToolOutcome,
} from "./tool-contract.js";
import { HISTORY_ERRORS } from "./tool-errors.js";

const updatedAtSchema = z.iso.datetime();

const searchConversationHistoryInputSchema = z
  .object({
    query: z.string().trim().min(1).max(1_000),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .strict();
type SearchConversationHistoryInput = z.infer<typeof searchConversationHistoryInputSchema>;

const searchConversationHistoryOutputSchema = z
  .object({
    results: z.array(
      z
        .object({
          messageId: z.string(),
          role: z.enum(["user", "assistant"]),
          createdAt: updatedAtSchema,
          excerpt: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
type SearchConversationHistoryOutput = z.infer<typeof searchConversationHistoryOutputSchema>;

const readConversationMessageInputSchema = z
  .object({
    messageId: z.string().min(1),
    offset: z.number().int().nonnegative().default(0),
    maxCharacters: z.number().int().min(1).max(20_000).default(10_000),
  })
  .strict();
type ReadConversationMessageInput = z.infer<typeof readConversationMessageInputSchema>;

const readConversationMessageOutputSchema = z
  .object({
    message: z
      .object({
        messageId: z.string(),
        role: z.enum(["user", "assistant"]),
        createdAt: updatedAtSchema,
        content: z.string(),
        offset: z.number().int().nonnegative(),
        truncated: z.boolean(),
        nextOffset: z.number().int().nonnegative().nullable(),
        totalCharacters: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
type ReadConversationMessageOutput = z.infer<typeof readConversationMessageOutputSchema>;

export class SearchConversationHistoryTool implements Tool<
  SearchConversationHistoryInput,
  SearchConversationHistoryOutput
> {
  readonly name = "search_conversation_history";
  readonly version = 1;
  readonly description =
    "仅在累计摘要缺少完成任务所需的精确细节时，按关键字搜索当前 Conversation 中已关闭的用户和主笔历史消息；返回简短命中摘要。";
  readonly exposure = "summary";
  readonly approval = "auto";
  readonly errors = HISTORY_ERRORS;
  readonly inputSchema = searchConversationHistoryInputSchema;
  readonly outputSchema = searchConversationHistoryOutputSchema;

  constructor(private readonly repository: SessionRepository) {}

  async execute(
    input: SearchConversationHistoryInput,
    context: ToolExecutionContext,
  ): Promise<ToolOutcome<SearchConversationHistoryOutput>> {
    return toolSuccess({
      results: this.repository.searchClosedHistory({
        conversationId: context.conversationId,
        query: input.query,
        limit: input.limit,
      }),
    });
  }

  getCompactionMessage(
    _input: SearchConversationHistoryInput,
    outcome: ToolOutcome<SearchConversationHistoryOutput>,
  ): string {
    return compactionEvent(this, outcome, {
      ...(outcome.ok ? { resultCount: outcome.data.results.length } : {}),
    });
  }
}

export class ReadConversationMessageTool implements Tool<
  ReadConversationMessageInput,
  ReadConversationMessageOutput
> {
  readonly name = "read_conversation_message";
  readonly version = 1;
  readonly description =
    "根据 search_conversation_history 返回的 messageId，分段读取一条不可变历史消息。不得读取其他 Conversation、当前活动 Session 或 Reasoning。";
  readonly exposure = "summary";
  readonly approval = "auto";
  readonly errors = HISTORY_ERRORS;
  readonly inputSchema = readConversationMessageInputSchema;
  readonly outputSchema = readConversationMessageOutputSchema;

  constructor(private readonly repository: SessionRepository) {}

  async execute(
    input: ReadConversationMessageInput,
    context: ToolExecutionContext,
  ): Promise<ToolOutcome<ReadConversationMessageOutput>> {
    const message = this.repository.readClosedMessage({
      conversationId: context.conversationId,
      messageId: input.messageId,
    });
    const content = message.content.slice(input.offset, input.offset + input.maxCharacters);
    const nextOffset = input.offset + content.length;
    return toolSuccess({
      message: {
        messageId: message.id,
        role: message.role === "user" ? "user" : "assistant",
        createdAt: message.createdAt,
        content,
        offset: input.offset,
        truncated: nextOffset < message.content.length,
        nextOffset: nextOffset < message.content.length ? nextOffset : null,
        totalCharacters: message.content.length,
      },
    });
  }

  getCompactionMessage(
    _input: ReadConversationMessageInput,
    outcome: ToolOutcome<ReadConversationMessageOutput>,
  ): string {
    return compactionEvent(this, outcome, {
      ...(outcome.ok
        ? {
            readCharacters: outcome.data.message.content.length,
            truncated: outcome.data.message.truncated,
          }
        : {}),
    });
  }
}
