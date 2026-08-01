import type { ChatMessage, ModelUsage } from "./model.js";

export interface ConversationRecord {
  id: string;
  projectId: string;
  providerId: string;
  model: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSummary extends ConversationRecord {
  messageCount: number;
}

export interface StoredMessage extends ChatMessage {
  id: string;
  conversationId: string;
  sessionId: string | null;
  sequence: number;
  createdAt: string;
}

export type GenerationStatus = "running" | "completed" | "cancelled" | "failed";

export interface GenerationRecord {
  id: string;
  conversationId: string;
  providerId: string;
  model: string;
  status: GenerationStatus;
  content: string;
  usage: ModelUsage | null;
  errorCode: string | null;
  savedDocumentPath: string | null;
  savedContentHash: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ChatGenerationResult {
  conversationId: string;
  generationId: string;
  content: string;
  usage: ModelUsage | null;
}
