import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  LuAppWindow,
  LuChevronDown,
  LuChevronUp,
  LuCopy,
  LuDownload,
  LuImagePlus,
  LuMaximize2,
  LuMessageSquarePlus,
  LuMinimize2,
  LuPencil,
  LuScreenShare,
  LuSendHorizontal,
  LuSplit,
  LuTrash2,
  LuX,
} from 'react-icons/lu';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { emitTo } from '@tauri-apps/api/event';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import ModalPortal from '@/components/ModalPortal';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useAIChatStore } from '@/store/aiChatStore';
import { ASK_AI_LOCAL_CONVERSATION_KEY_PREFIX, DEFAULT_AI_SETTINGS } from '@/services/ai/constants';
import { getAIProvider } from '@/services/ai/providers';
import type { AIChatMessage, AIChatMessagePart, AIMessage, AIMessageAttachment } from '@/services/ai/types';
import { eventDispatcher } from '@/utils/event';
import { getLocale, makeSafeFilename } from '@/utils/misc';
import { useEnv } from '@/context/EnvContext';
import { useFileSelector } from '@/hooks/useFileSelector';
import { isTauriAppPlatform } from '@/services/environment';
import { useReaderStore } from '@/store/readerStore';
import { closeCaptureWindow, revealCaptureWindow, showCaptureWindow } from '@/utils/captureWindow';
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

type CachedCapturePayload = {
  backend: string;
  width: number;
  height: number;
  png: number[];
};

type CachedCaptureInfoPayload = {
  backend: string;
  width: number;
  height: number;
};

type AskAISendMode = 'enter' | 'mod-enter';

const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful reading assistant. Answer clearly, stay grounded in the selected text and attachments when provided, and say when the context is insufficient.';

const DIALOG_SIZE_KEY = 'ask-ai-dialog-size';
const ASK_AI_SEND_MODE_KEY = 'ask-ai-send-mode';
const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 680;
const MIN_WIDTH = 460;
const MIN_HEIGHT = 420;
const MAX_WIDTH = 972;
const MAX_HEIGHT = 860;
const RESIZE_HANDLE_SIZE = 18;
const EDGE_RESIZE_THICKNESS = 10;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const generateId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

const buildConversationTitle = (question: string, fallback: string) =>
  question.replace(/\s+/g, ' ').trim().slice(0, 40) || fallback;

const renderMarkdownToHtml = (content: string) => {
  const rawHtml = marked.parse(content, {
    async: false,
    breaks: true,
    gfm: true,
  });

  return DOMPurify.sanitize(rawHtml, {
    ALLOWED_ATTR: ['class', 'href', 'rel', 'target'],
  });
};

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

const drawArrowOnCanvas = (
  ctx: CanvasRenderingContext2D,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  strokeWidth: number,
  color: string,
) => {
  const dx = endX - startX;
  const dy = endY - startY;
  const length = Math.max(Math.hypot(dx, dy), 1);
  const ux = dx / length;
  const uy = dy / length;
  const headLength = Math.max(10, strokeWidth * 4);
  const headWidth = Math.max(6, strokeWidth * 2.5);
  const baseX = endX - ux * headLength;
  const baseY = endY - uy * headLength;
  const perpX = -uy;
  const perpY = ux;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.lineTo(endX, endY);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(endX, endY);
  ctx.lineTo(baseX + perpX * headWidth, baseY + perpY * headWidth);
  ctx.lineTo(baseX - perpX * headWidth, baseY - perpY * headWidth);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
};

let captureTextMeasureCanvas: HTMLCanvasElement | null = null;

const wrapCaptureTextLines = (text: string, maxWidth: number, fontSize: number) => {
  const canvas = captureTextMeasureCanvas ?? document.createElement('canvas');
  captureTextMeasureCanvas = canvas;
  const ctx = canvas.getContext('2d');
  if (!ctx) return text.split('\n');

  ctx.font = `600 ${fontSize}px sans-serif`;
  const lines: string[] = [];
  const availableWidth = Math.max(24, maxWidth);

  text.split('\n').forEach((paragraph) => {
    if (!paragraph) {
      lines.push('');
      return;
    }

    let currentLine = '';
    Array.from(paragraph).forEach((char) => {
      const candidate = `${currentLine}${char}`;
      if (currentLine && ctx.measureText(candidate).width > availableWidth) {
        lines.push(currentLine);
        currentLine = char;
      } else {
        currentLine = candidate;
      }
    });
    lines.push(currentLine);
  });

  return lines.length > 0 ? lines : [''];
};

const applyCaptureAnnotations = (
  canvas: HTMLCanvasElement,
  annotations: CaptureAnnotation[],
  selectionRect: CaptureRect,
) => {
  if (annotations.length === 0) return canvas;

  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const scaleX = canvas.width / Math.max(1, selectionRect.width);
  const scaleY = canvas.height / Math.max(1, selectionRect.height);
  const strokeScale = (scaleX + scaleY) / 2;

  annotations.forEach((annotation) => {
    if (annotation.type === 'rect') {
      ctx.save();
      ctx.strokeStyle = annotation.color;
      ctx.lineWidth = annotation.strokeWidth * strokeScale;
      ctx.lineJoin = 'round';
      ctx.strokeRect(
        annotation.x * scaleX,
        annotation.y * scaleY,
        annotation.width * scaleX,
        annotation.height * scaleY,
      );
      ctx.restore();
      return;
    }

    if (annotation.type === 'arrow') {
      drawArrowOnCanvas(
        ctx,
        annotation.startX * scaleX,
        annotation.startY * scaleY,
        annotation.endX * scaleX,
        annotation.endY * scaleY,
        annotation.strokeWidth * strokeScale,
        annotation.color,
      );
      return;
    }

    if (annotation.type !== 'pen' || annotation.points.length < 2) return;

    ctx.save();
    ctx.strokeStyle = annotation.color;
    ctx.lineWidth = annotation.strokeWidth * strokeScale;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(annotation.points[0]!.x * scaleX, annotation.points[0]!.y * scaleY);
    annotation.points.slice(1).forEach((point) => {
      ctx.lineTo(point.x * scaleX, point.y * scaleY);
    });
    ctx.stroke();
    ctx.restore();
    return;
  });

  annotations.forEach((annotation) => {
    if (annotation.type !== 'text') return;

    const textX = annotation.x * scaleX;
    const textY = annotation.y * scaleY;
    const wrappedLines = wrapCaptureTextLines(annotation.text, annotation.width * scaleX, annotation.fontSize * strokeScale);
    ctx.save();
    ctx.fillStyle = annotation.color;
    ctx.font = `600 ${annotation.fontSize * strokeScale}px sans-serif`;
    ctx.textBaseline = 'top';
    const lineHeight = annotation.fontSize * strokeScale * 1.25;
    wrappedLines.forEach((line, index) => {
      ctx.fillText(line || ' ', textX, textY + index * lineHeight);
    });
    ctx.restore();
  });

  return canvas;
};

const waitForNextPaint = async () => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};

const waitForCaptureUiToSettle = async () => {
  await waitForNextPaint();
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
};

const waitForCaptureWindowExit = async () => {
  await waitForNextPaint();
  await new Promise<void>((resolve) => setTimeout(resolve, 90));
};

const getErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error) {
    return error.message || `${error.name}: ${fallback}`;
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }
  return fallback;
};

const isLowInformationCapture = (canvas: HTMLCanvasElement, profile: 'default' | 'native' = 'default') => {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return true;
  const tileSize = profile === 'native' ? 20 : 16;
  const sampleTiles = [
    { x: 0, y: 0 },
    { x: Math.max(0, Math.floor(canvas.width / 2 - tileSize / 2)), y: 0 },
    { x: Math.max(0, canvas.width - tileSize), y: 0 },
    { x: 0, y: Math.max(0, Math.floor(canvas.height / 2 - tileSize / 2)) },
    {
      x: Math.max(0, Math.floor(canvas.width / 2 - tileSize / 2)),
      y: Math.max(0, Math.floor(canvas.height / 2 - tileSize / 2)),
    },
    { x: Math.max(0, canvas.width - tileSize), y: Math.max(0, Math.floor(canvas.height / 2 - tileSize / 2)) },
    { x: 0, y: Math.max(0, canvas.height - tileSize) },
    { x: Math.max(0, Math.floor(canvas.width / 2 - tileSize / 2)), y: Math.max(0, canvas.height - tileSize) },
    { x: Math.max(0, canvas.width - tileSize), y: Math.max(0, canvas.height - tileSize) },
  ];

  let totalPixels = 0;
  let nonWhite = 0;
  let nonTransparent = 0;
  for (const tile of sampleTiles) {
    const sampleWidth = Math.min(tileSize, canvas.width - tile.x);
    const sampleHeight = Math.min(tileSize, canvas.height - tile.y);
    if (sampleWidth < 2 || sampleHeight < 2) continue;
    const sample = ctx.getImageData(tile.x, tile.y, sampleWidth, sampleHeight).data;
    totalPixels += sampleWidth * sampleHeight;
    for (let i = 0; i < sample.length; i += 4) {
      const alpha = sample[i + 3] ?? 0;
      if (alpha > 0) nonTransparent += 1;
      const r = sample[i] ?? 255;
      const g = sample[i + 1] ?? 255;
      const b = sample[i + 2] ?? 255;
      if (!(r > 245 && g > 245 && b > 245)) nonWhite += 1;
    }
  }

  if (totalPixels < 4) return true;
  const threshold = profile === 'native' ? 0.005 : 0.03;
  return nonTransparent < totalPixels * threshold || nonWhite < totalPixels * threshold;
};

const applyCloneStyleFallbacks = (doc: Document) => {
  doc.documentElement.style.background = '#ffffff';
  doc.body.style.background = '#ffffff';
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

type CaptureWindowResultPayload = {
  annotations: CaptureAnnotation[];
  exitTiming?: {
    emitEnd: number;
    hideEnd: number;
    hideStart: number;
  };
  rect: CaptureRect;
  sessionId: number;
  scaleFactor?: number;
  windowOuterPosition?: { x: number; y: number } | null;
  windowOuterSize?: { width: number; height: number } | null;
  windowInnerPosition?: { x: number; y: number } | null;
  windowInnerSize?: { width: number; height: number } | null;
  monitor: {
    name?: string | null;
    position: { x: number; y: number };
    size: { width: number; height: number };
  } | null;
  viewport: { width: number; height: number };
};

type CaptureWindowLifecyclePayload = {
  sessionId?: number;
};

type CaptureWindowDebugTiming = {
  handleOpenAt?: number;
  pageReadyAt?: number;
  prepareSourceDoneAt?: number;
  revealDoneAt?: number;
  showWindowResolvedAt?: number;
  sourceDispatchedAt?: number;
  sourcePresentedAt?: number;
};

type CaptureAnnotationColor = '#22c55e' | '#ef4444' | '#3b82f6' | '#f59e0b';

type CaptureAnnotationPoint = {
  x: number;
  y: number;
};

type CaptureAnnotation =
  | {
      color: CaptureAnnotationColor;
      id: string;
      strokeWidth: number;
      type: 'rect';
      x: number;
      y: number;
      width: number;
      height: number;
    }
  | {
      color: CaptureAnnotationColor;
      endX: number;
      endY: number;
      id: string;
      startX: number;
      startY: number;
      strokeWidth: number;
      type: 'arrow';
    }
  | {
      color: CaptureAnnotationColor;
      id: string;
      points: CaptureAnnotationPoint[];
      strokeWidth: number;
      type: 'pen';
    }
  | {
      color: CaptureAnnotationColor;
      fontSize: number;
      height: number;
      id: string;
      text: string;
      type: 'text';
      width: number;
      x: number;
      y: number;
    };

type CaptureWindowSource =
  | {
      kind: 'file';
      path: string;
      width: number;
      height: number;
    }
  | {
      kind: 'memory';
      width: number;
      height: number;
    };

type PreparedCaptureWindowSource = CaptureWindowSource & {
  mode: 'file' | 'shared-buffer';
  src: string;
};

type CaptureWindowSourceCropPayload = {
  width: number;
  height: number;
  png: number[];
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
  const [isComposerExpanded, setIsComposerExpanded] = useState(false);
  const [isAdvancedControlsExpanded, setIsAdvancedControlsExpanded] = useState(false);
  const [isComposerOverflowing, setIsComposerOverflowing] = useState(false);
  const [sendMode, setSendMode] = useState<AskAISendMode>('enter');
  const [reasoningEffort, setReasoningEffort] = useState<typeof aiSettings.reasoningEffort>(
    aiSettings.reasoningEffort === 'medium' ? 'none' : aiSettings.reasoningEffort,
  );
  const [maxOutputTokens, setMaxOutputTokens] = useState(aiSettings.maxOutputTokens);
  const [selectionExpanded, setSelectionExpanded] = useState(false);
  const [isSelectingCapture, setIsSelectingCapture] = useState(false);
  const [isHidingCaptureUi, setIsHidingCaptureUi] = useState(false);
  const [isCaptureWindowOpen, setIsCaptureWindowOpen] = useState(false);
  const [confirmDeleteConversation, setConfirmDeleteConversation] = useState(false);
  const [captureSelectionRect, setCaptureSelectionRect] = useState<CaptureSelectionRect | null>(null);
  const [captureDebugInfo, setCaptureDebugInfo] = useState('');
  const [captureDebugPreviews, setCaptureDebugPreviews] = useState<CaptureDebugPreview[]>([]);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
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
  const captureWindowCooldownUntilRef = useRef(0);
  const captureWindowResetTimerRef = useRef<number | null>(null);
  const captureWindowSessionRef = useRef(0);
  const captureWindowPageReadyRef = useRef(false);
  const captureWindowMonitorIdRef = useRef<number | null>(null);
  const captureWindowSourceRef = useRef<CaptureWindowSource | null>(null);
  const captureWindowSourcePromiseRef = useRef<Promise<PreparedCaptureWindowSource | null> | null>(null);
  const captureWindowPendingTargetRef = useRef<string | null>(null);
  const captureWindowPendingSessionRef = useRef<number | null>(null);
  const captureWindowDebugTimingRef = useRef<Record<number, CaptureWindowDebugTiming>>({});

  const activeStorageKey = `${ASK_AI_LOCAL_CONVERSATION_KEY_PREFIX}-${bookHash}`;
  const dialogTitle = `${_('Ask AI')}${bookTitle ? ` - ${bookTitle}` : ''}`;
  const isChineseUI = getLocale().startsWith('zh');
  const localizedStartConversation = isChineseUI
    ? '开始围绕本书或所选文本发起对话。'
    : 'Start a conversation about this book or the selected text.';
  const localizedComposerHint = isChineseUI
    ? sendMode === 'enter'
      ? '按 Enter 发送，Shift + Enter 换行，也可直接粘贴图片到输入框。'
      : '按 Ctrl/Cmd + Enter 发送，也可直接粘贴图片到输入框。'
    : sendMode === 'enter'
      ? 'Press Enter to send, Shift + Enter for a new line. Paste images into the input box to attach them.'
      : 'Press Ctrl/Cmd + Enter to send. Paste images into the input box to attach them.';
  const localizedAdvancedControls = isChineseUI ? '高级选项' : 'Advanced Options';
  const localizedExpandedComposer = isChineseUI ? '展开输入框' : 'Expanded Composer';
  const localizedUploadImage = isChineseUI ? '上传图片' : 'Upload Image';
  const localizedCaptureScreen = isChineseUI ? '截取屏幕' : 'Capture Screen';
  const localizedThinkingEffort = isChineseUI ? '思考强度' : 'Thinking Effort';
  const localizedOutputLength = isChineseUI ? '输出长度' : 'Output Length';
  const localizedNone = isChineseUI ? '无' : 'None';
  const localizedLow = isChineseUI ? '低' : 'Low';
  const localizedMedium = isChineseUI ? '中' : 'Medium';
  const localizedHigh = isChineseUI ? '高' : 'High';
  const localizedDeleteConfirm = isChineseUI ? '再次点击删除' : 'Click again to delete';
  const localizedEnterToSend = isChineseUI ? '回车发送' : 'Enter to send';
  const localizedCtrlEnterToSend = isChineseUI ? 'Ctrl/Cmd+回车发送' : 'Ctrl/Cmd+Enter';
  const assistantMarkdownById = useMemo(() => {
    return Object.fromEntries(
      messages
        .filter((message) => message.role === 'assistant')
        .map((message) => [message.id, renderMarkdownToHtml(message.content)]),
    ) as Record<string, string>;
  }, [messages]);

  useEffect(() => {
    if (!selectionText.trim()) return;
    setQuotedContext((prev) => mergeQuotedContext(prev, selectionText));
  }, [selectionText]);

  useEffect(() => {
    if (!isOpen) return;
    try {
      const saved = window.localStorage.getItem(ASK_AI_SEND_MODE_KEY);
      if (saved === 'enter' || saved === 'mod-enter') {
        setSendMode(saved);
      }
    } catch {
      // ignore storage read failures
    }
  }, [isOpen]);

  useEffect(() => {
    try {
      window.localStorage.setItem(ASK_AI_SEND_MODE_KEY, sendMode);
    } catch {
      // ignore storage write failures
    }
  }, [sendMode]);

  useEffect(() => {
    if (!confirmDeleteConversation) return;
    const timer = window.setTimeout(() => {
      setConfirmDeleteConversation(false);
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [confirmDeleteConversation]);

  useEffect(() => {
    if (!isOpen) return;

    const handleSelectionChanged = (event: CustomEvent) => {
      const detail = (event.detail || {}) as { bookKey?: string; selectionText?: string };
      if (detail.bookKey && detail.bookKey !== bookKey) return;
      if (!detail.selectionText?.trim()) return;
      setQuotedContext((prev) => mergeQuotedContext(prev, detail.selectionText!));
    };

    eventDispatcher.on('ask-ai-selection-changed', handleSelectionChanged);
    return () => {
      eventDispatcher.off('ask-ai-selection-changed', handleSelectionChanged);
    };
  }, [bookKey, isOpen]);

  useEffect(() => {
    if (!appService?.isDesktopApp || appService.osPlatform !== 'windows' || !isTauriAppPlatform()) {
      return;
    }

    return () => {
      captureWindowPageReadyRef.current = false;
      void closeCaptureWindow();
    };
  }, [appService]);

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
      if (captureWindowResetTimerRef.current) {
        window.clearTimeout(captureWindowResetTimerRef.current);
      }
      captureWindowSessionRef.current += 1;
      captureWindowPageReadyRef.current = false;
      captureWindowMonitorIdRef.current = null;
      captureWindowSourceRef.current = null;
      captureWindowSourcePromiseRef.current = null;
      captureWindowPendingTargetRef.current = null;
      captureWindowPendingSessionRef.current = null;
      captureWindowDebugTimingRef.current = {};
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
    setReasoningEffort(aiSettings.reasoningEffort === 'medium' ? 'none' : aiSettings.reasoningEffort);
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
      if (editingMessageId) {
        textareaRef.current?.focus();
      } else {
        composerTextareaRef.current?.focus();
      }
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [isOpen, activeConversationId, editingMessageId]);

  useEffect(() => {
    const textarea = composerTextareaRef.current;
    if (!textarea) return;

    textarea.style.height = '0px';
    const nextHeight = textarea.scrollHeight;
    const collapsedHeight = 56;
    const expandedHeight = Math.max(collapsedHeight, nextHeight);
    textarea.style.height = `${isComposerExpanded ? expandedHeight : collapsedHeight}px`;
    setIsComposerOverflowing(nextHeight > collapsedHeight + 4);
  }, [input, attachments.length, isComposerExpanded]);

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
    if (!confirmDeleteConversation) {
      setConfirmDeleteConversation(true);
      return;
    }

    await deleteConversation(activeConversationId);
    setConfirmDeleteConversation(false);
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
    confirmDeleteConversation,
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
        reasoningEffort: reasoningEffort === 'none' ? undefined : reasoningEffort,
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
      pushPreview?: (label: string, canvas: HTMLCanvasElement) => void,
      onSourceReady?: () => Promise<void> | void,
    ): Promise<{ canvas: HTMLCanvasElement; backend: string; rawPreview?: HTMLCanvasElement; cropPreview?: HTMLCanvasElement } | null> => {
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
          pushDebug('Trying native window capture command...');
          const pngBytes = await invoke<number[]>('capture_current_window_png');
          if (Array.isArray(pngBytes) && pngBytes.length > 0) {
            screenshotBlob = new Blob([new Uint8Array(pngBytes)], { type: 'image/png' });
            pushDebug(`Native window capture command returned ${pngBytes.length} bytes.`);
          }
        } catch (error) {
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
            assumeClientAreaCapture: true,
          });
          const commandCanvas = cropImageSource(
            commandImage,
            commandGeometry.cropRect.left,
            commandGeometry.cropRect.top,
            commandGeometry.cropRect.width,
            commandGeometry.cropRect.height,
          );
          const commandRawPreview = cropImageSource(commandImage, 0, 0, commandSize.width, commandSize.height);
          if (!isLowInformationCapture(commandCanvas, 'native')) {
            await notifySourceReady();
            pushDebug(
              `Native capture geometry: source=${commandGeometry.sourceKind}, image=${commandSize.width}x${commandSize.height}, crop=(${commandGeometry.cropRect.left},${commandGeometry.cropRect.top},${commandGeometry.cropRect.width}x${commandGeometry.cropRect.height})`,
            );
            return {
              canvas: commandCanvas,
              backend: 'window-command',
              rawPreview: commandRawPreview,
              cropPreview: commandCanvas,
            };
          }
          pushDebug('Native window capture command looked blank, falling back to plugin capture.');
          pushPreview?.('native-raw-window-command', commandRawPreview);
          pushPreview?.('native-crop-window-command', commandCanvas);
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
            pushDebug('Waiting for UI settle before monitor capture...');
            await waitForCaptureUiToSettle();
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
          if (screenshotPath && cleanupTarget?.type === 'window') {
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

        const cropCanvas = cropImageSource(
          screenshotImage,
          geometry.cropRect.left,
          geometry.cropRect.top,
          geometry.cropRect.width,
          geometry.cropRect.height,
        );
        const rawPreview = cropImageSource(screenshotImage, 0, 0, screenshotSize.width, screenshotSize.height);
        return { canvas: cropCanvas, backend: geometry.sourceKind, rawPreview, cropPreview: cropCanvas };
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

  const cleanupCaptureWindowSource = useCallback(async () => {
    captureWindowSessionRef.current += 1;
    captureWindowSourcePromiseRef.current = null;
    captureWindowPendingTargetRef.current = null;
    captureWindowPendingSessionRef.current = null;
    delete captureWindowDebugTimingRef.current[captureWindowSessionRef.current];
    const monitorId = captureWindowMonitorIdRef.current;
    captureWindowMonitorIdRef.current = null;
    captureWindowSourceRef.current = null;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('clear_capture_window_source').catch(() => undefined);
    } catch {
      // ignore shared buffer cleanup failures
    }
    if (monitorId == null) return;
    try {
      const { removeMonitorScreenshot } = await import('tauri-plugin-screenshots-api');
      await removeMonitorScreenshot(monitorId).catch(() => undefined);
    } catch {
      // ignore cleanup failures
    }
  }, []);

  const prepareCaptureWindowSource = useCallback(
    async (sessionId: number): Promise<PreparedCaptureWindowSource | null> => {
      if (!appService?.isDesktopApp || appService.osPlatform !== 'windows' || !isTauriAppPlatform()) {
        return null;
      }

      const [{ currentMonitor }, { invoke }] = await Promise.all([
        import('@tauri-apps/api/window'),
        import('@tauri-apps/api/core'),
      ]);

      const monitor = await currentMonitor().catch(() => null);
      if (!monitor) {
        throw new Error('Unable to prepare capture source');
      }

      const memorySourceInfo = await invoke<{ width: number; height: number }>('set_capture_window_source_from_monitor', {
        monitor: {
          left: monitor.position.x,
          top: monitor.position.y,
          width: monitor.size.width,
          height: monitor.size.height,
        },
      }).catch(() => null);

      if (memorySourceInfo) {
        if (captureWindowSessionRef.current !== sessionId) {
          await invoke('clear_capture_window_source').catch(() => undefined);
          return null;
        }

        captureWindowSourceRef.current = {
          kind: 'memory',
          width: memorySourceInfo.width,
          height: memorySourceInfo.height,
        };
        captureWindowDebugTimingRef.current[sessionId] = {
          ...captureWindowDebugTimingRef.current[sessionId],
          prepareSourceDoneAt: performance.now(),
        };
        return {
          kind: 'memory',
          mode: 'shared-buffer',
          src: `capture-window-source:${sessionId}:${Date.now()}`,
          width: memorySourceInfo.width,
          height: memorySourceInfo.height,
        };
      }

      const [{ convertFileSrc }, { getMonitorScreenshot, getScreenshotableMonitors }] = await Promise.all([
        import('@tauri-apps/api/core'),
        import('tauri-plugin-screenshots-api'),
      ]);
      const monitorCandidates = await getScreenshotableMonitors();
      const matchedMonitor =
        monitorCandidates.find((candidate) => candidate.name === monitor?.name) ??
        (monitorCandidates.length === 1 ? monitorCandidates[0] : null);

      if (!matchedMonitor) {
        throw new Error('Unable to prepare capture source');
      }

      const screenshotPath = await getMonitorScreenshot(matchedMonitor.id);
      if (captureWindowSessionRef.current !== sessionId) {
        await import('tauri-plugin-screenshots-api')
          .then(({ removeMonitorScreenshot }) => removeMonitorScreenshot(matchedMonitor.id))
          .catch(() => undefined);
        return null;
      }

      await invoke('set_capture_window_source_from_file', { path: screenshotPath }).catch(() => undefined);

      if (captureWindowSessionRef.current !== sessionId) {
        await import('tauri-plugin-screenshots-api')
          .then(({ removeMonitorScreenshot }) => removeMonitorScreenshot(matchedMonitor.id))
          .catch(() => undefined);
        await invoke('clear_capture_window_source').catch(() => undefined);
        return null;
      }

      captureWindowMonitorIdRef.current = matchedMonitor.id;
      captureWindowSourceRef.current = {
        kind: 'file',
        path: screenshotPath,
        width: monitor.size.width,
        height: monitor.size.height,
      };
      captureWindowDebugTimingRef.current[sessionId] = {
        ...captureWindowDebugTimingRef.current[sessionId],
        prepareSourceDoneAt: performance.now(),
      };
      return {
        kind: 'file',
        path: screenshotPath,
        height: monitor.size.height,
        mode: 'file',
        src: convertFileSrc(screenshotPath),
        width: monitor.size.width,
      };
    },
    [appService],
  );

  const releaseCaptureWindowLock = useCallback(() => {
    captureWindowCooldownUntilRef.current = Date.now() + 120;
    setIsCaptureWindowOpen(false);
    if (captureWindowResetTimerRef.current) {
      window.clearTimeout(captureWindowResetTimerRef.current);
    }
    captureWindowResetTimerRef.current = window.setTimeout(() => {
      captureWindowCooldownUntilRef.current = 0;
      captureWindowResetTimerRef.current = null;
    }, 120);
  }, []);

  const emitPendingCaptureWindowSource = useCallback(async () => {
    const targetLabel = captureWindowPendingTargetRef.current;
    const sessionId = captureWindowPendingSessionRef.current;
    const sourcePromise = captureWindowSourcePromiseRef.current;
    if (!captureWindowPageReadyRef.current || !targetLabel || sessionId == null || !sourcePromise) {
      return;
    }

    captureWindowSourcePromiseRef.current = null;

    try {
      const source = await sourcePromise;
      if (!source || captureWindowPendingTargetRef.current !== targetLabel || captureWindowPendingSessionRef.current !== sessionId) {
        return;
      }

      await emitTo('capture-draw', 'capture-window-source-ready', { mode: source.mode, sessionId, src: source.src });
      captureWindowDebugTimingRef.current[sessionId] = {
        ...captureWindowDebugTimingRef.current[sessionId],
        sourceDispatchedAt: performance.now(),
      };
      captureWindowPendingTargetRef.current = null;
      captureWindowPendingSessionRef.current = null;
    } catch (error) {
      const message = getErrorMessage(error, 'capture window source dispatch failed');
      console.error('capture-window source dispatch failed', error);
      setCaptureDebugInfo(`capture window source dispatch failed: ${message}`);
      void cleanupCaptureWindowSource();
      void closeCaptureWindow();
      releaseCaptureWindowLock();
      setIsHidingCaptureUi(false);
      setError(`Capture source failed: ${message}`);
    }
  }, [_, cleanupCaptureWindowSource, releaseCaptureWindowLock]);

  const consumeCaptureWindowResult = useCallback(
    async (payload: CaptureWindowResultPayload) => {
      if (!appService?.isDesktopApp || appService.osPlatform !== 'windows' || !isTauriAppPlatform()) {
        return null;
      }

      const source = captureWindowSourceRef.current;
      if (!source) {
        throw new Error('Capture window source is missing');
      }

      let localLeft = 0;
      let localTop = 0;
      let localWidth = 1;
      let localHeight = 1;

      if (payload.monitor && payload.windowOuterPosition) {
        const webviewPosition = payload.windowInnerPosition
          ? {
              x: payload.windowInnerPosition.x - payload.windowOuterPosition.x,
              y: payload.windowInnerPosition.y - payload.windowOuterPosition.y,
            }
          : { x: 0, y: 0 };
        const webviewSize = payload.windowInnerSize ?? payload.windowOuterSize ?? payload.viewport;
        const geometry = getMonitorCaptureGeometry({
          monitorPosition: payload.monitor.position,
          screenshotSize: { width: source.width, height: source.height },
          selectionRect: payload.rect,
          viewportSize: payload.viewport,
          webviewPosition,
          webviewSize,
          windowOuterPosition: payload.windowOuterPosition,
        });
        localLeft = geometry.cropRect.left;
        localTop = geometry.cropRect.top;
        localWidth = geometry.cropRect.width;
        localHeight = geometry.cropRect.height;
      } else {
        const scaleX = source.width / payload.viewport.width;
        const scaleY = source.height / payload.viewport.height;
        localLeft = Math.max(0, Math.round(payload.rect.left * scaleX));
        localTop = Math.max(0, Math.round(payload.rect.top * scaleY));
        localWidth = Math.max(1, Math.round(payload.rect.width * scaleX));
        localHeight = Math.max(1, Math.round(payload.rect.height * scaleY));
      }

      const fallbackToMonitorFileCapture = async () => {
        const [{ currentMonitor }, { convertFileSrc }, { getMonitorScreenshot, getScreenshotableMonitors, removeMonitorScreenshot }] =
          await Promise.all([
            import('@tauri-apps/api/window'),
            import('@tauri-apps/api/core'),
            import('tauri-plugin-screenshots-api'),
          ]);

        const monitor = payload.monitor ?? (await currentMonitor().catch(() => null));
        const monitorCandidates = await getScreenshotableMonitors();
        const matchedMonitor =
          monitorCandidates.find((candidate) => candidate.name === monitor?.name) ??
          (monitorCandidates.length === 1 ? monitorCandidates[0] : null);

        if (!matchedMonitor) {
          throw new Error('Capture window source is missing');
        }

        const screenshotPath = await getMonitorScreenshot(matchedMonitor.id);
        try {
          const screenshotFile = await appService.openFile(screenshotPath, 'None').catch(() => undefined);
          const screenshotBlob = screenshotFile
            ? new Blob([await screenshotFile.arrayBuffer()], { type: 'image/png' })
            : await (await fetch(convertFileSrc(screenshotPath))).blob();
          const screenshotImage = await loadCanvasImageSource(screenshotBlob);
          const canvas = cropImageSource(screenshotImage, localLeft, localTop, localWidth, localHeight);
          return applyCaptureAnnotations(canvas, payload.annotations, payload.rect);
        } finally {
          await removeMonitorScreenshot(matchedMonitor.id).catch(() => undefined);
        }
      };

      if (source.kind === 'memory') {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const cropped = await invoke<CaptureWindowSourceCropPayload | null>('take_capture_window_source_crop_png', {
            crop: {
              left: localLeft,
              top: localTop,
              width: localWidth,
              height: localHeight,
            },
          });
          if (cropped) {
            const blob = new Blob([new Uint8Array(cropped.png)], { type: 'image/png' });
            const screenshotImage = await loadCanvasImageSource(blob);
            const canvas = applyCaptureAnnotations(
              cropImageSource(screenshotImage, 0, 0, cropped.width, cropped.height),
              payload.annotations,
              payload.rect,
            );
            if (!isLowInformationCapture(canvas, 'native')) {
              return canvas;
            }
          }
        } catch {
          // fall through to file-based fallback for reliability
        }

        return await fallbackToMonitorFileCapture();
      }

      const { convertFileSrc } = await import('@tauri-apps/api/core');
      const screenshotFile = await appService.openFile(source.path, 'None').catch(() => undefined);
      const screenshotBlob = screenshotFile
        ? new Blob([await screenshotFile.arrayBuffer()], { type: 'image/png' })
        : await (await fetch(convertFileSrc(source.path))).blob();
      const screenshotImage = await loadCanvasImageSource(screenshotBlob);

      return applyCaptureAnnotations(
        cropImageSource(screenshotImage, localLeft, localTop, localWidth, localHeight),
        payload.annotations,
        payload.rect,
      );
    },
    [appService],
  );

  useEffect(() => {
    if (!isOpen || !appService?.isDesktopApp || appService.osPlatform !== 'windows' || !isTauriAppPlatform()) {
      return;
    }

    let unlistenSelection: (() => void) | undefined;
    let unlistenCancel: (() => void) | undefined;
    let unlistenPageReady: (() => void) | undefined;
    let unlistenSourcePresented: (() => void) | undefined;

    const setup = async () => {
      const currentWindow = getCurrentWindow();
      captureWindowPageReadyRef.current = false;
      unlistenSelection = await currentWindow.listen<CaptureWindowResultPayload>(
        'capture-window-result',
        async (event) => {
          const payload = event.payload;
          if (!payload || payload.sessionId !== captureWindowSessionRef.current) return;

          const resultStartedAt = performance.now();
          const sourceAtResult = captureWindowSourceRef.current;
          await waitForCaptureWindowExit();
          setIsHidingCaptureUi(false);

          try {
            const canvas = await consumeCaptureWindowResult(payload);
            if (!canvas) {
              throw new Error('capture result canvas is empty');
            }
            setCaptureDebugPreviews([]);
            setAttachments((prev) => [
              ...prev,
              {
                id: generateId(),
                name: `selection-${Date.now()}.png`,
                dataUrl: canvas.toDataURL('image/png'),
                mediaType: 'image/png',
              },
            ]);
            setError('');
            const debugTiming = captureWindowDebugTimingRef.current[payload.sessionId];
            const exitTiming = payload.exitTiming
              ? ` exit-hide=${Math.round(payload.exitTiming.hideEnd - payload.exitTiming.hideStart)}ms exit-settle=${Math.round(payload.exitTiming.emitEnd - payload.exitTiming.hideEnd)}ms`
              : '';
            const flowTiming = debugTiming
              ? ` open->page=${debugTiming.pageReadyAt && debugTiming.handleOpenAt ? Math.round(debugTiming.pageReadyAt - debugTiming.handleOpenAt) : -1}ms` +
                ` open->show=${debugTiming.showWindowResolvedAt && debugTiming.handleOpenAt ? Math.round(debugTiming.showWindowResolvedAt - debugTiming.handleOpenAt) : -1}ms` +
                ` prepare=${debugTiming.prepareSourceDoneAt && debugTiming.handleOpenAt ? Math.round(debugTiming.prepareSourceDoneAt - debugTiming.handleOpenAt) : -1}ms` +
                ` dispatch=${debugTiming.sourceDispatchedAt && debugTiming.prepareSourceDoneAt ? Math.round(debugTiming.sourceDispatchedAt - debugTiming.prepareSourceDoneAt) : -1}ms` +
                ` presented=${debugTiming.sourcePresentedAt && debugTiming.sourceDispatchedAt ? Math.round(debugTiming.sourcePresentedAt - debugTiming.sourceDispatchedAt) : -1}ms` +
                ` reveal=${debugTiming.revealDoneAt && debugTiming.sourcePresentedAt ? Math.round(debugTiming.revealDoneAt - debugTiming.sourcePresentedAt) : -1}ms`
              : '';
            const selectionDebug = ` sel=${Math.round(payload.rect.width)}x${Math.round(payload.rect.height)} viewport=${Math.round(payload.viewport.width)}x${Math.round(payload.viewport.height)} ann=${payload.annotations.length}`;
            const sourceDebug = sourceAtResult
              ? ` source=${sourceAtResult.kind}:${sourceAtResult.width}x${sourceAtResult.height} monitor=${payload.monitor?.name || 'unknown'}`
              : ' source=missing';
            setCaptureDebugInfo(
              `capture mode=native-monitor-dedicated-static size=${canvas.width}x${canvas.height}${selectionDebug}${sourceDebug}${exitTiming}${flowTiming} result=${Math.round(performance.now() - resultStartedAt)}ms`,
            );
          } catch (error) {
            const message = getErrorMessage(error, 'capture window result handling failed');
            console.error('capture-window result failed', error);
            setCaptureDebugInfo(`capture window failed: ${message}`);
            setCaptureDebugPreviews([]);
            setError(`Capture result failed: ${message}`);
          } finally {
            void cleanupCaptureWindowSource();
            releaseCaptureWindowLock();
          }
        },
      );

      unlistenCancel = await currentWindow.listen<CaptureWindowLifecyclePayload>('capture-window-cancel', async (event) => {
        if (!event.payload || event.payload.sessionId !== captureWindowSessionRef.current) return;

        const debugTiming = captureWindowDebugTimingRef.current[event.payload.sessionId];
        void cleanupCaptureWindowSource();
        releaseCaptureWindowLock();
        await waitForCaptureWindowExit();
        setCaptureDebugInfo(
          `capture cancelled session=${event.payload.sessionId}` +
            (debugTiming
              ? ` open->page=${debugTiming.pageReadyAt && debugTiming.handleOpenAt ? Math.round(debugTiming.pageReadyAt - debugTiming.handleOpenAt) : -1}ms` +
                ` prepare=${debugTiming.prepareSourceDoneAt && debugTiming.handleOpenAt ? Math.round(debugTiming.prepareSourceDoneAt - debugTiming.handleOpenAt) : -1}ms` +
                ` dispatch=${debugTiming.sourceDispatchedAt && debugTiming.prepareSourceDoneAt ? Math.round(debugTiming.sourceDispatchedAt - debugTiming.prepareSourceDoneAt) : -1}ms` +
                ` presented=${debugTiming.sourcePresentedAt && debugTiming.sourceDispatchedAt ? Math.round(debugTiming.sourcePresentedAt - debugTiming.sourceDispatchedAt) : -1}ms`
              : ''),
        );
        setIsHidingCaptureUi(false);
      });

      unlistenPageReady = await currentWindow.listen<CaptureWindowLifecyclePayload>('capture-window-page-ready', async () => {
        captureWindowPageReadyRef.current = true;
        const sessionId = captureWindowPendingSessionRef.current;
        if (sessionId != null) {
          captureWindowDebugTimingRef.current[sessionId] = {
            ...captureWindowDebugTimingRef.current[sessionId],
            pageReadyAt: performance.now(),
          };
        }
        void emitPendingCaptureWindowSource();
      });

      unlistenSourcePresented = await currentWindow.listen<CaptureWindowLifecyclePayload>('capture-window-source-presented', async (event) => {
        if (!event.payload || event.payload.sessionId !== captureWindowSessionRef.current) return;

        captureWindowDebugTimingRef.current[event.payload.sessionId] = {
          ...captureWindowDebugTimingRef.current[event.payload.sessionId],
          sourcePresentedAt: performance.now(),
        };
        await revealCaptureWindow();
        captureWindowDebugTimingRef.current[event.payload.sessionId] = {
          ...captureWindowDebugTimingRef.current[event.payload.sessionId],
          revealDoneAt: performance.now(),
        };
      });

      void showCaptureWindow(currentWindow.label, { visible: false }).catch((error) => {
        console.error('preload capture window failed', error);
      });
    };

    void setup();

    return () => {
      unlistenSelection?.();
      unlistenCancel?.();
      unlistenPageReady?.();
      unlistenSourcePresented?.();
    };
  }, [_, appService, cleanupCaptureWindowSource, consumeCaptureWindowResult, emitPendingCaptureWindowSource, isOpen, releaseCaptureWindowLock]);

  const consumeWarmCapture = useCallback(
    async (selectionRect: CaptureRect, pushDebug: (line: string) => void) => {
      if (!appService?.isDesktopApp || appService.osPlatform !== 'windows' || !isTauriAppPlatform()) {
        return null;
      }

      const [{ invoke }, { getCurrentWindow }, { getCurrentWebview }] = await Promise.all([
        import('@tauri-apps/api/core'),
        import('@tauri-apps/api/window'),
        import('@tauri-apps/api/webview'),
      ]);

      const cachedInfo = await invoke<CachedCaptureInfoPayload | null>('take_cached_current_window_capture_info');
      if (!cachedInfo || cachedInfo.width <= 0 || cachedInfo.height <= 0) {
        pushDebug('warm cache miss');
        return null;
      }

      pushDebug(`warm cache hit backend=${cachedInfo.backend} size=${cachedInfo.width}x${cachedInfo.height}`);
      const [currentWindow, currentWebview] = [getCurrentWindow(), getCurrentWebview()];
      const [webviewSize, webviewPosition, windowOuterSize, windowOuterPosition] = await Promise.all([
        currentWebview.size(),
        currentWebview.position(),
        currentWindow.outerSize().catch(() => null),
        currentWindow.outerPosition().catch(() => null),
      ]);

      const geometry = getNativeCaptureGeometry({
        screenshotSize: { width: cachedInfo.width, height: cachedInfo.height },
        webviewSize: { width: webviewSize.width, height: webviewSize.height },
        webviewPosition: { x: webviewPosition.x, y: webviewPosition.y },
        viewportSize: { width: window.innerWidth, height: window.innerHeight },
        selectionRect,
        windowOuterPosition: windowOuterPosition ? { x: windowOuterPosition.x, y: windowOuterPosition.y } : null,
        windowOuterSize: windowOuterSize ? { width: windowOuterSize.width, height: windowOuterSize.height } : null,
        assumeClientAreaCapture: true,
      });

      pushDebug(
        `warm geometry: source=${geometry.sourceKind}, crop=(${geometry.cropRect.left},${geometry.cropRect.top},${geometry.cropRect.width}x${geometry.cropRect.height})`,
      );
      const raw = await invoke<CachedCapturePayload | null>('take_cached_current_window_capture_png');
      let warmRawPreview: HTMLCanvasElement | undefined;
      if (raw && Array.isArray(raw.png) && raw.png.length > 0) {
        const rawBlob = new Blob([new Uint8Array(raw.png)], { type: 'image/png' });
        const rawImage = await loadCanvasImageSource(rawBlob);
        const rawCanvas = cropImageSource(rawImage, 0, 0, raw.width, raw.height);
        warmRawPreview = rawCanvas;
        pushDebug(`warm raw png bytes=${raw.png.length}`);
      }
      const cropped = await invoke<CachedCapturePayload | null>('take_cached_current_window_capture_crop_png', {
        crop: {
          left: geometry.cropRect.left,
          top: geometry.cropRect.top,
          width: geometry.cropRect.width,
          height: geometry.cropRect.height,
        },
      });
      void invoke('clear_cached_current_window_capture').catch(() => undefined);
      flushSync(() => {
        setIsHidingCaptureUi(false);
      });
      await waitForNextPaint();
      if (!cropped || !Array.isArray(cropped.png) || cropped.png.length === 0) {
        pushDebug('warm crop miss');
        return null;
      }
      const screenshotBlob = new Blob([new Uint8Array(cropped.png)], { type: 'image/png' });
      const screenshotImage = await loadCanvasImageSource(screenshotBlob);
      return Object.assign(cropImageSource(screenshotImage, 0, 0, cropped.width, cropped.height), {
        __warmRawPreview: warmRawPreview,
      });
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
    flushSync(() => {
      setIsHidingCaptureUi(true);
      setIsSelectingCapture(true);
    });
    setError('');

    if (appService?.isDesktopApp && appService.osPlatform === 'windows' && isTauriAppPlatform()) {
      try {
        await waitForCaptureUiToSettle();
        const { invoke } = await import('@tauri-apps/api/core');
        void invoke('warm_current_window_capture');
      } catch {
        // ignore warmup failures; regular capture path will still run
      }
    }
  }, [_, appService]);

  const handleOpenCaptureWindow = useCallback(async () => {
    if (isCaptureWindowOpen || Date.now() < captureWindowCooldownUntilRef.current) return;
    setIsCaptureWindowOpen(true);
    flushSync(() => {
      setIsHidingCaptureUi(true);
    });
    setError('');

    const targetLabel = getCurrentWindow().label;
    const sessionId = captureWindowSessionRef.current + 1;
    captureWindowSessionRef.current = sessionId;
    captureWindowDebugTimingRef.current[sessionId] = {
      handleOpenAt: performance.now(),
    };
    captureWindowSourcePromiseRef.current = null;
    captureWindowPendingTargetRef.current = targetLabel;
    captureWindowPendingSessionRef.current = sessionId;

    try {
      await waitForNextPaint();

      const showWindowPromise = showCaptureWindow(targetLabel, { visible: false });
      if (captureWindowSessionRef.current !== sessionId) {
        return;
      }

      captureWindowSourcePromiseRef.current = prepareCaptureWindowSource(sessionId);
      await showWindowPromise;
      captureWindowDebugTimingRef.current[sessionId] = {
        ...captureWindowDebugTimingRef.current[sessionId],
        showWindowResolvedAt: performance.now(),
      };
      void emitPendingCaptureWindowSource();
    } catch (error) {
      const message = getErrorMessage(error, 'opening capture window failed');
      console.error('open capture window failed', error);
      setCaptureDebugInfo(`open capture window failed: ${message}`);
      void cleanupCaptureWindowSource();
      void closeCaptureWindow();
      releaseCaptureWindowLock();
      setIsHidingCaptureUi(false);
      setError(`Open capture failed: ${message}`);
    }
  }, [_, cleanupCaptureWindowSource, emitPendingCaptureWindowSource, isCaptureWindowOpen, prepareCaptureWindowSource, releaseCaptureWindowLock]);

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

    if (appService?.isDesktopApp && appService.osPlatform === 'windows' && isTauriAppPlatform()) {
      void import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke('clear_cached_current_window_capture'))
        .catch(() => undefined);
    }
  }, [appService]);

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
      await waitForCaptureUiToSettle();

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
      const frames: ReaderFrameCaptureInfo[] = rendererContents.flatMap(({ doc, index }) => {
        const iframe = doc.defaultView?.frameElement;
        if (!iframe) return [];
        const frameRect = iframe.getBoundingClientRect();
        return [
          {
            iframe,
            doc,
            index: index ?? null,
            rect: {
              left: frameRect.left,
              top: frameRect.top,
              width: frameRect.width,
              height: frameRect.height,
            },
          } satisfies ReaderFrameCaptureInfo,
        ];
      });
      pushDebug(`capture frames: ${frames.length}`);

      const selectionRect: CaptureRect = rect;
      pushDebug(
        `selectionRect=(${Math.round(selectionRect.left)},${Math.round(selectionRect.top)},${Math.round(selectionRect.width)}x${Math.round(selectionRect.height)})`,
      );

      try {
        const warmCanvas = await consumeWarmCapture(selectionRect, pushDebug);
        const warmRawPreview = (warmCanvas as (HTMLCanvasElement & { __warmRawPreview?: HTMLCanvasElement }) | null)?.__warmRawPreview;
        if (warmRawPreview) {
          pushPreview('warm-native-raw', warmRawPreview);
        }
        if (warmCanvas) {
          pushDebug(`warm lowInfo=${String(isLowInformationCapture(warmCanvas, 'native'))}`);
        }
        if (warmCanvas && !isLowInformationCapture(warmCanvas, 'native')) {
          pushPreview('warm-native-canvas', warmCanvas);
          pushDebug('capture mode=native-warm');
          flushSync(() => {
            setIsHidingCaptureUi(false);
          });
          await waitForNextPaint();
          setCaptureDebugInfo(debugLines.join('\n'));
          setCaptureDebugPreviews(debugPreviews);
          setAttachments((prev) => [
            ...prev,
            {
              id: generateId(),
              name: `selection-${Date.now()}.png`,
              dataUrl: warmCanvas.toDataURL('image/png'),
              mediaType: 'image/png',
            },
          ]);
          setError('');
          return;
        }
      } catch (warmError) {
        pushDebug(`warm capture failed: ${(warmError as Error).message || 'unknown'}`);
      }

      try {
        const nativeResult = await captureNativeWindowRegion(
          selectionRect,
          pushDebug,
          pushPreview,
          async () => {
            flushSync(() => {
              setIsHidingCaptureUi(false);
            });
            await waitForNextPaint();
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          },
        );
        if (nativeResult?.rawPreview) {
          pushPreview(`native-raw-${nativeResult.backend}`, nativeResult.rawPreview);
        }
        if (nativeResult?.cropPreview) {
          pushPreview(`native-crop-${nativeResult.backend}`, nativeResult.cropPreview);
        }
        const nativeCanvas = nativeResult?.canvas ?? null;
        if (nativeCanvas && !isLowInformationCapture(nativeCanvas, 'native')) {
          pushPreview('native-canvas', nativeCanvas);
          pushDebug(`capture mode=native-${nativeResult?.backend || 'unknown'}`);
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
        primaryIndex: view?.renderer?.page ?? null,
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
  }, [_, bookKey, captureNativeWindowRegion, captureSelectionRect, consumeWarmCapture, getView, hideCaptureOverlay, quotedContext, selectionText]);

  const handleSend = useCallback(async () => {
    const question = input.trim();
    if ((!question && attachments.length === 0) || loading) return;
    if (!validateBeforeSend()) return;

    const currentAttachments = attachments;
    setLoading(true);
    setError('');

    try {
      const conversationId = await ensureConversation();
      const displayText = buildUserDisplayText(quotedContext, question, currentAttachments, _);
      const payloadMessage = buildCurrentUserMessage(quotedContext, question, currentAttachments, _);

      await addMessage({
        conversationId,
        role: 'user',
        content: displayText,
        attachments: toStoredAttachments(currentAttachments),
      });

      setAttachments([]);

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
      setIsComposerExpanded(false);
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

  const handleComposerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.nativeEvent.isComposing) return;

      if (sendMode === 'enter') {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          void handleSend();
        }
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend, sendMode],
  );

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
            height: `min(calc(92vh - 16px), ${dialogSize.height}px)`,
            bottom: '32px',
            right: '16px',
            display: isHidingCaptureUi ? 'none' : 'flex',
          }}
          data-ai-capture-hide='true'
        >
          <div className='flex items-center gap-3 border-b border-base-300 px-5 py-4'>
            <div className='min-w-0 flex-1'>
              <div className='flex items-center gap-3'>
                <select
                  className='select select-bordered h-11 min-h-11 w-full max-w-[760px] rounded-2xl bg-base-100 text-sm'
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
                <button className='btn btn-ghost btn-sm whitespace-nowrap px-1 text-sm font-semibold' onClick={() => void handleExport()}>
                  <LuDownload className='mr-1 size-4' />
                  {_('Export')}
                </button>
              </div>
            </div>
            <button className='btn btn-ghost btn-sm' onClick={() => void handleNewConversation()}>
              <LuMessageSquarePlus className='size-4' />
            </button>
            <button
              className={`btn btn-ghost btn-sm transition-all duration-150 ${confirmDeleteConversation ? 'scale-110 bg-error/15 text-error' : ''}`}
              title={confirmDeleteConversation ? localizedDeleteConfirm : undefined}
              onClick={() => void handleDeleteConversation()}
            >
              <LuTrash2 className='size-4' />
            </button>
            <button className='btn btn-ghost btn-sm' onClick={onClose}>
              <LuX className='size-4' />
            </button>
          </div>

          {quotedContext.trim() && (
            <div className='mx-5 mt-4 rounded-3xl border border-base-300 bg-base-200/40 px-4 py-3'>
              <div className='mb-2 flex items-start justify-between gap-3'>
                <div className='text-base-content/60 text-[11px] font-semibold uppercase tracking-[0.12em]'>{_('Selected text')}</div>
                <div className='flex items-center gap-1'>
                  <button className='btn btn-ghost btn-xs h-7 min-h-7 px-2 text-[11px]' onClick={() => setSelectionExpanded((prev) => !prev)}>
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

          <div className='min-h-0 flex-1 overflow-auto px-5 py-5'>
            {isLoadingHistory ? (
              <div className='text-base-content/60 text-sm'>{_('Loading history...')}</div>
            ) : messages.length === 0 ? (
              <div className='flex h-full items-center justify-center'>
                <div className='text-base-content/50 max-w-sm text-center text-sm leading-7'>
                    {localizedStartConversation}
                </div>
              </div>
            ) : (
              <div className='space-y-6'>
                {messages.map((message) => (
                  <div key={message.id} className='space-y-2'>
                    <div className={`text-base-content/55 text-xs font-semibold ${message.role === 'user' ? 'text-right' : ''}`}>
                      {message.role === 'user' ? _('You') : _('Assistant')}
                    </div>

                    {editingMessageId === message.id ? (
                      <div className='space-y-3 rounded-[28px] border border-base-300 bg-base-100 px-4 py-4'>
                        <textarea
                          ref={textareaRef}
                          className='textarea textarea-bordered min-h-24 w-full resize-none rounded-2xl'
                          value={editingText}
                          onChange={(e) => setEditingText(e.target.value)}
                        />
                        <div className='flex justify-end gap-2'>
                          <button className='btn btn-ghost btn-xs' onClick={handleCancelEditMessage}>
                            {_('Cancel')}
                          </button>
                          <button className='btn btn-primary btn-xs' onClick={() => void handleSaveEditedMessage()} disabled={loading || !editingText.trim()}>
                            {_('Save & Retry')}
                          </button>
                        </div>
                      </div>
                    ) : message.role === 'user' ? (
                      <div className='flex flex-col items-end gap-3'>
                        {message.attachments?.length ? (
                          <div className='flex max-w-full flex-wrap justify-end gap-3'>
                            {message.attachments.map((attachment, index) => (
                              <div
                                key={`${message.id}-${attachment.name}-${index}`}
                                className='w-36 overflow-hidden rounded-[24px] border border-base-300 bg-base-100 shadow-sm'
                              >
                                <img src={attachment.dataUrl} alt={attachment.name} className='h-28 w-full object-cover' />
                                <div className='line-clamp-2 px-3 py-2 text-xs text-base-content/60'>{attachment.name}</div>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        {message.content.trim() ? (
                          <div className='max-w-[82%] rounded-[24px] bg-base-200 px-4 py-3 text-right text-[15px] leading-7'>
                            <div className='whitespace-pre-wrap break-words'>{message.content}</div>
                          </div>
                        ) : null}
                        <div className='flex items-center gap-2 text-xs'>
                          <button className='btn btn-ghost btn-xs' onClick={() => handleStartEditMessage(message)} disabled={loading}>
                            <LuPencil className='mr-1 size-3' />
                            {_('Edit')}
                          </button>
                          <button className='btn btn-ghost btn-xs' onClick={() => void handleCopyMessage(message.content)}>
                            <LuCopy className='mr-1 size-3' />
                            {_('Copy')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className='rounded-[28px] border border-base-300 bg-base-100 px-5 py-4 shadow-sm'>
                        <div
                          className='prose prose-sm max-w-none break-words leading-7 prose-headings:mb-3 prose-headings:mt-5 prose-p:my-3 prose-ul:my-3 prose-ol:my-3 prose-li:my-1 prose-pre:rounded-2xl prose-pre:bg-base-200 prose-code:before:hidden prose-code:after:hidden prose-a:text-primary'
                          dangerouslySetInnerHTML={{ __html: assistantMarkdownById[message.id] || '' }}
                        />
                        <div className='mt-3 flex items-center gap-2 text-xs'>
                          <button className='btn btn-ghost btn-xs' onClick={() => void handleBranchConversation(message.id)} disabled={branching || loading}>
                            <LuSplit className='mr-1 size-3' />
                            {_('Branch')}
                          </button>
                          <button className='btn btn-ghost btn-xs' onClick={() => void handleCopyMessage(message.content)}>
                            <LuCopy className='mr-1 size-3' />
                            {_('Copy')}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}

                {loading && (
                  <div className='rounded-[28px] border border-base-300 bg-base-100 px-5 py-4 shadow-sm'>
                    <div className='text-base-content/60 text-sm'>{_('Thinking...')}</div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          <div className='relative shrink-0 border-t border-base-300 px-5 pb-4 pt-4'>
            {error && <div className='text-error mb-3 text-sm'>{error}</div>}

            <div className='rounded-[28px] border border-base-300 bg-base-100 px-4 py-3 shadow-sm'>
              {attachments.length > 0 ? (
                <div className='mb-3 flex gap-3 overflow-x-auto pb-1'>
                  {attachments.map((attachment) => (
                    <div key={attachment.id} className='relative w-28 shrink-0 overflow-hidden rounded-[22px] border border-base-300 bg-base-100'>
                      <img src={attachment.dataUrl} alt={attachment.name} className='h-24 w-full object-cover' />
                      <div className='line-clamp-2 px-2 py-2 text-[11px] text-base-content/65'>{attachment.name}</div>
                      <div className='absolute right-2 top-2 flex gap-1'>
                        <button className='btn btn-circle btn-xs border-none bg-black/75 text-white' onClick={() => handleRemoveAttachment(attachment.id)}>
                          <LuX className='size-3' />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className='relative'>
                <textarea
                  ref={composerTextareaRef}
                  className={`w-full resize-none border-none bg-transparent pr-14 text-[15px] leading-7 outline-none placeholder:text-base-content/45 ${isComposerExpanded ? 'min-h-[44vh]' : 'min-h-[56px] max-h-[56px] overflow-y-auto'}`}
                  placeholder={localizedComposerHint}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onPaste={(e) => {
                    void handlePaste(e);
                  }}
                  onKeyDown={handleComposerKeyDown}
                />
                <button
                  className='btn btn-primary btn-circle btn-sm absolute bottom-0 right-0'
                  onClick={() => void handleSend()}
                  disabled={loading || (!input.trim() && attachments.length === 0)}
                >
                  <LuSendHorizontal className='size-4' />
                </button>
              </div>

              <div className='mt-2 flex flex-wrap items-center gap-2'>
                <button className='btn btn-ghost btn-sm rounded-2xl px-3' onClick={() => void handleUploadImage()}>
                  <LuImagePlus className='mr-1 size-4' />
                  {localizedUploadImage}
                </button>
                {appService?.isDesktopApp && appService.osPlatform === 'windows' ? (
                  <button className='btn btn-ghost btn-sm rounded-2xl px-3' disabled={isCaptureWindowOpen} onClick={() => void handleOpenCaptureWindow()}>
                    <LuAppWindow className='mr-1 size-4' />
                    {localizedCaptureScreen}
                  </button>
                ) : (
                  <button className='btn btn-ghost btn-sm rounded-2xl px-3' onClick={() => void handleCaptureScreenshot()}>
                    <LuScreenShare className='mr-1 size-4' />
                    {localizedCaptureScreen}
                  </button>
                )}
                <button className='btn btn-ghost btn-sm rounded-2xl px-3' onClick={() => setIsAdvancedControlsExpanded((prev) => !prev)}>
                  {isAdvancedControlsExpanded ? <LuChevronUp className='mr-1 size-4' /> : <LuChevronDown className='mr-1 size-4' />}
                  {localizedAdvancedControls}
                </button>
                {isComposerOverflowing || isComposerExpanded ? (
                  <button className='btn btn-ghost btn-sm ml-auto rounded-2xl px-3' onClick={() => setIsComposerExpanded((prev) => !prev)}>
                    {isComposerExpanded ? <LuMinimize2 className='mr-1 size-4' /> : <LuMaximize2 className='mr-1 size-4' />}
                    {isComposerExpanded ? _('Collapse') : _('Expand')}
                  </button>
                ) : null}
              </div>

            </div>

            <div className='mt-4 space-y-4'>
              {isAdvancedControlsExpanded ? (
                <div className='rounded-2xl border border-base-300 bg-base-200/20 px-3 py-3'>
                  <div className='grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]'>
                    <label className='flex flex-col gap-1'>
                      <span className='text-base-content/60 text-[11px] font-semibold uppercase tracking-[0.12em]'>{localizedThinkingEffort}</span>
                      <select
                        className='select select-bordered h-11 min-h-11 w-full rounded-2xl'
                        value={reasoningEffort}
                        onChange={(e) => setReasoningEffort(e.target.value as typeof reasoningEffort)}
                      >
                        <option value='none'>{localizedNone}</option>
                        <option value='low'>{localizedLow}</option>
                        <option value='medium'>{localizedMedium}</option>
                        <option value='high'>{localizedHigh}</option>
                      </select>
                    </label>
                    <label className='flex flex-col gap-1'>
                      <div className='flex items-center justify-between gap-2'>
                        <span className='text-base-content/60 text-[11px] font-semibold uppercase tracking-[0.12em]'>{localizedOutputLength}</span>
                        <span className='text-base-content/50 text-[11px]'>{maxOutputTokens}</span>
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

                  <div className='mt-3 flex flex-wrap items-center gap-2'>
                    <span className='text-base-content/60 text-[11px] font-semibold uppercase tracking-[0.12em]'>
                      {isChineseUI ? '发送方式' : 'Send Mode'}
                    </span>
                    <button
                      type='button'
                      className='btn btn-ghost btn-sm rounded-2xl px-3'
                      onClick={() => setSendMode((prev) => (prev === 'enter' ? 'mod-enter' : 'enter'))}
                    >
                      {sendMode === 'enter' ? localizedEnterToSend : localizedCtrlEnterToSend}
                    </button>
                  </div>

                  {captureDebugInfo ? (
                    <details className='mt-4 rounded-2xl border border-base-300 bg-base-100/70 px-3 py-3 text-xs'>
                      <summary className='cursor-pointer select-none font-medium'>{_('Capture Debug')}</summary>
                      <div className='mt-2 max-h-72 overflow-auto pr-1'>
                        <div className='flex justify-end'>
                          <button type='button' className='btn btn-ghost btn-xs' onClick={() => void handleCopyMessage(captureDebugInfo)}>
                            <LuCopy className='mr-1 size-3' />
                            {_('Copy Debug')}
                          </button>
                        </div>
                        <pre className='mt-2 whitespace-pre-wrap leading-5'>{captureDebugInfo}</pre>
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
                      </div>
                    </details>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          {isComposerExpanded ? (
            <div className='absolute inset-5 z-20 rounded-[32px] border border-base-300 bg-base-100 p-4 shadow-2xl'>
              <div className='mb-3 flex items-center justify-between gap-3'>
                <div className='text-sm font-semibold'>{localizedExpandedComposer}</div>
                <button className='btn btn-ghost btn-sm rounded-2xl' onClick={() => setIsComposerExpanded(false)}>
                  <LuMinimize2 className='size-4' />
                </button>
              </div>
              <div className='flex h-[calc(100%-40px)] flex-col rounded-[26px] border border-base-300 bg-base-100 px-4 py-3'>
                <textarea
                  ref={composerTextareaRef}
                  className='min-h-0 flex-1 resize-none border-none bg-transparent text-[15px] leading-7 outline-none placeholder:text-base-content/45'
                  placeholder={localizedComposerHint}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onPaste={(e) => {
                    void handlePaste(e);
                  }}
                  onKeyDown={handleComposerKeyDown}
                />
                <div className='mt-3 flex flex-wrap items-center gap-2'>
                  <button className='btn btn-ghost btn-sm rounded-2xl px-3' onClick={() => void handleUploadImage()}>
                    <LuImagePlus className='mr-1 size-4' />
                    {localizedUploadImage}
                  </button>
                  {appService?.isDesktopApp && appService.osPlatform === 'windows' ? (
                    <button className='btn btn-ghost btn-sm rounded-2xl px-3' disabled={isCaptureWindowOpen} onClick={() => void handleOpenCaptureWindow()}>
                      <LuAppWindow className='mr-1 size-4' />
                      {localizedCaptureScreen}
                    </button>
                  ) : (
                    <button className='btn btn-ghost btn-sm rounded-2xl px-3' onClick={() => void handleCaptureScreenshot()}>
                      <LuScreenShare className='mr-1 size-4' />
                      {localizedCaptureScreen}
                    </button>
                  )}
                  <button className='btn btn-primary btn-circle btn-sm ml-auto' onClick={() => void handleSend()} disabled={loading || (!input.trim() && attachments.length === 0)}>
                    <LuSendHorizontal className='size-4' />
                  </button>
                  <button
                    type='button'
                    className='btn btn-ghost btn-sm rounded-2xl px-3'
                    onClick={() => setSendMode((prev) => (prev === 'enter' ? 'mod-enter' : 'enter'))}
                  >
                    {sendMode === 'enter' ? localizedEnterToSend : localizedCtrlEnterToSend}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

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
