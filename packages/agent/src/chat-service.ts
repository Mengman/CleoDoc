import type {
  ChatGenerationResult,
  ConversationSummary,
  ModelEvent,
  ModelProvider,
  ModelToolCall,
  ModelUsage,
  SavedDocument,
  StoredMessage,
} from "../../contracts/src/index.js";
import { AppError, asAppError } from "../../contracts/src/index.js";
import { ConversationRepository, ProjectDatabase } from "../../database/src/index.js";
import { DocumentService } from "../../project/src/index.js";
import { ProjectToolRuntime, type ToolApprovalHandler } from "./project-tools.js";

const DEFAULT_SYSTEM_PROMPT = `你是 CleoDoc 的中文小说主笔。你与用户讨论创作委托，给出完整、可保存的中文内容。明确区分用户决定、已知资料与创作假设。

你可以使用项目工具列出、分段读取和写入 manuscript 中的 Markdown 文档。只有在确实需要项目内容时才读取；不要声称读取了未通过工具获得的资料。当用户明确要求“保存、写入、记录到项目”时，应调用 write_project_document，而不是只在聊天中展示内容。写入会由 CleoDoc 请求用户确认，拒绝后不得绕过。不得覆盖已有文档，除非用户明确要求覆盖并再次批准。`;

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
}

export class ChatService {
  private readonly repository: ConversationRepository;
  private readonly documents: DocumentService;

  private constructor(
    private readonly projectRoot: string,
    private readonly database: ProjectDatabase,
  ) {
    this.repository = new ConversationRepository(database);
    this.documents = new DocumentService(projectRoot);
  }

  static async open(projectRoot: string): Promise<ChatService> {
    return new ChatService(projectRoot, await ProjectDatabase.open(projectRoot));
  }

  async send(input: SendMessageInput): Promise<ChatGenerationResult> {
    const conversation =
      input.conversationId === undefined
        ? await this.repository.createConversation({
            projectId: input.projectId,
            providerId: input.provider.id,
            model: input.model,
            systemPrompt: DEFAULT_SYSTEM_PROMPT,
            title: input.prompt.slice(0, 80),
          })
        : this.repository.getConversation(input.conversationId);
    if (conversation === null) {
      throw new AppError("VALIDATION_ERROR", "指定的对话不存在。");
    }
    if (conversation.providerId !== input.provider.id || conversation.model !== input.model) {
      throw new AppError("VALIDATION_ERROR", "恢复对话时不能静默切换 Provider 或模型。");
    }

    await this.repository.addMessage(conversation.id, { role: "user", content: input.prompt });
    const generation = await this.repository.beginGeneration({
      conversationId: conversation.id,
      providerId: input.provider.id,
      model: input.model,
    });
    let streamedContent = "";
    let usage: ModelUsage | undefined;
    const tools = new ProjectToolRuntime(this.projectRoot, { approve: input.approveToolCall });

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        const messages = this.repository.getMessages(conversation.id);
        let roundContent = "";
        const toolCalls: ModelToolCall[] = [];

        for await (const event of input.provider.stream(
          { model: input.model, messages, tools: tools.definitions },
          input.signal,
        )) {
          if (event.type === "text-delta") {
            roundContent += event.text;
            streamedContent += event.text;
          } else if (event.type === "usage") {
            usage = mergeUsage(usage, event.usage);
          } else if (event.type === "tool-call") {
            toolCalls.push(event.call);
          }
          input.onEvent?.(event);
        }

        if (toolCalls.length > 0) {
          await this.repository.addMessage(conversation.id, {
            role: "assistant",
            content: roundContent,
            toolCalls,
          });
          for (const call of toolCalls) {
            const result = await tools.execute(call);
            await this.repository.addMessage(conversation.id, {
              role: "tool",
              name: call.name,
              toolCallId: call.id,
              content: result,
            });
          }
          continue;
        }

        if (roundContent.trim() === "") {
          throw new AppError("PROVIDER_UNAVAILABLE", "模型没有生成可保存的文本内容。");
        }
        await this.repository.finishGeneration({
          generationId: generation.id,
          status: "completed",
          content: roundContent,
          ...(usage === undefined ? {} : { usage }),
          addAssistantMessage: true,
        });
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
    await this.repository.addMessage(conversationId, {
      role: "system",
      content: `用户明确读取了项目文档 ${document.summary.relativePath}：\n\n${document.content}`,
    });
  }

  async close(): Promise<void> {
    await this.database.close();
  }
}

function mergeUsage(current: ModelUsage | undefined, next: ModelUsage): ModelUsage {
  return {
    inputTokens: mergeTokenCount(current?.inputTokens, next.inputTokens),
    outputTokens: mergeTokenCount(current?.outputTokens, next.outputTokens),
    totalTokens: mergeTokenCount(current?.totalTokens, next.totalTokens),
  };
}

function mergeTokenCount(
  current: number | undefined,
  next: number | undefined,
): number | undefined {
  return current === undefined && next === undefined ? undefined : (current ?? 0) + (next ?? 0);
}
