export type AIProviderName = 'ollama' | 'openai-compatible';

export interface AISettings {
  enabled: boolean;
  provider: AIProviderName;
  ollamaBaseUrl: string;
  ollamaModel: string;
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
}

export interface AIConversation {
  id: string;
  bookHash: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface AIMessageAttachment {
  name: string;
  dataUrl: string;
  mediaType: string;
}

export interface AIMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: AIMessageAttachment[];
  createdAt: number;
}

export type AIChatMessagePart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string; mediaType?: string };

export interface AIChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | AIChatMessagePart[];
}

export interface AIChatOptions {
  system?: string;
  maxOutputTokens?: number;
}

export interface AIProvider {
  id: AIProviderName;
  name: string;
  requiresAuth: boolean;
  chat(messages: AIChatMessage[], options?: AIChatOptions): Promise<string>;
  healthCheck(): Promise<boolean>;
}
