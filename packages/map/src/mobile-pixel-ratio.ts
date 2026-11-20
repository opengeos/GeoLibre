/**
 * Mobile WebGL pixel ratio capping (GeoLibre#3537 Phase 5).
 *
 * High-DPR smartphones (3x–4x OLED displays) allocate 9x–16x as many WebGL
 * fragments as 1x, which increases battery drain and WebGL context loss on
 * tiled maps. Capping touch devices at 2x preserves retina sharpness while
 * cutting fragment fill rate by >55% on 3x devices.
 */

export const MAX_MOBILE_PIXEL_RATIO = 2;

export function resolveMapPixelRatio(options?: {
  devicePixelRatio?: number;
  isTouchDevice?: boolean;
}): number | undefined {
  const rawDpr =
    options?.devicePixelRatio ??
    (typeof window !== "undefined" ? window.devicePixelRatio : undefined);
  if (typeof rawDpr !== "number" || !Number.isFinite(rawDpr) || rawDpr <= 0) {
    return undefined;
  }
  const touch =
    options?.isTouchDevice ??
    (typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches);
  if (!touch) return rawDpr;
  return Math.min(rawDpr, MAX_MOBILE_PIXEL_RATIO);
}

/**
 * Subscribe to `window.devicePixelRatio` changes (moving across displays or
 * switching zoom/display modes) and invoke `onChange` with the resolved
 * pixel ratio (respecting the 2x mobile cap). Returns a cleanup callback.
 */
export function watchMapPixelRatio(
  onChange: (pixelRatio: number) => void,
  env?: {
    getDevicePixelRatio?: () => number;
    matchMedia?: (query: string) => {
      matches: boolean;
      addEventListener: (type: string, listener: () => void, options?: { once?: boolean }) => void;
      removeEventListener: (type: string, listener: () => void) => void;
    };
    isTouchDevice?: boolean;
  },
): () => void {
  const matchMediaFn =
    env?.matchMedia ??
    (typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? (q: string) => window.matchMedia(q)
      : undefined);
  const getDpr =
    env?.getDevicePixelRatio ??
    (typeof window !== "undefined" ? () => window.devicePixelRatio : undefined);
  if (!matchMediaFn || !getDpr) {
    return () => {};
  }
  let disposed = false;
  let activeMedia: ReturnType<typeof matchMediaFn> | null = null;
  let activeListener: (() => void) | null = null;
  const pointerMedia = env?.isTouchDevice === undefined ? matchMediaFn("(pointer: coarse)") : null;

  const resolveCurrent = () =>
    resolveMapPixelRatio({
      devicePixelRatio: getDpr(),
      isTouchDevice: env?.isTouchDevice ?? pointerMedia?.matches,
    });

  const detachResolution = () => {
    if (activeMedia && activeListener) {
      activeMedia.removeEventListener("change", activeListener);
    }
    activeMedia = null;
    activeListener = null;
  };

  const subscribeResolution = () => {
    detachResolution();
    if (disposed) return;
    const dpr = getDpr();
    if (!Number.isFinite(dpr) || dpr <= 0) return;
    const media = matchMediaFn(`(resolution: ${dpr}dppx)`);
    const onResolutionChange = () => {
      if (disposed) return;
      // Re-subscribe BEFORE invoking onChange so a throwing callback cannot
      // kill future DPR tracking.
      subscribeResolution();
      const resolved = resolveCurrent();
      if (resolved !== undefined) onChange(resolved);
    };
    activeMedia = media;
    activeListener = onResolutionChange;
    media.addEventListener("change", onResolutionChange, { once: true });
  };

  const onPointerChange = () => {
    if (disposed) return;
    const resolved = resolveCurrent();
    if (resolved !== undefined) onChange(resolved);
  };

  pointerMedia?.addEventListener("change", onPointerChange);
  subscribeResolution();
  return () => {
    disposed = true;
    detachResolution();
    pointerMedia?.removeEventListener("change", onPointerChange);
  };
}
