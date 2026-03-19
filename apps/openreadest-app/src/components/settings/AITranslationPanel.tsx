import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useEnv } from '@/context/EnvContext';
import { eventDispatcher } from '@/utils/event';
import { debounce } from '@/utils/debounce';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isTauriAppPlatform } from '@/services/environment';
import { AITranslationSettings } from '@/types/settings';
import { DEFAULT_AI_TRANSLATION_SETTINGS } from '@/services/constants';

interface AITranslationPanelProps {
  bookKey?: string;
}

type ModelOption = {
  id: string;
  name: string;
};

const DEFAULT_PROMPT_HINT =
  'You are a professional translator. Translate the following text from {{sourceLang}} to {{targetLang}}. ' +
  'Only output the translated text, without any explanation or extra content. ' +
  'Preserve the original formatting, line breaks, and paragraph structure.';

const parseModels = (value: string): ModelOption[] => {
  if (!value || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.entries(parsed).map(([id, cfg]) => {
      let name = id;
      if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
        const rawName = (cfg as { name?: unknown }).name;
        if (typeof rawName === 'string' && rawName.trim()) {
          name = rawName;
        }
      }
      return { id, name };
    });
  } catch {
    return [];
  }
};

const AITranslationPanel: React.FC<AITranslationPanelProps> = () => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const { settings, setSettings, saveSettings } = useSettingsStore();
  const aiTranslation = settings.aiTranslation;

  const legacyApiUrl = (aiTranslation as { apiUrl?: string }).apiUrl;
  const initialBaseUrl =
    aiTranslation.baseUrl || legacyApiUrl || DEFAULT_AI_TRANSLATION_SETTINGS.baseUrl;

  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [apiKey, setApiKey] = useState(aiTranslation.apiKey);
  const [model, setModel] = useState(aiTranslation.model);
  const [modelsJson, setModelsJson] = useState(aiTranslation.models || '');
  const [systemPrompt, setSystemPrompt] = useState(aiTranslation.systemPrompt);
  const [isTesting, setIsTesting] = useState(false);

  const modelOptions = useMemo(() => parseModels(modelsJson), [modelsJson]);

  useEffect(() => {
    const currentLegacyApiUrl = (aiTranslation as { apiUrl?: string }).apiUrl;
    const nextBaseUrl =
      aiTranslation.baseUrl || currentLegacyApiUrl || DEFAULT_AI_TRANSLATION_SETTINGS.baseUrl;
    setBaseUrl(nextBaseUrl);
    setApiKey(aiTranslation.apiKey);
    setModel(aiTranslation.model);
    setModelsJson(aiTranslation.models || '');
    setSystemPrompt(aiTranslation.systemPrompt);
  }, [aiTranslation]);

  const updateSettings = useCallback(
    (partial: Partial<AITranslationSettings>) => {
      const newAiTranslation = { ...settings.aiTranslation, ...partial };
      const newSettings = { ...settings, aiTranslation: newAiTranslation };
      setSettings(newSettings);
      saveSettings(envConfig, newSettings);
    },
    [settings, setSettings, saveSettings, envConfig],
  );

  const debouncedUpdateSettings = useCallback(
    debounce((partial: Partial<AITranslationSettings>) => {
      updateSettings(partial);
    }, 500),
    [updateSettings],
  );

  useEffect(() => {
    if (!modelOptions.length) return;
    const hasModel = modelOptions.some((option) => option.id === model);
    if (!hasModel) {
      const first = modelOptions[0]?.id;
      if (first) {
        setModel(first);
        debouncedUpdateSettings({ model: first });
      }
    }
  }, [modelOptions, model, debouncedUpdateSettings]);

  const handleToggle = () => {
    updateSettings({ enabled: !aiTranslation.enabled });
  };

  const handleBaseUrlChange = (value: string) => {
    setBaseUrl(value);
    debouncedUpdateSettings({ baseUrl: value.trim() });
  };

  const handleApiKeyChange = (value: string) => {
    setApiKey(value);
    debouncedUpdateSettings({ apiKey: value });
  };

  const handleModelChange = (value: string) => {
    setModel(value);
    debouncedUpdateSettings({ model: value });
  };

  const handleModelsChange = (value: string) => {
    setModelsJson(value);
    debouncedUpdateSettings({ models: value });
  };

  const handleSystemPromptChange = (value: string) => {
    setSystemPrompt(value);
    debouncedUpdateSettings({ systemPrompt: value });
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    try {
      const payload = {
        model,
        messages: [
          { role: 'system', content: 'You are a translator.' },
          { role: 'user', content: 'Translate "hello" to Chinese.' },
        ],
        max_tokens: 50,
      };

      const response = isTauriAppPlatform()
        ? await tauriFetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(payload),
          })
        : await fetch('/api/ai/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messages: payload.messages,
              system: 'You are a translator.',
              apiKey,
              model,
              baseUrl,
            }),
          });

      if (response.ok) {
        eventDispatcher.dispatch('toast', {
          message: _('Connection successful!'),
          type: 'info',
        });
      } else {
        const errorText = await response.text().catch(() => response.statusText);
        eventDispatcher.dispatch('toast', {
          message: `${_('Connection failed')}: ${response.status} ${errorText}`,
          type: 'error',
        });
      }
    } catch (error) {
      eventDispatcher.dispatch('toast', {
        message: `${_('Connection failed')}: ${(error as Error).message}`,
        type: 'error',
      });
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className='my-4 w-full space-y-4'>
      <div className='flex h-14 items-center justify-between'>
        <span className='text-base-content/80 font-medium'>{_('AI Translation')}</span>
        <input
          type='checkbox'
          className='toggle'
          checked={aiTranslation.enabled}
          onChange={handleToggle}
        />
      </div>

      {aiTranslation.enabled && (
        <>
          <div className='form-control w-full'>
            <label className='label py-1'>
              <span className='label-text font-medium'>{_('Base URL')}</span>
            </label>
            <input
              type='text'
              placeholder='https://api.openai.com/v1'
              className='input input-bordered h-12 w-full text-sm focus:outline-none focus:ring-0'
              spellCheck='false'
              value={baseUrl}
              onChange={(e) => handleBaseUrlChange(e.target.value)}
            />
            <label className='label py-1'>
              <span className='label-text-alt text-base-content/50'>
                {_('Base URL must include /v1.')}
              </span>
            </label>
          </div>

          <div className='form-control w-full'>
            <label className='label py-1'>
              <span className='label-text font-medium'>{_('API Key')}</span>
            </label>
            <input
              type='password'
              placeholder={_('Enter your API key')}
              className='input input-bordered h-12 w-full text-sm focus:outline-none focus:ring-0'
              value={apiKey}
              onChange={(e) => handleApiKeyChange(e.target.value)}
              autoComplete='off'
            />
          </div>

          <div className='form-control w-full'>
            <label className='label py-1'>
              <span className='label-text font-medium'>{_('Models')}</span>
            </label>
            <textarea
              className='textarea textarea-bordered h-28 w-full text-sm leading-relaxed focus:outline-none focus:ring-0'
              placeholder='{
  "gpt-4o-mini": { "name": "GPT-4o Mini" }
}'
              spellCheck='false'
              value={modelsJson}
              onChange={(e) => handleModelsChange(e.target.value)}
            />
          </div>

          <div className='form-control w-full'>
            <label className='label py-1'>
              <span className='label-text font-medium'>{_('Model')}</span>
            </label>
            {modelOptions.length > 0 ? (
              <select
                className='select select-bordered h-12 w-full text-sm focus:outline-none focus:ring-0'
                value={model}
                onChange={(e) => handleModelChange(e.target.value)}
              >
                {modelOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type='text'
                placeholder={_('e.g. gpt-4o-mini')}
                className='input input-bordered h-12 w-full text-sm focus:outline-none focus:ring-0'
                spellCheck='false'
                value={model}
                onChange={(e) => handleModelChange(e.target.value)}
              />
            )}
          </div>

          <div className='form-control w-full'>
            <label className='label py-1'>
              <span className='label-text font-medium'>{_('System Prompt')}</span>
            </label>
            <textarea
              className='textarea textarea-bordered h-28 w-full text-sm leading-relaxed focus:outline-none focus:ring-0'
              placeholder={DEFAULT_PROMPT_HINT}
              spellCheck='false'
              value={systemPrompt}
              onChange={(e) => handleSystemPromptChange(e.target.value)}
            />
            <label className='label py-1'>
              <span className='label-text-alt text-base-content/50'>
                {_('Use {{sourceLang}} and {{targetLang}} as placeholders for languages.')}
              </span>
            </label>
          </div>

          <button
            className='btn btn-primary mt-2 h-12 min-h-12 w-full'
            onClick={handleTestConnection}
            disabled={isTesting || !baseUrl || !apiKey || !model}
          >
            {isTesting ? <span className='loading loading-spinner'></span> : _('Test Connection')}
          </button>
        </>
      )}
    </div>
  );
};

export default AITranslationPanel;
