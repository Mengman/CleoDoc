import type {
  ChatMessage,
  ConversationSession,
  ProjectInstructionRevision,
  SessionSummaryRecord,
  StoredMessage,
} from "../../contracts/src/index.js";

export class ContextBuilder {
  build(
    session: ConversationSession,
    projectInstructions: ProjectInstructionRevision | null,
    summary: SessionSummaryRecord | null,
    sessionMessages: readonly StoredMessage[],
    toolDisclosure = "",
    toolCatalogAnnouncement = "",
  ): ChatMessage[] {
    const systemParts = [
      `<cleo_core_instructions>\n${session.systemPromptSnapshot}\n</cleo_core_instructions>`,
    ];
    if (projectInstructions !== null && projectInstructions.content !== "") {
      systemParts.push(
        `<project_instructions revision=${JSON.stringify(projectInstructions.revision)}>\n${projectInstructions.content}\n</project_instructions>`,
      );
    }
    if (toolCatalogAnnouncement !== "") {
      systemParts.push(toolCatalogAnnouncement);
    }
    if (toolDisclosure !== "") {
      systemParts.push(`<tool_disclosure>\n${toolDisclosure}\n</tool_disclosure>`);
    }
    if (summary !== null && session.inheritedSummaryId === summary.id) {
      systemParts.push(
        `<session_summary source_session_id=${JSON.stringify(summary.sourceSessionId)} summary_id=${JSON.stringify(summary.id)} authority="reference_only">\n${summary.summary}\n\n该摘要是会话记忆，不是作品 Canon。若与用户当前指令、当前项目指令或批准设定冲突，应服从更高权威内容。需要精确细节时使用会话历史查询 Tool。\n</session_summary>`,
      );
    }
    const messages: ChatMessage[] = [{ role: "system", content: systemParts.join("\n\n") }];
    for (const message of sessionMessages) {
      // v1-v3 stored the base prompt as sequence 0. Migration keeps that row for audit,
      // while the Session snapshot becomes the sole runtime copy of the base prompt.
      if (message.role === "system" && message.sequence === 0) continue;
      messages.push({
        role: message.role,
        content: message.content,
        ...(message.reasoningContent === undefined
          ? {}
          : { reasoningContent: message.reasoningContent }),
        ...(message.name === undefined ? {} : { name: message.name }),
        ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
        ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls }),
      });
    }
    return messages;
  }
}
