import { type GeoLibreLayer, styleValue, useAppStore } from "@geolibre/core";
import type { Layer } from "@deck.gl/core";
import type { GeoLibreAppAPI, GeoLibreDeckGL } from "../../types";
import { ensureMercatorProjection } from "../map-projection-utils";
import { ensureSharedDeckOverlay, setSharedDeckLayers } from "../shared-deck-overlay";
import { buildDiagramLayers, isDiagramLayer } from "./diagrams";
import { buildElevation3dLayers, isElevation3dLayer } from "./elevation";
import { type DeckVizBuildContext, getDeckVizLayerDef } from "./registry";
import { deckVizRows, isDeckVizLayer, readDeckVizConfig } from "./store-layer";

/**
 * Renders every Deck.gl Layer in the store, plus ordinary vector layers whose
 * style enables 3D Z-value rendering (see ./elevation.ts), into the shared
 * interleaved deck overlay (../shared-deck-overlay.ts) under the "deckviz"
 * source. The store is the source of truth: this module rebuilds its layer list
 * whenever the layer set, visibility, or opacity changes, and drives an
 * animation clock for animated layer types (Trips). The shared overlay owns the
 * single MapboxOverlay so these layers coexist with Google 3D Tiles and the COG
 * raster overlay instead of clobbering deck.gl's per-map Deck (see #1149).
 */

// Data-time units advanced per real second for animated layers.
const ANIMATION_SPEED = 60;

let storeUnsubscribe: (() => void) | null = null;
let deckGL: GeoLibreDeckGL | null = null;
let appRef: GeoLibreAppAPI | null = null;

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

  // The shared overlay owns the single interleaved MapboxOverlay and its map
  // binding (including rebind on a globe/projection toggle); this module only
  // supplies the "deckviz" layer list.
  await ensureSharedDeckOverlay(app);
  storeUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    if (state.layers !== previous.layers) renderDeckVizLayers();
  });
  renderDeckVizLayers();
}

/**
 * Tears down the store subscription and clears this module's contribution to
 * the shared overlay. Store layers are left intact so re-activation (or a
 * project still holding them) re-renders.
 *
 * @param _app - The host application API (unused; the shared overlay owns the
 *   MapboxOverlay lifecycle).
 */
export function deactivateDeckViz(_app: GeoLibreAppAPI): void {
  storeUnsubscribe?.();
  storeUnsubscribe = null;
  stopAnimation();
  syncViewListeners(null);
  setSharedDeckLayers("deckviz", []);
}

// The map the diagram view listeners are attached to. Diagram layers with a
// min-zoom or decluttering need a rebuild when the view settles (the deck
// layer list itself is view-independent otherwise).
type ViewListenerMap = {
  on: (event: string, handler: () => void) => unknown;
  off: (event: string, handler: () => void) => unknown;
};
let viewListenerMap: ViewListenerMap | null = null;
const handleViewChange = (): void => renderDeckVizLayers();

function syncViewListeners(target: ViewListenerMap | null): void {
  if (viewListenerMap === target) return;
  viewListenerMap?.off("zoomend", handleViewChange);
  viewListenerMap?.off("moveend", handleViewChange);
  viewListenerMap = target;
  target?.on("zoomend", handleViewChange);
  target?.on("moveend", handleViewChange);
}

function renderDeckVizLayers(): void {
  if (!deckGL || !appRef) return;

  const storeLayers = useAppStore.getState().layers;
  const vizLayers = storeLayers.filter(isDeckVizLayer);
  const diagramLayers = storeLayers.filter((layer) => layer.visible && isDiagramLayer(layer));
  const hasRenderableLayers =
    vizLayers.length > 0 || diagramLayers.length > 0 || storeLayers.some(isElevation3dLayer);

  if (!hasRenderableLayers) {
    setSharedDeckLayers("deckviz", []);
    stopAnimation();
    syncViewListeners(null);
    return;
  }

  // The deck.gl overlay renders in a Mercator viewport and does not align with
  // MapLibre's globe projection, so force Mercator while deck layers are shown
  // (same contract as the DuckDB deck overlay).
  ensureMercatorProjection(appRef.getMap?.());

  const contexts = vizLayers
    .filter((layer) => layer.visible)
    .map((layer) => buildContext(layer))
    .filter((entry): entry is RenderEntry => entry !== null);

  const currentTime = updateAnimationClock(contexts);
  const contextById = new Map(contexts.map((entry) => [entry.id, entry]));

  // Diagram layers need the live view for their min-zoom gate and optional
  // screen-space decluttering, and a rebuild when the view settles.
  const map = appRef.getMap?.() ?? null;
  const diagramOptions = {
    zoom: map?.getZoom(),
    project: map ? (position: [number, number]) => map.project(position) : null,
  };
  syncViewListeners(
    diagramLayers.some(
      (layer) =>
        styleValue(layer.style, "diagramMinZoom") > 0 ||
        styleValue(layer.style, "diagramDeclutter"),
    )
      ? (map as ViewListenerMap | null)
      : null,
  );

  // Walk the store order (first-is-top) so deck-viz layers, 3D Z-value vector
  // layers, and feature diagrams interleave exactly as the Layers panel shows
  // them.
  const deckLayers: Layer[] = [];
  for (const layer of storeLayers) {
    if (!layer.visible) continue;
    const entry = contextById.get(layer.id);
    try {
      // Diagrams go first so the final reverse() puts them on top of the same
      // layer's other deck rendering (e.g. its 3D Z-value geometry).
      if (isDiagramLayer(layer)) {
        deckLayers.push(...buildDiagramLayers(deckGL, layer, diagramOptions));
      }
      if (entry) {
        deckLayers.push(
          entry.def.build(deckGL, entry.id, {
            ...entry.ctx,
            currentTime,
          }),
        );
      } else if (isElevation3dLayer(layer)) {
        deckLayers.push(...buildElevation3dLayers(deckGL, layer));
      }
    } catch (error) {
      console.warn("[GeoLibre] deckgl-viz: failed to build layer", error);
    }
  }

  // Reverse so the topmost layer in the panel draws last (on top), matching the
  // store's first-is-top ordering.
  deckLayers.reverse();
  setSharedDeckLayers("deckviz", deckLayers);

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
    rows: isGeoJson ? undefined : (deckVizRows(layer) as DeckVizBuildContext["rows"]),
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
