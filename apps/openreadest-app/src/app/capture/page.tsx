'use client';

import { flushSync } from 'react-dom';
import { useEffect, useMemo, useState } from 'react';
import { emitTo } from '@tauri-apps/api/event';
import { currentMonitor, getCurrentWindow } from '@tauri-apps/api/window';
import { isTauriAppPlatform } from '@/services/environment';

type SelectionRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

const normalizeRect = (startX: number, startY: number, endX: number, endY: number): SelectionRect => ({
  left: Math.min(startX, endX),
  top: Math.min(startY, endY),
  width: Math.abs(endX - startX),
  height: Math.abs(endY - startY),
});

export default function CapturePage() {
  const searchParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const targetLabel = searchParams.get('target') || 'main';
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);
  const [startPoint, setStartPoint] = useState<{ x: number; y: number } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const handleKeyDown = async (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isTauriAppPlatform()) {
        await emitTo(targetLabel, 'capture-window-cancel', {});
        await getCurrentWindow().close().catch(() => undefined);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [targetLabel]);

  return (
    <main
      className='relative min-h-screen cursor-crosshair bg-black/10 text-base-content'
      onPointerDown={(event) => {
        event.preventDefault();
        setStartPoint({ x: event.clientX, y: event.clientY });
        setSelectionRect({ left: event.clientX, top: event.clientY, width: 0, height: 0 });
      }}
      onPointerMove={(event) => {
        if (!startPoint) return;
        setSelectionRect(normalizeRect(startPoint.x, startPoint.y, event.clientX, event.clientY));
      }}
      onPointerUp={async () => {
        if (!selectionRect || selectionRect.width < 8 || selectionRect.height < 8) {
          setStartPoint(null);
          setSelectionRect(null);
          return;
        }

        flushSync(() => {
          setIsSubmitting(true);
        });
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

        const appWindow = getCurrentWindow();
        const monitor = await currentMonitor().catch(() => null);
        const [scaleFactor, outerPosition, outerSize, innerPosition, innerSize] = await Promise.all([
          appWindow.scaleFactor().catch(() => 1),
          appWindow.outerPosition().catch(() => null),
          appWindow.outerSize().catch(() => null),
          appWindow.innerPosition().catch(() => null),
          appWindow.innerSize().catch(() => null),
        ]);
        await emitTo(targetLabel, 'capture-window-selection', {
          rect: selectionRect,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          scaleFactor,
          windowOuterPosition: outerPosition,
          windowOuterSize: outerSize,
          windowInnerPosition: innerPosition,
          windowInnerSize: innerSize,
          monitor: monitor
            ? {
                name: monitor.name,
                position: monitor.position,
                size: monitor.size,
              }
            : null,
        });
        await getCurrentWindow().close().catch(() => undefined);
      }}
      style={{ display: isSubmitting ? 'none' : 'block' }}
    >
      <div className='pointer-events-none absolute inset-0 border border-white/10' />
      {selectionRect ? (
        <div
          className='pointer-events-none absolute border-2 border-primary bg-primary/10 shadow-[0_0_0_9999px_rgba(0,0,0,0.2)]'
          style={{
            left: `${selectionRect.left}px`,
            top: `${selectionRect.top}px`,
            width: `${selectionRect.width}px`,
            height: `${selectionRect.height}px`,
          }}
        />
      ) : null}
      <div className='pointer-events-none absolute left-1/2 top-6 -translate-x-1/2 rounded-full bg-base-100/90 px-4 py-2 text-sm shadow'>
        Drag to capture an area. Release to finish. Press Esc to cancel.
      </div>
    </main>
  );
}
