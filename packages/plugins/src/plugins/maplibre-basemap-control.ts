import { useAppStore } from "@geolibre/core";
import {
  BasemapControl,
  type BasemapChangeEvent,
  type BasemapDefinition,
  type BasemapControlEventPayload,
  type BasemapControlOptions,
  type ManagedRasterBasemap,
} from "maplibre-gl-basemap-control";
import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
} from "../types";

const basemapEnv = (
  import.meta as ImportMeta & {
    env?: Record<string, string | undefined>;
  }
).env;

/** Merge build-time and runtime environment variables (runtime wins). */
function getRuntimeEnvironment(): Record<string, string | undefined> {
  if (typeof window === "undefined") return basemapEnv ?? {};
  // __GEOLIBRE_RUNTIME_ENV__ is declared globally in @geolibre/core.
  return {
    ...(basemapEnv ?? {}),
    ...(window.__GEOLIBRE_RUNTIME_ENV__ ?? {}),
  };
}

/**
 * Provider credentials for the traffic overlays added in
 * maplibre-gl-basemap-control 0.6.0. The keys come from runtime environment
 * variables (set in Settings → Environment Variables), so users opt in with
 * their own API keys; Google Traffic reuses the same VITE_GOOGLE_MAPS_API_KEY
 * that the Street View plugin reads. Returns empty strings when unset, which the
 * control treats as "no key" (the overlay then surfaces a "Get a … API key"
 * error rather than loading tiles).
 */
function getBasemapCredentials(): {
  googleMapsApiKey: string;
  tomtomApiKey: string;
  hereApiKey: string;
} {
  const env = getRuntimeEnvironment();
  return {
    googleMapsApiKey: env.VITE_GOOGLE_MAPS_API_KEY?.trim() || "",
    tomtomApiKey: env.VITE_TOMTOM_API_KEY?.trim() || "",
    hereApiKey: env.VITE_HERE_API_KEY?.trim() || "",
  };
}

let basemapControlPosition: GeoLibreMapControlPosition = "top-left";
let removeRuntimeEnvListener: (() => void) | null = null;

/**
 * User-facing strings the panel cannot translate itself. Defaults are English;
 * the desktop shell pushes translated values via {@link setBasemapControlLabels}
 * since this package is framework-agnostic and has no direct access to
 * react-i18next.
 */
export interface BasemapControlLabels {
  /**
   * Builds the confirmation shown before a style basemap replaces the stacked
   * raster basemaps, given the style basemap name and how many will be removed
   * (always at least one).
   */
  confirmStyleReplace: (basemapName: string, count: number) => string;
}

let labels: BasemapControlLabels = {
  confirmStyleReplace: (basemapName, count) =>
    count === 1
      ? `Switching to "${basemapName}" replaces the whole map style and will remove the stacked basemap you added. Continue?`
      : `Switching to "${basemapName}" replaces the whole map style and will remove the ${count} stacked basemaps you added. Continue?`,
};

/** Override the panel strings (called from the app layer with translated text). */
export function setBasemapControlLabels(
  next: Partial<BasemapControlLabels>,
): void {
  labels = { ...labels, ...next };
}

let basemapControl: BasemapControl | null = null;
// GeoLibre layer ids of registered raster basemaps, keyed by basemap id. In
// multiple mode several raster basemaps can be registered at once.
const registeredRasterLayers = new Map<string, string>();

export const maplibreBasemapControlPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-basemap-control",
  name: "Basemaps",
  version: "0.3.0",
  activate: (app: GeoLibreAppAPI) => {
    if (!basemapControl) {
      basemapControl = new BasemapControl(getBasemapControlOptions(app));
      basemapControl.on("basemapchange", (event) => {
        handleBasemapChange(app, event);
      });
      basemapControl.on("basemapremove", (event) => {
        handleBasemapRemove(app, event);
      });
      addRuntimeEnvListener();
    }

    const added = app.addMapControl(
      basemapControl,
      basemapControlPosition,
    );
    if (!added) {
      // Tear the listener down too, or it outlives the nulled control: deactivate
      // bails on `!basemapControl`, so it would never be cleaned up otherwise.
      cleanupRuntimeEnvListener();
      basemapControl = null;
      return false;
    }
    basemapControl.setState({
      activeBasemapId: getBasemapIdForStyleUrl(app.getActiveBasemap()),
    });
    // Re-link raster basemap layers restored from a reopened project so that a
    // later switch to a style basemap or a removal can unregister them (the
    // module state does not survive a new session).
    relinkRestoredRasterBasemaps();
    setTimeout(() => basemapControl?.expand(), 0);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    if (!basemapControl) return;
    cleanupRuntimeEnvListener();
    unregisterAllRasterBasemaps(app);
    app.removeMapControl(basemapControl);
    basemapControl = null;
  },
  getMapControlPosition: () => basemapControlPosition,
  setMapControlPosition: (
    app: GeoLibreAppAPI,
    position: GeoLibreMapControlPosition,
  ) => {
    basemapControlPosition = position;
    if (!basemapControl) return;
    app.removeMapControl(basemapControl);
    const added = app.addMapControl(basemapControl, basemapControlPosition);
    if (!added) return false;
    basemapControl.setState({
      activeBasemapId: getBasemapIdForStyleUrl(app.getActiveBasemap()),
    });
    setTimeout(() => basemapControl?.expand(), 0);
  },
};

function getBasemapControlOptions(
  app: GeoLibreAppAPI,
): BasemapControlOptions {
  return {
    collapsed: false,
    position: basemapControlPosition,
    title: "Basemaps",
    // Traffic overlays (Google/TomTom/HERE) authenticate with the user's own
    // API keys, read from runtime env. Unset keys are harmless: the overlay just
    // reports a missing-key error instead of loading tiles.
    ...getBasemapCredentials(),
    // A style basemap (e.g. OpenFreeMap 3D) swaps the whole map style and so
    // discards every stacked raster basemap. In stack mode that silently wiped
    // a carefully assembled stack, so confirm before the rasters are lost. See
    // issue #551.
    confirmStyleReplace: ({ basemap, replacedBasemapIds }) => {
      const count = replacedBasemapIds.length;
      // Nothing stacked to lose: never prompt (and avoids a "remove 0" message).
      if (count === 0) return true;
      // Native dialog, matching the existing window.confirm usage in the shell.
      // In a sandboxed cross-origin iframe (e.g. the Jupyter embed) confirm is
      // suppressed and returns false, so the switch is simply blocked there.
      // That fails safe: the stacked basemaps are kept and nothing is lost.
      return window.confirm(labels.confirmStyleReplace(basemap.name, count));
    },
  };
}

/**
 * Push updated provider keys into the live control when the user edits their
 * runtime environment variables, so a newly entered key takes effect without
 * reopening the project. The control's setters re-resolve tile templates in
 * place, so the panel state (and any stacked basemaps) is preserved.
 */
function addRuntimeEnvListener(): void {
  if (removeRuntimeEnvListener || typeof window === "undefined") return;

  const handleRuntimeEnvChange = () => {
    if (!basemapControl) return;
    const { googleMapsApiKey, tomtomApiKey, hereApiKey } =
      getBasemapCredentials();
    basemapControl.setGoogleMapsApiKey(googleMapsApiKey);
    basemapControl.setTomTomApiKey(tomtomApiKey);
    basemapControl.setHereApiKey(hereApiKey);
  };

  window.addEventListener("geolibre:runtime-env-change", handleRuntimeEnvChange);
  removeRuntimeEnvListener = () => {
    window.removeEventListener(
      "geolibre:runtime-env-change",
      handleRuntimeEnvChange,
    );
  };
}

function cleanupRuntimeEnvListener(): void {
  removeRuntimeEnvListener?.();
  removeRuntimeEnvListener = null;
}

function handleBasemapChange(
  app: GeoLibreAppAPI,
  event: BasemapControlEventPayload,
): void {
  // Narrows the BasemapControlEventPayload union so event.basemap is accessible.
  if (event.type !== "basemapchange") return;
  const { source } = event.basemap;
  if (source.type === "raster") {
    registerRasterBasemap(app, event.basemap, event);
    return;
  }
  // Only a style/vector-style basemap actually replaces the whole map style
  // (and so drops every managed raster overlay). Bail out on any other type
  // before touching the layer manager, so an unrecognized future source type
  // does not evict the raster overlays without replacing the style.
  if (source.type !== "style" && source.type !== "vector-style") return;
  unregisterAllRasterBasemaps(app);
  app.setBasemap(source.url);
}

function handleBasemapRemove(
  app: GeoLibreAppAPI,
  event: BasemapControlEventPayload,
): void {
  // Narrows the BasemapControlEventPayload union so event.basemap is accessible.
  if (event.type !== "basemapremove") return;
  const layerId = registeredRasterLayers.get(event.basemap.id);
  if (!layerId) return;
  app.unregisterExternalNativeLayer?.(layerId);
  registeredRasterLayers.delete(event.basemap.id);
}

function registerRasterBasemap(
  app: GeoLibreAppAPI,
  basemap: BasemapDefinition,
  event: BasemapChangeEvent,
): void {
  if (basemap.source.type !== "raster") return;
  const managedRaster = getManagedRaster(event, basemap);
  if (!managedRaster || !app.registerExternalNativeLayer) return;

  const layerId = `basemap-${basemap.id}`;
  // In replace mode the control keeps a single raster basemap, so drop any
  // other registered raster basemaps. In add mode they stack, so keep them; if
  // this basemap is already registered (a duplicate add event), there is
  // nothing to do.
  if (event.mode !== "add") {
    unregisterRasterBasemapsExcept(app, basemap.id);
  } else if (registeredRasterLayers.has(basemap.id)) {
    return;
  }

  app.registerExternalNativeLayer({
    id: layerId,
    name: basemap.name,
    type: "raster",
    source: {
      attribution: basemap.attribution,
      maxzoom: basemap.source.maxzoom,
      minzoom: basemap.source.minzoom,
      scheme: basemap.source.scheme,
      sourceId: managedRaster.sourceId,
      tileSize: basemap.source.tileSize ?? 256,
      tiles: basemap.source.tiles,
      type: "raster",
    },
    nativeLayerIds: [managedRaster.layerId],
    sourceId: managedRaster.sourceId,
    sourceIds: [managedRaster.sourceId],
    beforeId: managedRaster.beforeId,
    metadata: {
      basemapId: basemap.id,
      basemapProvider: basemap.provider,
      category: basemap.category,
      externalNativeLayer: true,
      identifiable: false,
      sourceKind: "maplibre-basemap-control",
      // Tile URL template lives in metadata, not sourcePath, which is reserved
      // for local file paths (GeoJSON, FlatGeobuf, etc.).
      tileType: "raster",
      tileUrl:
        basemap.source.tiles.length > 0 ? basemap.source.tiles[0] : undefined,
    },
  });
  registeredRasterLayers.set(basemap.id, layerId);
}

function unregisterAllRasterBasemaps(app: GeoLibreAppAPI): void {
  for (const layerId of registeredRasterLayers.values()) {
    app.unregisterExternalNativeLayer?.(layerId);
  }
  registeredRasterLayers.clear();
}

function unregisterRasterBasemapsExcept(
  app: GeoLibreAppAPI,
  keepBasemapId: string,
): void {
  // Snapshot the entries so deleting from the Map mid-loop is safe.
  for (const [basemapId, layerId] of [...registeredRasterLayers.entries()]) {
    if (basemapId === keepBasemapId) continue;
    app.unregisterExternalNativeLayer?.(layerId);
    registeredRasterLayers.delete(basemapId);
  }
}

function relinkRestoredRasterBasemaps(): void {
  if (registeredRasterLayers.size > 0) return;
  const restored = useAppStore
    .getState()
    .layers.filter(
      (layer) => layer.metadata?.sourceKind === "maplibre-basemap-control",
    );
  for (const layer of restored) {
    const basemapId = layer.metadata?.basemapId;
    if (typeof basemapId === "string") {
      registeredRasterLayers.set(basemapId, layer.id);
    } else if (layer.id.startsWith("basemap-")) {
      // Fallback for projects saved before basemapId was stored in metadata.
      // The layer id is deterministic (`basemap-${basemap.id}`), so the
      // original basemap id can be recovered by stripping the prefix.
      registeredRasterLayers.set(layer.id.slice("basemap-".length), layer.id);
    }
  }
}

function getManagedRaster(
  event: BasemapChangeEvent,
  basemap: BasemapDefinition,
): ManagedRasterBasemap | null {
  if (event.managedRaster) {
    return event.managedRaster;
  }

  // Fallback for library versions that omit `managedRaster` on the event. These
  // ids must mirror the native source/layer ids maplibre-gl-basemap-control
  // creates: `${CONTROL_SOURCE_PREFIX}-${id}` for the source and the bare
  // `${id}` for the layer (CONTROL_LAYER_PREFIX is empty). Verified against
  // maplibre-gl-basemap-control@0.2.2.
  return {
    sourceId: `maplibre-basemap-control-source-${basemap.id}`,
    layerId: basemap.id,
    beforeId: normalizeBeforeId(event.state.beforeId),
  };
}

function normalizeBeforeId(
  value: string | undefined | null,
): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "none") return undefined;
  return trimmed;
}

function getBasemapIdForStyleUrl(url: string): string | undefined {
  if (url === "https://tiles.openfreemap.org/styles/positron") {
    return "openfreemap-positron";
  }
  if (url === "https://tiles.openfreemap.org/styles/bright") {
    return "openfreemap-bright";
  }
  if (url === "https://tiles.openfreemap.org/styles/liberty") {
    return "openfreemap-liberty";
  }
  if (url === "https://tiles.openfreemap.org/styles/dark") {
    return "openfreemap-dark";
  }
  if (url === "https://tiles.openfreemap.org/styles/fiord") {
    return "openfreemap-fiord";
  }
  return undefined;
}
