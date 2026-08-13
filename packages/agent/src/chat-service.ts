import type {
  ChatGenerationResult,
  ConversationRecord,
  ConversationSummary,
  ConversationSession,
  ContextBudgetStatus,
  ContextBudgetPolicy,
  CompactionEvent,
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
import type { KnowledgeToolService } from "../../knowledge/src/index.js";
import { ProjectToolCatalog, ProjectToolRuntime } from "./tool/index.js";
import {
  DEFAULT_SYSTEM_PROMPT,
  describeModelRequest,
  mergeUsage,
  modelRequestForBudget,
  parseToolResponseError,
  type SendMessageInput,
} from "./chat-request.js";
import { CompactionService } from "./compaction-service.js";
import { ContextBudgetService, estimateTokens } from "./context-budget.js";
import { ContextBuilder } from "./context-builder.js";
import { emitLlmDebugEvent, type LlmDebugHandler } from "./debug-events.js";

export { DEFAULT_SYSTEM_PROMPT } from "./chat-request.js";
export type { SendMessageInput } from "./chat-request.js";

export interface ChatServiceOptions {
  database: { busyTimeoutMs: number };
  maxToolRounds: number;
  defaultContextBudgetPolicy?: ContextBudgetPolicy;
  compaction: ConstructorParameters<typeof CompactionService>[2];
}

export interface ChatServiceDependencies {
  readonly knowledge?: KnowledgeToolService;
}

export class ChatService {
  private readonly repository: ConversationRepository;
  private readonly sessions: SessionRepository;
  private readonly modelCalls: ModelCallRepository;
  private readonly projectInstructions: ProjectInstructionRepository;
  private readonly documents: DocumentService;
  private readonly toolCatalog: ProjectToolCatalog;
  private readonly toolRuntimes = new Map<string, ProjectToolRuntime>();
  private readonly contextBuilder = new ContextBuilder();
  private readonly budgetService = new ContextBudgetService();

  private constructor(
    private readonly projectRoot: string,
    private readonly database: ProjectDatabase,
    private readonly options: ChatServiceOptions,
    dependencies: ChatServiceDependencies,
    private readonly ownsDatabase = true,
  ) {
    this.repository = new ConversationRepository(database);
    this.sessions = new SessionRepository(database);
    this.modelCalls = new ModelCallRepository(database);
    this.projectInstructions = new ProjectInstructionRepository(database);
    this.documents = new DocumentService(projectRoot);
    this.toolCatalog = ProjectToolCatalog.create({
      documents: this.documents,
      projectInstructions: this.projectInstructions,
      history: this.sessions,
      ...(dependencies.knowledge === undefined ? {} : { knowledge: dependencies.knowledge }),
    });
  }

  static async open(
    projectRoot: string,
    options: ChatServiceOptions,
    dependencies: ChatServiceDependencies = {},
  ): Promise<ChatService> {
    const service = new ChatService(
      projectRoot,
      await ProjectDatabase.open(projectRoot, options.database),
      options,
      dependencies,
    );
    await service.sessions.recoverInterruptedJobs();
    await service.modelCalls.recoverInterruptedCalls();
    return service;
  }

  static async usingDatabase(
    projectRoot: string,
    database: ProjectDatabase,
    options: ChatServiceOptions,
    dependencies: ChatServiceDependencies = {},
  ): Promise<ChatService> {
    // Attach chat behavior to an already-open project database without taking ownership of it.
    const service = new ChatService(projectRoot, database, options, dependencies, false);
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
    const tools = this.getToolRuntime(conversation);

    try {
      for (let round = 0; round < this.options.maxToolRounds; round += 1) {
        const toolInfo = tools.toolInfo;
        const messages = this.contextBuilder.build(
          session,
          this.projectInstructions.getCurrent(),
          this.sessions.getInheritedSummary(session),
          this.sessions.getSessionMessages(session.id),
        );
        let roundContent = "";
        let roundReasoning = "";
        const toolCalls: ModelToolCall[] = [];
        let roundUsage: ModelUsage | undefined;
        let finishReason: string | null = null;
        const modelRequest: ModelRequest = {
          model: input.model,
          messages,
          tools: toolInfo.definitions,
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

        if (toolCalls.length === 0 && roundContent.trim() === "") {
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
            const result = await tools.execute(call, input.approveToolCall);
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
          this.resolveContextBudgetPolicy(input.contextBudgetPolicy),
          tools.toolInfo.definitions,
          "",
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
      throw new AppError(
        "PROVIDER_UNAVAILABLE",
        `模型连续调用工具超过 ${this.options.maxToolRounds} 轮。`,
      );
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
    contextBudgetPolicy?: ContextBudgetPolicy,
    toolDefinitions?: readonly ModelToolDefinition[],
    draft = "",
  ): ContextBudgetStatus {
    const conversation = this.assertConversation(conversationId);
    const session = this.sessions.getCurrentSession(conversationId);
    if (session === null) throw new AppError("VALIDATION_ERROR", "当前对话没有可用 Session。");
    const defaultTools =
      toolDefinitions === undefined ? this.getToolRuntime(conversation).toolInfo : undefined;
    const messages = this.contextBuilder.build(
      session,
      this.projectInstructions.getCurrent(),
      this.sessions.getInheritedSummary(session),
      this.sessions.getSessionMessages(session.id),
    );
    return this.budgetService.estimate(
      messages,
      toolDefinitions ?? defaultTools?.definitions ?? [],
      this.resolveContextBudgetPolicy(contextBudgetPolicy),
      draft,
    );
  }

  async compactConversation(input: {
    conversationId: string;
    provider: ModelProvider;
    model: string;
    contextBudgetPolicy?: ContextBudgetPolicy;
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
    const tools = this.getToolRuntime(conversation);
    return new CompactionService(
      this.sessions,
      this.modelCalls,
      this.options.compaction,
      (messages) => tools.projectToolEventsForCompaction(messages),
    ).compact({
      conversationId: input.conversationId,
      session,
      provider: input.provider,
      model: input.model,
      contextBudgetPolicy: this.resolveContextBudgetPolicy(input.contextBudgetPolicy),
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
    this.toolRuntimes.clear();
    if (this.ownsDatabase) await this.database.close();
  }

  private getToolRuntime(conversation: ConversationRecord): ProjectToolRuntime {
    const existing = this.toolRuntimes.get(conversation.id);
    if (existing !== undefined) return existing;
    const runtime = new ProjectToolRuntime(
      { projectId: conversation.projectId, conversationId: conversation.id },
      this.toolCatalog,
      {
        toolStateMessages: this.repository.getToolMessages(conversation.id, this.toolCatalog.name),
      },
    );
    this.toolRuntimes.set(conversation.id, runtime);
    return runtime;
  }

  private resolveContextBudgetPolicy(policy: ContextBudgetPolicy | undefined): ContextBudgetPolicy {
    const resolved = policy ?? this.options.defaultContextBudgetPolicy;
    if (resolved === undefined) {
      throw new AppError("VALIDATION_ERROR", "当前模型缺少上下文能力配置。");
    }
    return resolved;
  }

  private assertConversation(conversationId: string) {
    const conversation = this.repository.getConversation(conversationId);
    if (conversation === null) throw new AppError("VALIDATION_ERROR", "指定的对话不存在。");
    return conversation;
  }
}
