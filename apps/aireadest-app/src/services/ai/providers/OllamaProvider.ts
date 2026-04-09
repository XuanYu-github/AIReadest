import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isTauriAppPlatform } from '@/services/environment';
import type { AIProvider, AISettings, AIChatMessage, AIChatOptions } from '../types';

const flattenContent = (content: AIChatMessage['content']) => {
  if (typeof content === 'string') return content;
  return content
    .filter((part): part is Extract<(typeof content)[number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
};

const buildDirectMessages = (messages: AIChatMessage[], system?: string) => {
  const payload = system ? [{ role: 'system' as const, content: system }, ...messages] : messages;
  return payload.map((message) => ({ role: message.role, content: flattenContent(message.content) }));
};

export class OllamaProvider implements AIProvider {
  id = 'ollama' as const;
  name = 'Ollama';
  requiresAuth = false;

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
          baseUrl: this.settings.ollamaBaseUrl,
          model: this.settings.ollamaModel,
          maxOutputTokens: options?.maxOutputTokens,
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
      `${this.settings.ollamaBaseUrl.replace(/\/+$/, '')}/api/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.settings.ollamaModel,
          stream: false,
          messages: buildDirectMessages(messages, options?.system),
          options: options?.maxOutputTokens ? { num_predict: options.maxOutputTokens } : undefined,
        }),
      },
    );

    const json = await response.json();
    const content = json?.message?.content;
    if (!response.ok || !content) throw new Error(json?.error || 'AI request failed');
    return String(content).trim();
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.settings.ollamaBaseUrl.replace(/\/+$/, '')}/api/tags`);
      if (!response.ok) return false;
      const json = await response.json();
      return Array.isArray(json?.models);
    } catch {
      return false;
    }
  }
}
