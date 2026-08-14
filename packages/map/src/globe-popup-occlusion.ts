import type { Popup, PopupOptions } from "maplibre-gl";

/** JS-observable marker for occluded popups; visual hiding is applied inline. */
export const GLOBE_POPUP_OCCLUDED_CLASS = "geolibre-globe-popup-occluded";

const DEFAULT_OCCLUDED_OPACITY = 0;
const ZERO_OPACITY_STRING = /^[+-]?(?:0+(?:\.0*)?|\.(?:0+))$/;

// Registered with Symbol.for so a second copy of this module (a duplicated
// @geolibre/map inside a plugin bundle) recognizes the first copy's work and
// does not wrap `addTo` — or a popup's `_updateOpacity` — twice.
const PATCHED_PROTOTYPE = Symbol.for("geolibre.globePopupOcclusion.patchedPrototype");
const INSTRUMENTED_POPUP = Symbol.for("geolibre.globePopupOcclusion.instrumentedPopup");

type PopupConstructor = new (options?: PopupOptions) => Popup;

/**
 * The slice of the MapLibre entry point this module touches.
 *
 * Typed structurally instead of as `typeof maplibregl` so it accepts both v5's
 * mutable default-export object and v6's ESM module namespace object.
 */
export interface MapLibrePopupNamespace {
  Popup: PopupConstructor;
}

interface PatchablePopupPrototype {
  addTo: (this: unknown, map: unknown) => unknown;
  [PATCHED_PROTOTYPE]?: true;
}

interface OccludableTransform {
  isLocationOccluded?: (lngLat: unknown) => boolean;
}

interface PopupHostMap {
  /** MapLibre v6: `Map` no longer extends `Camera`, so the transform moved here. */
  _camera?: { transform?: OccludableTransform };
  /** MapLibre v5: `Map extends Camera`, so the transform is on the map itself. */
  transform?: OccludableTransform;
}

interface PopupInternals {
  _container?: HTMLElement;
  _map?: PopupHostMap;
  _updateOpacity?: (...args: unknown[]) => void;
  getLngLat: () => unknown;
  options?: {
    locationOccludedOpacity?: number | string | null;
  };
  [INSTRUMENTED_POPUP]?: true;
}

interface InteractiveStyles {
  pointerEvents: string;
  visibility: string;
}

const hiddenPopupStyles = new WeakMap<HTMLElement, InteractiveStyles>();

/**
 * Resolve the transform MapLibre computes globe occlusion against.
 *
 * v6 split `Camera` out of `Map` and its own `Popup` reads
 * `_map._camera.transform`; v5 exposes `_map.transform` directly. Both are
 * checked because this module ships against either. Getting this wrong fails
 * silently — the occlusion check just never runs — so it stays in one place.
 */
function resolveOccludableTransform(
  map: PopupHostMap | undefined,
): OccludableTransform | undefined {
  return map?._camera?.transform ?? map?.transform;
}

function shouldSuppressInteraction(popup: PopupInternals): boolean {
  const opacity = popup.options?.locationOccludedOpacity;
  if (typeof opacity === "string") {
    const trimmedOpacity = opacity.trim();
    return ZERO_OPACITY_STRING.test(trimmedOpacity);
  }
  // Else branch is numeric; strict comparison avoids Number(null) === 0.
  return opacity === DEFAULT_OCCLUDED_OPACITY;
}

function restoreInteractiveStyles(container: HTMLElement): void {
  const previous = hiddenPopupStyles.get(container);
  if (!previous) return;
  container.style.pointerEvents = previous.pointerEvents;
  container.style.visibility = previous.visibility;
  hiddenPopupStyles.delete(container);
}

function setPopupOccluded(container: HTMLElement, occluded: boolean): void {
  container.classList.toggle(GLOBE_POPUP_OCCLUDED_CLASS, occluded);

  if (!occluded) {
    restoreInteractiveStyles(container);
    return;
  }

  if (!hiddenPopupStyles.has(container)) {
    hiddenPopupStyles.set(container, {
      pointerEvents: container.style.pointerEvents,
      visibility: container.style.visibility,
    });
  }
  container.style.pointerEvents = "none";
  container.style.visibility = "hidden";
}

export function syncPopupGlobeOcclusion(popup: Popup): boolean {
  const popupInternals = popup as unknown as PopupInternals;
  const container = popupInternals._container;
  const opacity = popupInternals.options?.locationOccludedOpacity;
  const transform = resolveOccludableTransform(popupInternals._map);
  const isLocationOccluded = transform?.isLocationOccluded;

  if (!container || opacity === undefined || opacity === null) {
    if (container) setPopupOccluded(container, false);
    return false;
  }

  const lngLat = popupInternals.getLngLat();
  const occluded = Boolean(lngLat) && Boolean(isLocationOccluded?.call(transform, lngLat));
  container.style.opacity = occluded ? `${opacity}` : "";
  setPopupOccluded(container, occluded && shouldSuppressInteraction(popupInternals));
  return occluded;
}

/**
 * Give one popup instance the occlusion behavior: opt it into MapLibre's own
 * occlusion math, then wrap the opacity update so the interaction suppression
 * and marker class ride along.
 *
 * MapLibre assigns `_updateOpacity` as an instance arrow inside the `Popup`
 * constructor, so it shadows anything installed on the prototype — the wrap has
 * to happen per instance rather than once on `Popup.prototype`.
 */
function instrumentPopup(popup: PopupInternals): void {
  if (popup[INSTRUMENTED_POPUP]) return;
  popup[INSTRUMENTED_POPUP] = true;

  // MapLibre skips the occlusion check entirely unless this option is set, so
  // default it on every popup — including ones a plugin constructed itself.
  if (popup.options) {
    popup.options.locationOccludedOpacity ??= DEFAULT_OCCLUDED_OPACITY;
  }

  const updateOpacity = popup._updateOpacity;
  popup._updateOpacity = (...args: unknown[]) => {
    if (popup.getLngLat()) updateOpacity?.apply(popup, args);
    syncPopupGlobeOcclusion(popup as unknown as Popup);
  };
}

/**
 * Install globe-occlusion behavior on every MapLibre popup, including ones
 * constructed by third-party plugins.
 *
 * This patches `Popup.prototype.addTo` rather than replacing `maplibre.Popup`.
 * A v6 module namespace object is sealed and rejects assignment
 * (`TypeError: Cannot assign to property 'Popup' of [object Module]`), while
 * the `Popup` class it exposes is an ordinary mutable object. Patching the
 * prototype also reaches consumers a namespace swap never could: plugins that
 * `import { Popup } from "maplibre-gl"` by name, and popups (or subclasses)
 * created before this runs.
 *
 * `addTo` is the hook because it is the one prototype method every popup goes
 * through on its way onto a map — `Marker#togglePopup` routes through it too —
 * and it wraps before MapLibre's own `_update()`/`_updateOpacity()` runs, so
 * the first painted frame is already correct.
 */
export function installGlobePopupOcclusion(maplibre: MapLibrePopupNamespace): void {
  const prototype = maplibre.Popup.prototype as unknown as PatchablePopupPrototype;
  if (prototype[PATCHED_PROTOTYPE]) return;

  const originalAddTo = prototype.addTo;
  prototype.addTo = function (this: unknown, map: unknown) {
    instrumentPopup(this as PopupInternals);
    return originalAddTo.call(this, map);
  };
  prototype[PATCHED_PROTOTYPE] = true;
}
