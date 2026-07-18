import type { Layer } from "@deck.gl/core";
import type { MapboxOverlay } from "@deck.gl/mapbox";
import type { GeoLibreAppAPI, GeoLibreDeckGL } from "../types";

/**
 * The single interleaved deck.gl overlay shared by every GeoLibre feature that
 * renders interleaved deck layers: the deckgl-viz overlay (Deck.gl layers plus
 * 3D Z-value vectors), Google Photorealistic 3D Tiles, and the web COG raster
 * control.
 *
 * deck.gl keeps exactly ONE interleaved Deck per map, stored on `map.__deck`
 * (see `@deck.gl/mapbox`'s getDeckInstance). A second interleaved MapboxOverlay
 * reuses that same Deck, but each overlay's `setProps({ layers })` overwrites
 * the Deck's entire layer list with only its own layers -- so the last overlay
 * to render wins and the others' layers silently vanish, and removing one
 * interleaved overlay finalizes the shared Deck out from under the others (see
 * opengeos/GeoLibre#1149: enabling a track's "3D (Z values)" made Google
 * Photorealistic tiles disappear). Routing every interleaved producer through
 * this one overlay keeps their layers in a single `setProps` call, so they
 * coexist. Overlaid (non-interleaved) overlays -- ArcGIS I3S, the Tauri raster
 * fallback -- own a separate deck canvas and are unaffected, so they keep their
 * own overlays.
 */

/** A device-ready listener; the luma device is opaque to this module. */
type DeviceListener = (device: unknown) => void;

/**
 * Draw order, bottom (drawn first) to top (drawn last). Rasters sit under 3D
 * tiles, which sit under vector / deck-viz overlays -- typical GIS stacking.
 * The route-animation marker/trail sit on top of everything so the animated
 * position stays visible above the 3D track it rides (see #1210).
 * Ordering WITHIN a source is whatever order that source supplies.
 */
const SOURCE_DRAW_ORDER = ["raster", "google-3d-tiles", "deckviz", "route-anim"] as const;
export type SharedDeckSource = (typeof SOURCE_DRAW_ORDER)[number];

let overlay: MapboxOverlay | null = null;
let overlayMounted = false;
let deckGL: GeoLibreDeckGL | null = null;
let appRef: GeoLibreAppAPI | null = null;
// The map the current overlay is bound to; on map re-init a fresh overlay is
// created and re-attached, mirroring the other deck overlays in this repo.
let boundMap: unknown;
// Serialises concurrent setup calls: several producers (deckgl-viz, Google,
// raster) can all race to ensure the overlay before the first getDeckGL()
// resolves, and only one overlay may exist per map.
let ensureInFlight: Promise<MapboxOverlay | null> | null = null;

// The per-source layer lists, aggregated into one setProps on every render.
const layersBySource = new Map<SharedDeckSource, Layer[]>();

// The luma device from the shared Deck, forwarded to producers that need it to
// allocate GPU resources (the raster control's classification colormap
// textures). Reset on every rebind because a new Deck creates a new device.
let device: unknown = null;
const deviceListeners = new Set<DeviceListener>();

// Bounds the lazy-mount retry so a restore that races map init still mounts
// without spinning requestAnimationFrame forever if the map never becomes
// ready. ~2s at 60fps.
const MAX_MOUNT_RETRIES = 120;
let mountRetries = 0;
let mountRetryScheduled = false;
// Latches once the bounded retry gives up so the warning logs once, not on
// every subsequent render.
let mountGaveUp = false;

/**
 * Resolves the host's deck.gl modules, creates the shared overlay, and binds it
 * to the current map (recreating it after a map re-init). Idempotent; safe to
 * call from every producer's own ensure hook.
 *
 * @param app - The host application API.
 * @returns The shared overlay, or null when deck.gl is unavailable.
 */
export function ensureSharedDeckOverlay(app: GeoLibreAppAPI): Promise<MapboxOverlay | null> {
  if (ensureInFlight) return ensureInFlight;
  ensureInFlight = runEnsureSharedDeckOverlay(app).finally(() => {
    ensureInFlight = null;
  });
  return ensureInFlight;
}

async function runEnsureSharedDeckOverlay(app: GeoLibreAppAPI): Promise<MapboxOverlay | null> {
  appRef = app;
  if (!app.getDeckGL) return null;
  deckGL ??= await app.getDeckGL();

  const map = app.getMap?.() ?? null;
  if (overlay && boundMap === map) {
    // Already bound to this map; just refresh the rendered layers.
    renderSharedDeckOverlay();
    return overlay;
  }

  // First attach, or the map was reinitialised (e.g. a projection/globe
  // toggle). Drop the stale overlay before building a fresh one so its Deck
  // cannot leak onto the new map.
  if (overlay && overlayMounted) {
    try {
      app.removeMapControl(overlay);
    } catch (error) {
      // The old map may already be gone; surface anything unexpected.
      console.debug("[GeoLibre] shared-deck-overlay: cleanup", error);
    }
  }
  boundMap = map;
  device = null;
  overlay = new deckGL.mapbox.MapboxOverlay({
    interleaved: true,
    layers: [],
    onDeviceInitialized: (initializedDevice: unknown) => {
      device = initializedDevice;
      for (const listener of deviceListeners) {
        try {
          listener(initializedDevice);
        } catch (error) {
          console.warn("[GeoLibre] shared-deck-overlay: device listener", error);
        }
      }
    },
  });
  overlayMounted = false;
  mountRetries = 0;
  mountGaveUp = false;
  // Also clear the retry latch: a mount-retry rAF may still be queued for the
  // previous overlay, and leaving this true would make the fresh overlay's own
  // scheduleMountRetry a no-op if its first addMapControl attempt also fails.
  mountRetryScheduled = false;
  // Re-apply any layers producers registered before this (re)bind.
  renderSharedDeckOverlay();
  return overlay;
}

/**
 * Sets (or clears, when empty) the deck layers contributed by one producer and
 * re-renders the aggregated overlay. Layers registered before the overlay
 * mounts are retained and applied once it does.
 *
 * @param source - The producer key.
 * @param layers - That producer's deck layers, in its own draw order.
 */
export function setSharedDeckLayers(source: SharedDeckSource, layers: Layer[]): void {
  if (layers.length > 0) layersBySource.set(source, layers);
  else layersBySource.delete(source);
  renderSharedDeckOverlay();
}

/**
 * Registers a listener for the shared Deck's luma device, invoked immediately
 * when the device already exists. Producers that allocate GPU resources against
 * the shared Deck (the raster control) use this instead of passing their own
 * `onDeviceInitialized` to a private overlay.
 *
 * @param listener - Called with the device now (if ready) and on every rebind.
 * @returns An unsubscribe function.
 */
export function onSharedDeckDevice(listener: DeviceListener): () => void {
  deviceListeners.add(listener);
  if (device) {
    try {
      listener(device);
    } catch (error) {
      console.warn("[GeoLibre] shared-deck-overlay: device listener", error);
    }
  }
  return () => {
    deviceListeners.delete(listener);
  };
}

function aggregatedLayers(): Layer[] {
  const layers: Layer[] = [];
  for (const source of SOURCE_DRAW_ORDER) {
    const sourceLayers = layersBySource.get(source);
    if (sourceLayers) layers.push(...sourceLayers);
  }
  return layers;
}

function renderSharedDeckOverlay(): void {
  if (!overlay || !deckGL || !appRef) return;

  const layers = aggregatedLayers();

  // Mount lazily: the map must be ready for addMapControl to succeed, and there
  // is nothing to show until a producer registers layers. Once mounted the
  // overlay stays attached (even when momentarily empty) so its luma device --
  // which the raster control allocates textures against -- is not torn down and
  // recreated on every layer add/remove.
  if (!overlayMounted) {
    if (layers.length === 0) return;
    if (!appRef.addMapControl(overlay, "top-left")) {
      scheduleMountRetry();
      return;
    }
    overlayMounted = true;
    mountRetries = 0;
    mountGaveUp = false;
    // The successful mount can happen on a later retry, after the map became
    // ready; record the map it actually bound to so a subsequent ensure() does
    // not see a stale value and needlessly rebind.
    boundMap = appRef.getMap?.() ?? boundMap;
  }

  overlay.setProps({ layers });
}

function scheduleMountRetry(): void {
  if (mountRetryScheduled || mountGaveUp || typeof requestAnimationFrame === "undefined") {
    return;
  }
  if (mountRetries >= MAX_MOUNT_RETRIES) {
    mountGaveUp = true;
    console.warn(
      "[GeoLibre] shared-deck-overlay: gave up mounting after repeated addMapControl failures.",
    );
    return;
  }
  mountRetries += 1;
  mountRetryScheduled = true;
  requestAnimationFrame(() => {
    mountRetryScheduled = false;
    renderSharedDeckOverlay();
  });
}
