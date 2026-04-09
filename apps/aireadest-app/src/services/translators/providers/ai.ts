import { stubTranslation as _ } from '@/utils/misc';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isTauriAppPlatform } from '@/services/environment';
import { TranslationProvider } from '../types';
import { useSettingsStore } from '@/store/settingsStore';
import { DEFAULT_AI_TRANSLATION_SETTINGS, TRANSLATOR_LANGS } from '@/services/constants';

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: string | { message?: string };
};

type ResponsesApiResponse = {
  output_text?: string;
  output?: Array<{
    content?: Array<{ type?: string; text?: string }>;
  }>;
  error?: string | { message?: string };
};

const DEFAULT_SYSTEM_PROMPT =
  'You are a professional translator. Translate the following text from {{sourceLang}} to {{targetLang}}. ' +
  'Only output the translated text, without any explanation or extra content. ' +
  'Preserve the original formatting, line breaks, and paragraph structure.';

function getLanguageDisplayName(langCode: string): string {
  const lowerCode = langCode.toLowerCase();
  const entry = Object.entries(TRANSLATOR_LANGS).find(([code]) => code.toLowerCase() === lowerCode);
  return entry ? entry[1] : langCode;
}

function buildSystemPrompt(customPrompt: string, sourceLang: string, targetLang: string): string {
  const template = customPrompt.trim() || DEFAULT_SYSTEM_PROMPT;
  const sourceName =
    sourceLang === 'AUTO' ? 'the source language' : getLanguageDisplayName(sourceLang);
  const targetName = getLanguageDisplayName(targetLang);
  return template
    .replace(/\{\{sourceLang\}\}/g, sourceName)
    .replace(/\{\{targetLang\}\}/g, targetName);
}

function getSettings() {
  return useSettingsStore.getState().settings.aiTranslation;
}

function isResponsesModel(model: string): boolean {
  return /^gpt-5/i.test(model.trim());
}

function toResponsesInput(systemPrompt: string, text: string) {
  return [
    {
      role: 'system',
      content: [{ type: 'input_text' as const, text: systemPrompt }],
    },
    {
      role: 'user',
      content: [{ type: 'input_text' as const, text }],
    },
  ];
}

function extractResponsesContent(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const parsed = payload as ResponsesApiResponse;
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
}

function extractErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const error = (payload as { error?: unknown }).error;
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
}

function isUnsupportedLegacyProtocolError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('unsupported legacy protocol') ||
    (normalized.includes('/v1/chat/completions') && normalized.includes('not supported')) ||
    (normalized.includes('please use') && normalized.includes('/v1/responses'))
  );
}

async function requestOpenAICompatible({
  baseUrl,
  apiKey,
  model,
  text,
  systemPrompt,
  useResponsesApi,
}: {
  baseUrl: string;
  apiKey: string;
  model: string;
  text: string;
  systemPrompt: string;
  useResponsesApi: boolean;
}) {
  const endpoint = `${baseUrl}${useResponsesApi ? '/responses' : '/chat/completions'}`;
  const payload = useResponsesApi
    ? {
        model,
        input: toResponsesInput(systemPrompt, text),
      }
    : {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text },
        ],
        temperature: 0.3,
      };

  const response = await tauriFetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const rawText = await response.text().catch(() => '');
  let parsed: unknown = null;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = null;
    }
  }

  const content = useResponsesApi
    ? extractResponsesContent(parsed)
    : ((parsed as ChatCompletionResponse | null)?.choices?.[0]?.message?.content || '').trim();

  const parsedError = extractErrorMessage(parsed);
  const errorMessage =
    parsedError ||
    rawText ||
    `AI translation failed with status ${response.status}: ${response.statusText}`;

  return {
    ok: response.ok,
    content,
    errorMessage,
  };
}

async function translateSingle(
  text: string,
  systemPrompt: string,
  baseUrl: string,
  model: string,
  apiKey: string,
): Promise<string> {
  if (!isTauriAppPlatform()) {
    const requestMessages = [{ role: 'user' as const, content: text }];
    const response = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: requestMessages,
        system: systemPrompt,
        apiKey,
        model,
        baseUrl,
      }),
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(
        responseText ||
              `AI translation failed with status ${response.status}: ${response.statusText}`,
      );
    }
    if (!responseText.trim()) {
      throw new Error('Invalid response from AI translation service');
    }
    return responseText.trim();
  }

  const preferredResponsesApi = isResponsesModel(model);
  const firstAttempt = await requestOpenAICompatible({
    baseUrl,
    apiKey,
    model,
    text,
    systemPrompt,
    useResponsesApi: preferredResponsesApi,
  });

  if (firstAttempt.ok && firstAttempt.content) {
    return firstAttempt.content;
  }

  if (
    !preferredResponsesApi &&
    isUnsupportedLegacyProtocolError(firstAttempt.errorMessage)
  ) {
    const fallbackAttempt = await requestOpenAICompatible({
      baseUrl,
      apiKey,
      model,
      text,
      systemPrompt,
      useResponsesApi: true,
    });

    if (fallbackAttempt.ok && fallbackAttempt.content) {
      return fallbackAttempt.content;
    }
    throw new Error(fallbackAttempt.errorMessage || 'Invalid response from AI translation service');
  }

  if (firstAttempt.ok && !firstAttempt.content) {
    throw new Error('Invalid response from AI translation service');
  }

  throw new Error(firstAttempt.errorMessage || 'Invalid response from AI translation service');
}

export const aiProvider: TranslationProvider = {
  name: 'ai',
  label: _('AI Translate'),
  authRequired: false,
  translate: async (texts: string[], sourceLang: string, targetLang: string): Promise<string[]> => {
    if (!texts.length) return [];

    const settings = getSettings();
    if (!settings.apiKey) {
      throw new Error('AI Translation API key is not configured');
    }

    const systemPrompt = buildSystemPrompt(settings.systemPrompt, sourceLang, targetLang);
    const legacyApiUrl = (settings as { apiUrl?: string }).apiUrl;
    const rawBaseUrl = settings.baseUrl || legacyApiUrl || DEFAULT_AI_TRANSLATION_SETTINGS.baseUrl;
    const baseUrl = rawBaseUrl.replace(/\/+$/, '');

    const results: string[] = [...texts];
    const nonEmptyCount = texts.filter((text) => text && text.trim()).length;

    const promises = texts.map(async (text, index) => {
      if (!text || !text.trim()) return;
      try {
        results[index] = await translateSingle(
          text,
          systemPrompt,
          baseUrl,
          settings.model,
          settings.apiKey,
        );
      } catch (err) {
        if (nonEmptyCount === 1) throw err;
        console.error(`AI translation failed for segment ${index}:`, err);
      }
    });

    await Promise.all(promises);
    return results;
  },
};
