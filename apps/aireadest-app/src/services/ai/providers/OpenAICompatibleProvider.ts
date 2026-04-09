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

const toResponsesInput = (messages: AIChatMessage[], system?: string) => {
  const fullMessages = buildDirectMessages(messages, system);
  return fullMessages.map((message) => ({
    role: message.role,
    content:
      typeof message.content === 'string'
        ? [{ type: (message.role === 'assistant' ? 'output_text' : 'input_text') as 'input_text' | 'output_text', text: message.content }]
        : message.content.map((part) =>
            part.type === 'text'
              ? {
                  type: (message.role === 'assistant' ? 'output_text' : 'input_text') as 'input_text' | 'output_text',
                  text: part.text,
                }
              : { type: 'input_image' as const, image_url: part.image },
          ),
  }));
};

const extractResponsesContent = (json: unknown): string => {
  if (!json || typeof json !== 'object') return '';
  const parsed = json as {
    output_text?: string;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  };
  if (typeof parsed.output_text === 'string' && parsed.output_text.trim()) {
    return parsed.output_text.trim();
  }

  return (
    parsed.output
      ?.flatMap((item) => item.content ?? [])
      .filter((item) => item.type === 'output_text' && typeof item.text === 'string')
      .map((item) => item.text?.trim() || '')
      .filter(Boolean)
      .join('\n\n') || ''
  ).trim();
};

const extractChatCompletionsContent = (json: unknown): string => {
  if (!json || typeof json !== 'object') return '';
  const parsed = json as { choices?: Array<{ message?: { content?: string } }> };
  const content = parsed.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content.trim() : '';
};

const extractUpstreamError = (json: unknown): string => {
  if (!json || typeof json !== 'object') return '';
  const error = (json as { error?: unknown }).error;
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      return message;
    }
  }
  return '';
};

const isUnsupportedLegacyProtocolError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('unsupported legacy protocol') ||
    (normalized.includes('/v1/chat/completions') && normalized.includes('not supported')) ||
    (normalized.includes('please use') && normalized.includes('/v1/responses'))
  );
};

const requestOpenAICompatible = async ({
  baseUrl,
  apiKey,
  model,
  messages,
  system,
  maxOutputTokens,
  reasoningEffort,
  useResponsesApi,
}: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: AIChatMessage[];
  system?: string;
  maxOutputTokens?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  useResponsesApi: boolean;
}) => {
  const response = await (isTauriAppPlatform() ? tauriFetch : fetch)(
    `${baseUrl}${useResponsesApi ? '/responses' : '/chat/completions'}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(
        useResponsesApi
          ? {
              model,
              input: toResponsesInput(messages, system),
              max_output_tokens: maxOutputTokens,
              reasoning: reasoningEffort ? { effort: reasoningEffort } : undefined,
            }
          : {
              model,
              messages: buildDirectMessages(messages, system).map((message) => ({
                role: message.role,
                content: toOpenAIContent(message.content),
              })),
              max_tokens: maxOutputTokens,
              reasoning: reasoningEffort ? { effort: reasoningEffort } : undefined,
            },
      ),
    },
  );

  const rawText = await response.text().catch(() => '');
  let parsed: unknown = null;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = null;
    }
  }

  const content = useResponsesApi ? extractResponsesContent(parsed) : extractChatCompletionsContent(parsed);
  const errorMessage =
    extractUpstreamError(parsed) || rawText || `AI request failed: ${response.status}`;

  return {
    ok: response.ok,
    content,
    errorMessage,
  };
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

    const normalizedBaseUrl = this.settings.openaiBaseUrl.replace(/\/+$/, '');
    const useResponsesApi = !!options?.reasoningEffort || /^gpt-5/i.test(this.settings.openaiModel);

    const firstAttempt = await requestOpenAICompatible({
      baseUrl: normalizedBaseUrl,
      apiKey: this.settings.openaiApiKey,
      model: this.settings.openaiModel,
      messages,
      system: options?.system,
      maxOutputTokens: options?.maxOutputTokens,
      reasoningEffort: options?.reasoningEffort,
      useResponsesApi,
    });

    if (firstAttempt.ok && firstAttempt.content) {
      return firstAttempt.content;
    }

    if (!useResponsesApi && isUnsupportedLegacyProtocolError(firstAttempt.errorMessage)) {
      const fallbackAttempt = await requestOpenAICompatible({
        baseUrl: normalizedBaseUrl,
        apiKey: this.settings.openaiApiKey,
        model: this.settings.openaiModel,
        messages,
        system: options?.system,
        maxOutputTokens: options?.maxOutputTokens,
        reasoningEffort: options?.reasoningEffort,
        useResponsesApi: true,
      });

      if (fallbackAttempt.ok && fallbackAttempt.content) {
        return fallbackAttempt.content;
      }
      throw new Error(fallbackAttempt.errorMessage || 'AI request failed');
    }

    if (firstAttempt.ok && !firstAttempt.content) {
      throw new Error('AI request failed');
    }

    throw new Error(firstAttempt.errorMessage || 'AI request failed');
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
