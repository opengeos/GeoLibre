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
export function watchMapPixelRatio(onChange: (pixelRatio: number) => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  let disposed = false;
  let activeMedia: MediaQueryList | null = null;
  let activeListener: (() => void) | null = null;

  const detach = () => {
    if (activeMedia && activeListener) {
      activeMedia.removeEventListener("change", activeListener);
    }
    activeMedia = null;
    activeListener = null;
  };

  const subscribe = () => {
    detach();
    if (disposed) return;
    const dpr = window.devicePixelRatio;
    if (!Number.isFinite(dpr) || dpr <= 0) return;
    const media = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onResolutionChange = () => {
      if (disposed) return;
      const resolved = resolveMapPixelRatio();
      if (resolved !== undefined) onChange(resolved);
      subscribe();
    };
    activeMedia = media;
    activeListener = onResolutionChange;
    media.addEventListener("change", onResolutionChange, { once: true });
  };

  subscribe();
  return () => {
    disposed = true;
    detach();
  };
}
