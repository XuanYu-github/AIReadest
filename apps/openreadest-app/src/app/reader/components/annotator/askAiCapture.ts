export type CaptureMode = 'native' | 'pdf-canvas' | 'surface' | 'approximate-dom' | 'text';

export type CaptureRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type ReaderFrameCaptureInfo = {
  iframe: Element;
  rect: CaptureRect;
  index?: number | null;
  doc?: Document | null;
};

export type RankedCaptureFrame<T extends ReaderFrameCaptureInfo> = {
  frame: T;
  hitCount: number;
  innerHitCount: number;
  intersectionArea: number;
  isPrimary: boolean;
  reason: 'hit-test' | 'primary-intersection' | 'intersection-fallback';
};

export type CapturePoint = {
  x: number;
  y: number;
};

export type CaptureSize = {
  width: number;
  height: number;
};

export type NativeCaptureGeometry = {
  contentOrigin: CapturePoint;
  contentSize: CaptureSize;
  cropRect: CaptureRect;
  scaleX: number;
  scaleY: number;
  sourceKind: 'webview' | 'window' | 'monitor';
};

export type ScreenshotableWindowCandidate = {
  id: number;
  name: string;
  title: string;
  appName: string;
};

type HitTestOptions<T extends ReaderFrameCaptureInfo> = {
  primaryIndex?: number | null;
  rootHitTest?: (x: number, y: number) => Element[];
  frameHitTest?: (frame: T, x: number, y: number) => Element[];
};

const getIntersectionArea = (a: CaptureRect, b: CaptureRect) => {
  const interLeft = Math.max(a.left, b.left);
  const interTop = Math.max(a.top, b.top);
  const interRight = Math.min(a.left + a.width, b.left + b.width);
  const interBottom = Math.min(a.top + a.height, b.top + b.height);
  const interWidth = Math.max(0, interRight - interLeft);
  const interHeight = Math.max(0, interBottom - interTop);
  return interWidth * interHeight;
};

const uniqueNumbers = (values: number[]) =>
  Array.from(new Set(values.map((value) => Math.round(value * 1000) / 1000)));

export const getSelectionSamplePoints = (rect: CaptureRect, inset = 2) => {
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  const safeInsetX = Math.min(Math.max(0.5, inset), Math.max(0.5, rect.width / 2));
  const safeInsetY = Math.min(Math.max(0.5, inset), Math.max(0.5, rect.height / 2));
  const xPositions = uniqueNumbers([rect.left + safeInsetX, rect.left + rect.width / 2, right - safeInsetX]);
  const yPositions = uniqueNumbers([rect.top + safeInsetY, rect.top + rect.height / 2, bottom - safeInsetY]);

  return yPositions.flatMap((y) => xPositions.map((x) => ({ x, y })));
};

const nearlyEqual = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export const getNativeCaptureGeometry = ({
  screenshotSize,
  webviewSize,
  webviewPosition,
  viewportSize,
  selectionRect,
  windowOuterPosition,
  windowOuterSize,
  tolerance = 4,
}: {
  screenshotSize: CaptureSize;
  webviewSize: CaptureSize;
  webviewPosition: CapturePoint;
  viewportSize: CaptureSize;
  selectionRect: CaptureRect;
  windowOuterPosition?: CapturePoint | null;
  windowOuterSize?: CaptureSize | null;
  tolerance?: number;
}): NativeCaptureGeometry => {
  const screenshotMatchesWebview =
    nearlyEqual(screenshotSize.width, webviewSize.width, tolerance) &&
    nearlyEqual(screenshotSize.height, webviewSize.height, tolerance);
  const screenshotMatchesOuter =
    windowOuterSize != null &&
    nearlyEqual(screenshotSize.width, windowOuterSize.width, tolerance) &&
    nearlyEqual(screenshotSize.height, windowOuterSize.height, tolerance);

  let contentOrigin: CapturePoint = { x: 0, y: 0 };
  let contentSize: CaptureSize = { ...screenshotSize };
  let sourceKind: 'webview' | 'window' | 'monitor' = 'webview';

  if (!screenshotMatchesWebview && windowOuterPosition && screenshotMatchesOuter) {
    sourceKind = 'window';
    contentOrigin = {
      x: clamp(webviewPosition.x - windowOuterPosition.x, 0, screenshotSize.width),
      y: clamp(webviewPosition.y - windowOuterPosition.y, 0, screenshotSize.height),
    };
    contentSize = {
      width: Math.max(1, Math.min(webviewSize.width, screenshotSize.width - contentOrigin.x)),
      height: Math.max(1, Math.min(webviewSize.height, screenshotSize.height - contentOrigin.y)),
    };
  }

  const scaleX = contentSize.width / Math.max(1, viewportSize.width);
  const scaleY = contentSize.height / Math.max(1, viewportSize.height);
  const cropLeft = clamp(Math.round(contentOrigin.x + selectionRect.left * scaleX), 0, Math.max(0, screenshotSize.width - 1));
  const cropTop = clamp(Math.round(contentOrigin.y + selectionRect.top * scaleY), 0, Math.max(0, screenshotSize.height - 1));
  const cropWidth = clamp(Math.round(selectionRect.width * scaleX), 1, Math.max(1, screenshotSize.width - cropLeft));
  const cropHeight = clamp(Math.round(selectionRect.height * scaleY), 1, Math.max(1, screenshotSize.height - cropTop));

  return {
    contentOrigin,
    contentSize,
    cropRect: { left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight },
    scaleX,
    scaleY,
    sourceKind,
  };
};

export const getMonitorCaptureGeometry = ({
  screenshotSize,
  monitorPosition,
  windowOuterPosition,
  webviewPosition,
  webviewSize,
  viewportSize,
  selectionRect,
}: {
  screenshotSize: CaptureSize;
  monitorPosition: CapturePoint;
  windowOuterPosition: CapturePoint;
  webviewPosition: CapturePoint;
  webviewSize: CaptureSize;
  viewportSize: CaptureSize;
  selectionRect: CaptureRect;
}): NativeCaptureGeometry => {
  const contentOrigin = {
    x: clamp(windowOuterPosition.x - monitorPosition.x + webviewPosition.x, 0, screenshotSize.width),
    y: clamp(windowOuterPosition.y - monitorPosition.y + webviewPosition.y, 0, screenshotSize.height),
  };
  const contentSize = {
    width: Math.max(1, Math.min(webviewSize.width, screenshotSize.width - contentOrigin.x)),
    height: Math.max(1, Math.min(webviewSize.height, screenshotSize.height - contentOrigin.y)),
  };
  const scaleX = contentSize.width / Math.max(1, viewportSize.width);
  const scaleY = contentSize.height / Math.max(1, viewportSize.height);
  const cropLeft = clamp(Math.round(contentOrigin.x + selectionRect.left * scaleX), 0, Math.max(0, screenshotSize.width - 1));
  const cropTop = clamp(Math.round(contentOrigin.y + selectionRect.top * scaleY), 0, Math.max(0, screenshotSize.height - 1));
  const cropWidth = clamp(Math.round(selectionRect.width * scaleX), 1, Math.max(1, screenshotSize.width - cropLeft));
  const cropHeight = clamp(Math.round(selectionRect.height * scaleY), 1, Math.max(1, screenshotSize.height - cropTop));

  return {
    contentOrigin,
    contentSize,
    cropRect: { left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight },
    scaleX,
    scaleY,
    sourceKind: 'monitor',
  };
};

const normalizeCandidateText = (value?: string | null) => (value || '').trim().toLowerCase();

const hasMeaningfulText = (value?: string | null) => normalizeCandidateText(value).length > 0;

const compactCandidateTexts = (values: Array<string | null | undefined>): string[] =>
  values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

const matchesCandidateText = (candidate: ScreenshotableWindowCandidate, targets: string[]) => {
  const normalizedTargets = targets.filter(hasMeaningfulText).map((target) => normalizeCandidateText(target));
  if (normalizedTargets.length === 0) return false;

  const texts = [candidate.name, candidate.title, candidate.appName]
    .filter(hasMeaningfulText)
    .map((value) => normalizeCandidateText(value));

  return normalizedTargets.some((target) => texts.some((text) => text === target || text.includes(target) || target.includes(text)));
};

export const pickScreenshotWindow = ({
  candidates,
  windowLabel,
  windowTitle,
  documentTitle,
  preferredAppName,
}: {
  candidates: ScreenshotableWindowCandidate[];
  windowLabel?: string | null;
  windowTitle?: string | null;
  documentTitle?: string | null;
  preferredAppName?: string | null;
}) => {
  if (candidates.length === 0) return null;

  const exactLabel = normalizeCandidateText(windowLabel);
  if (exactLabel) {
    const byExactName = candidates.find((candidate) => normalizeCandidateText(candidate.name) === exactLabel);
    if (byExactName) return byExactName;
  }

  const titleMatches = candidates.filter((candidate) =>
    matchesCandidateText(candidate, compactCandidateTexts([windowTitle, documentTitle])),
  );
  if (titleMatches.length === 1) return titleMatches[0];

  const appNameMatches = candidates.filter((candidate) =>
    matchesCandidateText(candidate, compactCandidateTexts([preferredAppName, 'AIReadest', 'OpenReadest', 'Readest'])),
  );
  if (appNameMatches.length === 1) return appNameMatches[0];

  if (titleMatches.length > 1) {
    const titleAndAppMatch = titleMatches.find((candidate) =>
      matchesCandidateText(candidate, compactCandidateTexts([preferredAppName, 'AIReadest', 'OpenReadest', 'Readest'])),
    );
    if (titleAndAppMatch) return titleAndAppMatch;
  }

  if (appNameMatches.length > 0) return appNameMatches[0];
  if (titleMatches.length > 0) return titleMatches[0];
  if (candidates.length === 1) return candidates[0];
  return null;
};

const sortRankedFrames = <T extends ReaderFrameCaptureInfo>(a: RankedCaptureFrame<T>, b: RankedCaptureFrame<T>) => {
  return (
    b.hitCount - a.hitCount ||
    b.innerHitCount - a.innerHitCount ||
    Number(b.isPrimary) - Number(a.isPrimary) ||
    b.intersectionArea - a.intersectionArea
  );
};

export const rankFramesForCapture = <T extends ReaderFrameCaptureInfo>(
  frames: T[],
  selectionRect: CaptureRect,
  { primaryIndex = null, rootHitTest, frameHitTest }: HitTestOptions<T> = {},
): RankedCaptureFrame<T>[] => {
  if (frames.length === 0) return [];

  const rootElementsFromPoint =
    rootHitTest ??
    ((x: number, y: number) => (typeof document.elementsFromPoint === 'function' ? document.elementsFromPoint(x, y) : []));

  const frameElementsFromPoint =
    frameHitTest ??
    ((frame: T, x: number, y: number) => {
      if (typeof frame.doc?.elementsFromPoint === 'function') {
        return frame.doc.elementsFromPoint(x, y);
      }
      return [];
    });

  const rankedByFrame = new Map<T, RankedCaptureFrame<T>>(
    frames.map((frame) => [
      frame,
      {
        frame,
        hitCount: 0,
        innerHitCount: 0,
        intersectionArea: getIntersectionArea(frame.rect, selectionRect),
        isPrimary: frame.index != null && primaryIndex != null && frame.index === primaryIndex,
        reason: 'intersection-fallback',
      },
    ]),
  );

  for (const point of getSelectionSamplePoints(selectionRect)) {
    const hitElements = rootElementsFromPoint(point.x, point.y);
    if (hitElements.length === 0) continue;

    for (const frame of frames) {
      if (!hitElements.includes(frame.iframe)) continue;
      const ranked = rankedByFrame.get(frame);
      if (!ranked) continue;

      ranked.hitCount += 1;
      ranked.reason = 'hit-test';

      const localX = point.x - frame.rect.left;
      const localY = point.y - frame.rect.top;
      if (localX < 0 || localY < 0 || localX > frame.rect.width || localY > frame.rect.height) continue;

      if (frameElementsFromPoint(frame, localX, localY).length > 0) {
        ranked.innerHitCount += 1;
      }
    }
  }

  const hitTestMatches = Array.from(rankedByFrame.values())
    .filter((ranked) => ranked.hitCount > 0)
    .sort(sortRankedFrames);
  if (hitTestMatches.length > 0) return hitTestMatches;

  const intersectingFrames = Array.from(rankedByFrame.values()).filter((ranked) => ranked.intersectionArea > 0);
  if (intersectingFrames.length === 0) return Array.from(rankedByFrame.values()).sort(sortRankedFrames);

  const primaryIntersecting = intersectingFrames.find((ranked) => ranked.isPrimary);
  if (primaryIntersecting) {
    primaryIntersecting.reason = 'primary-intersection';
    return [primaryIntersecting, ...intersectingFrames.filter((ranked) => ranked !== primaryIntersecting).sort(sortRankedFrames)];
  }

  return intersectingFrames.sort(sortRankedFrames);
};
