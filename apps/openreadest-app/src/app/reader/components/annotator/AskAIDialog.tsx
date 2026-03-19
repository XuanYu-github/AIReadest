import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LuCopy,
  LuImagePlus,
  LuMessageSquarePlus,
  LuPencil,
  LuScreenShare,
  LuSendHorizontal,
  LuSplit,
  LuTrash2,
  LuX,
} from 'react-icons/lu';
import ModalPortal from '@/components/ModalPortal';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useAIChatStore } from '@/store/aiChatStore';
import { ASK_AI_LOCAL_CONVERSATION_KEY_PREFIX, DEFAULT_AI_SETTINGS } from '@/services/ai/constants';
import { getAIProvider } from '@/services/ai/providers';
import type { AIChatMessage, AIChatMessagePart, AIMessage, AIMessageAttachment } from '@/services/ai/types';
import { eventDispatcher } from '@/utils/event';
import { makeSafeFilename } from '@/utils/misc';
import { useEnv } from '@/context/EnvContext';
import { useFileSelector } from '@/hooks/useFileSelector';
import { isTauriAppPlatform } from '@/services/environment';
import { useDrag } from '@/hooks/useDrag';

interface AskAIDialogProps {
  isOpen: boolean;
  bookKey: string;
  bookHash: string;
  bookTitle: string;
  selectionText: string;
  onClose: () => void;
}

type Attachment = {
  id: string;
  name: string;
  dataUrl: string;
  mediaType: string;
};

const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful reading assistant. Answer clearly, stay grounded in the selected text and attachments when provided, and say when the context is insufficient.';

const DIALOG_SIZE_KEY = 'ask-ai-dialog-size';
const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 680;
const MIN_WIDTH = 460;
const MIN_HEIGHT = 420;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const generateId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

const buildConversationTitle = (question: string, fallback: string) =>
  question.replace(/\s+/g, ' ').trim().slice(0, 40) || fallback;

const mergeQuotedContext = (current: string, next: string) => {
  const normalizedNext = next.trim();
  if (!normalizedNext) return current;
  const normalizedCurrent = current.trim();
  if (!normalizedCurrent) return normalizedNext;
  if (normalizedCurrent === normalizedNext || normalizedCurrent.includes(normalizedNext)) {
    return current;
  }
  return `${current.trimEnd()}\n\n${normalizedNext}`;
};

const fileToDataUrl = async (file: Blob): Promise<string> =>
  await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });

const captureStreamFrame = async (stream: MediaStream): Promise<File> => {
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;

  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error('Failed to read captured screen stream'));
  });

  await video.play();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || window.innerWidth;
  canvas.height = video.videoHeight || window.innerHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Failed to create screenshot canvas');
  context.drawImage(video, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => {
      if (value) resolve(value);
      else reject(new Error('Failed to create screenshot image'));
    }, 'image/png');
  });

  stream.getTracks().forEach((track) => track.stop());
  video.srcObject = null;
  return new File([blob], `screenshot-${Date.now()}.png`, { type: 'image/png' });
};

const toStoredAttachments = (items: Attachment[]): AIMessageAttachment[] =>
  items.map((item) => ({
    name: item.name,
    dataUrl: item.dataUrl,
    mediaType: item.mediaType,
  }));

const buildPayloadMessageFromStoredMessage = (message: AIMessage): AIChatMessage => {
  const parts: AIChatMessagePart[] = [];
  const content = message.content.trim();
  if (content) parts.push({ type: 'text', text: content });
  message.attachments?.forEach((attachment) => {
    parts.push({
      type: 'image',
      image: attachment.dataUrl,
      mediaType: attachment.mediaType,
    });
  });

  return {
    role: message.role,
    content: parts.length === 1 && parts[0]?.type === 'text' ? content : parts,
  };
};

const buildUserDisplayText = (quotedContext: string, question: string, attachments: Attachment[], t: (key: string) => string) => {
  const parts = [quotedContext.trim(), question.trim()].filter(Boolean);
  if (parts.length > 0) return parts.join('\n\n');
  if (attachments.length > 0) return t('Images Attached');
  return '';
};

const buildCurrentUserMessage = (
  quotedContext: string,
  question: string,
  attachments: Attachment[],
  t: (key: string) => string,
): AIChatMessage => {
  const parts: AIChatMessagePart[] = [];
  if (quotedContext.trim()) {
    parts.push({
      type: 'text',
      text: `${t('Selected text')}:\n"""\n${quotedContext.trim()}\n"""`,
    });
  }
  if (question.trim()) {
    parts.push({ type: 'text', text: `${t('Question')}: ${question.trim()}` });
  }
  attachments.forEach((attachment) => {
    parts.push({
      type: 'image',
      image: attachment.dataUrl,
      mediaType: attachment.mediaType,
    });
  });
  if (parts.length === 1 && parts[0]?.type === 'text') {
    return { role: 'user', content: parts[0].text };
  }
  return { role: 'user', content: parts };
};

const buildTranscript = (
  title: string,
  context: string,
  messages: { role: string; content: string }[],
) => {
  const lines = [`# ${title}`];
  if (context.trim()) lines.push('', '## Selected Text', '', context.trim());
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
  const { selectFiles } = useFileSelector(appService, _);
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
    updateMessage,
    deleteMessage,
    deleteConversation,
    renameConversation,
    clearActiveConversation,
  } = useAIChatStore();

  const [quotedContext, setQuotedContext] = useState('');
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(false);
  const [branching, setBranching] = useState(false);
  const [error, setError] = useState('');
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [dialogSize, setDialogSize] = useState({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const payloadMessagesRef = useRef<AIChatMessage[]>([]);

  const activeStorageKey = `${ASK_AI_LOCAL_CONVERSATION_KEY_PREFIX}-${bookHash}`;
  const dialogTitle = `${_('Ask AI')}${bookTitle ? ` - ${bookTitle}` : ''}`;

  useEffect(() => {
    if (!selectionText.trim()) return;
    setQuotedContext((prev) => mergeQuotedContext(prev, selectionText));
  }, [selectionText]);

  useEffect(() => {
    payloadMessagesRef.current = messages.map(buildPayloadMessageFromStoredMessage);
  }, [messages]);

  useEffect(() => {
    if (!isOpen) return;
    try {
      const raw = window.localStorage.getItem(DIALOG_SIZE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { width?: number; height?: number };
      if (parsed.width && parsed.height) {
        setDialogSize({
          width: clamp(parsed.width, MIN_WIDTH, window.innerWidth - 24),
          height: clamp(parsed.height, MIN_HEIGHT, window.innerHeight - 32),
        });
      }
    } catch {
      // ignore invalid persisted size
    }
  }, [isOpen]);

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
  }, [
    isOpen,
    bookHash,
    activeStorageKey,
    dialogTitle,
    loadConversations,
    setActiveConversation,
    createConversation,
    clearActiveConversation,
  ]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, loading]);

  useEffect(() => {
    if (!isOpen) return;
    const timeoutId = window.setTimeout(() => {
      textareaRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [isOpen, activeConversationId, editingMessageId]);

  const handleResizeMove = useCallback(
    ({ deltaX, deltaY }: { clientX: number; clientY: number; deltaX: number; deltaY: number }) => {
      setDialogSize((prev) => ({
        width: clamp(prev.width + deltaX, MIN_WIDTH, window.innerWidth - 24),
        height: clamp(prev.height + deltaY, MIN_HEIGHT, window.innerHeight - 24),
      }));
    },
    [],
  );

  const handleResizeKeyDown = useCallback(() => {}, []);

  const handleResizeEnd = useCallback(() => {
    const next = {
      width: Math.round(dialogSize.width),
      height: Math.round(dialogSize.height),
    };
    window.localStorage.setItem(DIALOG_SIZE_KEY, JSON.stringify(next));
  }, [dialogSize.height, dialogSize.width]);

  const { handleDragStart: handleResizeStart } = useDrag(
    handleResizeMove,
    handleResizeKeyDown,
    handleResizeEnd,
  );

  const conversationOptions = useMemo(
    () => conversations.map((item) => ({ value: item.id, label: item.title })),
    [conversations],
  );

  const handleCopyMessage = useCallback(
    async (content: string) => {
      await navigator.clipboard?.writeText(content);
      void eventDispatcher.dispatch('toast', {
        type: 'info',
        message: _('Copied to clipboard'),
        timeout: 1600,
      });
    },
    [_],
  );

  const handleNewConversation = useCallback(async () => {
    const newId = await createConversation(bookHash, dialogTitle);
    window.localStorage.setItem(activeStorageKey, newId);
    setQuotedContext(selectionText.trim());
    setInput('');
    setAttachments([]);
    setEditingMessageId(null);
    setEditingText('');
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
  }, [
    activeConversationId,
    activeStorageKey,
    bookHash,
    createConversation,
    deleteConversation,
    dialogTitle,
    setActiveConversation,
  ]);

  const handleExport = useCallback(async () => {
    const transcript = buildTranscript(dialogTitle, quotedContext, messages);
    await navigator.clipboard?.writeText(transcript);
    const filename = `${makeSafeFilename(dialogTitle || 'Ask-AI')}.md`;
    const saved = await appService?.saveFile(filename, transcript, 'text/markdown');
    void eventDispatcher.dispatch('toast', {
      type: 'info',
      message: saved ? _('Exported successfully') : _('Copied to clipboard'),
      timeout: 2000,
    });
  }, [_, appService, dialogTitle, messages, quotedContext]);

  const requestAssistantResponse = useCallback(
    async (payload: AIChatMessage[]) =>
      await getAIProvider(aiSettings).chat(payload, {
        system: DEFAULT_SYSTEM_PROMPT,
        maxOutputTokens: 1024,
      }),
    [aiSettings],
  );

  const ensureConversation = useCallback(async () => {
    if (activeConversationId) return activeConversationId;
    const fallbackTitle = `${_('Ask AI')}${bookTitle ? ` - ${bookTitle}` : ''}`;
    const newId = await createConversation(bookHash, fallbackTitle);
    window.localStorage.setItem(activeStorageKey, newId);
    return newId;
  }, [_, activeConversationId, activeStorageKey, bookHash, bookTitle, createConversation]);

  const validateBeforeSend = useCallback(() => {
    if (!aiSettings.enabled) {
      setError(_('Please enable Ask AI in Settings first.'));
      return false;
    }
    if (isOpenAICompatible && !aiSettings.openaiApiKey.trim()) {
      setError(_('Please configure your API key in Settings.'));
      return false;
    }
    if (isOpenAICompatible && !aiSettings.openaiBaseUrl.trim()) {
      setError(_('Please configure the Base URL in Settings.'));
      return false;
    }
    if (!isOpenAICompatible && !aiSettings.ollamaBaseUrl.trim()) {
      setError(_('Please configure the Ollama server URL in Settings.'));
      return false;
    }
    return true;
  }, [_, aiSettings, isOpenAICompatible]);

  const handleUploadImage = useCallback(async () => {
    const result = await selectFiles({ type: 'images', multiple: true });
    if (result.error) {
      setError(result.error);
      return;
    }
    const nextAttachments: Attachment[] = [];
    for (const item of result.files) {
      try {
        let file: File | undefined;
        if (item.file) {
          file = item.file;
        } else if (item.path && appService) {
          file = await appService.openFile(item.path, 'None');
        }
        if (!file) continue;
        const dataUrl = await fileToDataUrl(file);
        nextAttachments.push({
          id: generateId(),
          name: file.name || 'image',
          dataUrl,
          mediaType: file.type || 'image/png',
        });
      } catch (uploadError) {
        setError((uploadError as Error).message || _('Unable to load image.'));
      }
    }
    if (nextAttachments.length > 0) {
      setAttachments((prev) => [...prev, ...nextAttachments]);
    }
  }, [_, appService, selectFiles]);

  const handleCaptureScreenshot = useCallback(async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setError(_('Screen capture is not supported in this environment.'));
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 1, max: 2 } },
        audio: false,
      });
      const file = await captureStreamFrame(stream);
      const dataUrl = await fileToDataUrl(file);
      setAttachments((prev) => [
        ...prev,
        {
          id: generateId(),
          name: file.name,
          dataUrl,
          mediaType: file.type || 'image/png',
        },
      ]);
      setError('');
    } catch (captureError) {
      const message = (captureError as Error)?.message || '';
      if (/cancel|denied|dismissed|abort/i.test(message)) return;
      setError(message || _('Unable to capture screenshot.'));
    }
  }, [_]);

  const handlePaste = useCallback(
    async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(event.clipboardData?.items || []);
      const imageItems = items.filter((item) => item.type.startsWith('image/'));
      if (imageItems.length === 0) return;

      event.preventDefault();
      const nextAttachments: Attachment[] = [];
      for (const item of imageItems) {
        const file = item.getAsFile();
        if (!file) continue;
        try {
          const dataUrl = await fileToDataUrl(file);
          nextAttachments.push({
            id: generateId(),
            name: file.name || `clipboard-${Date.now()}.png`,
            dataUrl,
            mediaType: file.type || 'image/png',
          });
        } catch (pasteError) {
          setError((pasteError as Error).message || _('Unable to read pasted image.'));
        }
      }

      if (nextAttachments.length > 0) {
        setAttachments((prev) => [...prev, ...nextAttachments]);
        setError('');
      }
    },
    [_],
  );

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const handleSend = useCallback(async () => {
    const question = input.trim();
    if ((!question && attachments.length === 0) || loading) return;
    if (!validateBeforeSend()) return;

    setLoading(true);
    setError('');

    try {
      const conversationId = await ensureConversation();
      const displayText = buildUserDisplayText(quotedContext, question, attachments, _);
      const payloadMessage = buildCurrentUserMessage(quotedContext, question, attachments, _);

      await addMessage({
        conversationId,
        role: 'user',
        content: displayText,
        attachments: toStoredAttachments(attachments),
      });

      const nextPayload = [...payloadMessagesRef.current, payloadMessage];
      payloadMessagesRef.current = nextPayload;

      const shouldRename = !messages.some((message) => message.role === 'assistant');
      const renameSource = displayText || question || _('Images Attached');
      if (shouldRename) {
        await renameConversation(conversationId, buildConversationTitle(renameSource, dialogTitle));
      }

      setInput('');
      const answer = await requestAssistantResponse(nextPayload);
      await addMessage({ conversationId, role: 'assistant', content: answer });
      payloadMessagesRef.current = [...nextPayload, { role: 'assistant', content: answer }];
      setAttachments([]);
      if (quotedContext) setQuotedContext('');
    } catch (sendError) {
      setError((sendError as Error).message || _('Unable to fetch AI response.'));
    } finally {
      setLoading(false);
    }
  }, [
    _,
    addMessage,
    attachments,
    dialogTitle,
    ensureConversation,
    input,
    loading,
    messages,
    quotedContext,
    renameConversation,
    requestAssistantResponse,
    validateBeforeSend,
  ]);

  const handleBranchConversation = useCallback(
    async (messageId: string) => {
      if (!bookHash || !activeConversationId || messages.length === 0) return;
      const branchUntilIndex = messages.findIndex((message) => message.id === messageId);
      if (branchUntilIndex < 0) return;
      const branchMessages = messages.slice(0, branchUntilIndex + 1);
      const sourceConversation = conversations.find((item) => item.id === activeConversationId);
      const sourceTitle = sourceConversation?.title || dialogTitle;
      setBranching(true);
      setError('');
      try {
        const newId = await createConversation(bookHash, `${sourceTitle} (${_('Branch')})`);
        for (const message of branchMessages) {
          await addMessage({
            conversationId: newId,
            role: message.role,
            content: message.content,
            attachments: message.attachments,
          });
        }
        await setActiveConversation(newId);
        window.localStorage.setItem(activeStorageKey, newId);
      } catch {
        setError(_('Failed to create branch conversation.'));
      } finally {
        setBranching(false);
      }
    },
    [
      _,
      activeConversationId,
      activeStorageKey,
      addMessage,
      bookHash,
      conversations,
      createConversation,
      dialogTitle,
      messages,
      setActiveConversation,
    ],
  );

  const handleStartEditMessage = useCallback((message: AIMessage) => {
    setEditingMessageId(message.id);
    setEditingText(message.content);
  }, []);

  const handleCancelEditMessage = useCallback(() => {
    setEditingMessageId(null);
    setEditingText('');
  }, []);

  const handleSaveEditedMessage = useCallback(async () => {
    if (!editingMessageId || !activeConversationId || loading) return;
    const targetIndex = messages.findIndex((message) => message.id === editingMessageId);
    const targetMessage = targetIndex >= 0 ? messages[targetIndex] : null;
    const nextContent = editingText.trim();
    if (!targetMessage || targetMessage.role !== 'user' || !nextContent) return;

    const remainingMessages = messages
      .slice(0, targetIndex + 1)
      .map((message, index) => (index === targetIndex ? { ...message, content: nextContent } : message));
    const messagesToDelete = messages.slice(targetIndex + 1);
    const nextPayload = remainingMessages.map(buildPayloadMessageFromStoredMessage);

    setLoading(true);
    setError('');
    try {
      await updateMessage(editingMessageId, { content: nextContent });
      if (targetIndex === 0) {
        await renameConversation(activeConversationId, buildConversationTitle(nextContent, dialogTitle));
      }
      for (const message of messagesToDelete) {
        await deleteMessage(message.id);
      }

      const answer = await requestAssistantResponse(nextPayload);
      await addMessage({ conversationId: activeConversationId, role: 'assistant', content: answer });
      payloadMessagesRef.current = [...nextPayload, { role: 'assistant', content: answer }];
      setEditingMessageId(null);
      setEditingText('');
    } catch (saveError) {
      setError((saveError as Error).message || _('Unable to fetch AI response.'));
    } finally {
      setLoading(false);
    }
  }, [
    activeConversationId,
    addMessage,
    deleteMessage,
    dialogTitle,
    editingMessageId,
    editingText,
    loading,
    messages,
    renameConversation,
    requestAssistantResponse,
    updateMessage,
  ]);

  if (!isOpen) return null;

  return (
    <ModalPortal showOverlay={false}>
      <div className='pointer-events-none fixed inset-0 z-[120]'>
        <div
          className='pointer-events-auto absolute right-4 top-14 flex flex-col overflow-hidden rounded-2xl border border-base-300 bg-base-100 shadow-2xl'
          style={{
            width: `min(96vw, ${dialogSize.width}px)`,
            height: `min(82vh, ${dialogSize.height}px)`,
          }}
        >
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
              <div className='mb-2 flex items-start justify-between gap-3'>
                <div className='text-base-content/70 text-xs font-medium uppercase'>{_('Selected text')}</div>
                <button className='btn btn-ghost btn-xs h-7 min-h-7 w-7 p-0' onClick={() => setQuotedContext('')}>
                  <LuX className='size-3' />
                </button>
              </div>
              <div className='max-h-28 overflow-auto whitespace-pre-wrap text-sm leading-6'>{quotedContext}</div>
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

                    {editingMessageId === message.id ? (
                      <div className='space-y-3'>
                        <textarea
                          ref={textareaRef}
                          className='textarea textarea-bordered min-h-24 w-full resize-none'
                          value={editingText}
                          onChange={(e) => setEditingText(e.target.value)}
                        />
                        <div className='flex justify-end gap-2'>
                          <button className='btn btn-ghost btn-xs' onClick={handleCancelEditMessage}>
                            {_('Cancel')}
                          </button>
                          <button
                            className='btn btn-primary btn-xs'
                            onClick={() => void handleSaveEditedMessage()}
                            disabled={loading || !editingText.trim()}
                          >
                            {_('Save & Retry')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className='whitespace-pre-wrap break-words text-sm leading-6'>{message.content}</div>
                        {message.attachments?.length ? (
                          <div className='mt-3 flex gap-3 overflow-x-auto pb-1'>
                            {message.attachments.map((attachment, index) => (
                              <div
                                key={`${message.id}-${attachment.name}-${index}`}
                                className='w-32 shrink-0 overflow-hidden rounded-2xl border border-base-300 bg-base-100'
                              >
                                <img
                                  src={attachment.dataUrl}
                                  alt={attachment.name}
                                  className='h-24 w-full object-cover'
                                />
                                <div className='line-clamp-2 px-2 py-1 text-[11px] opacity-70'>
                                  {attachment.name}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </>
                    )}

                    {editingMessageId !== message.id ? (
                      <div
                        className={
                          message.role === 'user'
                            ? 'mt-2 flex items-center justify-end gap-1'
                            : 'mt-2 flex items-center justify-start gap-1'
                        }
                      >
                        {message.role === 'assistant' ? (
                          <button
                            className='btn btn-ghost btn-xs'
                            onClick={() => void handleBranchConversation(message.id)}
                            disabled={branching || loading}
                          >
                            <LuSplit className='mr-1 size-3' />
                            {_('Branch')}
                          </button>
                        ) : (
                          <button
                            className='btn btn-ghost btn-xs'
                            onClick={() => handleStartEditMessage(message)}
                            disabled={loading}
                          >
                            <LuPencil className='mr-1 size-3' />
                            {_('Edit')}
                          </button>
                        )}
                        <button className='btn btn-ghost btn-xs' onClick={() => void handleCopyMessage(message.content)}>
                          <LuCopy className='mr-1 size-3' />
                          {_('Copy')}
                        </button>
                      </div>
                    ) : null}
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
            {attachments.length > 0 ? (
              <div className='mb-3 flex gap-3 overflow-x-auto pb-1'>
                {attachments.map((attachment) => (
                  <div
                    key={attachment.id}
                    className='relative w-28 shrink-0 overflow-hidden rounded-2xl border border-base-300 bg-base-100'
                  >
                    <img src={attachment.dataUrl} alt={attachment.name} className='h-20 w-full object-cover' />
                    <div className='line-clamp-1 px-2 py-1 text-[11px] opacity-70'>{attachment.name}</div>
                    <button
                      className='btn btn-circle btn-xs absolute right-1 top-1 border-none bg-black/60 text-white'
                      onClick={() => handleRemoveAttachment(attachment.id)}
                    >
                      <LuX className='size-3' />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            {error && <div className='text-error mb-3 text-sm'>{error}</div>}

            <div className='mb-3 flex flex-wrap items-center gap-2'>
              <button className='btn btn-outline btn-sm' onClick={() => void handleUploadImage()}>
                <LuImagePlus className='mr-1 size-4' />
                {_('Upload Image')}
              </button>
              <button className='btn btn-outline btn-sm' onClick={() => void handleCaptureScreenshot()}>
                <LuScreenShare className='mr-1 size-4' />
                {_('Capture Screen')}
              </button>
              <div className='text-base-content/60 text-xs'>
                {isTauriAppPlatform()
                  ? _('You can capture the screen or paste an image from the clipboard.')
                  : _('You can capture the screen or paste an image from the clipboard.')}
              </div>
            </div>

            <div className='flex gap-3'>
              <textarea
                ref={textareaRef}
                className='textarea textarea-bordered min-h-28 flex-1 resize-none'
                placeholder={_('Ask a question about the current selection or the book...')}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onPaste={(e) => {
                  void handlePaste(e);
                }}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
              />
              <div className='flex flex-col justify-end gap-2'>
                <button
                  className='btn btn-primary'
                  onClick={() => void handleSend()}
                  disabled={loading || (!input.trim() && attachments.length === 0)}
                >
                  <LuSendHorizontal className='size-4' />
                  {_('Send')}
                </button>
                <button
                  className='btn btn-ghost btn-sm'
                  onClick={() => setQuotedContext(mergeQuotedContext(quotedContext, selectionText.trim()))}
                  disabled={!selectionText.trim()}
                >
                  {_('Use Selection')}
                </button>
              </div>
            </div>
            <div className='text-base-content/50 mt-2 text-xs'>
              {_('Press Ctrl/Cmd + Enter to send. Paste images into the input box to attach them.')}
            </div>
          </div>

          <div
            className='drag-handle absolute bottom-0 right-0 h-5 w-5 cursor-se-resize opacity-40'
            onMouseDown={handleResizeStart}
          />
        </div>
      </div>
    </ModalPortal>
  );
};

export default AskAIDialog;
