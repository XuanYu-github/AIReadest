import type { AIProvider, AISettings } from '../types';
import { OllamaProvider } from './OllamaProvider';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider';

export { OllamaProvider, OpenAICompatibleProvider };

export const getAIProvider = (settings: AISettings): AIProvider => {
  switch (settings.provider) {
    case 'ollama':
      return new OllamaProvider(settings);
    case 'openai-compatible':
      return new OpenAICompatibleProvider(settings);
    default:
      throw new Error(`Unsupported AI provider: ${String(settings.provider)}`);
  }
};
