import {
  geocodeReverse,
  nominatimReverseResultToDisplay,
} from "@geolibre/core";
import type {
  Map as MapLibreMap,
  MapMouseEvent,
  Popup,
} from "maplibre-gl";
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

function buildPopupContent(
  title: string,
  body: string,
  copyLabel: string,
): HTMLElement {
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
): Promise<void> {
  const { Popup } = await import("maplibre-gl");
  // A teardown or a newer click during the import supersedes this lookup.
  if (requestToken !== lookupToken) return;
  popup?.remove();
  popup = new Popup({ closeButton: true, closeOnClick: false })
    .setLngLat([lng, lat])
    .setText("Looking up address...")
    .addTo(map);

  try {
    const result = await geocodeReverse(lng, lat);
    if (requestToken !== lookupToken || !popup) return;
    const resolved = nominatimReverseResultToDisplay(result);
    const label = resolved?.displayName ?? "No address found.";
    popup.setDOMContent(
      buildPopupContent(resolved?.displayName ?? "", label, "Copy address"),
    );
  } catch {
    if (requestToken !== lookupToken || !popup) return;
    popup.setText("Reverse geocoding failed.");
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
    void showReverseGeocodePopup(
      map,
      event.lngLat.lng,
      event.lngLat.lat,
      requestToken,
    );
  };

  map.on("click", clickHandler);
  boundMap = map;
}

function teardown(app: GeoLibreAppAPI): void {
  ++lookupToken;
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
export function restoreReverseGeocode(
  app: GeoLibreAppAPI,
  active: boolean,
): void {
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
