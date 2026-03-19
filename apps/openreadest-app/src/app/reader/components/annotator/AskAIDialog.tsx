import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LuMessageSquarePlus, LuSendHorizontal, LuTrash2, LuX } from 'react-icons/lu';
import ModalPortal from '@/components/ModalPortal';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useAIChatStore } from '@/store/aiChatStore';
import { ASK_AI_LOCAL_CONVERSATION_KEY_PREFIX, DEFAULT_AI_SETTINGS } from '@/services/ai/constants';
import { getAIProvider } from '@/services/ai/providers';
import { eventDispatcher } from '@/utils/event';
import { makeSafeFilename } from '@/utils/misc';
import { useEnv } from '@/context/EnvContext';

interface AskAIDialogProps {
  isOpen: boolean;
  bookKey: string;
  bookHash: string;
  bookTitle: string;
  selectionText: string;
  onClose: () => void;
}

const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful reading assistant. Answer clearly, stay grounded in the selected text when provided, and say when the context is insufficient.';

const buildConversationTitle = (question: string, fallback: string) =>
  question.replace(/\s+/g, ' ').trim().slice(0, 40) || fallback;

const buildTranscript = (title: string, context: string, messages: { role: string; content: string }[]) => {
  const lines = [`# ${title}`];
  if (context.trim()) {
    lines.push('', '## Selected Text', '', context.trim());
  }
  lines.push('', '## Conversation', '');
  messages.forEach((message) => {
    lines.push(`### ${message.role === 'user' ? 'User' : 'Assistant'}`, '', message.content, '');
  });
  return lines.join('\n');
};

const AskAIDialog: React.FC<AskAIDialogProps> = ({
  isOpen,
  bookKey,
  bookHash,
  bookTitle,
  selectionText,
  onClose,
}) => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const aiSettings = useSettingsStore((state) => state.settings.aiSettings ?? DEFAULT_AI_SETTINGS);
  const isOpenAICompatible = aiSettings.provider === 'openai-compatible';
  const {
    conversations,
    messages,
    activeConversationId,
    isLoadingHistory,
    loadConversations,
    setActiveConversation,
    createConversation,
    addMessage,
    deleteConversation,
    renameConversation,
    clearActiveConversation,
  } = useAIChatStore();

  const [quotedContext, setQuotedContext] = useState('');
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const activeStorageKey = `${ASK_AI_LOCAL_CONVERSATION_KEY_PREFIX}-${bookHash}`;
  const dialogTitle = `${_('Ask AI')}${bookTitle ? ` - ${bookTitle}` : ''}`;

  useEffect(() => {
    if (!selectionText.trim()) return;
    setQuotedContext((prev) => {
      const next = selectionText.trim();
      if (!prev) return next;
      if (prev.includes(next)) return prev;
      return `${prev}\n\n${next}`;
    });
  }, [selectionText]);

  useEffect(() => {
    if (!isOpen || !bookHash) return;

    const setup = async () => {
      await loadConversations(bookHash);
      const latest = useAIChatStore.getState().conversations;
      const storedId = window.localStorage.getItem(activeStorageKey);
      const target = latest.find((item) => item.id === storedId) || latest[0];
      if (target) {
        await setActiveConversation(target.id);
        window.localStorage.setItem(activeStorageKey, target.id);
        return;
      }
      const newId = await createConversation(bookHash, dialogTitle);
      window.localStorage.setItem(activeStorageKey, newId);
    };

    void setup();

    return () => {
      clearActiveConversation();
    };
  }, [isOpen, bookHash, activeStorageKey, dialogTitle, loadConversations, setActiveConversation, createConversation, clearActiveConversation]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, loading]);

  useEffect(() => {
    if (!isOpen) return;
    const timeoutId = window.setTimeout(() => {
      textareaRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [isOpen, activeConversationId]);

  const conversationOptions = useMemo(
    () => conversations.map((item) => ({ value: item.id, label: item.title })),
    [conversations],
  );

  const handleNewConversation = useCallback(async () => {
    const newId = await createConversation(bookHash, dialogTitle);
    window.localStorage.setItem(activeStorageKey, newId);
    setQuotedContext(selectionText.trim());
    setInput('');
    setError('');
  }, [activeStorageKey, bookHash, createConversation, dialogTitle, selectionText]);

  const handleDeleteConversation = useCallback(async () => {
    if (!activeConversationId) return;
    await deleteConversation(activeConversationId);
    const nextConversations = useAIChatStore.getState().conversations;
    const nextConversation = nextConversations[0];
    if (nextConversation) {
      await setActiveConversation(nextConversation.id);
      window.localStorage.setItem(activeStorageKey, nextConversation.id);
    } else {
      const newId = await createConversation(bookHash, dialogTitle);
      window.localStorage.setItem(activeStorageKey, newId);
    }
  }, [activeConversationId, activeStorageKey, bookHash, createConversation, deleteConversation, dialogTitle, setActiveConversation]);

  const handleExport = useCallback(async () => {
    const transcript = buildTranscript(dialogTitle, quotedContext, messages);
    navigator.clipboard?.writeText(transcript);
    const filename = `${makeSafeFilename(dialogTitle || 'Ask-AI')}.md`;
    const saved = await appService?.saveFile(filename, transcript, 'text/markdown');
    void eventDispatcher.dispatch('toast', {
      type: 'info',
      message: saved ? _('Exported successfully') : _('Copied to clipboard'),
      timeout: 2000,
    });
  }, [_, appService, dialogTitle, messages, quotedContext]);

  const handleSend = useCallback(async () => {
    const question = input.trim();
    if (!question || loading) return;
    if (!aiSettings.enabled) {
      setError(_('Please enable Ask AI in Settings first.'));
      return;
    }
    if (isOpenAICompatible && !aiSettings.openaiApiKey.trim()) {
      setError(_('Please configure your API key in Settings.'));
      return;
    }
    if (isOpenAICompatible && !aiSettings.openaiBaseUrl.trim()) {
      setError(_('Please configure the Base URL in Settings.'));
      return;
    }
    if (!isOpenAICompatible && !aiSettings.ollamaBaseUrl.trim()) {
      setError(_('Please configure the Ollama server URL in Settings.'));
      return;
    }

    setLoading(true);
    setError('');

    try {
      let conversationId = activeConversationId;
      if (!conversationId) {
        conversationId = await createConversation(bookHash, buildConversationTitle(question, dialogTitle));
        window.localStorage.setItem(activeStorageKey, conversationId);
      }

      const userContent = quotedContext.trim()
        ? `${_('Selected text')}:\n"""\n${quotedContext.trim()}\n"""\n\n${_('Question')}: ${question}`
        : question;

      await addMessage({ conversationId, role: 'user', content: userContent });
      if (messages.length === 0) {
        await renameConversation(conversationId, buildConversationTitle(question, dialogTitle));
      }
      setInput('');

      const allMessages = useAIChatStore
        .getState()
        .messages.map((message) => ({ role: message.role, content: message.content }));

      const answer = await getAIProvider(aiSettings).chat(allMessages, {
        system: DEFAULT_SYSTEM_PROMPT,
        maxOutputTokens: 1024,
      });

      await addMessage({ conversationId, role: 'assistant', content: answer });
    } catch (sendError) {
      setError((sendError as Error).message || _('Unable to fetch AI response.'));
    } finally {
      setLoading(false);
    }
  }, [
    _,
    activeConversationId,
    activeStorageKey,
    aiSettings,
    bookHash,
    createConversation,
    input,
    loading,
    dialogTitle,
    quotedContext,
    addMessage,
    messages.length,
    renameConversation,
  ]);

  if (!isOpen) return null;

  return (
    <ModalPortal showOverlay={false}>
      <div className='pointer-events-none fixed inset-0 z-[120]'>
        <div className='pointer-events-auto absolute right-4 top-14 flex h-[min(78vh,680px)] w-[min(96vw,720px)] flex-col overflow-hidden rounded-2xl border border-base-300 bg-base-100 shadow-2xl'>
          <div className='flex items-center gap-3 border-b border-base-300 px-4 py-3'>
            <div className='min-w-0 flex-1'>
              <div className='truncate text-sm font-semibold'>{dialogTitle}</div>
              <div className='text-base-content/60 text-xs'>
                {aiSettings.enabled
                  ? aiSettings.provider === 'ollama'
                    ? `Ollama · ${aiSettings.ollamaModel}`
                    : `OpenAI Compatible · ${aiSettings.openaiModel}`
                  : _('Ask AI is disabled')}
              </div>
            </div>
            <button className='btn btn-ghost btn-sm' onClick={() => void handleNewConversation()}>
              <LuMessageSquarePlus className='size-4' />
            </button>
            <button className='btn btn-ghost btn-sm' onClick={() => void handleDeleteConversation()}>
              <LuTrash2 className='size-4' />
            </button>
            <button className='btn btn-ghost btn-sm' onClick={onClose}>
              <LuX className='size-4' />
            </button>
          </div>

          <div className='flex items-center gap-2 border-b border-base-300 px-4 py-2'>
            <select
              className='select select-bordered select-sm w-full'
              value={activeConversationId ?? ''}
              onChange={(e) => {
                const nextId = e.target.value;
                void setActiveConversation(nextId || null);
                if (nextId) window.localStorage.setItem(activeStorageKey, nextId);
              }}
            >
              {conversationOptions.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
            <button className='btn btn-ghost btn-sm whitespace-nowrap' onClick={() => void handleExport()}>
              {_('Export')}
            </button>
          </div>

          {quotedContext.trim() && (
            <div className='bg-base-200/60 mx-4 mt-4 rounded-xl border border-base-300 px-4 py-3'>
              <div className='text-base-content/70 mb-2 text-xs font-medium uppercase'>
                {_('Selected text')}
              </div>
              <div className='max-h-28 overflow-auto whitespace-pre-wrap text-sm leading-6'>
                {quotedContext}
              </div>
            </div>
          )}

          <div className='min-h-0 flex-1 overflow-auto px-4 py-4'>
            {isLoadingHistory ? (
              <div className='text-base-content/60 text-sm'>{_('Loading history...')}</div>
            ) : messages.length === 0 ? (
              <div className='text-base-content/60 text-sm leading-6'>
                {_('Start a conversation about this book or the selected text.')}
              </div>
            ) : (
              <div className='space-y-3'>
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={
                      message.role === 'user'
                        ? 'ml-10 rounded-2xl bg-base-200 px-4 py-3'
                        : 'mr-10 rounded-2xl border border-base-300 px-4 py-3'
                    }
                  >
                    <div className='text-base-content/60 mb-1 text-xs font-medium'>
                      {message.role === 'user' ? _('You') : _('Assistant')}
                    </div>
                    <div className='whitespace-pre-wrap break-words text-sm leading-6'>
                      {message.content}
                    </div>
                  </div>
                ))}
                {loading && (
                  <div className='mr-10 rounded-2xl border border-base-300 px-4 py-3'>
                    <div className='text-base-content/60 text-sm'>{_('Thinking...')}</div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          <div className='border-t border-base-300 p-4'>
            {error && <div className='text-error mb-3 text-sm'>{error}</div>}
            <div className='flex gap-3'>
              <textarea
                ref={textareaRef}
                className='textarea textarea-bordered min-h-28 flex-1 resize-none'
                placeholder={_('Ask a question about the current selection or the book...')}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
              />
              <div className='flex flex-col justify-end gap-2'>
                <button className='btn btn-primary' onClick={() => void handleSend()} disabled={loading || !input.trim()}>
                  <LuSendHorizontal className='size-4' />
                  {_('Send')}
                </button>
                <button
                  className='btn btn-ghost btn-sm'
                  onClick={() => setQuotedContext(selectionText.trim())}
                  disabled={!selectionText.trim()}
                >
                  {_('Use Selection')}
                </button>
              </div>
            </div>
            <div className='text-base-content/50 mt-2 text-xs'>{_('Press Ctrl/Cmd + Enter to send.')}</div>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
};

export default AskAIDialog;
