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

export function createWeatherLayer(
  config: WeatherLayerConfig,
): WeatherLayerController {
  let appRef: GeoLibreAppAPI | null = null;
  /** Id of the store layer this engine owns, or null when inactive. */
  let layerId: string | null = null;
  let frames: WeatherFrame[] = [];
  let index = 0;
  let playing = false;
  let frameTimer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  /** Swap the live source to the current frame for an instant visual update. */
  const applyFrameToMap = (): void => {
    if (layerId === null || frames.length === 0) return;
    const map = appRef?.getMap?.() as MapLibreMap | null | undefined;
    const source = map?.getSource(rasterSourceId(layerId)) as
      | RasterTileSource
      | undefined;
    source?.setTiles([frames[index].tileUrl]);
  };

  /**
   * Mirror the current frame into the store layer's `source.tiles` + metadata so
   * the project persists the shown frame and a later source rebuild recreates it
   * correctly. `force` writes even when the tile is unchanged (used on adopt so a
   * layer restored from an older project picks up the current frame + metadata).
   * Clears {@link layerId} if the layer was deleted from the panel.
   */
  const syncStore = (force = false): void => {
    if (layerId === null || frames.length === 0) return;
    const store = useAppStore.getState();
    const layer = store.layers.find((l) => l.id === layerId);
    if (!layer) {
      layerId = null;
      return;
    }
    const frame = frames[index];
    const currentTile = Array.isArray(layer.source.tiles)
      ? layer.source.tiles[0]
      : undefined;
    if (!force && currentTile === frame.tileUrl) return;
    store.updateLayer(layerId, {
      source: { ...layer.source, tiles: [frame.tileUrl] },
      metadata: { ...frame.metadata, [config.layerFlag]: true },
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
    frameTimer = setInterval(() => {
      index = (index + 1) % frames.length;
      // Live source swap only per tick; avoid churning the store (and its dirty
      // flag) every frame — the resting frame is written on pause.
      applyFrameToMap();
      notify();
    }, config.frameMs);
  };

  return {
    activate: async (app: GeoLibreAppAPI): Promise<boolean> => {
      appRef = app;
      frames = await config.loadFrames();
      if (frames.length === 0) {
        appRef = null;
        return false; // source unavailable — the manager rolls the toggle back
      }
      index = frames.length - 1; // newest frame
      playing = false;

      const store = useAppStore.getState();
      // Adopt a layer restored from the project (avoids a duplicate on reload),
      // otherwise add a fresh one. No beforeLayerId — the overlay sits on top.
      const existing = store.layers.find(
        (l) => l.metadata?.[config.layerFlag] === true,
      );
      if (existing) {
        layerId = existing.id;
        syncStore(true); // refresh a stale saved frame + enrich its metadata
        applyFrameToMap();
      } else {
        const frame = frames[index];
        layerId = store.addTileLayer(config.layerName, {
          type: "xyz",
          tiles: [frame.tileUrl],
          url: config.serviceUrl,
          attribution: config.attribution,
          maxzoom: config.maxzoom,
          opacity: config.opacity,
          metadata: { ...frame.metadata, [config.layerFlag]: true },
        });
      }
      notify();
      return true;
    },

    deactivate: (): void => {
      stopPlaying();
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
