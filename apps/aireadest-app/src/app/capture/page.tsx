'use client';

import { flushSync } from 'react-dom';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { emitTo } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { currentMonitor, getCurrentWindow } from '@tauri-apps/api/window';
import { useSearchParams } from 'next/navigation';
import { LuArrowRight, LuCheck, LuPenLine, LuSquare, LuType, LuUndo2, LuX } from 'react-icons/lu';
import { isTauriAppPlatform } from '@/services/environment';
import { getWebViewSharedBuffer, releaseWebViewSharedBuffer, supportWebViewSharedBuffer } from '@/utils/webviewSharedBuffer';

type SelectionRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type CaptureWindowResultPayload = {
  annotations: CaptureAnnotation[];
  exitTiming?: {
    emitEnd: number;
    hideEnd: number;
    hideStart: number;
  };
  rect: SelectionRect;
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

type CaptureWindowSourcePayload = {
  mode?: 'file' | 'shared-buffer';
  src?: string;
  sessionId?: number;
};

type CaptureAnnotationTool = 'rect' | 'arrow' | 'pen' | 'text';

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

type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

type ResizeState = {
  startAnnotations: CaptureAnnotation[];
  handle: ResizeHandle;
  startPoint: CaptureAnnotationPoint;
  startRect: SelectionRect;
};

type TextEditorState = {
  text: string;
  x: number;
  y: number;
};

type DragTextState = {
  id: string;
  moved: boolean;
  startPoint: CaptureAnnotationPoint;
  startX: number;
  startY: number;
};

type CaptureWindowMetrics = {
  scaleFactor?: number;
  windowOuterPosition?: { x: number; y: number } | null;
  windowOuterSize?: { width: number; height: number } | null;
  windowInnerPosition?: { x: number; y: number } | null;
  windowInnerSize?: { width: number; height: number } | null;
  monitor: CaptureWindowResultPayload['monitor'];
};

const normalizeRect = (startX: number, startY: number, endX: number, endY: number): SelectionRect => ({
  left: Math.min(startX, endX),
  top: Math.min(startY, endY),
  width: Math.abs(endX - startX),
  height: Math.abs(endY - startY),
});

const settleAfterHide = async () => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => setTimeout(resolve, 90));
};

const settleBeforeHide = async () => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};

const ANNOTATION_COLORS: CaptureAnnotationColor[] = ['#22c55e', '#ef4444', '#3b82f6', '#f59e0b'];
const DEFAULT_ANNOTATION_COLOR: CaptureAnnotationColor = '#22c55e';
const DEFAULT_ANNOTATION_STROKE_WIDTH = 3;
const TEXT_FONT_SIZE = 18;
const TEXT_BOX_WIDTH = 210;
const TEXT_LINE_HEIGHT = 1.35;
const TEXT_BOX_MIN_HEIGHT = TEXT_FONT_SIZE * TEXT_LINE_HEIGHT;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const isPointInsideRect = (x: number, y: number, rect: SelectionRect) => {
  return x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height;
};

const toLocalPoint = (x: number, y: number, rect: SelectionRect): CaptureAnnotationPoint => ({
  x: clamp(x - rect.left, 0, rect.width),
  y: clamp(y - rect.top, 0, rect.height),
});

const createAnnotationId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const getArrowHeadPoints = (annotation: Extract<CaptureAnnotation, { type: 'arrow' }>) => {
  const dx = annotation.endX - annotation.startX;
  const dy = annotation.endY - annotation.startY;
  const length = Math.max(Math.hypot(dx, dy), 1);
  const ux = dx / length;
  const uy = dy / length;
  const headLength = Math.max(10, annotation.strokeWidth * 4);
  const headWidth = Math.max(6, annotation.strokeWidth * 2.5);
  const baseX = annotation.endX - ux * headLength;
  const baseY = annotation.endY - uy * headLength;
  const perpX = -uy;
  const perpY = ux;

  return [
    `${annotation.endX},${annotation.endY}`,
    `${baseX + perpX * headWidth},${baseY + perpY * headWidth}`,
    `${baseX - perpX * headWidth},${baseY - perpY * headWidth}`,
  ].join(' ');
};

const updateSelectionRectByHandle = (startRect: SelectionRect, handle: ResizeHandle, point: CaptureAnnotationPoint) => {
  let left = startRect.left;
  let top = startRect.top;
  let right = startRect.left + startRect.width;
  let bottom = startRect.top + startRect.height;

  if (handle.includes('w')) left = point.x;
  if (handle.includes('e')) right = point.x;
  if (handle.includes('n')) top = point.y;
  if (handle.includes('s')) bottom = point.y;

  return normalizeRect(left, top, right, bottom);
};

const normalizeAnnotationForRender = (annotation: CaptureAnnotation) => {
  if (annotation.type !== 'rect') return annotation;

  const normalized = normalizeRect(annotation.x, annotation.y, annotation.x + annotation.width, annotation.y + annotation.height);
  return {
    ...annotation,
    height: normalized.height,
    width: normalized.width,
    x: normalized.left,
    y: normalized.top,
  } satisfies CaptureAnnotation;
};

const measureTextEditorSize = (textarea: HTMLTextAreaElement | null) => {
  if (!textarea) {
    return { height: TEXT_BOX_MIN_HEIGHT, width: TEXT_BOX_WIDTH };
  }

  return {
    height: Math.max(TEXT_BOX_MIN_HEIGHT, textarea.scrollHeight),
    width: TEXT_BOX_WIDTH,
  };
};

let textMeasureCanvas: HTMLCanvasElement | null = null;

const getTextMeasureContext = (fontSize: number) => {
  const canvas = textMeasureCanvas ?? document.createElement('canvas');
  textMeasureCanvas = canvas;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.font = `600 ${fontSize}px sans-serif`;
  return ctx;
};

const wrapTextLines = (text: string, maxWidth: number, fontSize: number) => {
  const ctx = getTextMeasureContext(fontSize);
  if (!ctx) return text.split('\n');
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

const measureWrappedText = (text: string, maxWidth: number, fontSize: number) => {
  const lines = wrapTextLines(text, maxWidth, fontSize);
  const ctx = getTextMeasureContext(fontSize);
  const measuredWidth = ctx
    ? lines.reduce((max, line) => Math.max(max, ctx.measureText(line || ' ').width), 0)
    : maxWidth;

  return {
    height: Math.max(TEXT_BOX_MIN_HEIGHT, lines.length * fontSize * TEXT_LINE_HEIGHT),
    lines,
    width: Math.min(maxWidth, Math.max(fontSize, Math.ceil(measuredWidth))),
  };
};

export default function CapturePage() {
  const searchParams = useSearchParams();
  const targetLabel = searchParams.get('target') || 'main';
  const [imageSrc, setImageSrc] = useState('');
  const [sourceMode, setSourceMode] = useState<'file' | 'shared-buffer'>('file');
  const [captureStage, setCaptureStage] = useState<'select' | 'annotate'>('select');
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);
  const [startPoint, setStartPoint] = useState<{ x: number; y: number } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSelecting, setIsSelecting] = useState(false);
  const [isAnnotating, setIsAnnotating] = useState(false);
  const [imageReady, setImageReady] = useState(false);
  const [useCanvasSource, setUseCanvasSource] = useState(false);
  const [activeTool, setActiveTool] = useState<CaptureAnnotationTool>('rect');
  const [activeColor, setActiveColor] = useState<CaptureAnnotationColor>(DEFAULT_ANNOTATION_COLOR);
  const [annotations, setAnnotations] = useState<CaptureAnnotation[]>([]);
  const [draftAnnotation, setDraftAnnotation] = useState<CaptureAnnotation | null>(null);
  const [resizeState, setResizeState] = useState<ResizeState | null>(null);
  const [textEditor, setTextEditor] = useState<TextEditorState | null>(null);
  const [dragTextState, setDragTextState] = useState<DragTextState | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const emitSelectionRef = useRef<(() => Promise<void>) | null>(null);
  const sourcePresentedRef = useRef(false);
  const activeSessionIdRef = useRef(0);
  const metricsRef = useRef<CaptureWindowMetrics | null>(null);
  const annotationsRef = useRef<CaptureAnnotation[]>([]);
  const draftAnnotationRef = useRef<CaptureAnnotation | null>(null);
  const textEditorStateRef = useRef<TextEditorState | null>(null);

  const renderedAnnotations = useMemo(() => {
    const items = annotations.map((annotation, index) => ({ annotation: normalizeAnnotationForRender(annotation), renderKey: `${annotation.id}-${index}` }));
    if (draftAnnotation) {
      items.push({ annotation: normalizeAnnotationForRender(draftAnnotation), renderKey: `draft-${draftAnnotation.id}` });
    }
    return items;
  }, [annotations, draftAnnotation]);

  useEffect(() => {
    annotationsRef.current = annotations;
  }, [annotations]);

  useEffect(() => {
    draftAnnotationRef.current = draftAnnotation;
  }, [draftAnnotation]);

  useEffect(() => {
    textEditorStateRef.current = textEditor;
  }, [textEditor]);

  const toolbarStyle = useMemo(() => {
    if (!selectionRect || captureStage !== 'annotate') return null;

    const viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth;
    const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight;
    const preferredTop = selectionRect.top + selectionRect.height + 16;
    const fallbackTop = selectionRect.top - 64;
    const top = preferredTop + 56 <= viewportHeight ? preferredTop : Math.max(12, fallbackTop);
    const centerX = selectionRect.left + selectionRect.width / 2;
    const left = viewportWidth > 0 ? clamp(centerX, 190, viewportWidth - 190) : centerX;

    return {
      left: `${left}px`,
      top: `${top}px`,
      transform: 'translateX(-50%)',
    };
  }, [captureStage, selectionRect]);

  const resetDrawingState = useCallback(() => {
    setCaptureStage('select');
    setSelectionRect(null);
    setStartPoint(null);
    setIsSelecting(false);
    setIsAnnotating(false);
    setAnnotations([]);
    setDraftAnnotation(null);
    setResizeState(null);
    setTextEditor(null);
    setDragTextState(null);
    setIsSubmitting(false);
  }, []);

  const clearPresentedSource = useCallback(() => {
    sourcePresentedRef.current = false;
    metricsRef.current = null;
    setImageReady(false);
    setUseCanvasSource(false);
    setImageSrc('');
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (canvas && ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      canvas.width = 1;
      canvas.height = 1;
    }
  }, []);

  const refreshWindowMetrics = useCallback(async () => {
    const appWindow = getCurrentWindow();
    const monitor = await currentMonitor().catch(() => null);
    const [scaleFactor, outerPosition, outerSize, innerPosition, innerSize] = await Promise.all([
      appWindow.scaleFactor().catch(() => 1),
      appWindow.outerPosition().catch(() => null),
      appWindow.outerSize().catch(() => null),
      appWindow.innerPosition().catch(() => null),
      appWindow.innerSize().catch(() => null),
    ]);

    metricsRef.current = {
      monitor: monitor
        ? {
            name: monitor.name,
            position: monitor.position,
            size: monitor.size,
          }
        : null,
      scaleFactor,
      windowOuterPosition: outerPosition,
      windowOuterSize: outerSize,
      windowInnerPosition: innerPosition,
      windowInnerSize: innerSize,
    };
  }, []);

  const beginDraftAnnotation = useCallback(
    (clientX: number, clientY: number) => {
      if (!selectionRect) return;

      const point = toLocalPoint(clientX, clientY, selectionRect);
      const id = createAnnotationId();

      if (activeTool === 'rect') {
        setDraftAnnotation({
          color: activeColor,
          height: 0,
          id,
          strokeWidth: DEFAULT_ANNOTATION_STROKE_WIDTH,
          type: 'rect',
          width: 0,
          x: point.x,
          y: point.y,
        });
        return;
      }

      if (activeTool === 'arrow') {
        setDraftAnnotation({
          color: activeColor,
          endX: point.x,
          endY: point.y,
          id,
          startX: point.x,
          startY: point.y,
          strokeWidth: DEFAULT_ANNOTATION_STROKE_WIDTH,
          type: 'arrow',
        });
        return;
      }

      if (activeTool === 'text') {
        setTextEditor({ text: '', ...point });
        return;
      }

      setDraftAnnotation({
        color: activeColor,
        id,
        points: [point],
        strokeWidth: DEFAULT_ANNOTATION_STROKE_WIDTH,
        type: 'pen',
      });
    },
    [activeColor, activeTool, selectionRect],
  );

  const buildTextAnnotation = useCallback(
    (editor: TextEditorState | null) => {
      if (!editor || !editor.text.trim()) {
        return null;
      }

      const size = measureTextEditorSize(textEditorRef.current);
      const measured = measureWrappedText(editor.text.trim(), size.width, TEXT_FONT_SIZE);
      return {
        color: activeColor,
        fontSize: TEXT_FONT_SIZE,
        height: measured.height,
        id: createAnnotationId(),
        text: editor.text.trim(),
        type: 'text' as const,
        width: measured.width,
        x: editor.x,
        y: editor.y,
      };
    },
    [activeColor],
  );

  const commitPendingTextEditorNow = useCallback(() => {
    const current = textEditorStateRef.current;
    const nextAnnotation = buildTextAnnotation(current);
    if (!nextAnnotation) {
      textEditorStateRef.current = null;
      setTextEditor(null);
      return null;
    }

    textEditorStateRef.current = null;
    annotationsRef.current = [...annotationsRef.current, nextAnnotation];
    setAnnotations(annotationsRef.current);
    setTextEditor(null);
    return nextAnnotation;
  }, [buildTextAnnotation]);

  const setCaptureWindowMousePassthrough = useCallback(async (ignore: boolean) => {
    await getCurrentWindow().setIgnoreCursorEvents(ignore).catch(() => undefined);
  }, []);

  const commitTextEditor = useCallback(() => {
    commitPendingTextEditorNow();
  }, [commitPendingTextEditorNow]);

  const undoLastCaptureAction = useCallback(() => {
    if (draftAnnotationRef.current) {
      draftAnnotationRef.current = null;
      setDraftAnnotation(null);
      return;
    }

    if (textEditorStateRef.current) {
      textEditorStateRef.current = null;
      setTextEditor(null);
      return;
    }

    if (annotationsRef.current.length > 0) {
      annotationsRef.current = annotationsRef.current.slice(0, -1);
      setAnnotations(annotationsRef.current);
    }
  }, []);

  const offsetAnnotationsBySelectionChange = useCallback((items: CaptureAnnotation[], deltaX: number, deltaY: number) => {
    if (deltaX === 0 && deltaY === 0) {
      return items;
    }

    return items.map((item) => {
      if (item.type === 'rect' || item.type === 'text') {
        return {
          ...item,
          x: item.x + deltaX,
          y: item.y + deltaY,
        };
      }

      if (item.type === 'arrow') {
        return {
          ...item,
          endX: item.endX + deltaX,
          endY: item.endY + deltaY,
          startX: item.startX + deltaX,
          startY: item.startY + deltaY,
        };
      }

      return {
        ...item,
        points: item.points.map((point) => ({ x: point.x + deltaX, y: point.y + deltaY })),
      };
    });
  }, []);

  const beginTextDrag = useCallback(
    (id: string, clientX: number, clientY: number) => {
      if (!selectionRect) return;
      const annotation = annotations.find((item) => item.id === id);
      if (!annotation || annotation.type !== 'text') return;

      setTextEditor(null);
      setDraftAnnotation(null);
      setDragTextState({
        id,
        moved: false,
        startPoint: toLocalPoint(clientX, clientY, selectionRect),
        startX: annotation.x,
        startY: annotation.y,
      });
    },
    [annotations, selectionRect],
  );

  const beginTextEdit = useCallback(
    (id: string) => {
      const annotation = annotationsRef.current.find((item) => item.id === id);
      if (!annotation || annotation.type !== 'text') return;

      annotationsRef.current = annotationsRef.current.filter((item) => item.id !== id);
      setAnnotations(annotationsRef.current);
      setTextEditor({
        text: annotation.text,
        x: annotation.x,
        y: annotation.y,
      });
    },
    [],
  );

  const updateDraftAnnotation = useCallback(
    (clientX: number, clientY: number) => {
      if (!selectionRect) return;

      const point = toLocalPoint(clientX, clientY, selectionRect);
      setDraftAnnotation((current) => {
        if (!current) return null;

        if (current.type === 'rect') {
          return {
            ...current,
            height: point.y - current.y,
            width: point.x - current.x,
          };
        }

        if (current.type === 'arrow') {
          return {
            ...current,
            endX: point.x,
            endY: point.y,
          };
        }

        if (current.type !== 'pen') {
          return current;
        }

        const lastPoint = current.points[current.points.length - 1];
        if (lastPoint && Math.hypot(point.x - lastPoint.x, point.y - lastPoint.y) < 1.5) {
          return current;
        }

        return {
          ...current,
          points: [...current.points, point],
        };
      });
    },
    [selectionRect],
  );

  const commitDraftAnnotation = useCallback(() => {
    const current = draftAnnotationRef.current;
    if (!current) return;

    let nextAnnotation: CaptureAnnotation | null = current;
    if (current.type === 'rect') {
      const normalized = normalizeRect(current.x, current.y, current.x + current.width, current.y + current.height);
      if (normalized.width < 6 || normalized.height < 6) {
        nextAnnotation = null;
      } else {
        nextAnnotation = {
          ...current,
          height: normalized.height,
          width: normalized.width,
          x: normalized.left,
          y: normalized.top,
        };
      }
    } else if (current.type === 'arrow') {
      if (Math.hypot(current.endX - current.startX, current.endY - current.startY) < 8) {
        nextAnnotation = null;
      }
    } else if (current.type === 'pen' && current.points.length < 2) {
      nextAnnotation = null;
    }

    draftAnnotationRef.current = null;
    setDraftAnnotation(null);

    if (nextAnnotation) {
      annotationsRef.current = [...annotationsRef.current, nextAnnotation];
      setAnnotations(annotationsRef.current);
    }
  }, []);

  const beginResizeSelection = useCallback(
    (handle: ResizeHandle, clientX: number, clientY: number) => {
      if (!selectionRect) return;
      commitPendingTextEditorNow();
      setDraftAnnotation(null);
      setResizeState({
        handle,
        startAnnotations: annotationsRef.current,
        startPoint: { x: clientX, y: clientY },
        startRect: selectionRect,
      });
    },
    [commitPendingTextEditorNow, selectionRect],
  );

  const emitCancel = useCallback(async () => {
    const activeSessionId = activeSessionIdRef.current;
    flushSync(() => {
      resetDrawingState();
      clearPresentedSource();
      setIsSubmitting(true);
    });
    await settleBeforeHide();
    await setCaptureWindowMousePassthrough(true);
    await getCurrentWindow().hide().catch(() => undefined);
    await settleAfterHide();
    if (activeSessionId > 0) {
      await emitTo(targetLabel, 'capture-window-cancel', { sessionId: activeSessionId });
    }
  }, [clearPresentedSource, resetDrawingState, setCaptureWindowMousePassthrough, targetLabel]);

  useEffect(() => {
    if (!textEditor) return;
    const textarea = textEditorRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.style.height = '0px';
    textarea.style.height = `${Math.max(TEXT_BOX_MIN_HEIGHT, textarea.scrollHeight)}px`;
  }, [textEditor]);

  useEffect(() => {
    if (!imageReady) return;
    void refreshWindowMetrics();
  }, [imageReady, refreshWindowMetrics]);

  useEffect(() => {
    const html = document.documentElement;
    const previousPage = html.dataset.page;
    const previousHtmlOverflow = html.style.overflow;
    const previousBodyMargin = document.body.style.margin;
    const previousBodyOverflow = document.body.style.overflow;
    const previousBodyWidth = document.body.style.width;
    const previousBodyHeight = document.body.style.height;
    const previousBodyBorderRadius = document.body.style.borderRadius;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'crosshair';
    document.body.style.margin = '0';
    document.body.style.overflow = 'hidden';
    document.body.style.width = '100vw';
    document.body.style.height = '100vh';
    document.body.style.borderRadius = '0';
    html.dataset.page = 'capture';
    html.style.overflow = 'hidden';
    void emitTo(targetLabel, 'capture-window-page-ready', {});
    const handleKeyDown = async (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTextInputTarget = target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT';

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && captureStage === 'annotate' && !isTextInputTarget) {
        event.preventDefault();
        undoLastCaptureAction();
        return;
      }

      if (event.key === 'Enter' && captureStage === 'annotate' && !isTextInputTarget) {
        event.preventDefault();
        await emitSelectionRef.current?.();
        return;
      }

      if (event.key === 'Escape' && isTauriAppPlatform() && !isTextInputTarget) {
        event.preventDefault();
        await emitCancel();
      }
    };

    let unlistenSourceReady: (() => void) | undefined;

    void getCurrentWindow()
      .listen<CaptureWindowSourcePayload>('capture-window-source-ready', (event) => {
        const nextSessionId = event.payload?.sessionId ?? 0;
        if (nextSessionId <= 0) {
          return;
        }

        activeSessionIdRef.current = nextSessionId;
        sourcePresentedRef.current = false;
        resetDrawingState();
        metricsRef.current = null;
        void setCaptureWindowMousePassthrough(false);
        setUseCanvasSource(false);
        setImageReady(false);
        setSourceMode(event.payload?.mode || 'file');
        setImageSrc(event.payload?.src || '');
        void refreshWindowMetrics();
      })
      .then((unlisten) => {
        unlistenSourceReady = unlisten;
      });

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.body.style.margin = previousBodyMargin;
      document.body.style.overflow = previousBodyOverflow;
      document.body.style.width = previousBodyWidth;
      document.body.style.height = previousBodyHeight;
      document.body.style.borderRadius = previousBodyBorderRadius;
      html.style.overflow = previousHtmlOverflow;
      if (previousPage) {
        html.dataset.page = previousPage;
      } else {
        delete html.dataset.page;
      }
      unlistenSourceReady?.();
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [captureStage, emitCancel, refreshWindowMetrics, resetDrawingState, setCaptureWindowMousePassthrough, targetLabel, undoLastCaptureAction]);

  useEffect(() => {
    if (!imageReady || sourcePresentedRef.current || !isTauriAppPlatform()) {
      return;
    }

    sourcePresentedRef.current = true;
    const activeSessionId = activeSessionIdRef.current;
    if (activeSessionId > 0) {
      void emitTo(targetLabel, 'capture-window-source-presented', { sessionId: activeSessionId });
    }
  }, [imageReady, targetLabel]);

  useEffect(() => {
    let cancelled = false;

    const loadSharedBuffer = async () => {
      if (!imageSrc) {
        setUseCanvasSource(false);
        setImageReady(false);
        return;
      }

      if (sourceMode !== 'shared-buffer') {
        setUseCanvasSource(false);
        return;
      }

      if (!isTauriAppPlatform() || !supportWebViewSharedBuffer()) {
        setUseCanvasSource(false);
        return;
      }

      const bufferPromise = getWebViewSharedBuffer('capture-window-source');
      const posted = await invoke<boolean>('post_capture_window_source_shared_buffer').catch(() => false);
      if (!posted) {
        setUseCanvasSource(false);
        return;
      }

      const buffer = await bufferPromise;
      if (!buffer || cancelled) {
        setUseCanvasSource(false);
        return;
      }

      const imageBytesLength = buffer.byteLength - 8;
      if (imageBytesLength <= 0) {
        releaseWebViewSharedBuffer(buffer);
        setUseCanvasSource(false);
        return;
      }

      const width = new DataView(buffer, imageBytesLength, 4).getUint32(0, true);
      const height = new DataView(buffer, imageBytesLength + 4, 4).getUint32(0, true);
      const pixels = new Uint8ClampedArray(imageBytesLength);
      pixels.set(new Uint8ClampedArray(buffer, 0, imageBytesLength));
      releaseWebViewSharedBuffer(buffer);
      const imageData = new ImageData(pixels, width, height);

      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) {
        setUseCanvasSource(false);
        return;
      }

      canvas.width = width;
      canvas.height = height;
      ctx.putImageData(imageData, 0, 0);
      setUseCanvasSource(true);
      setImageReady(true);
    };

    void loadSharedBuffer();

    return () => {
      cancelled = true;
    };
  }, [imageSrc, sourceMode]);

  const isArmed = imageReady;
  const showBackdrop = imageReady && !isSubmitting;

  const emitSelection = async () => {
    if (!selectionRect) return;

    const rect = selectionRect;
    const metrics = metricsRef.current;

    const payload: CaptureWindowResultPayload = {
      annotations: (() => {
        const textAnnotation = buildTextAnnotation(textEditor);
        return textAnnotation ? [...annotations, textAnnotation] : annotations;
      })(),
      exitTiming: {
        emitEnd: 0,
        hideEnd: 0,
        hideStart: performance.now(),
      },
      rect,
      sessionId: activeSessionIdRef.current,
      scaleFactor: metrics?.scaleFactor,
      windowOuterPosition: metrics?.windowOuterPosition,
      windowOuterSize: metrics?.windowOuterSize,
      windowInnerPosition: metrics?.windowInnerPosition,
      windowInnerSize: metrics?.windowInnerSize,
      monitor: metrics?.monitor ?? null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };

    flushSync(() => {
      resetDrawingState();
      clearPresentedSource();
      setIsSubmitting(true);
    });
    await settleBeforeHide();
    await setCaptureWindowMousePassthrough(true);
    await getCurrentWindow().hide().catch(() => undefined);
    if (payload.exitTiming) {
      payload.exitTiming.hideEnd = performance.now();
    }
    await settleAfterHide();
    if (payload.exitTiming) {
      payload.exitTiming.emitEnd = performance.now();
    }
    await emitTo(targetLabel, 'capture-window-result', payload);
  };

  useEffect(() => {
    emitSelectionRef.current = emitSelection;
  }, [emitSelection]);

  return (
    <main
      className='fixed inset-0 cursor-crosshair overflow-hidden bg-transparent text-base-content'
      onPointerDown={(event) => {
        if (!isArmed || isSubmitting || event.button !== 0) return;

        const targetElement = event.target as HTMLElement | null;
        const isTextEditorTarget = !!targetElement?.closest('textarea');
        if (textEditorStateRef.current && !isTextEditorTarget) {
          commitPendingTextEditorNow();
        }

        if (dragTextState) {
          return;
        }

        if (resizeState) {
          return;
        }

        if (captureStage === 'annotate') {
          if (!selectionRect || !isPointInsideRect(event.clientX, event.clientY, selectionRect)) {
            return;
          }

          event.preventDefault();
          event.stopPropagation();
          if (event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          if (activeTool !== 'text') {
            setIsAnnotating(true);
          }
          beginDraftAnnotation(event.clientX, event.clientY);
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        setIsSelecting(true);
        setStartPoint({ x: event.clientX, y: event.clientY });
        setSelectionRect({ left: event.clientX, top: event.clientY, width: 0, height: 0 });
      }}
      onPointerMove={(event) => {
        if (!isArmed || isSubmitting) return;

        if (dragTextState && selectionRect) {
          const point = toLocalPoint(event.clientX, event.clientY, selectionRect);
          const moved = Math.hypot(point.x - dragTextState.startPoint.x, point.y - dragTextState.startPoint.y) > 2;
          if (moved && !dragTextState.moved) {
            setDragTextState((current) => (current ? { ...current, moved: true } : current));
          }
          setAnnotations((items) =>
            items.map((item) => {
              if (item.id !== dragTextState.id || item.type !== 'text') {
                return item;
              }

              const nextX = clamp(
                dragTextState.startX + (point.x - dragTextState.startPoint.x),
                0,
                Math.max(0, selectionRect.width - Math.max(item.width, TEXT_FONT_SIZE)),
              );
              const nextY = clamp(dragTextState.startY + (point.y - dragTextState.startPoint.y), 0, Math.max(0, selectionRect.height - item.height));
              return {
                ...item,
                x: nextX,
                y: nextY,
              };
            }),
          );
          return;
        }

        if (resizeState) {
          const nextRect = updateSelectionRectByHandle(resizeState.startRect, resizeState.handle, { x: event.clientX, y: event.clientY });
          const deltaX = resizeState.startRect.left - nextRect.left;
          const deltaY = resizeState.startRect.top - nextRect.top;
          setSelectionRect(nextRect);
          annotationsRef.current = offsetAnnotationsBySelectionChange(resizeState.startAnnotations, deltaX, deltaY);
          setAnnotations(annotationsRef.current);
          return;
        }

        if (captureStage === 'annotate') {
          if (!isAnnotating) return;
          updateDraftAnnotation(event.clientX, event.clientY);
          return;
        }

        if (!isSelecting || !startPoint) return;
        setSelectionRect(normalizeRect(startPoint.x, startPoint.y, event.clientX, event.clientY));
      }}
      onPointerUp={async (event) => {
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }

        if (!isArmed || isSubmitting) return;

        if (dragTextState) {
          if (!dragTextState.moved && activeTool === 'text') {
            beginTextEdit(dragTextState.id);
          }
          setDragTextState(null);
          return;
        }

        if (resizeState) {
          setResizeState(null);
          return;
        }

        if (captureStage === 'annotate') {
          if (!isAnnotating) return;
          setIsAnnotating(false);
          if (activeTool !== 'text') {
            commitDraftAnnotation();
          }
          return;
        }

        if (!isSelecting || !startPoint) return;
        setIsSelecting(false);
        setStartPoint(null);
        if (!selectionRect || selectionRect.width < 8 || selectionRect.height < 8) {
          setSelectionRect(null);
          return;
        }

        flushSync(() => {
          setCaptureStage('annotate');
        });
      }}
    >
      <canvas ref={canvasRef} className={`pointer-events-none absolute inset-0 h-full w-full select-none ${useCanvasSource ? '' : 'hidden'}`} />
      {sourceMode === 'file' && imageSrc ? (
        <img
          ref={imageRef}
          src={imageSrc}
          alt='capture source'
          className={`pointer-events-none absolute inset-0 h-full w-full object-fill select-none ${useCanvasSource ? 'hidden' : ''}`}
          draggable={false}
          onLoad={() => setImageReady(true)}
        />
      ) : null}

      {showBackdrop ? (
        selectionRect ? (
          <>
            <div className='pointer-events-none absolute left-0 top-0 bg-black/25' style={{ height: `${selectionRect.top}px`, width: '100%' }} />
            <div className='pointer-events-none absolute left-0 bg-black/25' style={{ top: `${selectionRect.top}px`, height: `${selectionRect.height}px`, width: `${selectionRect.left}px` }} />
            <div
              className='pointer-events-none absolute bg-black/25'
              style={{ top: `${selectionRect.top}px`, left: `${selectionRect.left + selectionRect.width}px`, height: `${selectionRect.height}px`, right: 0 }}
            />
            <div
              className='pointer-events-none absolute left-0 bg-black/25'
              style={{ top: `${selectionRect.top + selectionRect.height}px`, width: '100%', bottom: 0 }}
            />
          </>
        ) : (
          <div className='pointer-events-none absolute inset-0 bg-black/25' />
        )
      ) : null}
      {selectionRect ? (
        <div
          className='pointer-events-none absolute border border-white/80'
          style={{
            left: `${selectionRect.left}px`,
            top: `${selectionRect.top}px`,
            width: `${selectionRect.width}px`,
            height: `${selectionRect.height}px`,
          }}
        >
          {captureStage === 'annotate' ? (
            <svg className='absolute inset-0 h-full w-full overflow-visible' viewBox={`0 0 ${selectionRect.width} ${selectionRect.height}`}>
              {renderedAnnotations.map(({ annotation, renderKey }) => {
                if (annotation.type === 'rect') {
                  return (
                    <rect
                      key={renderKey}
                      x={annotation.x}
                      y={annotation.y}
                      width={annotation.width}
                      height={annotation.height}
                      fill='transparent'
                      stroke={annotation.color}
                      strokeWidth={annotation.strokeWidth}
                      strokeLinejoin='round'
                    />
                  );
                }

                if (annotation.type === 'arrow') {
                  return (
                    <g key={renderKey}>
                      <line
                        x1={annotation.startX}
                        y1={annotation.startY}
                        x2={annotation.endX}
                        y2={annotation.endY}
                        stroke={annotation.color}
                        strokeWidth={annotation.strokeWidth}
                        strokeLinecap='round'
                      />
                      <polygon points={getArrowHeadPoints(annotation)} fill={annotation.color} />
                    </g>
                  );
                }

                if (annotation.type === 'text') {
                  return null;
                }

                return (
                  <polyline
                    key={renderKey}
                    points={annotation.points.map((point) => `${point.x},${point.y}`).join(' ')}
                    fill='none'
                    stroke={annotation.color}
                    strokeWidth={annotation.strokeWidth}
                    strokeLinecap='round'
                    strokeLinejoin='round'
                  />
                );
              })}
            </svg>
          ) : null}
          {captureStage === 'annotate'
            ? renderedAnnotations
                .filter((item) => item.annotation.type === 'text')
                .map(({ annotation, renderKey }) => {
                  if (annotation.type !== 'text') return null;

                  const lines = wrapTextLines(annotation.text, annotation.width, annotation.fontSize);
                  return (
                    <div
                      key={renderKey}
                      className='pointer-events-auto absolute cursor-move select-none whitespace-pre-wrap font-semibold'
                      style={{
                        color: annotation.color,
                        fontSize: `${annotation.fontSize}px`,
                        left: `${annotation.x}px`,
                        lineHeight: TEXT_LINE_HEIGHT,
                        top: `${annotation.y}px`,
                        width: `${annotation.width}px`,
                      }}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (textEditorStateRef.current) {
                          commitPendingTextEditorNow();
                        }
                        beginTextDrag(annotation.id, event.clientX, event.clientY);
                      }}
                    >
                      {lines.join('\n')}
                    </div>
                  );
                })
            : null}
          {captureStage === 'annotate' ? (
            <>
              {(
                [
                  { handle: 'nw', left: -6, top: -6 },
                  { handle: 'ne', left: selectionRect.width - 6, top: -6 },
                  { handle: 'sw', left: -6, top: selectionRect.height - 6 },
                  { handle: 'se', left: selectionRect.width - 6, top: selectionRect.height - 6 },
                  { handle: 'n', left: selectionRect.width / 2 - 5, top: -6 },
                  { handle: 's', left: selectionRect.width / 2 - 5, top: selectionRect.height - 6 },
                  { handle: 'w', left: -6, top: selectionRect.height / 2 - 5 },
                  { handle: 'e', left: selectionRect.width - 6, top: selectionRect.height / 2 - 5 },
                ] as const
              ).map((item) => (
                <button
                  key={`handle-${item.handle}`}
                  type='button'
                  className='pointer-events-auto absolute h-3 w-3 rounded-full border-2 border-white bg-primary shadow'
                  style={{ left: `${item.left}px`, top: `${item.top}px` }}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    beginResizeSelection(item.handle, event.clientX, event.clientY);
                  }}
                />
              ))}
            </>
          ) : null}
          <div className='absolute bottom-2 right-2 rounded-md bg-black/65 px-2 py-1 text-xs text-white'>
            {Math.round(selectionRect.width)} x {Math.round(selectionRect.height)}
          </div>
        </div>
      ) : null}

      {selectionRect && textEditor ? (
        <div
          className='absolute z-30'
          style={{
            left: `${selectionRect.left + textEditor.x}px`,
            top: `${selectionRect.top + textEditor.y}px`,
            width: `${TEXT_BOX_WIDTH}px`,
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <textarea
            ref={textEditorRef}
            wrap='soft'
            className='h-full w-full resize-none border-none bg-transparent p-0 text-[18px] font-semibold leading-[1.35] outline-none'
            style={{ WebkitTextFillColor: activeColor, caretColor: activeColor, color: activeColor }}
            value={textEditor.text}
            onChange={(event) => {
              const element = event.target;
              element.style.height = '0px';
              element.style.height = `${Math.max(TEXT_FONT_SIZE * TEXT_LINE_HEIGHT, element.scrollHeight)}px`;
              setTextEditor((current) => (current ? { ...current, text: element.value } : current));
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                commitTextEditor();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setTextEditor(null);
              }
            }}
            placeholder='Input text'
          />
        </div>
      ) : null}

      {toolbarStyle ? (
        <div
          className='absolute z-20 flex items-center gap-2 rounded-2xl border border-black/10 bg-base-100/95 px-3 py-2 shadow-xl backdrop-blur'
          style={toolbarStyle}
          onPointerDown={(event) => {
            if (textEditorStateRef.current) {
              commitPendingTextEditorNow();
            }
            event.stopPropagation();
          }}
          onPointerUp={(event) => event.stopPropagation()}
        >
          <div className='flex items-center gap-1 rounded-xl bg-base-200/80 p-1'>
            <button
              type='button'
              className={`btn btn-sm btn-ghost ${activeTool === 'rect' ? 'bg-base-100 shadow-sm' : ''}`}
              onClick={() => setActiveTool('rect')}
            >
              <LuSquare className='size-4' />
            </button>
            <button
              type='button'
              className={`btn btn-sm btn-ghost ${activeTool === 'arrow' ? 'bg-base-100 shadow-sm' : ''}`}
              onClick={() => setActiveTool('arrow')}
            >
              <LuArrowRight className='size-4' />
            </button>
            <button
              type='button'
              className={`btn btn-sm btn-ghost ${activeTool === 'pen' ? 'bg-base-100 shadow-sm' : ''}`}
              onClick={() => setActiveTool('pen')}
            >
              <LuPenLine className='size-4' />
            </button>
            <button
              type='button'
              className={`btn btn-sm btn-ghost ${activeTool === 'text' ? 'bg-base-100 shadow-sm' : ''}`}
              onClick={() => setActiveTool('text')}
            >
              <LuType className='size-4' />
            </button>
          </div>
          <div className='flex items-center gap-2 px-1'>
            {ANNOTATION_COLORS.map((color) => (
              <button
                key={color}
                type='button'
                className={`h-6 w-6 rounded-full border-2 ${activeColor === color ? 'border-base-content scale-110' : 'border-white/70'}`}
                style={{ backgroundColor: color }}
                onClick={() => setActiveColor(color)}
              />
            ))}
          </div>
          <div className='h-7 w-px bg-base-300' />
          <button type='button' className='btn btn-sm btn-ghost' onClick={() => undoLastCaptureAction()} disabled={annotations.length === 0 && !draftAnnotation && !textEditor}>
            <LuUndo2 className='size-4' />
          </button>
          <button type='button' className='btn btn-sm btn-ghost text-error' onClick={() => void emitCancel()}>
            <LuX className='size-4' />
          </button>
          <button type='button' className='btn btn-sm btn-ghost text-success' onClick={() => void emitSelection()}>
            <LuCheck className='size-4' />
          </button>
        </div>
      ) : null}

      <div className='pointer-events-none absolute left-1/2 top-6 -translate-x-1/2 rounded-full bg-base-100/90 px-4 py-2 text-sm shadow'>
        {!imageReady
          ? 'Preparing capture...'
          : captureStage === 'select'
            ? 'Drag to capture an area. Release to finish. Press Esc to cancel.'
            : 'Annotate the captured area, then confirm. Press Esc to cancel.'}
      </div>
      {captureStage === 'select' ? (
        <button
          type='button'
          className='btn btn-sm btn-outline absolute right-4 top-4'
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onClick={() => void emitCancel()}
        >
          Cancel
        </button>
      ) : null}
    </main>
  );
}
