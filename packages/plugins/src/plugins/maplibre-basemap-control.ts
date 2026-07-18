import { getGoogleMapsApiKey, useAppStore } from "@geolibre/core";
import {
  BasemapControl,
  type BasemapChangeEvent,
  type BasemapDefinition,
  type BasemapControlEventPayload,
  type BasemapControlOptions,
  type ManagedRasterBasemap,
} from "maplibre-gl-basemap-control";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition, GeoLibrePlugin } from "../types";

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
 * Traffic-overlay provider credentials (added in maplibre-gl-basemap-control
 * 0.6.0) read from runtime environment variables (set in Settings → Environment
 * Variables), so users opt in with their own keys. Google Traffic reuses the
 * same VITE_GOOGLE_MAPS_API_KEY that the Street View plugin reads. Returns empty
 * strings when unset, which the control treats as "no key" (the overlay then
 * surfaces a "Get a … API key" error rather than loading tiles).
 */
function getTrafficOverlayCredentials(): {
  googleMapsApiKey: string;
  tomtomApiKey: string;
  hereApiKey: string;
} {
  const env = getRuntimeEnvironment();
  return {
    googleMapsApiKey: getGoogleMapsApiKey(env) || "",
    tomtomApiKey: env.VITE_TOMTOM_API_KEY?.trim() || "",
    hereApiKey: env.VITE_HERE_API_KEY?.trim() || "",
  };
}

/**
 * Amazon Location credentials from runtime env, or null when no key is set.
 * Unlike the always-applied traffic keys above, these are applied only when a
 * key is actually configured, for two reasons: the user's primary way to enter
 * an Amazon key is the panel's API keys view (#837), so an unrelated env change
 * must not clobber a key typed there; and the region is omitted when unset so
 * the control keeps its own default region rather than GeoLibre hardcoding one.
 */
function getAmazonCredentials(): { amazonApiKey: string; awsRegion?: string } | null {
  const env = getRuntimeEnvironment();
  const amazonApiKey = env.VITE_AMAZON_LOCATION_API_KEY?.trim() || "";
  if (!amazonApiKey) return null;
  const awsRegion = env.VITE_AMAZON_LOCATION_AWS_REGION?.trim() || undefined;
  return awsRegion ? { amazonApiKey, awsRegion } : { amazonApiKey };
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
export function setBasemapControlLabels(next: Partial<BasemapControlLabels>): void {
  labels = { ...labels, ...next };
}

let basemapControl: BasemapControl | null = null;
// GeoLibre layer ids of registered raster basemaps, keyed by basemap id. In
// multiple mode several raster basemaps can be registered at once.
const registeredRasterLayers = new Map<string, string>();
// The most recent style-basemap swap and the background style URL it replaced,
// so a failed provider style (e.g. an Amazon Location basemap with an invalid
// API key) can roll the background back instead of leaving a blank map. The
// control restores the previous basemap itself when that was one of its own
// style basemaps, but it cannot know GeoLibre's background style when the
// previous basemap was a stacked raster, so GeoLibre keeps this fallback. See
// opengeos/GeoLibre#913.
let styleChangeFallback: { attemptedUrl: string; previousUrl: string } | null = null;

export const BASEMAP_CONTROL_PLUGIN_ID = "maplibre-gl-basemap-control";

/**
 * The live BasemapControl instance while the plugin is active, or null when it
 * is deactivated. Mirrors getActiveTimeSliderControl; used by tests to assert
 * the panel state seeded on (re)activation.
 */
export function getActiveBasemapControl(): BasemapControl | null {
  return basemapControl;
}

export const maplibreBasemapControlPlugin: GeoLibrePlugin = {
  id: BASEMAP_CONTROL_PLUGIN_ID,
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
      basemapControl.on("error", (event) => {
        handleBasemapError(app, event);
      });
      addRuntimeEnvListener();
    }

    const added = app.addMapControl(basemapControl, basemapControlPosition);
    if (!added) {
      // Tear the listener down too, or it outlives the nulled control: deactivate
      // bails on `!basemapControl`, so it would never be cleaned up otherwise.
      cleanupRuntimeEnvListener();
      basemapControl = null;
      return false;
    }
    // Re-link raster basemap layers restored from a reopened project (or kept
    // from a previous activation in this session) so that a later switch to a
    // style basemap or a removal can unregister them (the module state does not
    // survive a new session).
    relinkRestoredRasterBasemaps();
    // Seed the fresh control instance with every basemap already on the map —
    // the active style basemap plus any stacked rasters we just relinked — so
    // the reopened panel highlights them as active and a re-click on a stacked
    // raster removes it. Without the raster ids the new instance only knows the
    // style basemap and shows restored overlays as inactive. When rasters are
    // stacked the map is in overlay mode, so restore that too.
    const activeStyleId = getBasemapIdForStyleUrl(app.getActiveBasemap());
    const stackedRasterIds = [...registeredRasterLayers.keys()];
    const activeBasemapIds = [
      ...new Set(
        [activeStyleId, ...stackedRasterIds].filter((id): id is string => typeof id === "string"),
      ),
    ];
    basemapControl.setState({
      activeBasemapId: activeStyleId,
      activeBasemapIds,
      ...(stackedRasterIds.length > 0 ? { allowMultiple: true } : {}),
    });
    setTimeout(() => basemapControl?.expand(), 0);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    if (!basemapControl) return;
    cleanupRuntimeEnvListener();
    // Closing the control must not throw away the stacked raster basemaps the
    // user assembled — they are real layers in the Layers panel. Keep them in
    // the store and only drop the module-level link tracking; a later
    // reactivation relinks them from the store via relinkRestoredRasterBasemaps
    // (the same path a reopened project takes). See #1113 follow-up.
    registeredRasterLayers.clear();
    app.removeMapControl(basemapControl);
    basemapControl = null;
    // Drop any pending style-failure fallback so a later reactivation cannot
    // act on it against a fresh control instance.
    styleChangeFallback = null;
  },
  getMapControlPosition: () => basemapControlPosition,
  setMapControlPosition: (app: GeoLibreAppAPI, position: GeoLibreMapControlPosition) => {
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

function getBasemapControlOptions(app: GeoLibreAppAPI): BasemapControlOptions {
  return {
    collapsed: false,
    position: basemapControlPosition,
    title: "Basemaps",
    // Provider basemaps that need a key (the Google/TomTom/HERE traffic overlays
    // and the Amazon Location styles) authenticate with the user's own
    // credentials, read from runtime env. Unset keys are harmless: the basemap
    // just reports a missing-key error instead of loading tiles. Amazon is
    // spread only when its key is set, so an unset key leaves the control's own
    // region default in place.
    ...getTrafficOverlayCredentials(),
    ...(getAmazonCredentials() ?? {}),
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
    const { googleMapsApiKey, tomtomApiKey, hereApiKey } = getTrafficOverlayCredentials();
    basemapControl.setGoogleMapsApiKey(googleMapsApiKey);
    basemapControl.setTomTomApiKey(tomtomApiKey);
    basemapControl.setHereApiKey(hereApiKey);
    // Only push Amazon credentials when a key is configured via env, so an
    // unrelated env change never clears a key entered in the panel. The region
    // is left undefined when unset, keeping the control's own default.
    const amazon = getAmazonCredentials();
    if (amazon) {
      basemapControl.setAmazonCredentials(amazon.amazonApiKey, amazon.awsRegion);
    }
  };

  window.addEventListener("geolibre:runtime-env-change", handleRuntimeEnvChange);
  removeRuntimeEnvListener = () => {
    window.removeEventListener("geolibre:runtime-env-change", handleRuntimeEnvChange);
  };
}

function cleanupRuntimeEnvListener(): void {
  removeRuntimeEnvListener?.();
  removeRuntimeEnvListener = null;
}

function handleBasemapChange(app: GeoLibreAppAPI, event: BasemapControlEventPayload): void {
  // Narrows the BasemapControlEventPayload union so event.basemap is accessible.
  if (event.type !== "basemapchange") return;
  // Any fresh user selection (a different style, or a raster overlay) supersedes
  // a pending style-failure fallback, so drop it here before the early returns
  // below. The control's own rollback carries `restored` and must keep it.
  if (!event.restored) styleChangeFallback = null;
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
  // Provider style basemaps (Amazon Location, MapTiler, Mapbox, ...) carry a
  // templated source.url with `{api-key}`/`{aws-region}` placeholders that the
  // control substitutes from the user's credentials. Apply the resolved URL the
  // control reports rather than the raw template, which would otherwise reach
  // MapLibre unsubstituted and fail to load, blanking the map. Plain style
  // basemaps have no placeholders and report no resolvedStyleUrl, so fall back
  // to source.url. See opengeos/GeoLibre#913.
  const styleUrl = event.resolvedStyleUrl ?? source.url;
  // Remember the background to roll back to if this style fails to load, but not
  // for the control's own rollback event (which carries `restored`), so a failed
  // swap's fallback survives the rollback that follows it.
  if (!event.restored) {
    styleChangeFallback = {
      attemptedUrl: styleUrl,
      previousUrl: app.getActiveBasemap(),
    };
  }
  unregisterAllRasterBasemaps(app);
  app.setBasemap(styleUrl);
}

// Roll the background style back when a provider style basemap fails to load
// (e.g. an invalid API key 403s its tiles). The control restores the previous
// basemap itself when that was one of its own style basemaps; this backstop
// covers the case it cannot — when the replaced background was a GeoLibre style
// the control does not own (the user had a raster basemap stacked on top). Only
// acts when the failed style is still applied, so it never clobbers a newer
// successful change. See opengeos/GeoLibre#913.
function handleBasemapError(app: GeoLibreAppAPI, event: BasemapControlEventPayload): void {
  if (event.type !== "error") return;
  const fallback = styleChangeFallback;
  if (!fallback) return;
  styleChangeFallback = null;
  if (app.getActiveBasemap() !== fallback.attemptedUrl) return;
  if (fallback.previousUrl && fallback.previousUrl !== fallback.attemptedUrl) {
    app.setBasemap(fallback.previousUrl);
  }
}

function handleBasemapRemove(app: GeoLibreAppAPI, event: BasemapControlEventPayload): void {
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
      tileUrl: basemap.source.tiles.length > 0 ? basemap.source.tiles[0] : undefined,
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

function unregisterRasterBasemapsExcept(app: GeoLibreAppAPI, keepBasemapId: string): void {
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
    .layers.filter((layer) => layer.metadata?.sourceKind === "maplibre-basemap-control");
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

function normalizeBeforeId(value: string | undefined | null): string | undefined {
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
