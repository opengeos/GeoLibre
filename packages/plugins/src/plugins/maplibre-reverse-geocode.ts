import { geocodeReverse } from "@geolibre/core";
import type { MapEngineClient } from "@geolibre/map";
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
const REVERSE_GEOCODE_POPUP_ID = "geolibre-reverse-geocode-popup";

// The MapEngine client the click handler is bound to, so restoreReverseGeocode
// can detect a map re-initialization and rebind without seeing a native map.
let boundMap: MapEngineClient | null = null;
let unsubscribeClick: (() => void) | null = null;
let cursorElement: HTMLElement | null = null;
let previousCursor = "";
let popupVisible = false;
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
 * Render a renderer-neutral popup and track user closure so a delayed lookup
 * result cannot reopen it.
 */
function renderReverseGeocodePopup(
  map: MapEngineClient,
  lng: number,
  lat: number,
  content: HTMLElement,
  requestToken: number,
): void {
  map.interactions.showPopup({
    id: REVERSE_GEOCODE_POPUP_ID,
    lngLat: [lng, lat],
    content,
    closeOnClick: false,
    maxWidth: "260px",
    onClose: () => {
      if (requestToken === lookupToken) popupVisible = false;
    },
  });
  popupVisible = true;
}

/** Resolve and render the address for a clicked point through MapEngine. */
async function showReverseGeocodePopup(
  map: MapEngineClient,
  lng: number,
  lat: number,
  requestToken: number,
  signal: AbortSignal,
): Promise<void> {
  renderReverseGeocodePopup(
    map,
    lng,
    lat,
    buildPopupContent("", labels.lookingUp, labels.copyAddress),
    requestToken,
  );

  try {
    const resolved = await geocodeReverse(lng, lat, { signal });
    if (requestToken !== lookupToken || !popupVisible) return;
    const label = resolved?.displayName ?? labels.noAddress;
    renderReverseGeocodePopup(
      map,
      lng,
      lat,
      buildPopupContent(resolved?.displayName ?? "", label, labels.copyAddress),
      requestToken,
    );
  } catch {
    // A superseded/aborted request fails the token check and is ignored; only a
    // still-current failure surfaces the error text.
    if (requestToken !== lookupToken || !popupVisible) return;
    renderReverseGeocodePopup(
      map,
      lng,
      lat,
      buildPopupContent("", labels.failed, labels.copyAddress),
      requestToken,
    );
  }
}

function mapClientFor(app: GeoLibreAppAPI): MapEngineClient | null {
  try {
    return app.map;
  } catch {
    // Preserve the legacy no-op behavior when activation happens before the
    // map engine mounts; restoreReverseGeocode will bind once it is ready.
    return null;
  }
}

function attachMap(map: MapEngineClient): void {
  if (boundMap === map && unsubscribeClick) return; // already bound to this map

  cursorElement = map.viewport.getElement();
  previousCursor = cursorElement?.style.cursor ?? "";
  if (cursorElement) cursorElement.style.cursor = "crosshair";

  unsubscribeClick = map.on("click", ({ lngLat }) => {
    const requestToken = ++lookupToken;
    // Cancel any request from a previous click before starting a new one.
    currentAbortController?.abort();
    currentAbortController = new AbortController();
    void showReverseGeocodePopup(
      map,
      lngLat[0],
      lngLat[1],
      requestToken,
      currentAbortController.signal,
    );
  });

  boundMap = map;
}

function attach(app: GeoLibreAppAPI): void {
  const map = mapClientFor(app);
  if (!map) return;
  if (boundMap && boundMap !== map) teardown();
  attachMap(map);
}

function teardown(): void {
  ++lookupToken;
  // Cancel an in-flight reverse request so it does not complete after the tool
  // is disabled.
  currentAbortController?.abort();
  currentAbortController = null;
  unsubscribeClick?.();
  unsubscribeClick = null;
  if (cursorElement) cursorElement.style.cursor = previousCursor;
  cursorElement = null;
  boundMap?.interactions.closePopup(REVERSE_GEOCODE_POPUP_ID);
  popupVisible = false;
  boundMap = null;
}

/**
 * Keep the reverse-geocode click handler bound to the current map after a map
 * re-init. Mirrors `restoreDirections`: the desktop shell calls this after
 * restoring plugin state. Idempotent.
 */
export function restoreReverseGeocode(app: GeoLibreAppAPI, active: boolean): void {
  if (!active) {
    teardown();
    return;
  }
  const map = mapClientFor(app);
  if (boundMap && boundMap === map && unsubscribeClick) return; // already bound
  teardown();
  if (map) attachMap(map);
}

export const maplibreReverseGeocodePlugin: GeoLibrePlugin = {
  id: REVERSE_GEOCODE_PLUGIN_ID,
  name: "Reverse Geocode",
  version: "1.0.0",
  activate: (app: GeoLibreAppAPI) => attach(app),
  deactivate: () => teardown(),
};
