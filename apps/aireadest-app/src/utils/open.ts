import { openUrl } from '@tauri-apps/plugin-opener';
import { isTauriAppPlatform } from '@/services/environment';
import { openExternalUrlByNativeBridge } from '@/utils/bridge';

const WINDOW_OPEN_FEATURES = 'noopener,noreferrer';
const isAndroidWebView = () =>
  typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);

export const openExternalUrl = async (url: string, target = '_blank') => {
  if (!url) return false;

  if (isTauriAppPlatform() && isAndroidWebView()) {
    try {
      const result = await openExternalUrlByNativeBridge({ url });
      if (result.success) {
        return true;
      }
    } catch (error) {
      console.warn('Failed to open external URL via native bridge:', error);
    }
  }

  if (isTauriAppPlatform()) {
    try {
      await openUrl(url);
      return true;
    } catch (error) {
      console.warn('Failed to open external URL via native opener:', error);
    }
  }

  try {
    const openedWindow = window.open(url, target, WINDOW_OPEN_FEATURES);
    if (openedWindow || target !== '_blank') {
      return true;
    }
  } catch (error) {
    console.warn('Failed to open external URL via window.open:', error);
  }

  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.target = target;
    anchor.rel = 'noopener noreferrer';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    return true;
  } catch (error) {
    console.warn('Failed to open external URL via anchor fallback:', error);
  }

  if (target === '_blank') {
    return false;
  }

  window.location.href = url;
  return true;
};

export const interceptWindowOpen = () => {
  const windowOpen = window.open;
  globalThis.open = function (
    url?: string | URL,
    target?: string,
    features?: string,
  ): Window | null {
    if (isTauriAppPlatform()) {
      if (isAndroidWebView()) {
        openExternalUrlByNativeBridge({ url: url?.toString() || '' }).catch((error) => {
          console.warn('Failed to intercept window.open via native bridge:', error);
          windowOpen(url, target, features);
        });
        return null;
      }
      openUrl(url?.toString() || '').catch((error) => {
        console.warn('Failed to intercept window.open via native opener:', error);
        windowOpen(url, target, features);
      });
      return null;
    } else {
      return windowOpen(url, target, features);
    }
  };
};
