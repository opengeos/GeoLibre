import { type GeoLibreLayer, useAppStore } from "@geolibre/core";
import type { Layer } from "@deck.gl/core";
import type { MapboxOverlay } from "@deck.gl/mapbox";
import type { GeoLibreAppAPI, GeoLibreDeckGL } from "../../types";
import { ensureMercatorProjection } from "../map-projection-utils";
import {
  type DeckVizBuildContext,
  getDeckVizLayerDef,
} from "./registry";
import { deckVizRows, isDeckVizLayer, readDeckVizConfig } from "./store-layer";

/**
 * Owns the single deck.gl overlay that renders every Deck.gl Layer in the
 * store. Mirrors the store-subscription pattern of the raster overlay: the
 * store is the source of truth, this module rebuilds the overlay's layer list
 * whenever the layer set, visibility, or opacity changes, and drives an
 * animation clock for animated layer types (Trips).
 */

// Data-time units advanced per real second for animated layers.
const ANIMATION_SPEED = 60;

let overlay: MapboxOverlay | null = null;
let overlayMounted = false;
let storeUnsubscribe: (() => void) | null = null;
let deckGL: GeoLibreDeckGL | null = null;
let appRef: GeoLibreAppAPI | null = null;
// The map the current overlay is bound to; on map re-init a new overlay is
// created and re-attached, mirroring restoreDirections.
let boundMap: unknown;

// Bounds the lazy-mount retry so a restore that races map init still mounts
// (the store subscription only fires on layer-set changes), without spinning
// forever if the map never becomes ready.
const MAX_MOUNT_RETRIES = 120;
let mountRetries = 0;

let rafHandle: number | null = null;
// Signature of the current animated-layer set; when it changes the loop length
// is recomputed and the clock restarts so the animation stays in range.
let animatedSignature = "";
let animationRange = 0;
let animationEpoch = 0;

/**
 * Activates the deck.gl visualization overlay: resolves the host's deck.gl
 * modules, creates the overlay, subscribes to the store, and renders any
 * layers already present (e.g. from a project opened before activation).
 * Called from the plugin's activate() (manual toggle); also reachable via
 * {@link restoreDeckViz}.
 *
 * @param app - The host application API.
 */
export async function activateDeckViz(app: GeoLibreAppAPI): Promise<void> {
  await ensureDeckVizOverlay(app);
}

/**
 * Idempotent startup/restore hook. `activeByDefault` plugins are marked active
 * without their activate() being called, so the desktop shell must kick this
 * after restoreProjectState (and on map re-init) — the same contract as
 * restoreDirections/restoreEffects.
 *
 * @param app - The host application API.
 * @param active - Whether the plugin is currently active.
 */
export function restoreDeckViz(app: GeoLibreAppAPI, active: boolean): void {
  if (!active) {
    deactivateDeckViz(app);
    return;
  }
  void ensureDeckVizOverlay(app);
}

// Serialises concurrent setup calls (plugin activate() and the shell's restore
// hook can both fire before the first getDeckGL() resolves) so two overlays are
// never created for the same map.
let ensureInFlight: Promise<void> | null = null;

function ensureDeckVizOverlay(app: GeoLibreAppAPI): Promise<void> {
  if (ensureInFlight) return ensureInFlight;
  ensureInFlight = runEnsureDeckVizOverlay(app).finally(() => {
    ensureInFlight = null;
  });
  return ensureInFlight;
}

async function runEnsureDeckVizOverlay(app: GeoLibreAppAPI): Promise<void> {
  appRef = app;
  if (!app.getDeckGL) return;
  deckGL ??= await app.getDeckGL();

  const map = app.getMap?.() ?? null;
  if (overlay && boundMap === map) {
    // Already bound to this map; just refresh the rendered layers.
    renderDeckVizLayers();
    return;
  }

  // First attach, or the map was reinitialised (e.g. a projection/globe
  // toggle). Drop the stale overlay before building a fresh one so its widget
  // container cannot leak onto the new map.
  if (overlay && overlayMounted) {
    try {
      app.removeMapControl(overlay);
    } catch (error) {
      // The old map may already be gone; surface anything unexpected.
      console.debug("[GeoLibre] deckgl-viz: overlay cleanup", error);
    }
  }
  boundMap = map;
  overlay = new deckGL.mapbox.MapboxOverlay({ interleaved: false, layers: [] });
  overlayMounted = false;
  storeUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    if (state.layers !== previous.layers) renderDeckVizLayers();
  });
  renderDeckVizLayers();
}

/**
 * Tears down the overlay and store subscription. Store layers are left intact
 * so re-activation (or a project still holding them) re-renders.
 *
 * @param app - The host application API.
 */
export function deactivateDeckViz(app: GeoLibreAppAPI): void {
  storeUnsubscribe?.();
  storeUnsubscribe = null;
  stopAnimation();
  overlay?.setProps({ layers: [] });
  if (overlay && overlayMounted) {
    app.removeMapControl(overlay);
  }
  overlay = null;
  overlayMounted = false;
  boundMap = undefined;
  // Reset so a session that exhausted the retries can re-mount after
  // reactivation.
  mountRetries = 0;
}

function renderDeckVizLayers(): void {
  if (!overlay || !deckGL || !appRef) return;

  const vizLayers = useAppStore.getState().layers.filter(isDeckVizLayer);

  // The deck.gl overlay renders in a Mercator viewport and does not align with
  // MapLibre's globe projection, so force Mercator while deck layers are shown
  // (same contract as the DuckDB deck overlay).
  if (vizLayers.length > 0) {
    ensureMercatorProjection(appRef.getMap?.());
  }

  // Mount lazily: the map must be ready for addMapControl to succeed. Retry on
  // the next animation frame so a project restore that races map init does not
  // depend on a later store change to mount.
  if (!overlayMounted) {
    if (vizLayers.length === 0) return;
    // Add at top-left: MapboxOverlay's overlaid canvas is positioned `left:0`
    // to fill the map, which only aligns when its control container is the
    // left corner. The host's addControl otherwise defaults to top-right,
    // pushing the canvas a full map-width to the right (off screen).
    if (!appRef.addMapControl(overlay, "top-left")) {
      if (mountRetries < MAX_MOUNT_RETRIES) {
        mountRetries += 1;
        requestAnimationFrame(() => renderDeckVizLayers());
      }
      return;
    }
    mountRetries = 0;
    overlayMounted = true;
  }

  const contexts = vizLayers
    .filter((layer) => layer.visible)
    .map((layer) => buildContext(layer))
    .filter((entry): entry is RenderEntry => entry !== null);

  const currentTime = updateAnimationClock(contexts);

  const deckLayers: Layer[] = [];
  for (const entry of contexts) {
    try {
      deckLayers.push(
        entry.def.build(deckGL, entry.id, {
          ...entry.ctx,
          currentTime,
        }),
      );
    } catch (error) {
      console.warn("[GeoLibre] deckgl-viz: failed to build layer", error);
    }
  }

  // Reverse so the topmost layer in the panel draws last (on top), matching the
  // store's first-is-top ordering.
  deckLayers.reverse();
  overlay.setProps({ layers: deckLayers });

  if (animationRange > 0) startAnimation();
  else stopAnimation();
}

interface RenderEntry {
  id: string;
  def: NonNullable<ReturnType<typeof getDeckVizLayerDef>>;
  ctx: DeckVizBuildContext;
}

function buildContext(layer: GeoLibreLayer): RenderEntry | null {
  const config = readDeckVizConfig(layer);
  if (!config) return null;
  const def = getDeckVizLayerDef(config.layerKind);
  if (!def) return null;
  const isGeoJson = def.format === "geojson";
  // Bridge the Style panel: color/radius/line width come from the live
  // LayerStyle (which the panel edits) while deck-specific props (cellSize,
  // extrusion) stay on the viz config. Fill opacity folds into deck opacity.
  const style: DeckVizBuildContext["style"] = {
    ...config.style,
    color: layer.style.fillColor || config.style.color,
    // Number fields use a finite check (not `||`) so an explicit 0 from the
    // panel (e.g. hiding points) is honored rather than treated as unset.
    radius: Number.isFinite(layer.style.circleRadius)
      ? layer.style.circleRadius
      : config.style.radius,
    lineWidth: Number.isFinite(layer.style.strokeWidth)
      ? layer.style.strokeWidth
      : config.style.lineWidth,
  };
  const ctx: DeckVizBuildContext = {
    rows: isGeoJson
      ? undefined
      : (deckVizRows(layer) as DeckVizBuildContext["rows"]),
    geojson: isGeoJson ? layer.geojson : undefined,
    fieldMapping: config.fieldMapping,
    style,
    opacity: layer.opacity * layer.style.fillOpacity,
    scenegraph: config.scenegraph,
  };
  return { id: layer.id, def, ctx };
}

/**
 * Recomputes the animation loop length when the animated-layer set changes and
 * returns the current clock value (data-time units). Caches the loop length so
 * the per-frame path does not rescan timestamps.
 */
function updateAnimationClock(entries: RenderEntry[]): number {
  const animated = entries.filter((entry) => entry.def.animated);
  const signature = animated.map((entry) => entry.id).join("|");

  if (signature !== animatedSignature) {
    animatedSignature = signature;
    animationEpoch = performance.now();
    animationRange = 0;
    for (const entry of animated) {
      const range = entry.def.getTimeRange?.(entry.ctx) ?? 0;
      if (range > animationRange) animationRange = range;
    }
  }

  if (animationRange <= 0) return 0;
  const elapsedSeconds = (performance.now() - animationEpoch) / 1000;
  return (elapsedSeconds * ANIMATION_SPEED) % animationRange;
}

function startAnimation(): void {
  if (rafHandle !== null) return;
  const tick = (): void => {
    rafHandle = requestAnimationFrame(tick);
    renderDeckVizLayers();
  };
  rafHandle = requestAnimationFrame(tick);
}

function stopAnimation(): void {
  if (rafHandle === null) return;
  cancelAnimationFrame(rafHandle);
  rafHandle = null;
}
