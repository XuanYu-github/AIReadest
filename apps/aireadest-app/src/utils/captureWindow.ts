import { invoke } from '@tauri-apps/api/core';
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi';
import { currentMonitor, getAllWindows } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

const CAPTURE_WINDOW_LABEL = 'capture-draw';
const TAURI_DEV_SERVER_URL = 'http://localhost:3000';
let captureWindowTargetLabel: string | null = null;
let captureWindowPendingTargetLabel: string | null = null;
let captureWindowPromise: Promise<WebviewWindow> | null = null;

type CaptureWindowLike = {
  label: string;
  setPosition: (position: PhysicalPosition) => Promise<unknown>;
  setSize: (size: PhysicalSize) => Promise<unknown>;
  show: () => Promise<unknown>;
  hide: () => Promise<unknown>;
  setFocus: () => Promise<unknown>;
  close: () => Promise<unknown>;
};

type ShowCaptureWindowOptions = {
  visible?: boolean;
};

const isWindowNotFoundError = (error: unknown) => {
  if (error instanceof Error) {
    return error.message.toLowerCase().includes('window not found');
  }

  if (typeof error === 'string') {
    return error.toLowerCase().includes('window not found');
  }

  return false;
};

const ignoreWindowNotFound = (error: unknown) => {
  if (isWindowNotFoundError(error)) {
    return undefined;
  }

  throw error;
};

const resolveWindowUrl = (url: string) => {
  if (typeof window === 'undefined') return url;
  const isLocalDevServer = window.location.origin.startsWith(TAURI_DEV_SERVER_URL);
  return isLocalDevServer ? `${TAURI_DEV_SERVER_URL}${url}` : url;
};

const getCaptureWindow = async (): Promise<CaptureWindowLike | null> => {
  return (await getAllWindows()).find((win) => win.label === CAPTURE_WINDOW_LABEL) ?? null;
};

const setCaptureWindowBounds = async (win: CaptureWindowLike) => {
  const monitor = await currentMonitor().catch(() => null);
  if (!monitor) return;

  const position = new PhysicalPosition(monitor.position.x, monitor.position.y);
  const size = new PhysicalSize(monitor.size.width, monitor.size.height);

  await Promise.all([win.setPosition(position), win.setSize(size)]).catch(ignoreWindowNotFound);
  await Promise.all([win.setPosition(position), win.setSize(size)]).catch(ignoreWindowNotFound);
};

const createCaptureWindow = async (targetLabel: string) => {
  const query = new URLSearchParams({ target: targetLabel });
  const win = new WebviewWindow(CAPTURE_WINDOW_LABEL, {
    url: resolveWindowUrl(`/capture?${query.toString()}`),
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    decorations: false,
    shadow: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    visible: false,
    focus: false,
    title: 'AIReadest Capture',
  });

  await new Promise<void>((resolve, reject) => {
    win.once('tauri://created', () => resolve());
    win.once('tauri://error', (error) => reject(error));
  });

  captureWindowTargetLabel = targetLabel;
  await invoke('disable_capture_window_transitions', { label: CAPTURE_WINDOW_LABEL }).catch(() => undefined);
  await setCaptureWindowBounds(win);
  await win.hide().catch(ignoreWindowNotFound);
  return win;
};

const ensureCaptureWindow = async (targetLabel: string) => {
  if (captureWindowPromise && (captureWindowTargetLabel === targetLabel || captureWindowPendingTargetLabel === targetLabel)) {
    return await captureWindowPromise;
  }

  const existing = await getCaptureWindow();
  if (existing && captureWindowTargetLabel === targetLabel) {
    await setCaptureWindowBounds(existing);
    return existing;
  }

  if (existing) {
    await existing.close().catch(ignoreWindowNotFound);
  }

  captureWindowPendingTargetLabel = targetLabel;
  captureWindowPromise = createCaptureWindow(targetLabel);

  try {
    return await captureWindowPromise;
  } finally {
    captureWindowPendingTargetLabel = null;
    captureWindowPromise = null;
  }
};

export const showCaptureWindow = async (targetLabel: string, options: ShowCaptureWindowOptions = {}) => {
  const win = await ensureCaptureWindow(targetLabel);
  await setCaptureWindowBounds(win);

  if (options.visible ?? true) {
    await win.show().catch(ignoreWindowNotFound);
    await win.setFocus().catch(ignoreWindowNotFound);
  } else {
    await win.hide().catch(ignoreWindowNotFound);
  }

  return win;
};

export const revealCaptureWindow = async () => {
  const existing = await getCaptureWindow();
  if (!existing) return;

  await setCaptureWindowBounds(existing).catch(ignoreWindowNotFound);
  await existing.show().catch(ignoreWindowNotFound);
  await existing.setFocus().catch(ignoreWindowNotFound);
};

export const hideCaptureWindow = async () => {
  const existing = await getCaptureWindow();
  if (!existing) return;

  await existing.hide().catch(ignoreWindowNotFound);
};

export const closeCaptureWindow = async () => {
  captureWindowTargetLabel = null;
  captureWindowPendingTargetLabel = null;
  captureWindowPromise = null;
  const existing = await getCaptureWindow();
  if (existing) {
    await existing.close().catch(ignoreWindowNotFound);
  }
};

export const CAPTURE_WINDOW_ROUTE = '/capture';
