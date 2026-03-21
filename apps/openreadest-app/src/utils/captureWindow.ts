import { currentMonitor, getAllWindows, getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

const CAPTURE_WINDOW_LABEL = 'capture-draw';
const TAURI_DEV_SERVER_URL = 'http://localhost:3000';

const resolveWindowUrl = (url: string) => {
  if (typeof window === 'undefined') return url;
  const isLocalDevServer = window.location.origin.startsWith(TAURI_DEV_SERVER_URL);
  return isLocalDevServer ? `${TAURI_DEV_SERVER_URL}${url}` : url;
};

export const showCaptureWindow = async (targetLabel: string) => {
  const existing = (await getAllWindows()).find((win) => win.label === CAPTURE_WINDOW_LABEL);
  if (existing) {
    await existing.close().catch(() => undefined);
  }

  const currentWindow = getCurrentWindow();
  const monitor = await currentMonitor().catch(() => null);
  const position = monitor?.position;
  const size = monitor?.size;

  const win = new WebviewWindow(CAPTURE_WINDOW_LABEL, {
    url: resolveWindowUrl(`/capture?target=${encodeURIComponent(targetLabel)}`),
    x: position?.x,
    y: position?.y,
    width: size?.width ?? 1280,
    height: size?.height ?? 720,
    decorations: false,
    shadow: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    maximized: true,
    skipTaskbar: true,
    visible: true,
    focus: true,
    title: 'AIReadest Capture',
  });

  win.once('tauri://created', async () => {
    await win.setFocus();
  });

  win.once('tauri://error', (error) => {
    console.error('error creating capture window', error);
  });

  return win;
};

export const closeCaptureWindow = async () => {
  const existing = (await getAllWindows()).find((win) => win.label === CAPTURE_WINDOW_LABEL);
  if (existing) {
    await existing.close();
  }
};

export const CAPTURE_WINDOW_ROUTE = '/capture';
