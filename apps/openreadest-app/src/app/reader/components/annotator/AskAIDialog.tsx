import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  LuChevronDown,
  LuChevronUp,
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
import { useReaderStore } from '@/store/readerStore';
import {
  getMonitorCaptureGeometry,
  getNativeCaptureGeometry,
  pickScreenshotWindow,
  rankFramesForCapture,
  type CaptureRect,
  type ReaderFrameCaptureInfo,
} from './askAiCapture';

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

type CaptureDebugPreview = {
  label: string;
  dataUrl: string;
};

type CaptureSelectionRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful reading assistant. Answer clearly, stay grounded in the selected text and attachments when provided, and say when the context is insufficient.';

const DIALOG_SIZE_KEY = 'ask-ai-dialog-size';
const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 680;
const MIN_WIDTH = 460;
const MIN_HEIGHT = 420;
const MAX_WIDTH = 960;
const MAX_HEIGHT = 860;
const RESIZE_HANDLE_SIZE = 18;
const EDGE_RESIZE_THICKNESS = 10;

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

const loadImageElement = async (dataUrl: string) =>
  await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to load screenshot image'));
    image.src = dataUrl;
  });

const normalizeSelectionRect = (
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): CaptureSelectionRect => ({
  left: Math.min(startX, endX),
  top: Math.min(startY, endY),
  width: Math.abs(endX - startX),
  height: Math.abs(endY - startY),
});

const cropScreenshotToSelection = async (file: File, rect: CaptureSelectionRect) => {
  const dataUrl = await fileToDataUrl(file);
  const image = await loadImageElement(dataUrl);
  const scaleX = image.width / Math.max(1, window.innerWidth);
  const scaleY = image.height / Math.max(1, window.innerHeight);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(rect.width * scaleX));
  canvas.height = Math.max(1, Math.round(rect.height * scaleY));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Failed to create screenshot canvas');
  context.drawImage(
    image,
    Math.round(rect.left * scaleX),
    Math.round(rect.top * scaleY),
    Math.round(rect.width * scaleX),
    Math.round(rect.height * scaleY),
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return await new Promise<string>((resolve, reject) => {
    const nextDataUrl = canvas.toDataURL('image/png');
    if (!nextDataUrl) reject(new Error('Failed to crop screenshot image'));
    else resolve(nextDataUrl);
  });
};

const drawSourceRegion = (
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  sourceRect: CaptureRect,
  selectionRect: CaptureRect,
) => {
  const interLeft = Math.max(sourceRect.left, selectionRect.left);
  const interTop = Math.max(sourceRect.top, selectionRect.top);
  const interRight = Math.min(sourceRect.left + sourceRect.width, selectionRect.left + selectionRect.width);
  const interBottom = Math.min(sourceRect.top + sourceRect.height, selectionRect.top + selectionRect.height);
  const interWidth = interRight - interLeft;
  const interHeight = interBottom - interTop;
  if (interWidth <= 0 || interHeight <= 0) return false;

  const sx = ((interLeft - sourceRect.left) / sourceRect.width) * sourceWidth;
  const sy = ((interTop - sourceRect.top) / sourceRect.height) * sourceHeight;
  const sw = (interWidth / sourceRect.width) * sourceWidth;
  const sh = (interHeight / sourceRect.height) * sourceHeight;
  const dx = interLeft - selectionRect.left;
  const dy = interTop - selectionRect.top;

  ctx.drawImage(source, sx, sy, sw, sh, dx, dy, interWidth, interHeight);
  return true;
};

const createTextFallbackCanvas = (text: string, width: number, height: number) => {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(320, Math.round(width));
  canvas.height = Math.max(180, Math.round(height));
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.fillStyle = '#fffdf7';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#1f2937';
  ctx.font = '16px serif';

  const maxLineWidth = canvas.width - 40;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width > maxLineWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);

  lines.slice(0, 8).forEach((line, index) => {
    ctx.fillText(line, 20, 36 + index * 24);
  });
  return canvas;
};

const cropCanvasRegion = (
  source: HTMLCanvasElement,
  left: number,
  top: number,
  width: number,
  height: number,
) => {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, left, top, width, height, 0, 0, canvas.width, canvas.height);
  return canvas;
};

const loadCanvasImageSource = async (source: Blob) => {
  const dataUrl = await fileToDataUrl(source);
  return await loadImageElement(dataUrl);
};

const getCanvasImageSourceSize = (image: HTMLImageElement | HTMLCanvasElement) => {
  if (image instanceof HTMLCanvasElement) {
    return { width: image.width, height: image.height };
  }
  return { width: image.naturalWidth || image.width, height: image.naturalHeight || image.height };
};

const cropImageSource = (
  source: CanvasImageSource,
  left: number,
  top: number,
  width: number,
  height: number,
) => {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, left, top, width, height, 0, 0, canvas.width, canvas.height);
  return canvas;
};

const waitForNextPaint = async () => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};

const isLowInformationCapture = (canvas: HTMLCanvasElement) => {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return true;
  const sampleWidth = Math.min(64, canvas.width);
  const sampleHeight = Math.min(64, canvas.height);
  if (sampleWidth < 2 || sampleHeight < 2) return true;

  const sample = ctx.getImageData(0, 0, sampleWidth, sampleHeight).data;
  let nonWhite = 0;
  let nonTransparent = 0;
  for (let i = 0; i < sample.length; i += 4) {
    const alpha = sample[i + 3] ?? 0;
    if (alpha > 0) nonTransparent += 1;
    const r = sample[i] ?? 255;
    const g = sample[i + 1] ?? 255;
    const b = sample[i + 2] ?? 255;
    if (!(r > 245 && g > 245 && b > 245)) nonWhite += 1;
  }
  const total = sampleWidth * sampleHeight;
  return nonTransparent < total * 0.03 || nonWhite < total * 0.03;
};

const applyCloneStyleFallbacks = (doc: Document) => {
  doc.documentElement.style.background = '#ffffff';
  doc.body.style.background = '#ffffff';
};

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
  const getView = useReaderStore((state) => state.getView);
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
  const [reasoningEffort, setReasoningEffort] = useState(aiSettings.reasoningEffort);
  const [maxOutputTokens, setMaxOutputTokens] = useState(aiSettings.maxOutputTokens);
  const [selectionExpanded, setSelectionExpanded] = useState(false);
  const [isSelectingCapture, setIsSelectingCapture] = useState(false);
  const [isHidingCaptureUi, setIsHidingCaptureUi] = useState(false);
  const [captureSelectionRect, setCaptureSelectionRect] = useState<CaptureSelectionRect | null>(null);
  const [captureDebugInfo, setCaptureDebugInfo] = useState('');
  const [captureDebugPreviews, setCaptureDebugPreviews] = useState<CaptureDebugPreview[]>([]);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const payloadMessagesRef = useRef<AIChatMessage[]>([]);
  const dialogSizeRef = useRef(dialogSize);
  const resizeStartRef = useRef<{
    x: number;
    y: number;
    width: number;
    height: number;
    axis: 'both' | 'x' | 'y';
  } | null>(null);
  const captureStreamRef = useRef<MediaStream | null>(null);
  const captureStartPointRef = useRef<{ x: number; y: number } | null>(null);
  const skipNativeWindowCommandRef = useRef(false);

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
    dialogSizeRef.current = dialogSize;
  }, [dialogSize]);

  useEffect(
    () => () => {
      captureStreamRef.current?.getTracks().forEach((track) => track.stop());
      captureStreamRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!isOpen) return;
    try {
      const raw = window.localStorage.getItem(DIALOG_SIZE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { width?: number; height?: number };
      if (parsed.width && parsed.height) {
        setDialogSize({
          width: clamp(parsed.width, MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - 24)),
          height: clamp(parsed.height, MIN_HEIGHT, Math.min(MAX_HEIGHT, window.innerHeight - 96)),
        });
      }
    } catch {
      // ignore invalid persisted size
    }
  }, [isOpen]);

  useEffect(() => {
    setReasoningEffort(aiSettings.reasoningEffort);
    setMaxOutputTokens(aiSettings.maxOutputTokens);
  }, [aiSettings.maxOutputTokens, aiSettings.reasoningEffort]);

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

  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, axis: 'both' | 'x' | 'y' = 'both') => {
      event.stopPropagation();
      event.preventDefault();
      const target = event.currentTarget;

      target.setPointerCapture(event.pointerId);

      resizeStartRef.current = {
        x: event.clientX,
        y: event.clientY,
        width: dialogSizeRef.current.width,
        height: dialogSizeRef.current.height,
        axis,
      };

      const handleMove = (moveEvent: PointerEvent) => {
        if (moveEvent.cancelable) moveEvent.preventDefault();
        const start = resizeStartRef.current;
        if (!start) return;

        const deltaX = moveEvent.clientX - start.x;
        const deltaY = moveEvent.clientY - start.y;

        const nextWidth =
          start.axis === 'both' || start.axis === 'x'
            ? clamp(start.width - deltaX, MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - 24))
            : dialogSizeRef.current.width;
        const nextHeight =
          start.axis === 'both' || start.axis === 'y'
            ? clamp(start.height - deltaY, MIN_HEIGHT, Math.min(MAX_HEIGHT, window.innerHeight - 64))
            : dialogSizeRef.current.height;

        setDialogSize({
          width: nextWidth,
          height: nextHeight,
        });
      };

      const handleEnd = (endEvent?: PointerEvent) => {
        if (!resizeStartRef.current) return;
        resizeStartRef.current = null;
        if (endEvent && target.hasPointerCapture(endEvent.pointerId)) {
          target.releasePointerCapture(endEvent.pointerId);
        }
        const current = dialogSizeRef.current;
        window.localStorage.setItem(
          DIALOG_SIZE_KEY,
          JSON.stringify({ width: Math.round(current.width), height: Math.round(current.height) }),
        );
        window.removeEventListener('pointermove', handleMove);
        window.removeEventListener('pointerup', handleEnd);
        window.removeEventListener('pointercancel', handleEnd);
        window.removeEventListener('blur', handleBlur);
      };

      const handleBlur = () => handleEnd();

      window.addEventListener('pointermove', handleMove, { passive: false });
      window.addEventListener('pointerup', handleEnd, { once: true });
      window.addEventListener('pointercancel', handleEnd, { once: true });
      window.addEventListener('blur', handleBlur, { once: true });
    },
    [],
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
        maxOutputTokens,
        reasoningEffort,
      }),
    [aiSettings, maxOutputTokens, reasoningEffort],
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

  const captureNativeWindowRegion = useCallback(
    async (
      selectionRect: CaptureRect,
      pushDebug: (line: string) => void,
      onSourceReady?: () => Promise<void> | void,
    ) => {
      if (!appService?.isDesktopApp || !isTauriAppPlatform()) return null;

      const [
        { currentMonitor, getCurrentWindow, monitorFromPoint },
        { getCurrentWebview },
        { convertFileSrc, invoke },
        {
          getMonitorScreenshot,
          getScreenshotableMonitors,
          getScreenshotableWindows,
          getWindowScreenshot,
          removeMonitorScreenshot,
          removeWindowScreenshot,
        },
      ] = await Promise.all([
        import('@tauri-apps/api/window'),
        import('@tauri-apps/api/webview'),
        import('@tauri-apps/api/core'),
        import('tauri-plugin-screenshots-api'),
      ]);

      const currentWindow = getCurrentWindow();
      const currentWebview = getCurrentWebview();
      let screenshotPath = '';
      let cleanupTarget: { type: 'window' | 'monitor'; id: number } | null = null;
      let notifiedSourceReady = false;
      const notifySourceReady = async () => {
        if (notifiedSourceReady) return;
        notifiedSourceReady = true;
        await onSourceReady?.();
      };

      try {
        const [webviewSize, webviewPosition, windowOuterSize, windowOuterPosition] = await Promise.all([
          currentWebview.size(),
          currentWebview.position(),
          currentWindow.outerSize().catch(() => null),
          currentWindow.outerPosition().catch(() => null),
        ]);

        let screenshotGeometry: ReturnType<typeof getNativeCaptureGeometry> | ReturnType<typeof getMonitorCaptureGeometry> | null = null;
        let screenshotBlob: Blob | null = null;

        try {
          if (skipNativeWindowCommandRef.current) {
            pushDebug('Skipping native window capture command because previous attempts looked blank.');
          } else {
            pushDebug('Trying native window capture command...');
            const pngBytes = await invoke<number[]>('capture_current_window_png');
            if (Array.isArray(pngBytes) && pngBytes.length > 0) {
              screenshotBlob = new Blob([new Uint8Array(pngBytes)], { type: 'image/png' });
              pushDebug(`Native window capture command returned ${pngBytes.length} bytes.`);
            }
          }
        } catch (error) {
          skipNativeWindowCommandRef.current = true;
          pushDebug(`Native window capture command unavailable: ${(error as Error).message || 'unknown'}`);
        }

        if (screenshotBlob) {
          const commandImage = await loadCanvasImageSource(screenshotBlob);
          const commandSize = getCanvasImageSourceSize(commandImage);
          const commandGeometry = getNativeCaptureGeometry({
            screenshotSize: commandSize,
            webviewSize: { width: webviewSize.width, height: webviewSize.height },
            webviewPosition: { x: webviewPosition.x, y: webviewPosition.y },
            viewportSize: { width: window.innerWidth, height: window.innerHeight },
            selectionRect,
            windowOuterPosition: windowOuterPosition ? { x: windowOuterPosition.x, y: windowOuterPosition.y } : null,
            windowOuterSize: windowOuterSize ? { width: windowOuterSize.width, height: windowOuterSize.height } : null,
          });
          const commandCanvas = cropImageSource(
            commandImage,
            commandGeometry.cropRect.left,
            commandGeometry.cropRect.top,
            commandGeometry.cropRect.width,
            commandGeometry.cropRect.height,
          );
          if (!isLowInformationCapture(commandCanvas)) {
            await notifySourceReady();
            pushDebug(
              `Native capture geometry: source=${commandGeometry.sourceKind}, image=${commandSize.width}x${commandSize.height}, crop=(${commandGeometry.cropRect.left},${commandGeometry.cropRect.top},${commandGeometry.cropRect.width}x${commandGeometry.cropRect.height})`,
            );
            return commandCanvas;
          }
          skipNativeWindowCommandRef.current = true;
          pushDebug('Native window capture command looked blank, falling back to plugin capture.');
          screenshotBlob = null;
        }

        if (!screenshotBlob) {
          const monitorCandidates = await getScreenshotableMonitors();
          pushDebug(
            `Native capture monitors: ${monitorCandidates.map((candidate) => `${candidate.id}:${candidate.name}`).join(' | ') || 'none'}`,
          );

          const pointX = (windowOuterPosition?.x ?? 0) + (windowOuterSize?.width ?? webviewSize.width) / 2;
          const pointY = (windowOuterPosition?.y ?? 0) + (windowOuterSize?.height ?? webviewSize.height) / 2;
          const activeMonitor =
            (windowOuterPosition ? await monitorFromPoint(pointX, pointY).catch(() => null) : null) ??
            (await currentMonitor().catch(() => null));
          const matchedMonitor =
            monitorCandidates.find((candidate) => candidate.name === activeMonitor?.name) ??
            (monitorCandidates.length === 1 ? monitorCandidates[0] : null);

          if (matchedMonitor && activeMonitor && windowOuterPosition) {
            pushDebug(
              `Trying monitor capture fallback: id=${matchedMonitor.id}, name=${matchedMonitor.name}, monitorPos=(${activeMonitor.position.x},${activeMonitor.position.y})`,
            );
            screenshotPath = await getMonitorScreenshot(matchedMonitor.id);
            cleanupTarget = { type: 'monitor', id: matchedMonitor.id };
            screenshotGeometry = getMonitorCaptureGeometry({
              screenshotSize: { width: activeMonitor.size.width, height: activeMonitor.size.height },
              monitorPosition: { x: activeMonitor.position.x, y: activeMonitor.position.y },
              windowOuterPosition: { x: windowOuterPosition.x, y: windowOuterPosition.y },
              webviewPosition: { x: webviewPosition.x, y: webviewPosition.y },
              webviewSize: { width: webviewSize.width, height: webviewSize.height },
              viewportSize: { width: window.innerWidth, height: window.innerHeight },
              selectionRect,
            });
          } else {
            const currentTitle = await currentWindow.title().catch(() => document.title);
            const screenshotableWindows = await getScreenshotableWindows();
            pushDebug(
              `Native capture candidates: ${screenshotableWindows.map((candidate) => `${candidate.id}:${candidate.appName}/${candidate.name}/${candidate.title}`).join(' | ') || 'none'}`,
            );
            const screenshotTarget = pickScreenshotWindow({
              candidates: screenshotableWindows,
              windowLabel: currentWindow.label,
              windowTitle: currentTitle,
              documentTitle: document.title,
              preferredAppName: 'AIReadest',
            });

            if (!screenshotTarget) {
              pushDebug('Native capture unavailable: could not resolve current window or monitor.');
              return null;
            }

            pushDebug(`Trying native window capture: id=${screenshotTarget.id}, name=${screenshotTarget.name}, title=${screenshotTarget.title}`);
            screenshotPath = await getWindowScreenshot(screenshotTarget.id);
            cleanupTarget = { type: 'window', id: screenshotTarget.id };
          }
        }

        if (!screenshotBlob) {
          pushDebug(`Native screenshot capture path produced ${screenshotPath ? 'file output' : 'no output yet'}.`);
          if (screenshotPath) {
            await notifySourceReady();
          }
          try {
            const screenshotFile = await appService.openFile(screenshotPath, 'None');
            screenshotBlob = new Blob([await screenshotFile.arrayBuffer()], { type: 'image/png' });
          } catch (error) {
            pushDebug(`Native capture file read failed, retrying via asset URL: ${(error as Error).message}`);
          }

          if (!screenshotBlob) {
            const response = await fetch(convertFileSrc(screenshotPath));
            if (!response.ok) {
              throw new Error(`Native capture asset fetch failed with ${response.status}`);
            }
            const blob = await response.blob();
            screenshotBlob = new Blob([await blob.arrayBuffer()], { type: 'image/png' });
          }
        }

        if (!screenshotBlob) {
          throw new Error('Native capture did not produce image data.');
        }

        const screenshotImage = await loadCanvasImageSource(screenshotBlob);
        const screenshotSize = getCanvasImageSourceSize(screenshotImage);
        const geometry =
          screenshotGeometry ??
          getNativeCaptureGeometry({
            screenshotSize,
            webviewSize: { width: webviewSize.width, height: webviewSize.height },
            webviewPosition: { x: webviewPosition.x, y: webviewPosition.y },
            viewportSize: { width: window.innerWidth, height: window.innerHeight },
            selectionRect,
            windowOuterPosition: windowOuterPosition ? { x: windowOuterPosition.x, y: windowOuterPosition.y } : null,
            windowOuterSize: windowOuterSize ? { width: windowOuterSize.width, height: windowOuterSize.height } : null,
          });

        pushDebug(
          `Native capture geometry: source=${geometry.sourceKind}, image=${screenshotSize.width}x${screenshotSize.height}, crop=(${geometry.cropRect.left},${geometry.cropRect.top},${geometry.cropRect.width}x${geometry.cropRect.height})`,
        );

        return cropImageSource(
          screenshotImage,
          geometry.cropRect.left,
          geometry.cropRect.top,
          geometry.cropRect.width,
          geometry.cropRect.height,
        );
      } finally {
        if (screenshotPath && cleanupTarget) {
          if (cleanupTarget.type === 'window') {
            await removeWindowScreenshot(cleanupTarget.id).catch(() => undefined);
          } else {
            await removeMonitorScreenshot(cleanupTarget.id).catch(() => undefined);
          }
        }
      }
    },
    [appService],
  );

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
    setCaptureSelectionRect(null);
    captureStartPointRef.current = null;
    setIsHidingCaptureUi(true);
    setIsSelectingCapture(true);
    setError('');
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

  const handleCancelCapture = useCallback(() => {
    captureStreamRef.current?.getTracks().forEach((track) => track.stop());
    captureStreamRef.current = null;
    captureStartPointRef.current = null;
    setCaptureSelectionRect(null);
    setIsSelectingCapture(false);
    setIsHidingCaptureUi(false);
  }, []);

  const hideCaptureOverlay = useCallback(() => {
    captureStartPointRef.current = null;
    setCaptureSelectionRect(null);
    setIsSelectingCapture(false);
  }, []);

  const handleCapturePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    captureStartPointRef.current = { x: event.clientX, y: event.clientY };
    setCaptureSelectionRect({ left: event.clientX, top: event.clientY, width: 0, height: 0 });
  }, []);

  const handleCapturePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const start = captureStartPointRef.current;
    if (!start) return;
    setCaptureSelectionRect(normalizeSelectionRect(start.x, start.y, event.clientX, event.clientY));
  }, []);

  const handleCapturePointerUp = useCallback(async () => {
    const rect = captureSelectionRect;
    captureStartPointRef.current = null;
    if (!rect || rect.width < 8 || rect.height < 8) {
      hideCaptureOverlay();
      return;
    }

    try {
      const debugLines: string[] = [];
      const debugPreviews: CaptureDebugPreview[] = [];
      const pushDebug = (line: string) => {
        debugLines.push(line);
      };
      const pushPreview = (label: string, canvas: HTMLCanvasElement) => {
        try {
          debugPreviews.push({ label, dataUrl: canvas.toDataURL('image/png') });
        } catch {
          // ignore preview serialization failures
        }
      };

      hideCaptureOverlay();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      const view = getView(bookKey);
      const rendererContents = view?.renderer.getContents() ?? [];
      pushDebug(`renderer contents: ${rendererContents.length}`);
      const captureHost = document.querySelector(`#gridcell-${bookKey} .foliate-viewer`) as HTMLElement | null;
      const captureHostRect = captureHost?.getBoundingClientRect() ?? null;
      pushDebug(
        captureHostRect
          ? `capture host rect=(${Math.round(captureHostRect.left)},${Math.round(captureHostRect.top)},${Math.round(captureHostRect.width)}x${Math.round(captureHostRect.height)})`
          : 'capture host missing',
      );
      const frames: ReaderFrameCaptureInfo[] = rendererContents
        .map(({ doc, index }) => {
          const iframe = doc.defaultView?.frameElement;
          if (!iframe) return null;
          const frameRect = iframe.getBoundingClientRect();
          return {
            iframe,
            doc,
            index: index ?? null,
            rect: {
              left: frameRect.left,
              top: frameRect.top,
              width: frameRect.width,
              height: frameRect.height,
            },
          } satisfies ReaderFrameCaptureInfo;
        })
        .filter((frame): frame is ReaderFrameCaptureInfo => !!frame);
      pushDebug(`capture frames: ${frames.length}`);

      const selectionRect: CaptureRect = rect;
      pushDebug(
        `selectionRect=(${Math.round(selectionRect.left)},${Math.round(selectionRect.top)},${Math.round(selectionRect.width)}x${Math.round(selectionRect.height)})`,
      );

      try {
        const nativeCanvas = await captureNativeWindowRegion(selectionRect, pushDebug, async () => {
          flushSync(() => {
            setIsHidingCaptureUi(false);
          });
          await waitForNextPaint();
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        });
        if (nativeCanvas && !isLowInformationCapture(nativeCanvas)) {
          pushPreview('native-canvas', nativeCanvas);
          pushDebug('capture mode=native');
          setCaptureDebugInfo(debugLines.join('\n'));
          setCaptureDebugPreviews(debugPreviews);
          setAttachments((prev) => [
            ...prev,
            {
              id: generateId(),
              name: `selection-${Date.now()}.png`,
              dataUrl: nativeCanvas.toDataURL('image/png'),
              mediaType: 'image/png',
            },
          ]);
          setError('');
          return;
        }
      } catch (nativeError) {
        pushDebug(`native capture failed: ${(nativeError as Error).message || 'unknown'}`);
      }

      const rankedFrames = rankFramesForCapture(frames, selectionRect, {
        primaryIndex: view?.renderer?.primaryIndex ?? null,
      });
      pushDebug(`ranked frames: ${rankedFrames.length}`);

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(rect.width));
      canvas.height = Math.max(1, Math.round(rect.height));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error(_('Unable to capture screenshot.'));
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      let drawCount = 0;
      for (const ranked of rankedFrames) {
        const frame = ranked.frame;
        const renderables = Array.from(frame.doc?.querySelectorAll('canvas, img, video, svg') ?? []);
        pushDebug(
          `frame index=${frame.index ?? 'none'} reason=${ranked.reason} hits=${ranked.hitCount}/${ranked.innerHitCount} renderables=${renderables.length}`,
        );

        for (const element of renderables) {
          const localRect = (element as HTMLElement).getBoundingClientRect();
          if (localRect.width < 2 || localRect.height < 2) continue;

          const sourceRect = {
            left: frame.rect.left + localRect.left,
            top: frame.rect.top + localRect.top,
            width: localRect.width,
            height: localRect.height,
          };

          try {
            if (element instanceof HTMLCanvasElement) {
              if (drawSourceRegion(ctx, element, element.width, element.height, sourceRect, selectionRect)) {
                drawCount += 1;
              }
            } else if (element instanceof HTMLImageElement) {
              if (!element.complete) {
                try {
                  await element.decode();
                } catch {
                  // ignore
                }
              }
              const sourceWidth = element.naturalWidth || element.width;
              const sourceHeight = element.naturalHeight || element.height;
              if (
                sourceWidth > 1 &&
                sourceHeight > 1 &&
                drawSourceRegion(ctx, element, sourceWidth, sourceHeight, sourceRect, selectionRect)
              ) {
                drawCount += 1;
              }
            } else if (element instanceof SVGElement) {
              const xml = new XMLSerializer().serializeToString(element);
              const image = await loadImageElement(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`);
              const sourceWidth = image.naturalWidth || image.width;
              const sourceHeight = image.naturalHeight || image.height;
              if (
                sourceWidth > 1 &&
                sourceHeight > 1 &&
                drawSourceRegion(ctx, image, sourceWidth, sourceHeight, sourceRect, selectionRect)
              ) {
                drawCount += 1;
              }
            }
          } catch {
            // ignore individual render failures in MVP path
          }
        }
      }
      pushPreview('surface-canvas', canvas);

      let finalCanvas: HTMLCanvasElement = canvas;
      let captureMode: 'surface' | 'approximate-dom' | 'text' = drawCount > 0 ? 'surface' : 'text';
      if ((drawCount === 0 || isLowInformationCapture(canvas)) && frames.length > 0) {
        pushDebug(`surface drawCount=${drawCount}, lowInfo=${String(isLowInformationCapture(canvas))}`);
        try {
          const html2canvas = (await import('html2canvas')).default;
          let htmlHits = 0;
          for (const ranked of rankedFrames) {
            const frame = ranked.frame;
            pushDebug(
              `html2canvas frame rect=(${Math.round(frame.rect.left)},${Math.round(frame.rect.top)},${Math.round(frame.rect.width)}x${Math.round(frame.rect.height)})`,
            );
            const frameCanvas = await html2canvas(frame.doc?.documentElement || frame.doc?.body!, {
              backgroundColor: '#ffffff',
              useCORS: false,
              allowTaint: true,
              logging: false,
              removeContainer: true,
              foreignObjectRendering: true,
              width: Math.max(1, Math.round(frame.rect.width)),
              height: Math.max(1, Math.round(frame.rect.height)),
              x: frame.doc?.defaultView?.scrollX ?? 0,
              y: frame.doc?.defaultView?.scrollY ?? 0,
              scrollX: -(frame.doc?.defaultView?.scrollX ?? 0),
              scrollY: -(frame.doc?.defaultView?.scrollY ?? 0),
              windowWidth: Math.max(
                frame.doc?.documentElement?.scrollWidth ?? 0,
                Math.round(frame.rect.width),
              ),
              windowHeight: Math.max(
                frame.doc?.documentElement?.scrollHeight ?? 0,
                Math.round(frame.rect.height),
              ),
              onclone: (clonedDoc: Document) => applyCloneStyleFallbacks(clonedDoc),
            });
            const drawn = drawSourceRegion(
              ctx,
              frameCanvas,
              frameCanvas.width,
              frameCanvas.height,
              {
                left: frame.rect.left,
                top: frame.rect.top,
                width: frame.rect.width,
                height: frame.rect.height,
              },
              selectionRect,
            );
            pushPreview(`frame-${frame.index ?? 'none'}-html2canvas`, frameCanvas);
            if (drawn) htmlHits += 1;
          }
          pushDebug(`html2canvas frame hits=${htmlHits}`);

          if (htmlHits > 0 && !isLowInformationCapture(canvas)) {
            finalCanvas = canvas;
            captureMode = 'approximate-dom';
            pushDebug('using frame html2canvas result');
          } else {
            if (captureHost && captureHostRect) {
              pushDebug(
                `host crop local rect=(${Math.round(selectionRect.left - captureHostRect.left)},${Math.round(selectionRect.top - captureHostRect.top)},${Math.round(selectionRect.width)}x${Math.round(selectionRect.height)})`,
              );
              const hostCanvas = await html2canvas(captureHost, {
                backgroundColor: '#ffffff',
                useCORS: false,
                allowTaint: true,
                logging: false,
                removeContainer: true,
                foreignObjectRendering: true,
                width: Math.max(1, Math.round(captureHostRect.width)),
                height: Math.max(1, Math.round(captureHostRect.height)),
                onclone: (clonedDoc: Document) => applyCloneStyleFallbacks(clonedDoc),
                ignoreElements: (element) => {
                  const htmlEl = element as HTMLElement;
                  return htmlEl.dataset?.['aiCaptureHide'] === 'true';
                },
              });
              pushPreview('host-html2canvas', hostCanvas);
              finalCanvas = cropCanvasRegion(
                hostCanvas,
                selectionRect.left - captureHostRect.left,
                selectionRect.top - captureHostRect.top,
                selectionRect.width,
                selectionRect.height,
              );
              pushPreview('host-crop', finalCanvas);
              captureMode = 'approximate-dom';
              pushDebug('using host html2canvas crop');
            } else {
              pushDebug('capture host not found for host html2canvas crop');
            }
          }
        } catch (html2canvasError) {
          pushDebug(`html2canvas fallback failed: ${(html2canvasError as Error).message || 'unknown'}`);
          // keep existing canvas or text fallback below
        }
      }

      pushDebug(`final lowInfo=${String(isLowInformationCapture(finalCanvas))}`);
      const shouldUseCanvas = captureMode !== 'text' && !isLowInformationCapture(finalCanvas);
      const dataUrl = shouldUseCanvas
        ? finalCanvas.toDataURL('image/png')
        : createTextFallbackCanvas(
            quotedContext || selectionText || _('Unable to capture screenshot.'),
            rect.width,
            rect.height,
          ).toDataURL('image/png');
      if (!shouldUseCanvas) {
        captureMode = 'text';
      }
      pushDebug(`capture mode=${captureMode}`);
      pushPreview('final-canvas', finalCanvas);

      setCaptureDebugInfo(debugLines.join('\n'));
      setCaptureDebugPreviews(debugPreviews);

      setAttachments((prev) => [
        ...prev,
        {
          id: generateId(),
          name: `selection-${Date.now()}.png`,
          dataUrl,
          mediaType: 'image/png',
        },
      ]);
      setError('');
    } catch (captureError) {
      setCaptureDebugInfo(`capture failed: ${(captureError as Error).message || 'unknown'}`);
      setCaptureDebugPreviews([]);
      if (navigator.mediaDevices?.getDisplayMedia) {
        try {
          const stream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: 1, max: 2 } },
            audio: false,
          });
          captureStreamRef.current?.getTracks().forEach((track) => track.stop());
          captureStreamRef.current = stream;
          setCaptureSelectionRect(null);
          captureStartPointRef.current = null;
          setIsSelectingCapture(true);
          setError(_('App capture unavailable here. Falling back to screen sharing capture.'));
          return;
        } catch {
          // ignore and surface original error below
        }
      }
      setError((captureError as Error).message || _('Unable to capture screenshot.'));
    } finally {
      captureStreamRef.current?.getTracks().forEach((track) => track.stop());
      captureStreamRef.current = null;
      setIsHidingCaptureUi(false);
    }
  }, [_, bookKey, captureNativeWindowRegion, captureSelectionRect, getView, hideCaptureOverlay, quotedContext, selectionText]);

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
    <ModalPortal showOverlay={false} passthrough>
      {isSelectingCapture && (
        <div
          className='pointer-events-auto fixed inset-0 z-[130] cursor-crosshair bg-black/15'
          onPointerDown={handleCapturePointerDown}
          onPointerMove={handleCapturePointerMove}
          onPointerUp={() => void handleCapturePointerUp()}
          onPointerCancel={handleCancelCapture}
        >
          <div className='pointer-events-none absolute inset-0 border border-white/10' />
          {captureSelectionRect && (
            <div
              className='pointer-events-none absolute border-2 border-primary bg-primary/10 shadow-[0_0_0_9999px_rgba(0,0,0,0.18)]'
              style={{
                left: `${captureSelectionRect.left}px`,
                top: `${captureSelectionRect.top}px`,
                width: `${captureSelectionRect.width}px`,
                height: `${captureSelectionRect.height}px`,
              }}
            />
          )}
          <div className='pointer-events-none absolute left-1/2 top-6 -translate-x-1/2 rounded-full bg-base-100/90 px-4 py-2 text-sm shadow'>
            {_('Drag to capture an area. Release to finish.')}
          </div>
          <button
            type='button'
            className='btn btn-sm btn-outline absolute right-4 top-4 pointer-events-auto'
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            onPointerUp={(event) => {
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
              handleCancelCapture();
            }}
          >
            {_('Cancel')}
          </button>
        </div>
      )}
      <div className='pointer-events-none fixed inset-0 z-[120]'>
        <div
          className='pointer-events-auto absolute bottom-4 right-4 flex flex-col overflow-hidden rounded-2xl border border-base-300 bg-base-100 shadow-2xl'
          style={{
            width: `min(96vw, ${dialogSize.width}px)`,
            height: `min(calc(82vh - 16px), ${dialogSize.height}px)`,
            bottom: '32px',
            visibility: isHidingCaptureUi ? 'hidden' : 'visible',
          }}
          data-ai-capture-hide='true'
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
                <div className='flex items-center gap-1'>
                  <button
                    className='btn btn-ghost btn-xs h-7 min-h-7 px-2 text-[11px]'
                    onClick={() => setSelectionExpanded((prev) => !prev)}
                  >
                    {selectionExpanded ? <LuChevronUp className='mr-1 size-3' /> : <LuChevronDown className='mr-1 size-3' />}
                    {selectionExpanded ? _('Collapse') : _('Expand')}
                  </button>
                  <button className='btn btn-ghost btn-xs h-7 min-h-7 w-7 p-0' onClick={() => setQuotedContext('')}>
                    <LuX className='size-3' />
                  </button>
                </div>
              </div>
              <div
                className={selectionExpanded ? 'max-h-40 overflow-auto whitespace-pre-wrap text-sm leading-6' : 'line-clamp-2 whitespace-pre-wrap text-sm leading-6'}
              >
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
              <label className='flex min-w-[170px] flex-1 flex-col gap-1'>
                <span className='text-base-content/70 text-[11px] font-medium uppercase'>{_('Thinking Effort')}</span>
                <select
                  className='select select-bordered select-sm w-full'
                  value={reasoningEffort}
                  onChange={(e) => setReasoningEffort(e.target.value as typeof reasoningEffort)}
                >
                  <option value='low'>{_('Low')}</option>
                  <option value='medium'>{_('Medium')}</option>
                  <option value='high'>{_('High')}</option>
                </select>
              </label>
              <label className='flex min-w-[170px] flex-1 flex-col gap-1'>
                <div className='flex items-center justify-between gap-2'>
                  <span className='text-base-content/70 text-[11px] font-medium uppercase'>{_('Output Length')}</span>
                  <span className='text-base-content/60 text-[11px]'>{maxOutputTokens}</span>
                </div>
                <input
                  type='range'
                  min='256'
                  max='4096'
                  step='128'
                  className='range range-sm w-full'
                  value={maxOutputTokens}
                  onChange={(e) => setMaxOutputTokens(Number(e.target.value))}
                />
              </label>
            </div>

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

            {captureDebugInfo ? (
              <details className='mb-3 rounded-xl border border-base-300 bg-base-200/40 px-3 py-2 text-xs'>
                <summary className='cursor-pointer select-none font-medium'>{_('Capture Debug')}</summary>
                <div className='mt-2 flex justify-end'>
                  <button
                    type='button'
                    className='btn btn-ghost btn-xs'
                    onClick={() => void handleCopyMessage(captureDebugInfo)}
                  >
                    <LuCopy className='mr-1 size-3' />
                    {_('Copy Debug')}
                  </button>
                </div>
                <pre className='mt-2 max-h-40 overflow-auto whitespace-pre-wrap leading-5'>{captureDebugInfo}</pre>
                {captureDebugPreviews.length > 0 ? (
                  <div className='mt-3 grid grid-cols-2 gap-3'>
                    {captureDebugPreviews.map((preview) => (
                      <div key={preview.label} className='overflow-hidden rounded-lg border border-base-300 bg-base-100'>
                        <div className='border-b border-base-300 px-2 py-1 text-[11px] font-medium'>{preview.label}</div>
                        <img src={preview.dataUrl} alt={preview.label} className='max-h-40 w-full object-contain bg-white' />
                      </div>
                    ))}
                  </div>
                ) : null}
              </details>
            ) : null}

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

          <button
            type='button'
            aria-label={_('Resize Ask AI window')}
            className='drag-handle absolute left-0 top-0 z-10 cursor-nwse-resize rounded-br-xl bg-transparent opacity-0'
            style={{ width: `${RESIZE_HANDLE_SIZE}px`, height: `${RESIZE_HANDLE_SIZE}px` }}
            onPointerDown={(event) => handleResizePointerDown(event, 'both')}
          />
          <button
            type='button'
            aria-label={_('Resize Ask AI window width')}
            className='absolute left-0 top-0 z-[9] cursor-ew-resize bg-transparent opacity-0'
            style={{ width: `${EDGE_RESIZE_THICKNESS}px`, height: '100%' }}
            onPointerDown={(event) => handleResizePointerDown(event, 'x')}
          />
          <button
            type='button'
            aria-label={_('Resize Ask AI window height')}
            className='absolute left-0 top-0 z-[9] cursor-ns-resize bg-transparent opacity-0'
            style={{ width: '100%', height: `${EDGE_RESIZE_THICKNESS}px` }}
            onPointerDown={(event) => handleResizePointerDown(event, 'y')}
          />
        </div>
      </div>
    </ModalPortal>
  );
};

export default AskAIDialog;
