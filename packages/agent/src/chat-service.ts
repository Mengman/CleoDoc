import type {
  ChatGenerationResult,
  ConversationSummary,
  ConversationSession,
  ContextBudgetStatus,
  CompactionEvent,
  ModelEvent,
  ModelProvider,
  ModelRequest,
  ModelToolCall,
  ModelToolDefinition,
  ModelUsage,
  ProjectInstructionRevision,
  SavedDocument,
  StoredMessage,
} from "../../contracts/src/index.js";
import { AppError, asAppError } from "../../contracts/src/index.js";
import {
  ConversationRepository,
  ModelCallRepository,
  ProjectInstructionRepository,
  ProjectDatabase,
  SessionRepository,
} from "../../database/src/index.js";
import { DocumentService } from "../../project/src/index.js";
import { ProjectToolRuntime, type ToolApprovalHandler } from "./tool/index.js";
import { CompactionService } from "./compaction-service.js";
import {
  ContextBudgetService,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  createContextBudgetPolicy,
  estimateTokens,
} from "./context-budget.js";
import { ContextBuilder } from "./context-builder.js";
import { emitLlmDebugEvent, type LlmDebugHandler } from "./debug-events.js";

export const DEFAULT_SYSTEM_PROMPT = `你是 CleoDoc 的中文小说主笔。你与用户讨论创作委托，给出完整、可保存的中文内容。明确区分用户决定、已知资料与创作假设。

你可以使用项目工具列出、分段读取和写入 manuscript 中的 Markdown 文档。只有在确实需要项目内容时才读取；不要声称读取了未通过工具获得的资料。当用户明确要求“保存、写入、记录到项目”时，应调用 write_project_document，而不是只在聊天中展示内容。写入会由 CleoDoc 请求用户确认，拒绝后不得绕过。不得覆盖已有文档，除非用户明确要求覆盖并再次批准。

项目指令是跨对话生效的项目级长期规则。需要查看或修改时使用项目指令工具；修改前必须先读取当前 Revision。追加、局部替换和全量替换都会展示 Diff 并要求用户批准，拒绝后不得绕过。

只有累计摘要缺少完成当前任务所需的精确细节时，才使用会话历史查询工具。不得为了全面了解而批量读取全部历史。`;

const MAX_TOOL_ROUNDS = 8;

export interface SendMessageInput {
  conversationId?: string;
  projectId: string;
  provider: ModelProvider;
  model: string;
  prompt: string;
  signal: AbortSignal;
  onEvent?: (event: ModelEvent) => void;
  approveToolCall?: ToolApprovalHandler;
  contextWindowTokens?: number;
  onDebugEvent?: LlmDebugHandler;
}

export class ChatService {
  private readonly repository: ConversationRepository;
  private readonly sessions: SessionRepository;
  private readonly modelCalls: ModelCallRepository;
  private readonly projectInstructions: ProjectInstructionRepository;
  private readonly documents: DocumentService;
  private readonly toolApprovalsUntilExit = new Set<string>();
  private readonly contextBuilder = new ContextBuilder();
  private readonly budgetService = new ContextBudgetService();

  private constructor(
    private readonly projectRoot: string,
    private readonly database: ProjectDatabase,
  ) {
    this.repository = new ConversationRepository(database);
    this.sessions = new SessionRepository(database);
    this.modelCalls = new ModelCallRepository(database);
    this.projectInstructions = new ProjectInstructionRepository(database);
    this.documents = new DocumentService(projectRoot);
  }

  static async open(projectRoot: string): Promise<ChatService> {
    const service = new ChatService(projectRoot, await ProjectDatabase.open(projectRoot));
    await service.sessions.recoverInterruptedJobs();
    await service.modelCalls.recoverInterruptedCalls();
    return service;
  }

  async send(input: SendMessageInput): Promise<ChatGenerationResult> {
    const conversation =
      input.conversationId === undefined
        ? await this.repository.createConversation({
            projectId: input.projectId,
            providerId: input.provider.id,
            model: input.model,
            title: input.prompt.slice(0, 80),
          })
        : this.repository.getConversation(input.conversationId);
    if (conversation === null) {
      throw new AppError("VALIDATION_ERROR", "指定的对话不存在。");
    }
    if (conversation.providerId !== input.provider.id || conversation.model !== input.model) {
      throw new AppError("VALIDATION_ERROR", "恢复对话时不能静默切换 Provider 或模型。");
    }
    if (conversation.projectId !== input.projectId) {
      throw new AppError("VALIDATION_ERROR", "对话不属于当前项目。");
    }

    const session = await this.sessions.createInitialSession({
      conversationId: conversation.id,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
    });
    if (session.status === "compacting") {
      throw new AppError("VALIDATION_ERROR", "正在进行上下文压缩，完成后再提交消息。");
    }

    await this.repository.addMessage(
      conversation.id,
      { role: "user", content: input.prompt },
      session.id,
    );
    const generation = await this.repository.beginGeneration({
      conversationId: conversation.id,
      providerId: input.provider.id,
      model: input.model,
    });
    let streamedContent = "";
    let usage: ModelUsage | undefined;
    const tools = new ProjectToolRuntime(this.projectRoot, {
      approve: input.approveToolCall,
      approvedUntilExit: this.toolApprovalsUntilExit,
      history: { repository: this.sessions, conversationId: conversation.id },
      projectInstructions: this.projectInstructions,
      toolStateMessages: this.repository.getToolMessages(conversation.id, "get_tool"),
    });

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        const messages = this.contextBuilder.build(
          session,
          this.projectInstructions.getCurrent(),
          this.sessions.getInheritedSummary(session),
          this.sessions.getSessionMessages(session.id),
          tools.disclosurePrompt,
        );
        let roundContent = "";
        let roundReasoning = "";
        const toolCalls: ModelToolCall[] = [];
        let roundUsage: ModelUsage | undefined;
        let finishReason: string | null = null;
        const modelRequest: ModelRequest = {
          model: input.model,
          messages,
          tools: tools.definitions,
          ...(input.onDebugEvent === undefined
            ? {}
            : {
                onProtocolEvent: (protocol) =>
                  emitLlmDebugEvent(input.onDebugEvent, {
                    type: "llm-protocol",
                    operation: "agent",
                    round: round + 1,
                    providerId: input.provider.id,
                    model: input.model,
                    protocol,
                  }),
              }),
        };
        const estimatedContextTokens = estimateTokens(
          JSON.stringify(modelRequestForBudget(modelRequest)),
        );
        const modelCall = await this.modelCalls.beginGenerationCall({
          generationId: generation.id,
          ordinal: round + 1,
          providerId: input.provider.id,
          model: input.model,
          requestOptions: describeModelRequest(modelRequest),
        });

        try {
          for await (const event of input.provider.stream(modelRequest, input.signal)) {
            if (event.type === "reasoning-delta") {
              roundReasoning += event.text;
            } else if (event.type === "text-delta") {
              roundContent += event.text;
              streamedContent += event.text;
            } else if (event.type === "usage") {
              usage = mergeUsage(usage, event.usage);
              roundUsage = mergeUsage(roundUsage, event.usage);
            } else if (event.type === "tool-call") {
              toolCalls.push(event.call);
            } else if (event.type === "done") {
              finishReason = event.finishReason ?? null;
            }
            input.onEvent?.(event);
          }
        } catch (error) {
          const appError = asAppError(error);
          await this.modelCalls.finish({
            modelCallId: modelCall.id,
            status: input.signal.aborted ? "cancelled" : "failed",
            errorCode: appError.code,
            ...(roundUsage === undefined ? {} : { usage: roundUsage }),
          });
          emitLlmDebugEvent(input.onDebugEvent, {
            type: "llm-response-error",
            operation: "agent",
            round: round + 1,
            providerId: input.provider.id,
            model: input.model,
            errorCode: appError.code,
            message: appError.message,
            details: appError.details ?? null,
          });
          throw appError;
        }
        await this.modelCalls.finish({
          modelCallId: modelCall.id,
          status: "completed",
          finishReason,
          ...(roundUsage === undefined ? {} : { usage: roundUsage }),
        });
        emitLlmDebugEvent(input.onDebugEvent, {
          type: "llm-response",
          operation: "agent",
          round: round + 1,
          providerId: input.provider.id,
          model: input.model,
          contextTokens: roundUsage?.inputTokens ?? estimatedContextTokens,
          contextSource: roundUsage?.inputTokens === undefined ? "estimated" : "provider",
          estimatedContextTokens,
          outputTokens: roundUsage?.outputTokens ?? null,
          reasoningTokens: roundUsage?.reasoningTokens ?? null,
          totalTokens: roundUsage?.totalTokens ?? null,
          finishReason,
        });

        if (toolCalls.length > 0) {
          await this.repository.addMessage(
            conversation.id,
            {
              role: "assistant",
              content: roundContent,
              ...(roundReasoning === "" ? {} : { reasoningContent: roundReasoning }),
              toolCalls,
            },
            session.id,
            modelCall.id,
          );
          for (const call of toolCalls) {
            const result = await tools.execute(call);
            const toolResponseError = parseToolResponseError(result);
            if (
              toolResponseError !== null &&
              ["INVALID_TOOL_INPUT", "TOOL_NOT_FOUND"].includes(toolResponseError.code)
            ) {
              emitLlmDebugEvent(input.onDebugEvent, {
                type: "llm-response-error",
                operation: "agent",
                round: round + 1,
                providerId: input.provider.id,
                model: input.model,
                errorCode: toolResponseError.code,
                message: toolResponseError.message,
                details: {
                  responseStage: "tool_call_validation",
                  toolName: call.name,
                  toolCallId: call.id,
                },
              });
            }
            await this.repository.addMessage(
              conversation.id,
              { role: "tool", name: call.name, toolCallId: call.id, content: result },
              session.id,
            );
          }
          continue;
        }

        if (roundContent.trim() === "") {
          const emptyResponseError = new AppError(
            "PROVIDER_UNAVAILABLE",
            "模型没有生成可保存的文本内容。",
            { details: { responseStage: "agent_output_validation" } },
          );
          emitLlmDebugEvent(input.onDebugEvent, {
            type: "llm-response-error",
            operation: "agent",
            round: round + 1,
            providerId: input.provider.id,
            model: input.model,
            errorCode: emptyResponseError.code,
            message: emptyResponseError.message,
            details: emptyResponseError.details ?? null,
          });
          throw emptyResponseError;
        }
        await this.repository.finishGeneration({
          generationId: generation.id,
          status: "completed",
          content: roundContent,
          ...(usage === undefined ? {} : { usage }),
          addAssistantMessage: true,
          sessionId: session.id,
          ...(roundReasoning === "" ? {} : { reasoningContent: roundReasoning }),
          modelCallId: modelCall.id,
        });
        const status = this.getContextStatus(
          conversation.id,
          input.contextWindowTokens,
          tools.definitions,
          "",
          tools.disclosurePrompt,
        );
        await this.sessions.updateBudget(
          session.id,
          status.estimatedInputTokens,
          usage?.inputTokens ?? null,
          status.softLimitReached,
        );
        return {
          conversationId: conversation.id,
          generationId: generation.id,
          content: roundContent,
          usage: usage ?? null,
        };
      }
      throw new AppError("PROVIDER_UNAVAILABLE", `模型连续调用工具超过 ${MAX_TOOL_ROUNDS} 轮。`);
    } catch (error) {
      const appError = asAppError(error);
      await this.repository.finishGeneration({
        generationId: generation.id,
        status: appError.code === "GENERATION_CANCELLED" ? "cancelled" : "failed",
        content: streamedContent,
        ...(usage === undefined ? {} : { usage }),
        errorCode: appError.code,
      });
      throw new AppError(appError.code, appError.message, {
        cause: appError,
        details: {
          ...appError.details,
          conversationId: conversation.id,
          generationId: generation.id,
        },
      });
    }
  }

  getLatestConversation(
    projectId: string,
    providerId: string,
    model: string,
  ): ConversationSummary | null {
    return this.repository.getLatestConversation({ projectId, providerId, model });
  }

  listConversations(projectId: string): ConversationSummary[] {
    return this.repository.listConversations(projectId);
  }

  getConversationHistory(conversationId: string): StoredMessage[] {
    const conversation = this.repository.getConversation(conversationId);
    if (conversation === null) {
      throw new AppError("VALIDATION_ERROR", "指定的对话不存在。");
    }
    return this.repository.getMessages(conversationId);
  }

  getSessions(conversationId: string): ConversationSession[] {
    this.assertConversation(conversationId);
    return this.sessions.listSessions(conversationId);
  }

  getSessionDetails(conversationId: string, ordinal: number) {
    this.assertConversation(conversationId);
    const session = this.sessions
      .listSessions(conversationId)
      .find((item) => item.ordinal === ordinal);
    if (session === undefined)
      throw new AppError("VALIDATION_ERROR", "找不到指定的 Session 序号。");
    const messages = this.sessions.getSessionMessages(session.id);
    return {
      session,
      messageCount: messages.length,
      firstMessageId: messages[0]?.id ?? null,
      lastMessageId: messages.at(-1)?.id ?? null,
      summary: this.sessions.getSummaryForSourceSession(session.id),
    };
  }

  getProjectInstructions(): ProjectInstructionRevision | null {
    return this.projectInstructions.getCurrent();
  }

  listProjectInstructionHistory(limit = 50): ProjectInstructionRevision[] {
    return this.projectInstructions.list(limit);
  }

  async restoreProjectInstructions(
    revision: number,
    expectedRevision: number,
  ): Promise<ProjectInstructionRevision> {
    return this.projectInstructions.restore(revision, expectedRevision);
  }

  getContextStatus(
    conversationId: string,
    contextWindowTokens?: number,
    toolDefinitions?: readonly ModelToolDefinition[],
    draft = "",
    toolDisclosure?: string,
  ): ContextBudgetStatus {
    this.assertConversation(conversationId);
    const session = this.sessions.getCurrentSession(conversationId);
    if (session === null) throw new AppError("VALIDATION_ERROR", "当前对话没有可用 Session。");
    const defaultTools =
      toolDefinitions === undefined || toolDisclosure === undefined
        ? new ProjectToolRuntime(this.projectRoot, {
            history: { repository: this.sessions, conversationId },
            projectInstructions: this.projectInstructions,
          })
        : undefined;
    const messages = this.contextBuilder.build(
      session,
      this.projectInstructions.getCurrent(),
      this.sessions.getInheritedSummary(session),
      this.sessions.getSessionMessages(session.id),
      toolDisclosure ?? defaultTools?.disclosurePrompt ?? "",
    );
    return this.budgetService.estimate(
      messages,
      toolDefinitions ?? defaultTools?.definitions ?? [],
      createContextBudgetPolicy(contextWindowTokens),
      draft,
    );
  }

  async compactConversation(input: {
    conversationId: string;
    provider: ModelProvider;
    model: string;
    contextWindowTokens?: number;
    trigger?: "automatic" | "manual";
    signal: AbortSignal;
    onEvent?: (event: CompactionEvent) => void;
    onDebugEvent?: LlmDebugHandler;
  }): Promise<CompactionEvent & { type: "compaction-completed" }> {
    const conversation = this.assertConversation(input.conversationId);
    if (conversation.providerId !== input.provider.id || conversation.model !== input.model) {
      throw new AppError("VALIDATION_ERROR", "压缩不能静默切换 Provider 或模型。");
    }
    const session = this.sessions.getCurrentSession(input.conversationId);
    if (session === null || session.status !== "active") {
      throw new AppError("VALIDATION_ERROR", "当前 Session 不可压缩或压缩已在进行中。");
    }
    const tools = new ProjectToolRuntime(this.projectRoot, {
      history: { repository: this.sessions, conversationId: input.conversationId },
      projectInstructions: this.projectInstructions,
    });
    return new CompactionService(this.sessions, this.modelCalls, (messages) =>
      tools.projectToolEventsForCompaction(messages),
    ).compact({
      conversationId: input.conversationId,
      session,
      provider: input.provider,
      model: input.model,
      contextWindowTokens: input.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
      trigger: input.trigger ?? "manual",
      signal: input.signal,
      ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
      ...(input.onDebugEvent === undefined ? {} : { onDebugEvent: input.onDebugEvent }),
    });
  }

  async saveGeneration(
    relativePath: string,
    options: { generationId?: string; overwrite?: boolean } = {},
  ): Promise<SavedDocument> {
    const generation =
      options.generationId === undefined
        ? this.repository.getLastCompletedGeneration()
        : this.repository.getGeneration(options.generationId);
    if (generation === null || generation.status !== "completed") {
      throw new AppError("GENERATION_NOT_FOUND", "没有可保存的完整生成结果。");
    }
    const saved = await this.documents.save(relativePath, generation.content, options.overwrite);
    await this.repository.markGenerationSaved(generation.id, saved.relativePath, saved.contentHash);
    return saved;
  }

  async readDocumentIntoConversation(conversationId: string, idOrPath: string): Promise<void> {
    const document = await this.documents.read(idOrPath);
    const session = this.sessions.getCurrentSession(conversationId);
    if (session === null || session.status !== "active") {
      throw new AppError("VALIDATION_ERROR", "当前 Session 不可写入上下文。");
    }
    await this.repository.addMessage(
      conversationId,
      {
        role: "system",
        content: `用户明确读取了项目文档 ${document.summary.relativePath}：\n\n${document.content}`,
      },
      session.id,
    );
  }

  async close(): Promise<void> {
    await this.database.close();
  }

  private assertConversation(conversationId: string) {
    const conversation = this.repository.getConversation(conversationId);
    if (conversation === null) throw new AppError("VALIDATION_ERROR", "指定的对话不存在。");
    return conversation;
  }
}

function describeModelRequest(request: ModelRequest): Readonly<Record<string, unknown>> {
  return {
    thinking: request.thinking?.type ?? "provider_default",
    reasoningEffort: "provider_default",
    temperature: request.temperature ?? null,
    maxTokens: request.maxTokens ?? null,
    responseFormat: request.responseFormat ?? null,
    toolsEnabled: (request.tools?.length ?? 0) > 0,
    toolCount: request.tools?.length ?? 0,
    toolNames: request.tools?.map((tool) => tool.name) ?? [],
    toolVersions: request.tools?.map((tool) => ({ name: tool.name, version: tool.version })) ?? [],
  };
}

function modelRequestForBudget(request: ModelRequest): Record<string, unknown> {
  return {
    model: request.model,
    messages: request.messages.map((message) => {
      const { reasoningContent, ...base } = message;
      return message.role === "assistant" && message.toolCalls !== undefined
        ? { ...base, ...(reasoningContent === undefined ? {} : { reasoningContent }) }
        : base;
    }),
    tools: request.tools,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
    responseFormat: request.responseFormat,
    thinking: request.thinking,
  };
}

function mergeUsage(current: ModelUsage | undefined, next: ModelUsage): ModelUsage {
  return {
    inputTokens: mergeTokenCount(current?.inputTokens, next.inputTokens),
    outputTokens: mergeTokenCount(current?.outputTokens, next.outputTokens),
    reasoningTokens: mergeTokenCount(current?.reasoningTokens, next.reasoningTokens),
    totalTokens: mergeTokenCount(current?.totalTokens, next.totalTokens),
  };
}

function parseToolResponseError(result: string): { code: string; message: string } | null {
  try {
    const parsed = JSON.parse(result) as {
      ok?: boolean;
      error?: { code?: unknown; message?: unknown };
    };
    return parsed.ok === false &&
      typeof parsed.error?.code === "string" &&
      typeof parsed.error.message === "string"
      ? { code: parsed.error.code, message: parsed.error.message }
      : null;
  } catch {
    return null;
  }
}

function mergeTokenCount(
  current: number | undefined,
  next: number | undefined,
): number | undefined {
  return current === undefined && next === undefined ? undefined : (current ?? 0) + (next ?? 0);
}
