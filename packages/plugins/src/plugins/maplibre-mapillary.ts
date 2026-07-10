import type {
  GeoJSONSource,
  MapGeoJSONFeature,
  MapLayerMouseEvent,
  Map as MapLibreMap,
} from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

// mapillary-js is a heavy WebGL module, so it is loaded lazily the first time
// the viewer mounts (see mountViewer) rather than statically at import time.
type MapillaryViewer = import("mapillary-js").Viewer;

export const MAPILLARY_PLUGIN_ID = "maplibre-gl-mapillary";
const PANEL_ID = "geolibre-mapillary-viewer";

const SOURCE_ID = "geolibre-mapillary-coverage";
const SELECTED_SOURCE_ID = "geolibre-mapillary-selected";
const SEQUENCE_LAYER_ID = "geolibre-mapillary-sequence";
const OVERVIEW_LAYER_ID = "geolibre-mapillary-overview";
const IMAGE_LAYER_ID = "geolibre-mapillary-image";
const SELECTED_LAYER_ID = "geolibre-mapillary-selected-marker";
// The point layers that carry a clickable image `id` property.
const CLICKABLE_LAYER_IDS = [IMAGE_LAYER_ID, OVERVIEW_LAYER_ID];

// Mapillary green for coverage, orange for the currently viewed image, matching
// the colours used at mapillary.com/app.
const COVERAGE_COLOR = "#05cb63";
const SELECTED_COLOR = "#f5811f";

const TOKEN_STORAGE_KEY = "geolibre:mapillary-access-token";
const ATTRIBUTION =
  '<a href="https://www.mapillary.com/" target="_blank" rel="noopener noreferrer">© Mapillary</a>';

// The public vector-tile coverage set. The access token is appended per request.
const COVERAGE_TILE_BASE =
  "https://tiles.mapillary.com/maps/vtp/mly1_public/2/{z}/{x}/{y}";

// ---------------------------------------------------------------------------
// Translatable strings (host injects localized copies via setMapillaryLabels)
// ---------------------------------------------------------------------------

export interface MapillaryLabels {
  title: string;
  hint: string;
  noToken: string;
  tokenPlaceholder: string;
  tokenSave: string;
  tokenHelp: string;
  tokenLabel: string;
  loading: string;
  loadError: string;
}

let labels: MapillaryLabels = {
  title: "Mapillary",
  hint: "Click a coverage point on the map to view street-level imagery.",
  noToken:
    "A Mapillary access token is required to load coverage and imagery. Paste one below to get started.",
  tokenPlaceholder: "MLY|…",
  tokenSave: "Save token",
  tokenHelp: "Get a token",
  tokenLabel: "Mapillary access token",
  loading: "Loading imagery…",
  loadError: "Could not load this image.",
};

export function setMapillaryLabels(next: Partial<MapillaryLabels>): void {
  labels = { ...labels, ...next };
  if (!panelContainer) return;
  // With a live viewer, only refresh the static text nodes — rebuilding would
  // tear down the mapillary-js WebGL viewer and lose the user's current photo
  // just to update hint/button copy. Otherwise (token prompt showing) a full
  // rebuild is cheap and picks up every translated string.
  if (viewer) updatePanelText();
  else buildPanel(panelContainer);
}

function updatePanelText(): void {
  if (hintEl) hintEl.textContent = labels.hint;
  if (settingsButtonEl) settingsButtonEl.textContent = labels.tokenLabel;
}

// ---------------------------------------------------------------------------
// Access token resolution
// ---------------------------------------------------------------------------

function readEnvToken(): string | undefined {
  const buildEnv = (
    import.meta as ImportMeta & { env?: Record<string, string | undefined> }
  ).env;
  const runtimeEnv =
    typeof window === "undefined" ? undefined : window.__GEOLIBRE_RUNTIME_ENV__;
  const env = { ...(buildEnv ?? {}), ...(runtimeEnv ?? {}) };
  return env.VITE_MAPILLARY_ACCESS_TOKEN?.trim() || undefined;
}

/** A token the user pasted into the panel overrides the build/runtime default. */
function readUserToken(): string | undefined {
  if (typeof localStorage === "undefined") return undefined;
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function activeToken(): string | undefined {
  return readUserToken() ?? readEnvToken();
}

function saveUserToken(token: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* storage may be unavailable (private mode); ignore */
  }
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let map: MapLibreMap | null = null;
let appRef: GeoLibreAppAPI | null = null;
let unregisterPanel: (() => void) | null = null;
let unsubscribeBasemap: (() => void) | null = null;

let panelContainer: HTMLElement | null = null;
let viewerContainer: HTMLElement | null = null;
let viewer: MapillaryViewer | null = null;
// A mount in flight, so overlapping mountViewer() calls await it instead of
// racing to construct a second Viewer (which would leak a WebGL context).
let viewerMounting: Promise<void> | null = null;
// The live text nodes, so a language change refreshes copy in place instead of
// tearing down and remounting the viewer.
let hintEl: HTMLElement | null = null;
let settingsButtonEl: HTMLButtonElement | null = null;
// An image the user clicked before the viewer finished mounting.
let pendingImageId: string | null = null;

let clickHandler: ((event: MapLayerMouseEvent) => void) | null = null;
let enterHandler: (() => void) | null = null;
let leaveHandler: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Coverage layers
// ---------------------------------------------------------------------------

function emptyCollection(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function addCoverage(activeMap: MapLibreMap): void {
  const token = activeToken();
  if (!token) return; // Nothing to request until a token exists.

  if (!activeMap.getSource(SOURCE_ID)) {
    activeMap.addSource(SOURCE_ID, {
      type: "vector",
      tiles: [`${COVERAGE_TILE_BASE}?access_token=${encodeURIComponent(token)}`],
      minzoom: 6,
      maxzoom: 14,
      attribution: ATTRIBUTION,
    });
  }

  if (!activeMap.getLayer(SEQUENCE_LAYER_ID)) {
    activeMap.addLayer({
      id: SEQUENCE_LAYER_ID,
      type: "line",
      source: SOURCE_ID,
      "source-layer": "sequence",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": COVERAGE_COLOR,
        "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1, 14, 2.5],
        "line-opacity": 0.85,
      },
    });
  }

  if (!activeMap.getLayer(OVERVIEW_LAYER_ID)) {
    activeMap.addLayer({
      id: OVERVIEW_LAYER_ID,
      type: "circle",
      source: SOURCE_ID,
      "source-layer": "overview",
      maxzoom: 14,
      paint: {
        "circle-color": COVERAGE_COLOR,
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 1.5, 13, 3],
        "circle-opacity": 0.85,
      },
    });
  }

  if (!activeMap.getLayer(IMAGE_LAYER_ID)) {
    activeMap.addLayer({
      id: IMAGE_LAYER_ID,
      type: "circle",
      source: SOURCE_ID,
      "source-layer": "image",
      minzoom: 14,
      paint: {
        "circle-color": COVERAGE_COLOR,
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 4, 20, 7],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1,
      },
    });
  }

  if (!activeMap.getSource(SELECTED_SOURCE_ID)) {
    activeMap.addSource(SELECTED_SOURCE_ID, {
      type: "geojson",
      data: emptyCollection(),
    });
  }
  if (!activeMap.getLayer(SELECTED_LAYER_ID)) {
    activeMap.addLayer({
      id: SELECTED_LAYER_ID,
      type: "circle",
      source: SELECTED_SOURCE_ID,
      paint: {
        "circle-color": SELECTED_COLOR,
        "circle-radius": 8,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2,
      },
    });
  }
}

function removeCoverage(activeMap: MapLibreMap): void {
  for (const id of [
    SELECTED_LAYER_ID,
    IMAGE_LAYER_ID,
    OVERVIEW_LAYER_ID,
    SEQUENCE_LAYER_ID,
  ]) {
    if (activeMap.getLayer(id)) activeMap.removeLayer(id);
  }
  if (activeMap.getSource(SELECTED_SOURCE_ID))
    activeMap.removeSource(SELECTED_SOURCE_ID);
  if (activeMap.getSource(SOURCE_ID)) activeMap.removeSource(SOURCE_ID);
}

/** Re-add the coverage source with a fresh token (the token is baked into the
 * tile URL, so a token change means a source rebuild). */
function refreshCoverage(): void {
  if (!map) return;
  removeCoverage(map);
  addCoverage(map);
}

function setSelectedMarker(lngLat: { lng: number; lat: number } | null): void {
  if (!map) return;
  const source = map.getSource(SELECTED_SOURCE_ID) as GeoJSONSource | undefined;
  if (!source) return;
  source.setData(
    lngLat
      ? {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: { type: "Point", coordinates: [lngLat.lng, lngLat.lat] },
              properties: {},
            },
          ],
        }
      : emptyCollection(),
  );
}

// ---------------------------------------------------------------------------
// Click handling
// ---------------------------------------------------------------------------

function imageIdFromFeature(feature: MapGeoJSONFeature | undefined): string | null {
  const raw = feature?.properties?.id ?? feature?.properties?.image_id;
  return raw == null ? null : String(raw);
}

function attachInteractions(activeMap: MapLibreMap): void {
  clickHandler = (event: MapLayerMouseEvent) => {
    const id = imageIdFromFeature(event.features?.[0]);
    if (id) showImage(id);
  };
  enterHandler = () => {
    activeMap.getCanvas().style.cursor = "pointer";
  };
  leaveHandler = () => {
    activeMap.getCanvas().style.cursor = "";
  };
  for (const layerId of CLICKABLE_LAYER_IDS) {
    activeMap.on("click", layerId, clickHandler);
    activeMap.on("mouseenter", layerId, enterHandler);
    activeMap.on("mouseleave", layerId, leaveHandler);
  }
}

function detachInteractions(activeMap: MapLibreMap): void {
  for (const layerId of CLICKABLE_LAYER_IDS) {
    if (clickHandler) activeMap.off("click", layerId, clickHandler);
    if (enterHandler) activeMap.off("mouseenter", layerId, enterHandler);
    if (leaveHandler) activeMap.off("mouseleave", layerId, leaveHandler);
  }
  activeMap.getCanvas().style.cursor = "";
  clickHandler = null;
  enterHandler = null;
  leaveHandler = null;
}

/** Open the viewer panel (mounting it if needed) and navigate to an image. */
function showImage(imageId: string): void {
  pendingImageId = imageId;
  if (viewer) {
    void viewer.moveTo(imageId).catch(() => {
      /* navigation to a removed/blocked image can reject; ignore */
    });
    return;
  }
  // The panel's render callback mounts the viewer and consumes pendingImageId.
  appRef?.openFloatingPanel?.(PANEL_ID);
}

// ---------------------------------------------------------------------------
// Panel + viewer
// ---------------------------------------------------------------------------

function styleButton(button: HTMLButtonElement): void {
  button.style.cssText =
    "padding:6px 10px;border-radius:6px;border:1px solid var(--border,#d1d5db);" +
    "background:var(--primary,#05cb63);color:var(--primary-foreground,#ffffff);" +
    "font-size:12px;cursor:pointer;";
}

function buildPanel(container: HTMLElement): void {
  // Dispose any viewer bound to the DOM we are about to replace so a rebuild
  // (e.g. a language change) does not strand a live Viewer on a detached node.
  destroyViewer();
  container.innerHTML = "";
  container.style.cssText =
    "display:flex;flex-direction:column;gap:8px;padding:8px;font-size:12px;" +
    "color:var(--popover-foreground,inherit);background:var(--popover,transparent);";

  const hint = document.createElement("div");
  hint.textContent = labels.hint;
  hint.style.cssText = "opacity:0.8;line-height:1.4;";
  hintEl = hint;
  container.appendChild(hint);

  // The mapillary-js viewer mounts into this element.
  const view = document.createElement("div");
  view.style.cssText =
    "position:relative;width:100%;height:320px;border-radius:8px;overflow:hidden;" +
    "background:#000;";
  viewerContainer = view;
  container.appendChild(view);

  if (activeToken()) {
    void mountViewer();
  } else {
    renderTokenPrompt(view);
  }

  container.appendChild(buildFooter());
}

function renderTokenPrompt(host: HTMLElement): void {
  host.style.background = "var(--muted,#f3f4f6)";
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "display:flex;flex-direction:column;gap:8px;padding:16px;height:100%;" +
    "box-sizing:border-box;justify-content:center;color:var(--popover-foreground,inherit);";

  const msg = document.createElement("div");
  msg.textContent = labels.noToken;
  msg.style.cssText = "line-height:1.4;";
  wrap.appendChild(msg);

  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:6px;";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = labels.tokenPlaceholder;
  input.value = readUserToken() ?? "";
  input.style.cssText =
    "flex:1;min-width:0;padding:6px 8px;border-radius:6px;font-size:12px;" +
    "border:1px solid var(--border,#d1d5db);background:var(--background,#fff);" +
    "color:var(--foreground,inherit);";
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = labels.tokenSave;
  styleButton(save);
  const commit = () => {
    const token = input.value.trim();
    if (!token) return;
    saveUserToken(token);
    refreshCoverage();
    if (panelContainer) buildPanel(panelContainer);
  };
  save.addEventListener("click", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
  });
  row.appendChild(input);
  row.appendChild(save);
  wrap.appendChild(row);

  const help = document.createElement("a");
  help.href = "https://www.mapillary.com/dashboard/developers";
  help.target = "_blank";
  help.rel = "noopener noreferrer";
  help.textContent = labels.tokenHelp;
  help.style.cssText = "font-size:11px;color:var(--primary,#05cb63);";
  wrap.appendChild(help);

  host.appendChild(wrap);
}

function buildFooter(): HTMLElement {
  const footer = document.createElement("div");
  footer.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;" +
    "font-size:11px;opacity:0.75;";

  const attribution = document.createElement("div");
  // Required by the Mapillary developer terms: visible logo/name linking back.
  attribution.innerHTML = ATTRIBUTION + " · CC BY-SA";
  footer.appendChild(attribution);

  // Let the user swap in their own token even after one is already active.
  const settings = document.createElement("button");
  settings.type = "button";
  settings.textContent = labels.tokenLabel;
  settingsButtonEl = settings;
  settings.style.cssText =
    "background:none;border:none;color:var(--primary,#05cb63);cursor:pointer;" +
    "font-size:11px;padding:0;text-decoration:underline;";
  settings.addEventListener("click", () => {
    if (viewerContainer) {
      destroyViewer();
      viewerContainer.innerHTML = "";
      renderTokenPrompt(viewerContainer);
    }
  });
  footer.appendChild(settings);

  return footer;
}

function mountViewer(): Promise<void> {
  if (viewer) return Promise.resolve();
  // Coalesce overlapping calls: a rapid rebuild (e.g. two buildPanel runs)
  // could otherwise both pass the `viewer` guard before the dynamic import
  // resolves and construct two Viewers, leaking the first.
  if (viewerMounting) return viewerMounting;
  viewerMounting = doMountViewer().finally(() => {
    viewerMounting = null;
  });
  return viewerMounting;
}

async function doMountViewer(): Promise<void> {
  const token = activeToken();
  if (!token || !viewerContainer) return;
  try {
    const { Viewer } = await import("mapillary-js");
    // The panel may have been torn down (or a viewer already mounted) while the
    // dynamic import was in flight.
    if (!viewerContainer || !activeToken() || viewer) return;
    viewer = new Viewer({
      accessToken: token,
      container: viewerContainer,
      imageId: pendingImageId ?? undefined,
    });
    viewer.on("image", (event) => {
      const image = event.image;
      setSelectedMarker(image.lngLat);
    });
    if (pendingImageId) {
      void viewer.moveTo(pendingImageId).catch(() => {});
    }
  } catch {
    if (viewerContainer) {
      viewerContainer.innerHTML = "";
      const err = document.createElement("div");
      err.textContent = labels.loadError;
      err.style.cssText =
        "color:#fff;padding:16px;font-size:12px;text-align:center;";
      viewerContainer.appendChild(err);
    }
  }
}

function destroyViewer(): void {
  if (viewer) {
    try {
      viewer.remove();
    } catch {
      /* already disposed */
    }
    viewer = null;
  }
}

/**
 * Add the coverage layers, deferring to the next idle if the style is still
 * loading. Calling addSource/addLayer before the style is ready throws
 * ("Style is not done loading"), which can happen when the plugin is
 * (re)activated right after a basemap swap during project restore.
 */
function ensureCoverageWhenReady(activeMap: MapLibreMap): void {
  if (activeMap.isStyleLoaded()) addCoverage(activeMap);
  else activeMap.once("idle", () => addCoverage(activeMap));
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export const maplibreMapillaryPlugin: GeoLibrePlugin = {
  id: MAPILLARY_PLUGIN_ID,
  name: "Mapillary",
  version: "0.1.0",
  activate: (app: GeoLibreAppAPI) => {
    const activeMap = app.getMap?.();
    if (!activeMap) return false;
    map = activeMap;
    appRef = app;

    ensureCoverageWhenReady(activeMap);
    attachInteractions(activeMap);

    // A basemap switch calls setStyle, which drops our sources/layers; re-add
    // them once the new style settles.
    unsubscribeBasemap = app.onBasemapChange(() => {
      if (!map) return;
      map.once("idle", () => {
        if (!map) return;
        addCoverage(map);
      });
    });

    unregisterPanel =
      app.registerFloatingPanel?.({
        id: PANEL_ID,
        title: labels.title,
        defaultWidth: 460,
        render: (container) => {
          panelContainer = container;
          buildPanel(container);
          return () => {
            destroyViewer();
            viewerContainer = null;
            hintEl = null;
            settingsButtonEl = null;
            if (panelContainer === container) panelContainer = null;
          };
        },
      }) ?? null;

    app.openFloatingPanel?.(PANEL_ID);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    unsubscribeBasemap?.();
    unsubscribeBasemap = null;
    destroyViewer();
    unregisterPanel?.();
    unregisterPanel = null;
    panelContainer = null;
    viewerContainer = null;
    hintEl = null;
    settingsButtonEl = null;
    pendingImageId = null;
    const activeMap = map ?? app.getMap?.() ?? null;
    if (activeMap) {
      detachInteractions(activeMap);
      removeCoverage(activeMap);
    }
    map = null;
    appRef = null;
  },
};
