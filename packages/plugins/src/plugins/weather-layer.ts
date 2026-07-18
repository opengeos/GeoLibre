import { useAppStore } from "@geolibre/core";
import type { Map as MapLibreMap, RasterTileSource } from "maplibre-gl";
import type { GeoLibreAppAPI } from "../types";

/**
 * Shared engine for the Weather overlays (Clouds, Precipitation).
 *
 * Each weather layer is a normal raster tile layer added through the store's
 * {@link AppState.addTileLayer}, so it appears in the Layers panel, carries its
 * own visibility/opacity, and round-trips with the project. A time-scrub
 * animation steps the layer through a set of frames. Because
 * `syncRasterTileLayer` only creates a raster source once and never re-reads
 * `tiles`, playback drives the live source's `setTiles` directly for instant
 * frame swaps, and mirrors the current frame back into the store layer so
 * persistence and any source rebuild (e.g. a basemap change) stay in step.
 *
 * The two overlays differ only in how frames are produced (locally computed
 * NASA dates vs. fetched RainViewer radar timestamps), the tile URLs, and the
 * descriptive metadata — all supplied via {@link WeatherLayerConfig}.
 */

export interface WeatherFrame {
  /** Full tile URL template with `{z}`/`{x}`/`{y}` placeholders. */
  tileUrl: string;
  /** Short scrubber label (e.g. a date or a time-of-day). */
  label: string;
  /** Descriptive metadata written to the store layer for this frame. */
  metadata: Record<string, unknown>;
}

export interface WeatherAnimationState {
  /** Per-frame scrubber labels, oldest → newest. */
  labels: string[];
  /** Current frame index into {@link labels}. */
  index: number;
  /** Whether the animation is playing. */
  playing: boolean;
  /** Whether the overlay layer is present (plugin active). */
  active: boolean;
}

export interface WeatherLayerConfig {
  /** Layer name shown in the Layers panel. */
  layerName: string;
  /** Metadata flag marking the store layer this engine owns (adopt-on-restore). */
  layerFlag: string;
  /** Attribution string recorded on the raster source. */
  attribution: string;
  /** Service/base URL recorded on the layer for display. */
  serviceUrl: string;
  /** Source maxzoom; MapLibre overzooms above it. */
  maxzoom: number;
  /**
   * Tile size in px (default 256). A larger size (e.g. 512) covers the viewport
   * with far fewer tiles, so each frame swap issues a fraction of the requests —
   * key to keeping an animated tile source under a public host's rate limit.
   */
  tileSize?: number;
  /** Initial layer opacity (the user adjusts it from the Layers panel). */
  opacity: number;
  /** Animation frame interval while playing, in ms. */
  frameMs: number;
  /**
   * Produce the animation frames (may fetch). Newest last. An empty result
   * means the source is unavailable and activation fails.
   */
  loadFrames: () => WeatherFrame[] | Promise<WeatherFrame[]>;
}

export interface WeatherLayerController {
  activate: (app: GeoLibreAppAPI) => Promise<boolean>;
  deactivate: () => void;
  getState: () => WeatherAnimationState;
  setFrame: (index: number) => void;
  togglePlaying: () => void;
  subscribe: (listener: () => void) => () => void;
}

/** The live raster source id the map assigns to a store layer (`@geolibre/map`'s `sourceId`). */
function rasterSourceId(layerId: string): string {
  return `source-${layerId}`;
}

/**
 * Shallow equality for a layer's flat metadata record that ignores top-level
 * key order, so `syncStore` can skip a no-op write even after a JSON round-trip
 * or a future reordering of the metadata builders. Weather metadata values are
 * primitives; the per-value `JSON.stringify` compare would be order-sensitive
 * for a nested object value, but none are used here.
 */
function metadataEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(b, key) &&
      JSON.stringify(a[key]) === JSON.stringify(b[key]),
  );
}

export function createWeatherLayer(config: WeatherLayerConfig): WeatherLayerController {
  let appRef: GeoLibreAppAPI | null = null;
  /** Id of the store layer this engine owns, or null when inactive. */
  let layerId: string | null = null;
  let frames: WeatherFrame[] = [];
  let index = 0;
  let playing = false;
  let frameTimer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<() => void>();
  /** Recent tile-load-failure timestamps for this layer's source (ms). */
  let errorTimestamps: number[] = [];
  let mapErrorHandler: ((event: unknown) => void) | null = null;
  /**
   * Bumped on every activate() and deactivate() so an async activation (the
   * RainViewer fetch takes real network time) can tell it was superseded by a
   * toggle-off or a re-toggle that happened while its `loadFrames()` was still
   * in flight — and bail instead of resurrecting or duplicating the layer.
   */
  let activationGeneration = 0;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  /** Swap the live source to the current frame for an instant visual update. */
  const applyFrameToMap = (): void => {
    if (layerId === null || frames.length === 0) return;
    const map = appRef?.getMap?.() as MapLibreMap | null | undefined;
    const source = map?.getSource(rasterSourceId(layerId)) as RasterTileSource | undefined;
    source?.setTiles([frames[index].tileUrl]);
  };

  /**
   * Mirror the current frame into the store layer's `source.tiles` + metadata so
   * the project persists the shown frame and a later source rebuild recreates it
   * correctly. Writes only when the tile OR the metadata actually differs — a
   * no-op write would still flip the project's `isDirty` flag, so reopening a
   * project with an already-current overlay must not mark it dirty. (Comparing
   * metadata too, not just the tile, still lets an adopt from an older project
   * enrich sparse metadata even when the tile matches.) Clears {@link layerId}
   * if the layer was deleted from the panel.
   */
  const syncStore = (): void => {
    if (layerId === null || frames.length === 0) return;
    const store = useAppStore.getState();
    const layer = store.layers.find((l) => l.id === layerId);
    if (!layer) {
      layerId = null;
      return;
    }
    const frame = frames[index];
    const nextMetadata = { ...frame.metadata, [config.layerFlag]: true };
    const currentTile = Array.isArray(layer.source.tiles) ? layer.source.tiles[0] : undefined;
    const unchanged = currentTile === frame.tileUrl && metadataEqual(layer.metadata, nextMetadata);
    if (unchanged) return;
    store.updateLayer(layerId, {
      source: { ...layer.source, tiles: [frame.tileUrl] },
      metadata: nextMetadata,
    });
  };

  const stopPlaying = (): void => {
    if (frameTimer) {
      clearInterval(frameTimer);
      frameTimer = null;
    }
    if (playing) {
      playing = false;
      // Persist the frame we landed on so a saved project reopens on it.
      syncStore();
    }
  };

  const startPlaying = (): void => {
    if (playing || layerId === null || frames.length <= 1) return;
    playing = true;
    errorTimestamps = [];
    frameTimer = setInterval(() => {
      // If the layer was deleted from the Layers panel mid-playback, halt so the
      // loop doesn't keep advancing/notifying against a layer that's gone.
      if (layerId === null || !useAppStore.getState().layers.some((l) => l.id === layerId)) {
        stopPlaying();
        notify();
        return;
      }
      index = (index + 1) % frames.length;
      // Live source swap only per tick; avoid churning the store (and its dirty
      // flag) every frame — the resting frame is written on pause.
      applyFrameToMap();
      notify();
    }, config.frameMs);
  };

  /**
   * Break the failure cascade: if this layer's source starts failing to fetch
   * tiles while the loop is running (the tile host rate-limiting the animation),
   * `setTiles` would keep re-requesting them every frame — spamming errors
   * non-stop and starving the rest of the map. Detect a burst of source errors
   * and stop the loop so the map stays responsive; the user can press Play to
   * retry. Only failures for THIS layer's source count.
   */
  const handleMapError = (event: unknown): void => {
    if (!playing || layerId === null) return;
    const record = event as { sourceId?: string; error?: { sourceId?: string } } | null | undefined;
    const sourceId = record?.sourceId ?? record?.error?.sourceId;
    if (sourceId !== rasterSourceId(layerId)) return;
    const now = Date.now();
    errorTimestamps.push(now);
    errorTimestamps = errorTimestamps.filter((t) => now - t < 2500);
    if (errorTimestamps.length >= 5) {
      errorTimestamps = [];
      stopPlaying();
      console.warn(
        `[${config.layerName}] tile requests are failing; paused the animation to keep the map responsive. Press Play to retry.`,
      );
      notify();
    }
  };

  return {
    activate: async (app: GeoLibreAppAPI): Promise<boolean> => {
      const generation = (activationGeneration += 1);
      // Nothing is mutated until after the await + the supersede check, so a
      // toggle-off/on during the fetch can't leave partial state behind.
      const loaded = await config.loadFrames();
      if (generation !== activationGeneration) {
        return false; // a deactivate() or newer activate() superseded this one
      }
      const store = useAppStore.getState();
      // A layer restored from the saved project (tagged with our flag), if any.
      const existing = store.layers.find((l) => l.metadata?.[config.layerFlag] === true);
      // No fresh frames (offline / source briefly down): adopt a restored layer
      // and keep its last-saved tiles so it isn't orphaned in the panel with no
      // menu control; only fail (rolling the toggle back) when there's nothing
      // to show at all.
      if (loaded.length === 0 && !existing) return false;

      appRef = app;
      frames = loaded;
      index = Math.max(0, frames.length - 1); // newest frame (0 when none)
      playing = false;

      if (existing) {
        layerId = existing.id;
        // Refresh to the latest frame only when a fresh fetch succeeded;
        // otherwise leave the restored layer's saved tiles/metadata in place.
        // syncStore() is a no-op (no dirty flag) when already current.
        if (frames.length > 0) {
          syncStore();
          applyFrameToMap();
        }
      } else {
        // Guaranteed frames.length > 0 here (the empty + no-existing case
        // returned above). No beforeLayerId — the overlay sits on top.
        const frame = frames[index];
        layerId = store.addTileLayer(config.layerName, {
          type: "xyz",
          tiles: [frame.tileUrl],
          url: config.serviceUrl,
          attribution: config.attribution,
          maxzoom: config.maxzoom,
          tileSize: config.tileSize ?? 256,
          opacity: config.opacity,
          metadata: { ...frame.metadata, [config.layerFlag]: true },
        });
      }

      // Watch for this source's tile failures so a rate-limited animation can
      // stop itself instead of spiralling (see handleMapError).
      const map = appRef?.getMap?.() as MapLibreMap | null | undefined;
      if (map) {
        mapErrorHandler = handleMapError;
        map.on("error", mapErrorHandler);
      }

      notify();
      return true;
    },

    deactivate: (): void => {
      // Invalidate any activate() whose loadFrames() is still in flight so it
      // won't re-add the layer after the user turned it off.
      activationGeneration += 1;
      // Stop the timer directly rather than via stopPlaying(): its syncStore()
      // persistence write would be pure waste right before removeLayer() below.
      if (frameTimer) {
        clearInterval(frameTimer);
        frameTimer = null;
      }
      playing = false;
      const map = appRef?.getMap?.() as MapLibreMap | null | undefined;
      if (map && mapErrorHandler) map.off("error", mapErrorHandler);
      mapErrorHandler = null;
      errorTimestamps = [];
      if (layerId !== null) {
        const store = useAppStore.getState();
        if (store.layers.some((l) => l.id === layerId)) {
          store.removeLayer(layerId);
        }
      }
      layerId = null;
      appRef = null;
      frames = [];
      index = 0;
      notify();
    },

    getState: (): WeatherAnimationState => ({
      labels: frames.map((f) => f.label),
      index,
      playing,
      active: layerId !== null,
    }),

    /** Jump to a scrub frame. A manual scrub pauses playback. */
    setFrame: (next: number): void => {
      if (layerId === null || frames.length === 0) return;
      stopPlaying();
      index = Math.max(0, Math.min(frames.length - 1, Math.round(next)));
      applyFrameToMap();
      syncStore();
      notify();
    },

    togglePlaying: (): void => {
      if (playing) stopPlaying();
      else startPlaying();
      notify();
    },

    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
