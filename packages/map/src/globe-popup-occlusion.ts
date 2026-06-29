import type maplibregl from "maplibre-gl";

/** JS-observable marker for occluded popups; visual hiding is applied inline. */
export const GLOBE_POPUP_OCCLUDED_CLASS = "geolibre-globe-popup-occluded";

const PATCHED_POPUP_MARKER = "__geolibreGlobePopupOcclusionPatched";
const DEFAULT_OCCLUDED_OPACITY = 0;

type PopupConstructor = new (
  options?: maplibregl.PopupOptions,
) => maplibregl.Popup;

type PatchablePopupConstructor = PopupConstructor & {
  [PATCHED_POPUP_MARKER]?: true;
};

interface PatchableMapLibre {
  Popup: PatchablePopupConstructor;
}

interface PopupInternals {
  _container?: HTMLElement;
  _map?: {
    transform?: {
      isLocationOccluded?: (lngLat: unknown) => boolean;
    };
  };
  _updateOpacity?: () => void;
  getLngLat: () => unknown;
  options?: {
    locationOccludedOpacity?: number | string;
  };
}

interface InteractiveStyles {
  pointerEvents: string;
  visibility: string;
}

const hiddenPopupStyles = new WeakMap<HTMLElement, InteractiveStyles>();

function shouldSuppressInteraction(popup: PopupInternals): boolean {
  const opacity = popup.options?.locationOccludedOpacity;
  // MapLibre accepts CSS opacity strings too; treat an explicit "0" like 0.
  return opacity === DEFAULT_OCCLUDED_OPACITY || opacity === "0";
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

export function syncPopupGlobeOcclusion(popup: maplibregl.Popup): boolean {
  const popupInternals = popup as unknown as PopupInternals;
  const container = popupInternals._container;
  const opacity = popupInternals.options?.locationOccludedOpacity;
  const transform = popupInternals._map?.transform;
  const isLocationOccluded = transform?.isLocationOccluded;

  if (!container || opacity === undefined) {
    if (container) setPopupOccluded(container, false);
    return false;
  }

  const lngLat = popupInternals.getLngLat();
  const occluded =
    Boolean(lngLat) && Boolean(isLocationOccluded?.call(transform, lngLat));
  container.style.opacity = occluded ? `${opacity}` : "";
  setPopupOccluded(
    container,
    occluded && shouldSuppressInteraction(popupInternals),
  );
  return occluded;
}

export function installGlobePopupOcclusion(
  maplibre: typeof maplibregl,
): void {
  const api = maplibre as unknown as PatchableMapLibre;
  const OriginalPopup = api.Popup;
  if (OriginalPopup[PATCHED_POPUP_MARKER]) return;

  class GeoLibrePopup extends OriginalPopup {
    constructor(options: maplibregl.PopupOptions = {}) {
      super({
        ...options,
        locationOccludedOpacity:
          options.locationOccludedOpacity ?? DEFAULT_OCCLUDED_OPACITY,
      });

      (this as unknown as PopupInternals)._updateOpacity = () => {
        syncPopupGlobeOcclusion(this);
      };
    }
  }

  GeoLibrePopup[PATCHED_POPUP_MARKER] = true;
  api.Popup = GeoLibrePopup;
}
