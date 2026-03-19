import { stubTranslation as _ } from '@/utils/misc';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isTauriAppPlatform } from '@/services/environment';
import { TranslationProvider } from '../types';
import { useSettingsStore } from '@/store/settingsStore';
import { DEFAULT_AI_TRANSLATION_SETTINGS, TRANSLATOR_LANGS } from '@/services/constants';

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

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

async function translateSingle(
  text: string,
  systemPrompt: string,
  baseUrl: string,
  model: string,
  apiKey: string,
): Promise<string> {
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text },
    ],
    temperature: 0.3,
  };

  if (!isTauriAppPlatform()) {
    const response = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: body.messages,
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

  const endpoint = `${baseUrl}/chat/completions`;
  const response = await tauriFetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`AI translation failed with status ${response.status}: ${response.statusText}`);
  }

  let data: ChatCompletionResponse;
  try {
    data = (await response.json()) as ChatCompletionResponse;
  } catch {
    throw new Error('Invalid response from AI translation service');
  }
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Invalid response from AI translation service');
  }
  return content.trim();
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
