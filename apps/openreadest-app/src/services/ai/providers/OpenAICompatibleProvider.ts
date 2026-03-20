import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isTauriAppPlatform } from '@/services/environment';
import type { AIProvider, AISettings, AIChatMessage, AIChatOptions } from '../types';

const buildDirectMessages = (messages: AIChatMessage[], system?: string) =>
  system ? [{ role: 'system' as const, content: system }, ...messages] : messages;

const toOpenAIContent = (content: AIChatMessage['content']) => {
  if (typeof content === 'string') return content;
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    return { type: 'image_url', image_url: { url: part.image } };
  });
};

export class OpenAICompatibleProvider implements AIProvider {
  id = 'openai-compatible' as const;
  name = 'OpenAI Compatible';
  requiresAuth = true;

  constructor(private settings: AISettings) {}

  async chat(messages: AIChatMessage[], options?: AIChatOptions): Promise<string> {
    if (typeof window !== 'undefined') {
      const response = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: this.id,
          messages,
          system: options?.system,
          apiKey: this.settings.openaiApiKey,
          model: this.settings.openaiModel,
          baseUrl: this.settings.openaiBaseUrl,
          maxOutputTokens: options?.maxOutputTokens,
          reasoningEffort: options?.reasoningEffort,
        }),
      });
      const text = await response.text();
      if (!response.ok) {
        try {
          const parsed = JSON.parse(text) as { error?: string };
          throw new Error(parsed.error || text || 'AI request failed');
        } catch {
          throw new Error(text || 'AI request failed');
        }
      }
      return text.trim();
    }

    const response = await (isTauriAppPlatform() ? tauriFetch : fetch)(
      `${this.settings.openaiBaseUrl.replace(/\/+$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.settings.openaiApiKey}`,
        },
        body: JSON.stringify({
          model: this.settings.openaiModel,
          messages: buildDirectMessages(messages, options?.system).map((message) => ({
            role: message.role,
            content: toOpenAIContent(message.content),
          })),
          max_tokens: options?.maxOutputTokens,
          reasoning: options?.reasoningEffort ? { effort: options.reasoningEffort } : undefined,
        }),
      },
    );

    const json = await response.json();
    const content = json?.choices?.[0]?.message?.content;
    if (!response.ok || !content) {
      throw new Error(json?.error?.message || json?.error || 'AI request failed');
    }
    return String(content).trim();
  }

  async healthCheck(): Promise<boolean> {
    if (!this.settings.openaiApiKey || !this.settings.openaiBaseUrl || !this.settings.openaiModel) {
      return false;
    }
    try {
      await this.chat([{ role: 'user', content: 'ping' }], { maxOutputTokens: 8 });
      return true;
    } catch {
      return false;
    }
  }
}
