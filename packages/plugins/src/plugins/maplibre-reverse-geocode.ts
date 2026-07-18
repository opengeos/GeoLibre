import { geocodeReverse } from "@geolibre/core";
import type { Map as MapLibreMap, MapMouseEvent, Popup } from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

/**
 * Reverse geocoding: click the map to resolve a place/address, shown in a
 * popup with a copy-to-clipboard button.
 *
 * Toggled from the Controls menu (off by default). Coordinates of the clicked
 * point are sent to the configured geocoder (public Nominatim by default), so
 * the desktop shell surfaces a one-time privacy notice before first enabling
 * it, mirroring the Directions plugin.
 *
 * The popup is transient and is not persisted in the project. Like the
 * Directions plugin, this rebinds to the live map after a MapCanvas remount via
 * {@link restoreReverseGeocode}; it carries no project state of its own.
 */
export const REVERSE_GEOCODE_PLUGIN_ID = "maplibre-reverse-geocode";

let popup: Popup | null = null;
// The map the click handler is bound to, so restoreReverseGeocode can detect a
// map re-initialization (a brand-new Map object) and rebind.
let boundMap: MapLibreMap | null = null;
let clickHandler: ((event: MapMouseEvent) => void) | null = null;
let previousCursor = "";
// Bumped on every attach/teardown and before each lookup. A reverse lookup that
// resolves with a stale token (the user toggled off, or clicked again) is
// discarded so it does not render into a popup that is no longer current.
let lookupToken = 0;
// The in-flight reverse request. Aborted on the next click and on teardown so a
// burst of clicks does not leave several connections to the geocoder open.
let currentAbortController: AbortController | null = null;

/**
 * User-facing popup strings. Defaults are English; the desktop shell pushes
 * translated values via {@link setReverseGeocodeLabels} since this package is
 * framework-agnostic and has no direct access to react-i18next.
 */
export interface ReverseGeocodeLabels {
  lookingUp: string;
  noAddress: string;
  copyAddress: string;
  failed: string;
}

let labels: ReverseGeocodeLabels = {
  lookingUp: "Looking up address...",
  noAddress: "No address found.",
  copyAddress: "Copy address",
  failed: "Reverse geocoding failed.",
};

/** Override the popup strings (called from the app layer with translated text). */
export function setReverseGeocodeLabels(next: Partial<ReverseGeocodeLabels>): void {
  labels = { ...labels, ...next };
}

function buildPopupContent(title: string, body: string, copyLabel: string): HTMLElement {
  // Build a DOM node rather than an HTML string so the geocoder's returned text
  // is set via textContent (never parsed as HTML) and the copy button's handler
  // can be bound directly.
  const container = document.createElement("div");
  container.style.maxWidth = "260px";
  container.style.font = "13px/1.4 system-ui, sans-serif";

  const text = document.createElement("div");
  text.textContent = body;
  text.style.marginBottom = "6px";
  container.appendChild(text);

  if (title) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = copyLabel;
    button.style.cursor = "pointer";
    button.style.fontSize = "12px";
    button.addEventListener("click", () => {
      void navigator.clipboard?.writeText(title).then(
        () => {
          button.textContent = "✓";
        },
        () => {
          /* Clipboard denied (e.g. insecure context); leave the label as is. */
        },
      );
    });
    container.appendChild(button);
  }

  return container;
}

/**
 * Resolve and render the address for a clicked point. The maplibre-gl `Popup`
 * class is lazy-imported (mirroring how the Directions plugin defers its heavy
 * library) so this module stays free of a runtime maplibre-gl dependency; the
 * import resolves from cache instantly since the app already loaded maplibre-gl
 * for the map.
 */
async function showReverseGeocodePopup(
  map: MapLibreMap,
  lng: number,
  lat: number,
  requestToken: number,
  signal: AbortSignal,
): Promise<void> {
  const { Popup } = await import("maplibre-gl");
  // A teardown or a newer click during the import supersedes this lookup.
  if (requestToken !== lookupToken) return;
  popup?.remove();
  popup = new Popup({ closeButton: true, closeOnClick: false })
    .setLngLat([lng, lat])
    .setText(labels.lookingUp)
    .addTo(map);

  try {
    const resolved = await geocodeReverse(lng, lat, { signal });
    if (requestToken !== lookupToken || !popup) return;
    const label = resolved?.displayName ?? labels.noAddress;
    popup.setDOMContent(buildPopupContent(resolved?.displayName ?? "", label, labels.copyAddress));
  } catch {
    // A superseded/aborted request fails the token check and is ignored; only a
    // still-current failure surfaces the error text.
    if (requestToken !== lookupToken || !popup) return;
    popup.setText(labels.failed);
  }
}

function attach(app: GeoLibreAppAPI): void {
  const map = app.getMap?.();
  if (!map) return;
  if (boundMap === map && clickHandler) return; // already bound to this map

  previousCursor = map.getCanvas().style.cursor;
  map.getCanvas().style.cursor = "crosshair";

  clickHandler = (event: MapMouseEvent) => {
    const requestToken = ++lookupToken;
    // Cancel any request from a previous click before starting a new one.
    currentAbortController?.abort();
    currentAbortController = new AbortController();
    void showReverseGeocodePopup(
      map,
      event.lngLat.lng,
      event.lngLat.lat,
      requestToken,
      currentAbortController.signal,
    );
  };

  map.on("click", clickHandler);
  boundMap = map;
}

function teardown(app: GeoLibreAppAPI): void {
  ++lookupToken;
  // Cancel an in-flight reverse request so it does not complete after the tool
  // is disabled.
  currentAbortController?.abort();
  currentAbortController = null;
  const map = boundMap ?? app.getMap?.() ?? null;
  if (map && clickHandler) {
    map.off("click", clickHandler);
    map.getCanvas().style.cursor = previousCursor;
  }
  clickHandler = null;
  popup?.remove();
  popup = null;
  boundMap = null;
}

/**
 * Keep the reverse-geocode click handler bound to the current map after a map
 * re-init. Mirrors `restoreDirections`: the desktop shell calls this after
 * restoring plugin state. Idempotent.
 */
export function restoreReverseGeocode(app: GeoLibreAppAPI, active: boolean): void {
  if (!active) {
    teardown(app);
    return;
  }
  const map = app.getMap?.();
  if (boundMap && boundMap === map && clickHandler) return; // already bound
  teardown(app);
  attach(app);
}

export const maplibreReverseGeocodePlugin: GeoLibrePlugin = {
  id: REVERSE_GEOCODE_PLUGIN_ID,
  name: "Reverse Geocode",
  version: "1.0.0",
  activate: (app: GeoLibreAppAPI) => attach(app),
  deactivate: (app: GeoLibreAppAPI) => teardown(app),
};
