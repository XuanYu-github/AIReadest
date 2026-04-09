const getWebViewBridge = () => {
  const chrome = (window as Window & { chrome?: { webview?: any } }).chrome;
  return chrome?.webview;
};

export const supportWebViewSharedBuffer = () => {
  const webview = getWebViewBridge();
  return !!webview && typeof webview.addEventListener === 'function';
};

export const getWebViewSharedBuffer = (transferType: string): Promise<ArrayBuffer | undefined> => {
  if (!supportWebViewSharedBuffer()) {
    return Promise.resolve(undefined);
  }

  return new Promise((resolve) => {
    const webview = getWebViewBridge();
    if (!webview) {
      resolve(undefined);
      return;
    }

    const handler = (event: { getBuffer: () => ArrayBuffer; additionalData?: Record<string, unknown> }) => {
      if (event.additionalData?.['transfer_type'] !== transferType) {
        return;
      }

      window.clearTimeout(timeoutId);
      const buffer = event.getBuffer();
      webview.removeEventListener('sharedbufferreceived', handler);
      resolve(buffer);
    };

    const timeoutId = window.setTimeout(() => {
      webview.removeEventListener('sharedbufferreceived', handler);
      resolve(undefined);
    }, 3000);

    webview.addEventListener('sharedbufferreceived', handler);
  });
};

export const releaseWebViewSharedBuffer = (buffer: ArrayBuffer) => {
  const webview = getWebViewBridge();
  if (webview && typeof webview.releaseBuffer === 'function') {
    webview.releaseBuffer(buffer);
  }
};
