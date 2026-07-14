/**
 * Timelapse mode — animate through annual satellite imagery basemaps.
 *
 * The plugin opens a draggable, resizable floating panel (the host's
 * floating-panel card) with a year slider, play/pause, speed and loop
 * settings, and a Record button that exports one animation cycle to MP4/WebM.
 * Frames come from a {@link TimelapseProvider} (EOX Sentinel-2 cloudless
 * annual mosaics by default; see timelapse-providers.ts).
 *
 * Flicker-free playback: all frames are added as raster sources/layers up
 * front, every layer `visibility: visible` with `raster-opacity: 0` except the
 * active year. Layers with `visibility: none` never fetch tiles, but visible
 * opacity-0 layers do — so the whole stack stays tile-warm and advancing a
 * year is just two `setPaintProperty` calls, with no source mutation and no
 * refetch. `raster-fade-duration: 0` kills the per-tile fade flash and a zero
 * opacity transition keeps recorded frames a pure single year.
 *
 * Store integration: the stack is mirrored as ONE store layer (a tidy Layers
 * panel entry) whose `metadata.customLayerType` puts it on layer-sync's
 * ordering-only path — panel reorder moves all native layers together, while
 * this plugin owns their visibility/paint by subscribing to the store.
 */

import {
  DEFAULT_LAYER_STYLE,
  useAppStore,
  type GeoLibreLayer,
} from "@geolibre/core";
import type { Map as MapLibreMap } from "maplibre-gl";
import type {
  GeoLibreAppAPI,
  GeoLibreFloatingPanelRegistration,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
} from "../types";
import {
  CANVAS_VIDEO_BITS_PER_SECOND,
  CANVAS_VIDEO_STOP_TIMEOUT_MS,
  canvasVideoExtensionForMime,
  pickSupportedCanvasVideoMimeType,
} from "./canvas-video";
import {
  clampSecondsPerYear,
  frameIndexForYear,
  nextFrameIndex,
  normalizeTimelapseProjectState,
  TIMELAPSE_SPEED_STEPS,
  type TimelapseProjectState,
} from "./timelapse-engine";
import {
  getTimelapseProvider,
  listTimelapseProviders,
  type TimelapseFrame,
  type TimelapseProvider,
} from "./timelapse-providers";

export const TIMELAPSE_PLUGIN_ID = "geolibre-timelapse";

/** Floating-panel card id (registered with the host's panel registry). */
export const TIMELAPSE_PANEL_ID = "geolibre-timelapse-panel";

/** Tags the plugin's own store layer so it can find and prune only its own. */
export const TIMELAPSE_SOURCE_KIND = "timelapse";

/**
 * Marks the store layer for layer-sync's ordering-only external path (see
 * `isExternalCustomLayer` in packages/map/src/layer-sync.ts): sync moves the
 * native layers on panel reorder but never touches their visibility/paint,
 * which this plugin owns (per-year opacity would otherwise be overwritten).
 */
export const TIMELAPSE_CUSTOM_LAYER_TYPE = "timelapse-frames";

/** The store layer id mirroring a provider's frame stack. */
export function timelapseStoreLayerId(providerId: string): string {
  return `timelapse-${providerId}`;
}

function frameSourceId(frame: TimelapseFrame): string {
  return `timelapse-source-${frame.id}`;
}

function frameLayerId(frame: TimelapseFrame): string {
  return `timelapse-layer-${frame.id}`;
}

/** How long a playback tick waits for the next year's tiles before advancing
 * anyway, so a dead tile host degrades to visible loading rather than a
 * frozen animation. */
const SOURCE_LOADED_TIMEOUT_MS = 2000;

/** Fallback for the cosmetic tiles-ready gate: enable Play/Record this long
 * after the stack is built even if the map never fires `idle`. A slow or
 * partly-404 tile host (e.g. GIBS, which has no imagery over ocean) can keep
 * the map from ever settling, which would otherwise leave Play stuck disabled
 * until an unrelated interaction nudges the map idle. */
const TILES_READY_FALLBACK_MS = 3000;

/** Strict per-frame render gate while recording (`idle` can legitimately take
 * a while on slow networks; bail out so a stuck source can't hang the export). */
const RECORD_IDLE_TIMEOUT_MS = 8000;

/** Recording samples the composite canvas at this rate. */
const RECORD_FPS = 30;

/** Recording never dwells less than this per year, so every year is visible. */
const RECORD_MIN_SECONDS_PER_YEAR = 0.5;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * User-facing strings for the panel. This package is framework-agnostic and
 * cannot call react-i18next's `t()` directly, so the host pushes translated
 * values via {@link setTimelapseLabels} on every language change (the pattern
 * used by `maplibre-graticule` / `maplibre-reverse-geocode`; wired from
 * `TopToolbar.tsx`). Defaults are English.
 */
export interface TimelapseLabels {
  /** Panel title shown in the floating card's title bar. */
  title: string;
  /** Accessible name of the imagery-provider picker (shown only with >1 provider). */
  provider: string;
  /** Heading above a thematic provider's class legend (e.g. land cover). */
  legend: string;
  yearSlider: string;
  play: string;
  pause: string;
  speed: string;
  /** Accessible name of the speed select. */
  secondsPerYear: string;
  /** Unit suffix in the speed options (e.g. `1 s/yr`). */
  secondsPerYearSuffix: string;
  loop: string;
  record: string;
  stopRecording: string;
  /** Progress prefix while recording (`Recording 4/10…`). */
  recording: string;
  recordingFailed: string;
  recordingUnsupported: string;
  loadingTiles: string;
}

export const DEFAULT_TIMELAPSE_LABELS: TimelapseLabels = {
  title: "Timelapse",
  provider: "Imagery source",
  legend: "Legend",
  yearSlider: "Timelapse year",
  play: "Play",
  pause: "Pause",
  speed: "Speed",
  secondsPerYear: "Seconds per year",
  secondsPerYearSuffix: "s/yr",
  loop: "Loop",
  record: "Record video",
  stopRecording: "Stop recording",
  recording: "Recording",
  recordingFailed: "Recording failed.",
  recordingUnsupported: "Canvas recording is not supported in this browser.",
  loadingTiles: "Loading tiles…",
};

let labels: TimelapseLabels = { ...DEFAULT_TIMELAPSE_LABELS };

/**
 * Replace the user-facing strings (the host calls this with translations on
 * every language change) and push them into the live panel.
 */
export function setTimelapseLabels(next: Partial<TimelapseLabels>): void {
  labels = { ...labels, ...next };
  timelapseControl?.refreshLabels();
  syncPanelRegistration();
}

/**
 * Theme a native `<select>` so its text/border track the app theme. Inline (not
 * just the index.css `.geolibre-timelapse-panel` block, which themes the option
 * popup): rules from other control stylesheets can outrank a class selector.
 * The `important` color is required — with the app's global `transition: all`
 * on form controls, Chromium otherwise keeps reporting the pre-theme (black)
 * text color for a plain inline declaration.
 */
function styleThemedSelect(select: HTMLSelectElement): void {
  select.style.background = "hsl(var(--background))";
  select.style.setProperty("color", "hsl(var(--foreground))", "important");
  select.style.border = "1px solid hsl(var(--border))";
  select.style.borderRadius = "4px";
  select.style.padding = "2px 4px";
}

/** Shared styling for the panel's labelled (Play/Record) buttons. */
function stylePillButton(button: HTMLButtonElement): void {
  button.type = "button";
  button.style.cursor = "pointer";
  button.style.whiteSpace = "nowrap";
  button.style.padding = "2px 10px";
  button.style.border = "1px solid hsl(var(--border))";
  button.style.borderRadius = "4px";
  button.style.background = "transparent";
  button.style.color = "inherit";
}

// ---------------------------------------------------------------------------
// Store layer mirror
// ---------------------------------------------------------------------------

function createTimelapseStoreLayer(
  provider: TimelapseProvider,
  frames: readonly TimelapseFrame[],
): GeoLibreLayer {
  return {
    id: timelapseStoreLayerId(provider.id),
    name: `Timelapse: ${provider.name}`,
    type: "raster",
    source: { type: "raster", providerId: provider.id },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      externalNativeLayer: true,
      customLayerType: TIMELAPSE_CUSTOM_LAYER_TYPE,
      identifiable: false,
      nativeLayerIds: frames.map(frameLayerId),
      sourceIds: frames.map(frameSourceId),
      sourceKind: TIMELAPSE_SOURCE_KIND,
    },
  };
}

interface StoreLayerSnapshot {
  exists: boolean;
  visible: boolean;
  opacity: number;
}

function getStoreLayerSnapshot(): StoreLayerSnapshot {
  const layer = useAppStore
    .getState()
    .layers.find((item) => item.metadata?.sourceKind === TIMELAPSE_SOURCE_KIND);
  return layer
    ? { exists: true, visible: layer.visible, opacity: layer.opacity }
    : { exists: false, visible: true, opacity: 1 };
}

function removeTimelapseStoreLayers(): void {
  const store = useAppStore.getState();
  const staleIds = store.layers
    .filter((layer) => layer.metadata?.sourceKind === TIMELAPSE_SOURCE_KIND)
    .map((layer) => layer.id);
  for (const id of staleIds) store.removeLayer(id);
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

interface TimelapseControlOptions {
  map: MapLibreMap | null;
  provider: TimelapseProvider;
  frames: TimelapseFrame[];
  initial: TimelapseProjectState | null;
}

/**
 * The timelapse engine + floating-panel body (plain DOM, per the plugin
 * contract — external plugins share no React with the host). All map/store
 * work is guarded so the class is also usable headless in unit tests, where
 * {@link renderInto} never runs.
 */
export class TimelapseControl {
  // Not readonly: switchProvider swaps the active imagery provider (and its
  // frame stack) in place without tearing down the panel.
  provider: TimelapseProvider;
  frames: TimelapseFrame[];

  private map: MapLibreMap | null;
  private frameIndex = 0;
  private secondsPerYear: number;
  private loop: boolean;
  private playing = false;
  private recording = false;
  private tilesReady = false;
  private stackPresent = false;
  private playTimer: ReturnType<typeof setTimeout> | null = null;
  // Fallback timer for the tiles-ready gate (see armTilesReadyGate); cleared
  // when the map fires `idle` first, when re-arming, and on teardown.
  private tilesReadyTimer: ReturnType<typeof setTimeout> | null = null;
  // The current `idle` listener for the tiles-ready gate, tracked so a stale
  // one from a prior arm can be removed before re-arming.
  private tilesReadyIdleHandler: (() => void) | null = null;
  // Bumped by play()/pause() so a tick() awaiting the next year's tiles when
  // playback is toggled can tell it is stale and must not advance the frame
  // (a resumed session schedules its own timer; the old tick racing it would
  // double-advance).
  private playSession = 0;
  // Bumped by switchProvider() so a slow async provider whose listFrames()
  // resolves after the user has already picked another cannot clobber the newer
  // selection (mirrors playSession / the plugin-level activationSession).
  private switchSession = 0;
  private recordAbort: AbortController | null = null;

  // The floating-panel body container, kept so switchProvider can re-render the
  // slider range/labels/attribution in place after swapping providers.
  private container: HTMLElement | null = null;
  private providerSelect: HTMLSelectElement | null = null;
  private slider: HTMLInputElement | null = null;
  private playButton: HTMLButtonElement | null = null;
  private yearLabel: HTMLElement | null = null;
  private speedText: Text | null = null;
  private speedSelect: HTMLSelectElement | null = null;
  private loopText: Text | null = null;
  private recordButton: HTMLButtonElement | null = null;
  private recordStatus: HTMLElement | null = null;
  private attributionLine: HTMLElement | null = null;
  private legendHeading: HTMLElement | null = null;
  private badge: HTMLElement | null = null;

  constructor(options: TimelapseControlOptions) {
    this.map = options.map;
    this.provider = options.provider;
    this.frames = options.frames;
    const initial = options.initial;
    this.secondsPerYear = clampSecondsPerYear(initial?.secondsPerYear);
    this.loop = initial?.loop ?? true;
    this.frameIndex = frameIndexForYear(this.frames, initial?.year);
  }

  // --- Public state ------------------------------------------------------------

  getMapInstance(): MapLibreMap | null {
    return this.map;
  }

  getState(): TimelapseProjectState {
    return {
      providerId: this.provider.id,
      year: this.frames[this.frameIndex]?.year ?? 0,
      secondsPerYear: this.secondsPerYear,
      loop: this.loop,
    };
  }

  applyState(state: TimelapseProjectState): void {
    this.secondsPerYear = clampSecondsPerYear(state.secondsPerYear);
    this.loop = state.loop;
    this.setFrameIndex(frameIndexForYear(this.frames, state.year));
    this.refreshLabels();
  }

  getFrameIndex(): number {
    return this.frameIndex;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  isRecording(): boolean {
    return this.recording;
  }

  // --- Native frame stack -------------------------------------------------------

  /**
   * Add every frame's raster source + layer to the map (skipping ones already
   * present) and make sure the single mirroring store layer exists. Safe to
   * call repeatedly — used on activation, after a basemap style reload, and
   * when the user re-engages after deleting the Layers-panel entry.
   */
  ensureStack(): void {
    const map = this.map;
    if (!map) return;
    const snapshot = getStoreLayerSnapshot();
    for (const [index, frame] of this.frames.entries()) {
      const sourceId = frameSourceId(frame);
      if (!map.getSource(sourceId)) {
        map.addSource(sourceId, {
          type: "raster",
          tiles: [frame.tileUrlTemplate],
          tileSize: frame.tileSize ?? 256,
          ...(frame.minzoom !== undefined ? { minzoom: frame.minzoom } : {}),
          ...(frame.maxzoom !== undefined ? { maxzoom: frame.maxzoom } : {}),
          ...(frame.scheme === "tms" ? { scheme: "tms" as const } : {}),
          attribution: this.provider.attribution,
        });
      }
      const layerId = frameLayerId(frame);
      if (!map.getLayer(layerId)) {
        map.addLayer({
          id: layerId,
          type: "raster",
          source: sourceId,
          paint: {
            "raster-opacity":
              index === this.frameIndex && snapshot.visible
                ? snapshot.opacity
                : 0,
            // No per-tile fade and no opacity transition: a year swap must be
            // instant and atomic, or playback (and especially recorded frames)
            // shows a blend of two years.
            "raster-fade-duration": 0,
            "raster-opacity-transition": { duration: 0 },
          },
          layout: { visibility: snapshot.visible ? "visible" : "none" },
        });
      }
    }
    this.stackPresent = true;
    if (!snapshot.exists) {
      useAppStore
        .getState()
        .addLayer(createTimelapseStoreLayer(this.provider, this.frames));
    }
    this.armTilesReadyGate();
  }

  /** Remove every frame layer/source this control added (guarded lookups). */
  removeStack(): void {
    const map = this.map;
    this.stackPresent = false;
    if (!map) return;
    for (const frame of this.frames) {
      const layerId = frameLayerId(frame);
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      const sourceId = frameSourceId(frame);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    }
  }

  /** Rebuild after a basemap change wiped the style's sources and layers. */
  rebuildStack(): void {
    this.stackPresent = false;
    this.ensureStack();
  }

  /**
   * Swap the active imagery provider (the panel's provider picker). Pauses
   * playback, tears down the current frame stack and mirroring store layer,
   * resolves the new provider's frames (awaiting a remote catalog if the
   * provider is async), rebuilds the pre-warmed stack from the oldest year, and
   * re-renders the panel body in place so the slider range, end labels, and
   * attribution follow the new years.
   *
   * A no-op that leaves the current stack untouched (and re-syncs the picker to
   * the active provider) when: a recording is in flight, the id resolves back
   * to the current provider, a newer switch superseded this one while its
   * frames were resolving, the async catalog rejected, or the provider yields
   * no frames. The {@link switchSession} counter mirrors the `activationSession`
   * /`playSession` pattern so a slow async provider that resolves after the
   * user has already picked another cannot clobber the newer selection.
   */
  async switchProvider(providerId: string): Promise<void> {
    // Tearing down the stack mid-recording would corrupt the export (the record
    // loop is drawing from these exact layers); the select is also disabled
    // while recording, so this only guards the programmatic path.
    if (this.recording) return;
    // Bump the session on every early return too: re-selecting the active
    // provider must cancel a still-pending switch to another one (otherwise
    // that older switch's resolution would pass the superseded check below and
    // apply, overriding this re-selection).
    if (providerId === this.provider.id) {
      this.switchSession += 1;
      return;
    }
    const provider = getTimelapseProvider(providerId);
    // An unknown id falls back to the built-in provider; if that is the one
    // already active, there is nothing to switch to — but the native <select>
    // has already moved to the rejected option, so restore its display.
    if (provider.id === this.provider.id) {
      this.switchSession += 1;
      this.syncProviderSelect();
      return;
    }
    const session = ++this.switchSession;
    let frames: TimelapseFrame[];
    try {
      const framesResult = provider.listFrames();
      frames = Array.isArray(framesResult) ? framesResult : await framesResult;
    } catch {
      // A remote catalog can reject; keep the current provider and re-sync the
      // picker so it doesn't advertise a source that never loaded.
      if (session === this.switchSession) this.syncProviderSelect();
      return;
    }
    // A newer switch superseded this resolution while awaiting; the winning
    // call owns the picker and stack, so bail without touching either.
    if (session !== this.switchSession) return;
    // A recording may have started while an async listFrames() was pending (the
    // picker only disables once recording begins, which is after this switch
    // started); tearing down the stack now would corrupt that export, so bail
    // and restore the picker to the still-active provider.
    if (this.recording) {
      this.syncProviderSelect();
      return;
    }
    if (frames.length === 0) {
      this.syncProviderSelect();
      return;
    }
    this.pause();
    this.removeStack();
    removeTimelapseStoreLayers();
    this.provider = provider;
    this.frames = frames;
    this.frameIndex = 0;
    this.ensureStack();
    // Re-render the panel body so the slider bounds/labels and attribution
    // reflect the new frame set (renderInto rebuilds it from scratch, which
    // also selects the active provider in the picker).
    if (this.container) this.renderInto(this.container);
  }

  /**
   * Restore the provider `<select>`'s displayed value to the active provider,
   * after an early return that did not apply the user's picked option (the
   * browser moves the native select on `change` before the handler runs).
   */
  private syncProviderSelect(): void {
    if (this.providerSelect) this.providerSelect.value = this.provider.id;
  }

  /**
   * React to the mirroring store layer changing (Layers panel interaction).
   * The ordering-only sync path never touches visibility/paint, so the plugin
   * applies the store layer's `visible`/`opacity` to its native layers itself.
   */
  onStoreLayerChange(
    previous: StoreLayerSnapshot,
    next: StoreLayerSnapshot,
  ): void {
    if (!next.exists) {
      // Panel delete: layer-sync removed the native layers/sources; mirror
      // that here (guarded, so it is also correct headless) and stop playback.
      this.pause();
      this.removeStack();
      this.updateUi();
      return;
    }
    const map = this.map;
    if (!map || !this.stackPresent) return;
    if (next.visible !== previous.visible || !previous.exists) {
      for (const frame of this.frames) {
        const layerId = frameLayerId(frame);
        if (map.getLayer(layerId)) {
          map.setLayoutProperty(
            layerId,
            "visibility",
            next.visible ? "visible" : "none",
          );
        }
      }
      if (!next.visible) this.pause();
    }
    if (next.opacity !== previous.opacity || next.visible !== previous.visible) {
      const activeFrame = this.frames[this.frameIndex];
      if (activeFrame && map.getLayer(frameLayerId(activeFrame))) {
        map.setPaintProperty(
          frameLayerId(activeFrame),
          "raster-opacity",
          next.visible ? next.opacity : 0,
        );
      }
    }
    this.updateUi();
  }

  // --- Playback ---------------------------------------------------------------

  /** Jump to a frame: exactly two raster-opacity writes when it changes. */
  setFrameIndex(next: number): void {
    const clamped = Math.max(0, Math.min(this.frames.length - 1, next));
    if (clamped === this.frameIndex) {
      this.updateUi();
      return;
    }
    const previous = this.frames[this.frameIndex];
    const target = this.frames[clamped];
    this.frameIndex = clamped;
    const map = this.map;
    if (map && this.stackPresent) {
      const snapshot = getStoreLayerSnapshot();
      if (previous && map.getLayer(frameLayerId(previous))) {
        map.setPaintProperty(frameLayerId(previous), "raster-opacity", 0);
      }
      if (target && map.getLayer(frameLayerId(target))) {
        map.setPaintProperty(
          frameLayerId(target),
          "raster-opacity",
          snapshot.visible ? snapshot.opacity : 0,
        );
      }
    }
    this.updateUi();
  }

  play(): void {
    if (this.playing || this.recording || this.frames.length < 2) return;
    if (!this.stackPresent) this.ensureStack();
    const snapshot = getStoreLayerSnapshot();
    if (snapshot.exists && !snapshot.visible) {
      // Playing a hidden layer would animate nothing; flip it visible first.
      const store = useAppStore.getState();
      const layerId = timelapseStoreLayerId(this.provider.id);
      if (store.layers.some((layer) => layer.id === layerId)) {
        store.updateLayer(layerId, { visible: true });
      }
    }
    this.playing = true;
    this.playSession += 1;
    this.scheduleTick();
    this.updateUi();
  }

  pause(): void {
    this.playing = false;
    this.playSession += 1;
    if (this.playTimer !== null) {
      clearTimeout(this.playTimer);
      this.playTimer = null;
    }
    this.updateUi();
  }

  setSecondsPerYear(value: number): void {
    this.secondsPerYear = clampSecondsPerYear(value);
    this.updateUi();
  }

  setLoop(loop: boolean): void {
    this.loop = loop;
    this.updateUi();
  }

  /** Pause and abort any in-flight recording (deactivate/teardown path). */
  stopForTeardown(): void {
    this.pause();
    this.recordAbort?.abort();
  }

  /** Release DOM owned outside the panel container (the on-map year badge). */
  dispose(): void {
    this.stopForTeardown();
    this.clearTilesReadyTimer();
    this.clearTilesReadyIdleHandler();
    this.badge?.remove();
    this.badge = null;
  }

  private scheduleTick(): void {
    if (this.playTimer !== null) clearTimeout(this.playTimer);
    this.playTimer = setTimeout(() => {
      this.playTimer = null;
      void this.tick();
    }, this.secondsPerYear * 1000);
  }

  private async tick(): Promise<void> {
    if (!this.playing) return;
    const session = this.playSession;
    const next = nextFrameIndex(this.frameIndex, this.frames.length, this.loop);
    if (next === null) {
      this.pause();
      return;
    }
    const frame = this.frames[next];
    if (frame) await this.waitForSourceLoaded(frameSourceId(frame));
    // A pause (or pause+resume) while awaiting tiles makes this tick stale:
    // the resumed session runs on its own timer, so advancing here too would
    // double-step onto a frame computed before the pause.
    if (!this.playing || session !== this.playSession) return;
    this.setFrameIndex(next);
    this.scheduleTick();
  }

  /**
   * Wait (bounded) until a source has its current tiles loaded, so playback
   * advances onto rendered imagery instead of a blank flash. Bails out after
   * {@link SOURCE_LOADED_TIMEOUT_MS} so a dead tile host degrades to visible
   * loading rather than freezing the animation.
   */
  private async waitForSourceLoaded(
    sourceId: string,
    timeoutMs = SOURCE_LOADED_TIMEOUT_MS,
  ): Promise<void> {
    const map = this.map;
    if (!map) return;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        if (map.isSourceLoaded(sourceId)) return;
      } catch {
        // isSourceLoaded throws for unknown sources (e.g. mid style reload).
        return;
      }
      if (Date.now() >= deadline) return;
      await delay(50);
    }
  }

  /**
   * Disable Play (cosmetically) until the pre-warmed stack has fetched its
   * first round of tiles; the per-tick source gate is the real protection.
   * Play is re-enabled on whichever comes first — the map going `idle` or the
   * {@link TILES_READY_FALLBACK_MS} fallback — so a tile host that never lets
   * the map settle (a slow or partly-404 source such as GIBS over ocean) can't
   * leave the button stuck disabled.
   */
  private armTilesReadyGate(): void {
    this.tilesReady = false;
    this.clearTilesReadyTimer();
    this.updateUi();
    const map = this.map;
    if (!map || typeof map.once !== "function") {
      this.tilesReady = true;
      return;
    }
    // Drop a still-pending `idle` listener from a prior arm (e.g. a provider
    // switch before the last stack settled), so its stale closure can't flip
    // the new gate ready when `idle` finally fires.
    this.clearTilesReadyIdleHandler();
    const markReady = (): void => {
      this.clearTilesReadyTimer();
      this.clearTilesReadyIdleHandler();
      if (this.tilesReady) return;
      this.tilesReady = true;
      this.updateUi();
    };
    this.tilesReadyIdleHandler = markReady;
    map.once("idle", markReady);
    this.tilesReadyTimer = setTimeout(markReady, TILES_READY_FALLBACK_MS);
  }

  private clearTilesReadyTimer(): void {
    if (this.tilesReadyTimer !== null) {
      clearTimeout(this.tilesReadyTimer);
      this.tilesReadyTimer = null;
    }
  }

  private clearTilesReadyIdleHandler(): void {
    if (this.tilesReadyIdleHandler) {
      this.map?.off?.("idle", this.tilesReadyIdleHandler);
      this.tilesReadyIdleHandler = null;
    }
  }

  // --- Recording ----------------------------------------------------------------

  private async handleRecordClick(): Promise<void> {
    if (this.recording) {
      this.recordAbort?.abort();
      return;
    }
    // Mirror the Play gate (the button is disabled in updateUi, but guard the
    // programmatic path too): recording against an absent stack would export
    // a blank map with year labels, and starting before the pre-warm idle
    // would capture half-loaded opening frames.
    if (!this.stackPresent || !this.tilesReady) return;
    this.recording = true;
    this.recordAbort = new AbortController();
    this.pause();
    this.updateUi();
    try {
      const result = await recordTimelapseCycle({
        signal: this.recordAbort.signal,
        onFrame: (index, total) => {
          if (this.recordStatus) {
            this.recordStatus.textContent = `${labels.recording} ${index + 1}/${total}…`;
          }
        },
      });
      // An abort mid-first-frame can produce an empty file; treat as cancel.
      if (result.blob.size > 0) {
        await saveTimelapseRecording(result, this.provider.id);
      }
      if (this.recordStatus) this.recordStatus.textContent = "";
    } catch (error) {
      if (this.recordStatus) {
        this.recordStatus.textContent =
          error instanceof TimelapseVideoUnsupportedError
            ? labels.recordingUnsupported
            : error instanceof Error
              ? error.message
              : labels.recordingFailed;
      }
    } finally {
      this.recording = false;
      this.recordAbort = null;
      this.updateUi();
    }
  }

  // --- DOM ------------------------------------------------------------------------

  /**
   * Fill the floating-panel card body. Called by the host's `render` contract
   * each time the panel opens; returns the cleanup the host runs on close.
   */
  renderInto(container: HTMLElement): () => void {
    this.container = container;
    container.innerHTML = "";
    // Tag the panel so index.css can theme its native form controls (the
    // select's option popup cannot be styled inline).
    container.classList.add("geolibre-timelapse-panel");
    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.gap = "8px";
    container.style.padding = "10px 12px";
    container.style.fontSize = "12px";

    // Imagery-provider picker — shown only when more than one provider is
    // registered (a single-provider install has nothing to switch between).
    const providers = listTimelapseProviders();
    if (providers.length > 1) {
      const providerSelect = document.createElement("select");
      styleThemedSelect(providerSelect);
      providerSelect.style.width = "100%";
      for (const item of providers) {
        const option = document.createElement("option");
        option.value = item.id;
        option.textContent = item.name;
        option.selected = item.id === this.provider.id;
        providerSelect.appendChild(option);
      }
      providerSelect.addEventListener("change", () => {
        void this.switchProvider(providerSelect.value);
      });
      this.providerSelect = providerSelect;
      container.appendChild(providerSelect);
    }

    // Year slider with range labels.
    const sliderRow = document.createElement("div");
    sliderRow.style.display = "flex";
    sliderRow.style.alignItems = "center";
    sliderRow.style.gap = "6px";
    const firstLabel = document.createElement("span");
    firstLabel.textContent = this.frames[0]?.label ?? "";
    const lastLabel = document.createElement("span");
    lastLabel.textContent = this.frames[this.frames.length - 1]?.label ?? "";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = String(Math.max(0, this.frames.length - 1));
    slider.step = "1";
    slider.value = String(this.frameIndex);
    slider.style.flex = "1";
    slider.addEventListener("input", () => {
      // Read the value first: pause() runs updateUi(), which writes the
      // current frame back into the slider and would erase the user's drag.
      const next = Number(slider.value);
      this.pause();
      if (!this.stackPresent) this.ensureStack();
      this.setFrameIndex(next);
    });
    this.slider = slider;
    sliderRow.appendChild(firstLabel);
    sliderRow.appendChild(slider);
    sliderRow.appendChild(lastLabel);
    container.appendChild(sliderRow);

    // Transport: play/pause + current year.
    const transport = document.createElement("div");
    transport.style.display = "flex";
    transport.style.alignItems = "center";
    transport.style.justifyContent = "center";
    transport.style.gap = "10px";
    const playButton = document.createElement("button");
    stylePillButton(playButton);
    playButton.style.fontSize = "14px";
    playButton.addEventListener("click", () => {
      if (this.playing) this.pause();
      else this.play();
    });
    this.playButton = playButton;
    const yearLabel = document.createElement("span");
    yearLabel.style.fontSize = "18px";
    yearLabel.style.fontWeight = "700";
    this.yearLabel = yearLabel;
    transport.appendChild(playButton);
    transport.appendChild(yearLabel);
    container.appendChild(transport);

    // Speed + loop.
    const optionsRow = document.createElement("div");
    optionsRow.style.display = "flex";
    optionsRow.style.alignItems = "center";
    optionsRow.style.justifyContent = "space-between";
    const speedLabel = document.createElement("label");
    speedLabel.style.display = "flex";
    speedLabel.style.alignItems = "center";
    speedLabel.style.gap = "4px";
    const speedText = document.createTextNode(labels.speed);
    speedLabel.appendChild(speedText);
    this.speedText = speedText;
    const speedSelect = document.createElement("select");
    styleThemedSelect(speedSelect);
    for (const step of TIMELAPSE_SPEED_STEPS) {
      const option = document.createElement("option");
      option.value = String(step);
      option.selected = step === this.secondsPerYear;
      speedSelect.appendChild(option);
    }
    speedSelect.addEventListener("change", () =>
      this.setSecondsPerYear(Number(speedSelect.value)),
    );
    this.speedSelect = speedSelect;
    speedLabel.appendChild(speedSelect);
    const loopLabel = document.createElement("label");
    loopLabel.style.display = "flex";
    loopLabel.style.alignItems = "center";
    loopLabel.style.gap = "4px";
    loopLabel.style.cursor = "pointer";
    const loopCheckbox = document.createElement("input");
    loopCheckbox.type = "checkbox";
    loopCheckbox.checked = this.loop;
    loopCheckbox.addEventListener("change", () =>
      this.setLoop(loopCheckbox.checked),
    );
    loopLabel.appendChild(loopCheckbox);
    const loopText = document.createTextNode(labels.loop);
    loopLabel.appendChild(loopText);
    this.loopText = loopText;
    optionsRow.appendChild(speedLabel);
    optionsRow.appendChild(loopLabel);
    container.appendChild(optionsRow);

    // Record.
    const recordRow = document.createElement("div");
    recordRow.style.display = "flex";
    recordRow.style.alignItems = "center";
    recordRow.style.gap = "8px";
    const recordButton = document.createElement("button");
    stylePillButton(recordButton);
    recordButton.addEventListener("click", () => {
      void this.handleRecordClick();
    });
    this.recordButton = recordButton;
    const recordStatus = document.createElement("span");
    recordStatus.style.opacity = "0.8";
    this.recordStatus = recordStatus;
    recordRow.appendChild(recordButton);
    recordRow.appendChild(recordStatus);
    container.appendChild(recordRow);

    // Legend (thematic providers only, e.g. land-cover classes). The colors
    // are the data, so this is rendered where imagery providers show nothing.
    const legendItems = this.provider.legend;
    if (legendItems && legendItems.length > 0) {
      const legend = document.createElement("div");
      legend.style.display = "flex";
      legend.style.flexDirection = "column";
      legend.style.gap = "3px";
      legend.style.fontSize = "10px";
      const heading = document.createElement("div");
      heading.style.fontWeight = "600";
      heading.style.opacity = "0.8";
      this.legendHeading = heading;
      legend.appendChild(heading);
      const grid = document.createElement("div");
      grid.style.display = "grid";
      grid.style.gridTemplateColumns = "auto 1fr";
      grid.style.gap = "2px 6px";
      grid.style.alignItems = "center";
      for (const item of legendItems) {
        const swatch = document.createElement("span");
        swatch.style.width = "12px";
        swatch.style.height = "12px";
        swatch.style.flexShrink = "0";
        swatch.style.borderRadius = "2px";
        swatch.style.background = item.color;
        swatch.style.border = "1px solid hsl(var(--border))";
        const text = document.createElement("span");
        text.textContent = item.label;
        grid.appendChild(swatch);
        grid.appendChild(text);
      }
      legend.appendChild(grid);
      container.appendChild(legend);
    }

    // Attribution (per-frame, year-specific — updated in updateUi).
    const attribution = document.createElement("div");
    attribution.style.fontSize = "10px";
    attribution.style.opacity = "0.7";
    attribution.style.lineHeight = "1.4";
    this.attributionLine = attribution;
    container.appendChild(attribution);

    this.mountBadge();
    this.refreshLabels();

    return () => {
      // The card body is discarded on close; only the on-map badge outlives it.
      this.container = null;
      this.providerSelect = null;
      this.slider = null;
      this.playButton = null;
      this.yearLabel = null;
      this.speedText = null;
      this.speedSelect = null;
      this.loopText = null;
      this.recordButton = null;
      this.recordStatus = null;
      this.attributionLine = null;
      this.legendHeading = null;
    };
  }

  /** Big on-map year overlay (screen only; recordings burn their own copy). */
  private mountBadge(): void {
    if (this.badge) return;
    const container = this.map?.getContainer?.();
    if (!container) return;
    const badge = document.createElement("div");
    badge.className = "geolibre-timelapse-badge";
    badge.style.position = "absolute";
    // Clear MapLibre's bottom attribution bar.
    badge.style.bottom = "72px";
    badge.style.left = "50%";
    badge.style.transform = "translateX(-50%)";
    badge.style.fontSize = "40px";
    badge.style.fontWeight = "700";
    badge.style.color = "#ffffff";
    badge.style.textShadow = "0 1px 6px rgba(0, 0, 0, 0.7)";
    badge.style.pointerEvents = "none";
    badge.style.zIndex = "5";
    container.appendChild(badge);
    this.badge = badge;
  }

  /** Re-apply the current {@link labels} to the static panel strings. */
  refreshLabels(): void {
    if (this.providerSelect) {
      this.providerSelect.setAttribute("aria-label", labels.provider);
    }
    if (this.legendHeading) this.legendHeading.textContent = labels.legend;
    if (this.slider) {
      this.slider.setAttribute("aria-label", labels.yearSlider);
    }
    if (this.speedText) this.speedText.textContent = labels.speed;
    if (this.speedSelect) {
      this.speedSelect.setAttribute("aria-label", labels.secondsPerYear);
      for (const option of this.speedSelect.options) {
        option.textContent = `${option.value} ${labels.secondsPerYearSuffix}`;
      }
    }
    if (this.loopText) this.loopText.textContent = labels.loop;
    this.updateUi();
  }

  private updateUi(): void {
    const frame = this.frames[this.frameIndex];
    if (this.slider) this.slider.value = String(this.frameIndex);
    if (this.yearLabel) this.yearLabel.textContent = frame?.label ?? "";
    if (this.badge) {
      // No year overlay without imagery under it (e.g. after the user deletes
      // the Layers-panel entry); an empty badge renders nothing.
      this.badge.textContent = this.stackPresent ? (frame?.label ?? "") : "";
    }
    if (this.playButton) {
      this.playButton.textContent = this.playing
        ? `⏸ ${labels.pause}`
        : `▶ ${labels.play}`;
      this.playButton.disabled =
        this.recording ||
        this.frames.length < 2 ||
        (!this.tilesReady && !this.playing);
      this.playButton.title =
        !this.tilesReady && !this.playing ? labels.loadingTiles : "";
    }
    if (this.recordButton) {
      this.recordButton.textContent = this.recording
        ? `■ ${labels.stopRecording}`
        : `● ${labels.record}`;
      // Gate Record like Play — but never disable it mid-recording, when the
      // same button is the Stop control.
      this.recordButton.disabled =
        !this.recording &&
        (this.frames.length < 2 || !this.stackPresent || !this.tilesReady);
      this.recordButton.title =
        !this.tilesReady && !this.recording ? labels.loadingTiles : "";
    }
    if (this.slider) this.slider.disabled = this.recording;
    // Switching providers mid-recording would tear down the layers the export
    // is drawing from, so the picker is inert while recording; disable it too
    // (mirroring the slider) instead of looking interactive but silently no-op.
    if (this.providerSelect) this.providerSelect.disabled = this.recording;
    if (this.attributionLine && frame) {
      // Trust assumption: attribution HTML comes from the frame's provider.
      // The built-in EOX string is fixed, and registerTimelapseProvider is
      // only reachable from plugin code that already runs in-process — do not
      // copy this innerHTML pattern anywhere provider strings are less
      // trusted without sanitizing first.
      this.attributionLine.innerHTML = frame.attribution;
    }
  }
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/** Raised when the browser cannot record the canvas (no MediaRecorder/codec). */
export class TimelapseVideoUnsupportedError extends Error {
  constructor(message = "Canvas recording is not supported in this browser.") {
    super(message);
    this.name = "TimelapseVideoUnsupportedError";
  }
}

/** A finished timelapse recording plus how it should be saved. */
export interface TimelapseRecording {
  blob: Blob;
  mimeType: string;
  extension: "mp4" | "webm";
}

export interface RecordTimelapseCycleOptions {
  /** Aborts the recording early; the partial video up to then is kept. */
  signal?: AbortSignal;
  /** Reports the frame being captured (zero-based) and the frame count. */
  onFrame?: (index: number, total: number) => void;
}

/**
 * Record exactly one cycle of the active timelapse (first year → last year)
 * and resolve with the encoded video.
 *
 * The map canvas is composited into an offscreen canvas each animation frame
 * with the current year burned in as a label — DOM overlays are never captured
 * by canvas recording, so without this the export would have no year
 * indicator. Each year waits for the map to go `idle` (fully rendered tiles)
 * before its dwell, so no recorded frame shows half-loaded imagery. The user's
 * current year is restored afterwards.
 */
export async function recordTimelapseCycle({
  signal,
  onFrame,
}: RecordTimelapseCycleOptions = {}): Promise<TimelapseRecording> {
  const control = timelapseControl;
  const map = control?.getMapInstance();
  if (!control || !map) {
    throw new Error("The timelapse is not active.");
  }
  if (control.frames.length < 2) {
    throw new Error("The timelapse needs at least two years to record.");
  }
  const mimeType = pickSupportedCanvasVideoMimeType();
  if (!mimeType) throw new TimelapseVideoUnsupportedError();

  const mapCanvas = map.getCanvas();
  const out = document.createElement("canvas");
  out.width = mapCanvas.width;
  out.height = mapCanvas.height;
  const ctx = out.getContext("2d");
  if (!ctx || typeof out.captureStream !== "function") {
    throw new TimelapseVideoUnsupportedError();
  }

  const stream = out.captureStream(RECORD_FPS);
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: CANVAS_VIDEO_BITS_PER_SECOND,
    });
  } catch {
    // The constructor can still reject a codec isTypeSupported accepted.
    for (const track of stream.getTracks()) track.stop();
    throw new TimelapseVideoUnsupportedError();
  }

  const extension = canvasVideoExtensionForMime(mimeType);
  // Label the blob with the plain container type — the save path keys off the
  // blob's own `.type`, where the codec suffix is irrelevant.
  const containerType = extension === "mp4" ? "video/mp4" : "video/webm";

  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };

  let recorderFailed = false;
  const finished = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: containerType }));
    recorder.onerror = (event) => {
      const cause = (event as Event & { error?: DOMException }).error;
      recorderFailed = true;
      reject(
        new Error(`Recording failed: ${cause?.message ?? "unknown error"}`, {
          cause,
        }),
      );
    };
  });
  // A recorder error must not surface as an unhandled rejection while the
  // frame loop is still awaiting idle/dwell; it is re-awaited at the end.
  finished.catch(() => {});

  const savedFrameIndex = control.getFrameIndex();
  const frames = control.frames;
  const secondsPerYear = Math.max(
    RECORD_MIN_SECONDS_PER_YEAR,
    control.getState().secondsPerYear,
  );

  const drawFrame = (): void => {
    ctx.drawImage(mapCanvas, 0, 0, out.width, out.height);
    const label = frames[control.getFrameIndex()]?.label ?? "";
    if (!label) return;
    const fontSize = Math.max(24, Math.round(out.height * 0.05));
    ctx.font = `700 ${fontSize}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    const x = out.width / 2;
    const y = out.height - Math.round(out.height * 0.04);
    ctx.lineWidth = Math.max(2, Math.round(fontSize / 8));
    ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
    ctx.strokeText(label, x, y);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, x, y);
  };

  // Keep the captured stream fed with fresh frames even while the map itself
  // has nothing to redraw (a raster year dwelling on screen). The per-tick
  // triggerRepaint is intentional even during idle dwells: reading a WebGL
  // canvas via drawImage is only reliable right after a render on some
  // platforms, and recordings are short (seconds), so the bounded extra
  // rendering is preferred over risking blank captured frames.
  let rafId = 0;
  const pump = (): void => {
    map.triggerRepaint();
    drawFrame();
    rafId = window.requestAnimationFrame(pump);
  };

  try {
    recorder.start(1000);
    rafId = window.requestAnimationFrame(pump);
    for (let index = 0; index < frames.length; index += 1) {
      if (signal?.aborted || recorderFailed) break;
      control.setFrameIndex(index);
      await waitForIdle(map, RECORD_IDLE_TIMEOUT_MS, signal);
      if (signal?.aborted || recorderFailed) break;
      onFrame?.(index, frames.length);
      await delay(secondsPerYear * 1000, signal);
    }
  } finally {
    window.cancelAnimationFrame(rafId);
    if (recorder.state !== "inactive") recorder.stop();
    // recorder.stop() finalizes the file but does not stop the canvas capture.
    for (const track of stream.getTracks()) track.stop();
    control.setFrameIndex(savedFrameIndex);
  }

  // Guard against a browser that never fires onstop leaving this await hung.
  const timeout = new Promise<never>((_, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error("Recording timed out waiting for the encoder.")),
      CANVAS_VIDEO_STOP_TIMEOUT_MS,
    );
    void finished.then(
      () => window.clearTimeout(timer),
      () => window.clearTimeout(timer),
    );
  });
  const blob = await Promise.race([finished, timeout]);
  return { blob, mimeType: containerType, extension };
}

/** Bounded wait for the map's next `idle` (fully rendered) event. */
function waitForIdle(
  map: MapLibreMap,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      map.off("idle", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    if (signal?.aborted) {
      finish();
      return;
    }
    signal?.addEventListener("abort", finish, { once: true });
    map.once("idle", finish);
  });
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

/**
 * How the host saves a finished recording (a native dialog under Tauri, a
 * download on the web). Injected by the app (see usePlugins.ts) because the
 * plugins package cannot depend on the app's Tauri I/O helpers. Resolves to
 * the saved path, or null when the user cancels.
 */
export type TimelapseVideoSaver = (
  blob: Blob,
  options: { defaultName: string; extension: "mp4" | "webm"; mimeType: string },
) => Promise<string | null>;

let videoSaver: TimelapseVideoSaver | null = null;

export function setTimelapseVideoSaver(saver: TimelapseVideoSaver | null): void {
  videoSaver = saver;
}

async function saveTimelapseRecording(
  recording: TimelapseRecording,
  providerId: string,
): Promise<void> {
  const defaultName = `timelapse-${providerId}.${recording.extension}`;
  if (videoSaver) {
    await videoSaver(recording.blob, {
      defaultName,
      extension: recording.extension,
      mimeType: recording.mimeType,
    });
    return;
  }
  // Headless/no-host fallback: a plain anchor download.
  const url = URL.createObjectURL(recording.blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = defaultName;
    anchor.click();
  } finally {
    // Give the click a tick to start the download before releasing the URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

let timelapsePosition: GeoLibreMapControlPosition = "top-left";
let timelapseControl: TimelapseControl | null = null;
let savedState: TimelapseProjectState | null = null;
let unsubscribeStore: (() => void) | null = null;
let unsubscribeBasemap: (() => void) | null = null;
let unregisterPanel: (() => void) | null = null;
let appRef: GeoLibreAppAPI | null = null;
// Bumped by activate()/deactivate() so an async provider's listFrames()
// resolving after a deactivate cannot wire up a control the plugin manager
// already considers gone.
let activationSession = 0;

/**
 * The floating-panel registration. A single mutable object (the Mapillary
 * pattern): re-registering the same identity updates its title/position
 * without rebuilding an open card's body.
 */
const floatingPanelRegistration: GeoLibreFloatingPanelRegistration = {
  id: TIMELAPSE_PANEL_ID,
  title: DEFAULT_TIMELAPSE_LABELS.title,
  defaultWidth: 320,
  position: timelapsePosition,
  render: (container) => timelapseControl?.renderInto(container),
};

/** Push the current labels/position into the registration (and the host). */
function syncPanelRegistration(): void {
  floatingPanelRegistration.title = labels.title;
  floatingPanelRegistration.position = timelapsePosition;
  if (unregisterPanel && appRef) {
    unregisterPanel =
      appRef.registerFloatingPanel?.(floatingPanelRegistration) ?? null;
  }
}

/** The live control, for tests and e2e hooks. */
export function getActiveTimelapseControl(): TimelapseControl | null {
  return timelapseControl;
}

function subscribeStoreLayer(control: TimelapseControl): () => void {
  let last = getStoreLayerSnapshot();
  return useAppStore.subscribe(() => {
    const next = getStoreLayerSnapshot();
    if (
      next.exists === last.exists &&
      next.visible === last.visible &&
      next.opacity === last.opacity
    ) {
      return;
    }
    const previous = last;
    last = next;
    control.onStoreLayerChange(previous, next);
  });
}

function activateWithFrames(
  app: GeoLibreAppAPI,
  provider: TimelapseProvider,
  frames: TimelapseFrame[],
): boolean | void {
  if (frames.length === 0) return false;
  appRef = app;
  const control = new TimelapseControl({
    map: app.getMap?.() ?? null,
    provider,
    frames,
    initial: savedState,
  });
  timelapseControl = control;
  control.ensureStack();
  unsubscribeStore = subscribeStoreLayer(control);
  unsubscribeBasemap = app.onBasemapChange(() => {
    const map = app.getMap?.();
    if (!map || !timelapseControl) return;
    // A basemap change reloads the style, wiping this plugin's sources and
    // layers; rebuild once the new style is in (the ordering-only sync path
    // cannot recreate them).
    const rebuild = (): void => timelapseControl?.rebuildStack();
    if (map.isStyleLoaded?.()) rebuild();
    else map.once("style.load", rebuild);
  });
  floatingPanelRegistration.title = labels.title;
  floatingPanelRegistration.position = timelapsePosition;
  unregisterPanel =
    app.registerFloatingPanel?.(floatingPanelRegistration) ?? null;
  app.openFloatingPanel?.(TIMELAPSE_PANEL_ID);
}

export const maplibreTimelapsePlugin: GeoLibrePlugin = {
  id: TIMELAPSE_PLUGIN_ID,
  name: "Timelapse",
  version: "0.2.0",
  activate: (app: GeoLibreAppAPI) => {
    const session = ++activationSession;
    const provider = getTimelapseProvider(savedState?.providerId);
    const frames = provider.listFrames();
    if (Array.isArray(frames)) return activateWithFrames(app, provider, frames);
    return frames.then((resolved) =>
      activationSession === session
        ? activateWithFrames(app, provider, resolved)
        : false,
    );
  },
  deactivate: (_app: GeoLibreAppAPI) => {
    activationSession += 1;
    unsubscribeBasemap?.();
    unsubscribeBasemap = null;
    unsubscribeStore?.();
    unsubscribeStore = null;
    unregisterPanel?.();
    unregisterPanel = null;
    appRef = null;
    if (!timelapseControl) return;
    savedState = timelapseControl.getState();
    timelapseControl.dispose();
    timelapseControl.removeStack();
    removeTimelapseStoreLayers();
    timelapseControl = null;
  },
  // The floating card is freely draggable; the position submenu in the
  // Plugins menu just picks which corner it opens at.
  getMapControlPosition: () => timelapsePosition,
  setMapControlPosition: (
    _app: GeoLibreAppAPI,
    position: GeoLibreMapControlPosition,
  ) => {
    timelapsePosition = position;
    syncPanelRegistration();
  },
  getProjectState: () =>
    timelapseControl?.getState() ?? savedState ?? undefined,
  applyProjectState: (_app: GeoLibreAppAPI, state: unknown) => {
    const frames = timelapseControl
      ? timelapseControl.frames
      : syncFramesForNormalization(state);
    const next = normalizeTimelapseProjectState(state, frames);
    const current = timelapseControl?.getState() ?? savedState;
    if (JSON.stringify(next) === JSON.stringify(current ?? null)) return false;
    savedState = next;
    if (!timelapseControl) return;
    if (next) {
      timelapseControl.applyState(next);
      return;
    }
    // A null state (New Project reset, or a corrupted entry) with the plugin
    // still active must not leave the previous project's year/speed/loop on
    // screen — reset the live control to defaults (normalize({}) never
    // returns null) and stop any playback carried over from the old project.
    timelapseControl.pause();
    const defaults = normalizeTimelapseProjectState({}, frames);
    if (defaults) timelapseControl.applyState(defaults);
  },
};

/**
 * Frames used to normalize project state when no control is live. Only
 * synchronous providers (the built-in EOX one) can supply them here; an async
 * provider's saved year is clamped when the plugin next activates instead.
 */
function syncFramesForNormalization(state: unknown): TimelapseFrame[] {
  const providerId =
    state && typeof state === "object"
      ? (state as Record<string, unknown>).providerId
      : undefined;
  const provider = getTimelapseProvider(
    typeof providerId === "string" ? providerId : undefined,
  );
  const frames = provider.listFrames();
  return Array.isArray(frames) ? frames : [];
}
