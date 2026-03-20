import clsx from 'clsx';
import React, { useMemo, useState } from 'react';
import { PiArrowsClockwise, PiCheckCircle, PiWarningCircle } from 'react-icons/pi';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useEnv } from '@/context/EnvContext';
import { DEFAULT_AI_SETTINGS } from '@/services/ai/constants';
import { getAIProvider } from '@/services/ai/providers';
import type { AIProviderName, AISettings } from '@/services/ai/types';

type ConnectionStatus = 'idle' | 'testing' | 'success' | 'error';

const AIPanel: React.FC = () => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const { settings, setSettings, saveSettings } = useSettingsStore();
  const aiSettings = useMemo(() => settings.aiSettings ?? DEFAULT_AI_SETTINGS, [settings.aiSettings]);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('idle');
  const [connectionMessage, setConnectionMessage] = useState('');

  const updateAiSettings = async (partial: Partial<AISettings>) => {
    const nextSettings = { ...settings, aiSettings: { ...aiSettings, ...partial } };
    setSettings(nextSettings);
    await saveSettings(envConfig, nextSettings);
  };

  const fetchOllamaModels = async () => {
    const baseUrl = aiSettings.ollamaBaseUrl.trim().replace(/\/+$/, '');
    if (!baseUrl) {
      setOllamaModels([]);
      return;
    }

    setFetchingModels(true);
    try {
      const response = await fetch(`${baseUrl}/api/tags`);
      if (!response.ok) throw new Error('Failed to fetch Ollama models');
      const json = await response.json();
      const models = Array.isArray(json?.models)
        ? json.models.map((item: { name?: string }) => item.name).filter(Boolean)
        : [];
      setOllamaModels(models);
    } catch {
      setOllamaModels([]);
    } finally {
      setFetchingModels(false);
    }
  };

  const handleProviderChange = async (provider: AIProviderName) => {
    await updateAiSettings({ provider });
    setConnectionStatus('idle');
    setConnectionMessage('');
  };

  const handleTestConnection = async () => {
    setConnectionStatus('testing');
    setConnectionMessage('');
    try {
      const ok = await getAIProvider(aiSettings).healthCheck();
      setConnectionStatus(ok ? 'success' : 'error');
      setConnectionMessage(
        ok
          ? _('Connection successful')
          : aiSettings.provider === 'ollama'
            ? _('Unable to connect to Ollama')
            : _('Unable to connect to the AI provider'),
      );
    } catch (error) {
      setConnectionStatus('error');
      setConnectionMessage((error as Error).message || _('Connection failed'));
    }
  };

  const disabledSection = !aiSettings.enabled ? 'opacity-50 pointer-events-none select-none' : '';

  return (
    <div className='my-4 w-full space-y-6'>
      <div className='w-full'>
        <h2 className='mb-2 font-medium'>{_('Ask AI')}</h2>
        <div className='card border-base-200 bg-base-100 border shadow'>
          <div className='divide-base-200 divide-y'>
            <div className='config-item'>
              <span>{_('Enable Ask AI')}</span>
              <input
                type='checkbox'
                className='toggle'
                checked={aiSettings.enabled}
                onChange={() => void updateAiSettings({ enabled: !aiSettings.enabled })}
              />
            </div>
          </div>
        </div>
      </div>

      <div className={clsx('w-full', disabledSection)}>
        <h2 className='mb-2 font-medium'>{_('Provider')}</h2>
        <div className='card border-base-200 bg-base-100 border shadow'>
          <div className='divide-base-200 divide-y'>
            <div className='config-item'>
              <span>{_('Ollama')}</span>
              <input
                type='radio'
                className='radio'
                name='ask-ai-provider'
                checked={aiSettings.provider === 'ollama'}
                onChange={() => void handleProviderChange('ollama')}
              />
            </div>
            <div className='config-item'>
              <span>{_('OpenAI Compatible')}</span>
              <input
                type='radio'
                className='radio'
                name='ask-ai-provider'
                checked={aiSettings.provider === 'openai-compatible'}
                onChange={() => void handleProviderChange('openai-compatible')}
              />
            </div>
          </div>
        </div>
      </div>

      {aiSettings.provider === 'ollama' && (
        <div className={clsx('w-full', disabledSection)}>
          <h2 className='mb-2 font-medium'>{_('Ollama Configuration')}</h2>
          <div className='card border-base-200 bg-base-100 border shadow'>
            <div className='divide-base-200 divide-y'>
              <div className='config-item !h-auto flex-col !items-start gap-2 py-3'>
                <div className='flex w-full items-center justify-between'>
                  <span>{_('Server URL')}</span>
                  <button
                    className='btn btn-ghost btn-xs'
                    onClick={() => void fetchOllamaModels()}
                    disabled={fetchingModels}
                    title={_('Refresh Models')}
                  >
                    <PiArrowsClockwise className='size-4' />
                  </button>
                </div>
                <input
                  type='text'
                  className='input input-bordered input-sm w-full'
                  value={aiSettings.ollamaBaseUrl}
                  onChange={(e) => void updateAiSettings({ ollamaBaseUrl: e.target.value })}
                  placeholder='http://127.0.0.1:11434'
                />
              </div>
              <div className='config-item !h-auto flex-col !items-start gap-2 py-3'>
                <span>{_('Model')}</span>
                {ollamaModels.length > 0 ? (
                  <select
                    className='select select-bordered select-sm w-full'
                    value={aiSettings.ollamaModel}
                    onChange={(e) => void updateAiSettings({ ollamaModel: e.target.value })}
                  >
                    {ollamaModels.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type='text'
                    className='input input-bordered input-sm w-full'
                    value={aiSettings.ollamaModel}
                    onChange={(e) => void updateAiSettings({ ollamaModel: e.target.value })}
                    placeholder='llama3.2'
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {aiSettings.provider === 'openai-compatible' && (
        <div className={clsx('w-full', disabledSection)}>
          <h2 className='mb-2 font-medium'>{_('OpenAI Compatible Configuration')}</h2>
          <div className='card border-base-200 bg-base-100 border shadow'>
            <div className='divide-base-200 divide-y'>
              <div className='config-item !h-auto flex-col !items-start gap-2 py-3'>
                <span>{_('Base URL')}</span>
                <input
                  type='text'
                  className='input input-bordered input-sm w-full'
                  value={aiSettings.openaiBaseUrl}
                  onChange={(e) => void updateAiSettings({ openaiBaseUrl: e.target.value })}
                  placeholder='https://api.openai.com/v1'
                />
              </div>
              <div className='config-item !h-auto flex-col !items-start gap-2 py-3'>
                <span>{_('API Key')}</span>
                <input
                  type='password'
                  className='input input-bordered input-sm w-full'
                  value={aiSettings.openaiApiKey || ''}
                  onChange={(e) => void updateAiSettings({ openaiApiKey: e.target.value })}
                  autoComplete='off'
                />
              </div>
              <div className='config-item !h-auto flex-col !items-start gap-2 py-3'>
                <span>{_('Model')}</span>
                <input
                  type='text'
                  className='input input-bordered input-sm w-full'
                  value={aiSettings.openaiModel}
                  onChange={(e) => void updateAiSettings({ openaiModel: e.target.value })}
                  placeholder='gpt-4o-mini'
                />
              </div>
            </div>
          </div>
        </div>
      )}

      <div className={clsx('w-full', disabledSection)}>
        <div className='flex items-center gap-3'>
          <button className='btn btn-sm' onClick={() => void handleTestConnection()}>
            {_('Test Connection')}
          </button>
          {connectionStatus === 'success' && (
            <span className='text-success flex items-center gap-1 text-sm'>
              <PiCheckCircle className='size-4' />
              {connectionMessage}
            </span>
          )}
          {connectionStatus === 'error' && (
            <span className='text-error flex items-center gap-1 text-sm'>
              <PiWarningCircle className='size-4' />
              {connectionMessage}
            </span>
          )}
          {connectionStatus === 'testing' && (
            <span className='text-base-content/70 text-sm'>{_('Testing...')}</span>
          )}
        </div>
      </div>

      <div className={clsx('w-full', disabledSection)}>
        <h2 className='mb-2 font-medium'>{_('Generation')}</h2>
        <div className='card border-base-200 bg-base-100 border shadow'>
          <div className='divide-base-200 divide-y'>
            <div className='config-item !h-auto flex-col !items-start gap-2 py-3'>
              <span>{_('Thinking Effort')}</span>
              <select
                className='select select-bordered select-sm w-full'
                value={aiSettings.reasoningEffort}
                onChange={(e) =>
                  void updateAiSettings({
                    reasoningEffort: e.target.value as AISettings['reasoningEffort'],
                  })
                }
              >
                <option value='low'>{_('Low')}</option>
                <option value='medium'>{_('Medium')}</option>
                <option value='high'>{_('High')}</option>
              </select>
            </div>

            <div className='config-item !h-auto flex-col !items-start gap-2 py-3'>
              <div className='flex w-full items-center justify-between gap-3'>
                <span>{_('Max Output Tokens')}</span>
                <span className='text-base-content/60 text-xs'>{aiSettings.maxOutputTokens}</span>
              </div>
              <input
                type='range'
                min='256'
                max='4096'
                step='128'
                className='range range-sm w-full'
                value={aiSettings.maxOutputTokens}
                onChange={(e) => void updateAiSettings({ maxOutputTokens: Number(e.target.value) })}
              />
              <div className='text-base-content/60 flex w-full justify-between text-xs'>
                <span>256</span>
                <span>4096</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AIPanel;
