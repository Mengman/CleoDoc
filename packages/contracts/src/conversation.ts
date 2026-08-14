import type { ChatMessage, ModelUsage } from "./model.js";

export interface ConversationRecord {
  id: string;
  projectId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSummary extends ConversationRecord {
  messageCount: number;
}

export interface StoredMessage extends ChatMessage {
  messageRowid: number;
  id: string;
  conversationId: string;
  sessionId: string;
  modelCallId: string | null;
  sequence: number;
  createdAt: string;
}

export type ModelCallStatus = "running" | "completed" | "cancelled" | "failed";

export interface ModelCallRecord {
  id: string;
  providerId: string;
  model: string;
  requestOptions: Readonly<Record<string, unknown>>;
  status: ModelCallStatus;
  finishReason: string | null;
  errorCode: string | null;
  usage: ModelUsage | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ChatTurnResult {
  conversationId: string;
  content: string;
  usage: ModelUsage | null;
  userMessage: StoredMessage & { role: "user" };
  assistantMessage: StoredMessage & { role: "assistant" };
}
