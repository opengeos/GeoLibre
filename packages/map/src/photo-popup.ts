import { PHOTO_PROPERTY, PHOTO_FULL_PROPERTY, isInlineImageValue } from "@geolibre/core";

// The geotagged-photo popup (thumbnail, caption, fullscreen viewer). Plain DOM,
// shared by the MapLibre and Mapbox canvases.

/** Translatable strings of the photo popup and its fullscreen viewer. */
export interface PhotoPopupLabels {
  /** Alt text for a photo with no name. */
  photo: string;
  noPreview: string;
  viewFullResolution: string;
  viewFullscreen: string;
  close: string;
}

/** English fallbacks; the app passes translated labels. */
export const DEFAULT_PHOTO_POPUP_LABELS: PhotoPopupLabels = {
  photo: "Photo",
  noPreview: "No preview available",
  viewFullResolution: "Double-click to view at full resolution",
  viewFullscreen: "Double-click to view fullscreen",
  close: "Close",
};

/** `metadata.sourceKind` of a layer whose points open the photo popup on click. */
export const PHOTO_SOURCE_KIND = "geotagged-photos";

// Feature-property keys for geotagged/field-collection photos, from the shared
// @geolibre/core schema: the popup shows the light thumbnail while the fullscreen
// viewer and "Save image" use the embedded full-resolution image.
const PHOTO_THUMBNAIL_KEY = PHOTO_PROPERTY;
const PHOTO_FULL_KEY = PHOTO_FULL_PROPERTY;

/** Return the value at `key` when it is an inline raster image data URL. */
function imageDataUrlAt(properties: Record<string, unknown>, key: string): string | null {
  const value = properties[key];
  return isInlineImageValue(value) ? value : null;
}

/**
 * Find the first feature property holding an inline raster image (a geotagged
 * photo or field-collection thumbnail), returning its data URL or null. The
 * full-resolution key is skipped so this fallback never returns the heavy
 * original as if it were the light thumbnail (e.g. for a hand-edited feature
 * whose `photo` thumbnail is missing but `photo_full` is present).
 */
function findPhotoDataUrl(properties: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(properties)) {
    if (key !== PHOTO_FULL_KEY && isInlineImageValue(value)) {
      return value;
    }
  }
  return null;
}

/** How far past native resolution the fullscreen viewer can magnify (400%). */
const PHOTO_MAX_ZOOM_FRACTION = 4;
/** Per-wheel-notch zoom step. */
const PHOTO_ZOOM_STEP = 1.15;

/**
 * Open a photo in a fullscreen lightbox: a backdrop overlay with the image
 * centered and scaled to fit. The mouse wheel zooms in on the photo (up to 400%
 * of its native resolution) and, once zoomed past the fit, dragging pans it; a
 * badge reports the current zoom as a percentage of native resolution alongside
 * the source pixel dimensions. Uses the native Fullscreen API so it fills the
 * whole screen, falling back to a viewport-filling overlay where fullscreen is
 * denied. Closes on the × button, a backdrop click, or Escape (double-click
 * toggles zoom rather than closing), or when the user leaves native fullscreen.
 *
 * @param src - The image data URL or URL (native resolution where available).
 * @param alt - Accessible label for the image.
 */
function openPhotoFullscreen(src: string, alt: string, closeLabel: string): void {
  const overlay = document.createElement("div");
  overlay.className = "geolibre-photo-fullscreen";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", alt);

  const image = document.createElement("img");
  image.src = src;
  image.alt = alt;
  image.className = "geolibre-photo-fullscreen-img";
  overlay.appendChild(image);

  const badge = document.createElement("div");
  badge.className = "geolibre-photo-fullscreen-badge";
  badge.setAttribute("aria-hidden", "true");
  overlay.appendChild(badge);

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "geolibre-photo-fullscreen-close";
  closeButton.setAttribute("aria-label", closeLabel);
  closeButton.textContent = "×";
  overlay.appendChild(closeButton);

  document.body.appendChild(overlay);
  // Move focus into the lightbox so keyboard and screen-reader users land on a
  // control inside it (and Escape/Enter act on the close button by default).
  closeButton.focus();

  // Zoom is a multiple of the fit-to-screen size (1 = fit). `tx`/`ty` translate
  // the image while panning a zoomed photo.
  let zoom = 1;
  let tx = 0;
  let ty = 0;
  // Set once the image loads: the fit-size-to-native ratio (so the badge can
  // report zoom as a fraction of native), and the fit and max zoom multiples.
  let fitToNative = 1;
  let maxZoom = PHOTO_MAX_ZOOM_FRACTION;

  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

  const applyTransform = () => {
    // Bound the pan so the image can't be dragged fully off-screen: the image is
    // centered, so keeping |tx|/|ty| within half its scaled size guarantees the
    // viewport centre always sits on the photo (and its double-click-to-reset
    // target stays reachable). clientWidth/Height are the fit-rendered size.
    const maxTx = (image.clientWidth * zoom) / 2;
    const maxTy = (image.clientHeight * zoom) / 2;
    tx = clamp(tx, -maxTx, maxTx);
    ty = clamp(ty, -maxTy, maxTy);
    image.style.transform = `translate(${tx}px, ${ty}px) scale(${zoom})`;
    image.classList.toggle("is-zoomed", zoom > 1.001);
    const nativePercent = Math.round(fitToNative * zoom * 100);
    badge.textContent =
      image.naturalWidth > 0
        ? `${nativePercent}% · ${image.naturalWidth} × ${image.naturalHeight}`
        : "";
  };

  const measure = () => {
    // clientWidth is the fit-rendered width (max-width/height:100%, aspect kept);
    // dividing by naturalWidth gives how much of native the fit view shows.
    fitToNative =
      image.naturalWidth > 0 && image.clientWidth > 0 ? image.clientWidth / image.naturalWidth : 1;
    // Cap magnification at PHOTO_MAX_ZOOM_FRACTION of native. The floor of 1
    // only guards the degenerate case where the image is somehow larger than the
    // fit (fitToNative > cap) so zoom never drops below the fit; in the normal
    // case (fitToNative <= 1, no upscaling) this is always the native-cap branch,
    // keeping the badge at exactly 400% of native at maximum zoom.
    maxZoom = Math.max(1, PHOTO_MAX_ZOOM_FRACTION / fitToNative);
    // A resize (or entering fullscreen) can grow the fit ratio and shrink
    // maxZoom below the current zoom; reclamp so the 400%-of-native cap holds
    // instead of rendering (and reporting) a now-out-of-range zoom.
    zoom = clamp(zoom, 1, maxZoom);
    if (zoom === 1) {
      tx = 0;
      ty = 0;
    }
    applyTransform();
  };
  if (image.complete && image.naturalWidth > 0) measure();
  else image.addEventListener("load", measure, { once: true });
  // The fit size (and thus the native-zoom ratio and 400% cap) depends on the
  // viewport, which changes when the browser window resizes or the viewer
  // enters/leaves native fullscreen, so remeasure on both.
  const onResize = () => measure();
  window.addEventListener("resize", onResize);

  const setZoom = (next: number) => {
    zoom = clamp(next, 1, maxZoom);
    if (zoom <= 1.001) {
      // Back at fit: recenter so a later zoom-in starts from the middle.
      zoom = 1;
      tx = 0;
      ty = 0;
    }
    applyTransform();
  };

  overlay.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      setZoom(zoom * (event.deltaY < 0 ? PHOTO_ZOOM_STEP : 1 / PHOTO_ZOOM_STEP));
    },
    { passive: false },
  );

  // Pan (one pointer) and pinch-zoom (two pointers). Touch devices have no
  // wheel, and `touch-action: none` disables native pinch, so drive the same
  // zoom/pan transform from raw pointer events here.
  const activePointers = new Map<number, { x: number; y: number }>();
  let lastX = 0;
  let lastY = 0;
  let pinchStartDist = 0;
  let pinchStartZoom = 1;
  const pointerSpread = () => {
    const [a, b] = [...activePointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  image.addEventListener("pointerdown", (event) => {
    // Track at most two pointers; a third (e.g. an accidental palm touch) is
    // ignored so it can't perturb the pan anchor or the pinch spread.
    if (activePointers.size >= 2) return;
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    // Arm pan/pinch state before capturing the pointer: setPointerCapture can
    // throw for a non-active pointer, and that must not skip the setup below.
    if (activePointers.size === 2) {
      pinchStartDist = pointerSpread();
      pinchStartZoom = zoom;
    } else {
      lastX = event.clientX;
      lastY = event.clientY;
    }
    try {
      image.setPointerCapture(event.pointerId);
    } catch {
      // The pointer is already gone; pan/pinch still work without capture.
    }
    // Only suppress the default for a mouse drag while zoomed, to stop the native
    // image ghost-drag during a pan. Touch gestures are already neutralized by
    // `touch-action: none` on the image, so we must NOT preventDefault there: on
    // pointerdown that would suppress the compatibility events a double-tap's
    // dblclick is synthesized from, breaking double-tap-to-zoom on touch. A plain
    // mouse click at fit is likewise left untouched so mouse double-click works.
    if (event.pointerType === "mouse" && zoom > 1) {
      event.preventDefault();
    }
  });
  image.addEventListener("pointermove", (event) => {
    if (!activePointers.has(event.pointerId)) return;
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activePointers.size >= 2) {
      const spread = pointerSpread();
      // Re-anchor if the initial spread was zero (both fingers landed on the
      // same spot), so pinch isn't stuck disabled for the rest of the gesture.
      if (pinchStartDist <= 0) {
        pinchStartDist = spread;
        pinchStartZoom = zoom;
      } else {
        setZoom((pinchStartZoom * spread) / pinchStartDist);
      }
      return;
    }
    // Single-pointer pan, only meaningful once zoomed past the fit.
    if (zoom <= 1) return;
    tx += event.clientX - lastX;
    ty += event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    applyTransform();
  });
  const endPointer = (event: PointerEvent) => {
    if (!activePointers.delete(event.pointerId)) return;
    if (image.hasPointerCapture(event.pointerId)) {
      image.releasePointerCapture(event.pointerId);
    }
    // Dropping from a pinch back to one finger: resume panning from the survivor
    // so the image doesn't jump on the next move.
    const [survivor] = [...activePointers.values()];
    if (survivor) {
      lastX = survivor.x;
      lastY = survivor.y;
    }
  };
  image.addEventListener("pointerup", endPointer);
  image.addEventListener("pointercancel", endPointer);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    window.removeEventListener("resize", onResize);
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    if (document.fullscreenElement === overlay) {
      void document.exitFullscreen().catch(() => {});
    }
    overlay.remove();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };
  const onFullscreenChange = () => {
    if (document.fullscreenElement === overlay) {
      // Entering fullscreen changes the rendered fit size; remeasure so the
      // badge percentage and the 400%-of-native cap track the new layout.
      requestAnimationFrame(measure);
    } else {
      // Leaving native fullscreen (Esc / F11) should also dismiss the overlay.
      close();
    }
  };

  closeButton.addEventListener("click", close);
  // Click the backdrop (but not the image) to dismiss.
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  // Double-click toggles between fit and 100% of native (or max, if native is
  // beyond the cap), rather than closing, so the viewer stays a zoom surface.
  image.addEventListener("dblclick", (event) => {
    event.preventDefault();
    setZoom(zoom > 1.001 ? 1 : Math.min(1 / fitToNative, maxZoom));
  });
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("fullscreenchange", onFullscreenChange);

  // Best-effort true fullscreen; the overlay already fills the viewport if the
  // request is unsupported or denied (e.g. inside a sandboxed embed).
  void overlay.requestFullscreen?.().catch(() => {});
}

/**
 * Build the geotagged-photo popup: a resizable box showing the photo scaled to
 * fill it, captioned with the photo's name and timestamp. The box uses CSS
 * `resize` so the user can drag its corner to enlarge the photo, and
 * double-clicking the photo opens it fullscreen. Photos with no thumbnail (e.g.
 * HEIC) fall back to a "No preview available" note.
 *
 * @param properties - The clicked feature's properties.
 * @param labels - Translated strings.
 * @returns The popup's DOM content element.
 */
export function createPhotoPopupElement(
  properties: Record<string, unknown>,
  labels: PhotoPopupLabels = DEFAULT_PHOTO_POPUP_LABELS,
): HTMLElement {
  const root = document.createElement("div");
  root.className = "geolibre-photo-popup";

  // The popup shows the light thumbnail; the fullscreen viewer prefers the
  // embedded full-resolution image (falling back to the thumbnail when no
  // original was embedded, e.g. a format that can't be shown at full size).
  const thumbnail = imageDataUrlAt(properties, PHOTO_THUMBNAIL_KEY) ?? findPhotoDataUrl(properties);
  if (thumbnail) {
    // Prefer the embedded full-resolution image, falling back to the thumbnail
    // when no original was embedded (TIFF/HEIC, mislabeled bytes, or an original
    // over the size ceiling); `thumbnail` is non-null here, so this is a string.
    const fullImage = imageDataUrlAt(properties, PHOTO_FULL_KEY);
    const fullResolution = fullImage ?? thumbnail;
    const image = document.createElement("img");
    image.src = thumbnail;
    image.alt = typeof properties.name === "string" ? properties.name : labels.photo;
    image.className = "geolibre-photo-popup-img";
    // Only promise "full resolution" when the native original is actually
    // embedded; otherwise the double-click just opens the thumbnail fullscreen.
    image.title = fullImage ? labels.viewFullResolution : labels.viewFullscreen;
    // Double-click (not single, so it never fights the resize drag) opens the
    // photo fullscreen. The image is popup DOM, not the map canvas, so this does
    // not trigger MapLibre's double-click zoom.
    image.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      openPhotoFullscreen(fullResolution, image.alt, labels.close);
    });
    root.appendChild(image);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "geolibre-photo-popup-placeholder";
    placeholder.textContent = labels.noPreview;
    root.appendChild(placeholder);
  }

  const caption = [properties.name, properties.timestamp]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join(" · ");
  if (caption) {
    const captionEl = document.createElement("div");
    captionEl.className = "geolibre-photo-popup-caption";
    captionEl.textContent = caption;
    captionEl.title = caption;
    root.appendChild(captionEl);
  }

  return root;
}
