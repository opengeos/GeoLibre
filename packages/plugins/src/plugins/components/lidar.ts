// The LiDAR point-cloud control, its store sync and project restore.
// Split out of maplibre-components.ts (opengeos/GeoLibre#2633).

import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, useAppStore } from "@geolibre/core";
import type { LidarControl, LidarLayerAdapter } from "maplibre-gl-components";
import type { LidarControlEventHandler, PointCloudInfo } from "maplibre-gl-lidar";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition } from "../../types";
import {
  acquireMercatorProjectionLock,
  ensureMercatorProjection,
  releaseMercatorProjectionLock,
} from "../map-projection-utils";
import {
  getComponentsConstructors,
  type LidarControlConstructor,
  type LidarLayerAdapterConstructor,
} from "./constructors";
import { refreshLidarMeasureMirror, setLidarControlReader } from "./lidar-measure-link";
import { layerNameFromUrl, resolveDocumentTheme } from "./shared";

/**
 * `metadata.sourceKind` marking the LiDAR point-cloud layers this plugin adds. Exported so the Layer Library's
 * restore dispatch keys off the same value this plugin writes rather than a
 * hand-typed copy (issue #1520).
 */
export const LIDAR_SOURCE_KIND = "lidar-url";

const lidarControlPosition: GeoLibreMapControlPosition = "top-left";

const LIDAR_SAMPLE_URL = "https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz";

const LIDAR_OPTIONS = {
  title: "Add LiDAR Layer",
  collapsed: false,
  className: "geolibre-lidar-layer-control",
  panelWidth: 365,
  // Omit maxHeight so the panel (maplibre-gl-lidar >= 0.16.2) sizes to its
  // content, grows up to the available vertical space within the map, and
  // exposes its two bottom-corner resize handles, matching the upstream
  // default. A fixed cap left empty space below a long panel on tall screens
  // and suppressed the resize handles.
  pointSize: 2,
  colorScheme: "elevation",
  pickable: false,
  autoZoom: true,
  // Empty input; the sample point cloud is the explicit, opt-in way to load
  // one (replaces the former seedLidarDefaultUrl DOM injection).
  sampleData: [{ label: "Autzen", url: LIDAR_SAMPLE_URL }],
  // The panel doubles as the Add LiDAR Layer dialog, so it stays open until
  // the user closes it; clicking the map must not collapse it.
  closeOnOutsideClick: false,
} satisfies ConstructorParameters<LidarControlConstructor>[0];

let lidarControl: LidarControl | null = null;
let lidarLayerAdapter: LidarLayerAdapter | null = null;
let lidarControlMounted = false;
let lidarStoreUnsubscribe: (() => void) | null = null;
setLidarControlReader(() => lidarControl);

// Re-streaming saved LiDAR layers on project open. The store only holds a
// `lidar-url` layer's metadata; the point cloud itself is loaded by the LiDAR
// control, not the store, so a reopened project shows the layer in the panel
// but renders nothing until we ask the control to stream it again (see
// restoreLidarLayers). Because loadPointCloud assigns a fresh id, each entry
// carries the saved layer's desired state so the load handler can reattach the
// loaded cloud to the saved layer instead of adding a duplicate. The map is
// keyed by source URL and holds a FIFO queue per URL, so two saved layers that
// point at the same COPC file both restore (one entry consumed per load event).
interface PendingLidarRestore {
  layerId: string;
  name: string;
  visible: boolean;
  opacity: number;
  style: GeoLibreLayer["style"];
  groupId: string | undefined;
  beforeLayerId: string | null;
}
const pendingLidarRestores = new Map<string, PendingLidarRestore[]>();
// The currently-running restoreLidarLayers() call, if any — a promise rather
// than a boolean so a concurrent caller can wait for it and retry instead of
// bailing out and silently dropping its own layer. See restoreLidarLayers.
let lidarRestoreInFlightPromise: Promise<void> | null = null;
let lidarThemeObserver: MutationObserver | null = null;

export function openLidarLayerPanel(app: GeoLibreAppAPI): void {
  void openStandaloneLidarControl(app);
}

/**
 * Stream a remote LAS/LAZ/COPC file (or an EPT `ept.json`) into the shared
 * LiDAR control without revealing its panel, as the `?data=` deep link does.
 * The control's `load` handler adds the store layer, so this resolves once the
 * layer exists.
 *
 * @param app - The GeoLibre app API.
 * @param url - The point cloud URL.
 * @param options - `fit: false` keeps the camera still, for a batch the caller frames.
 * @returns The store layer id of the loaded point cloud, or null when the LiDAR
 *   control could not be mounted.
 * @throws When `url` is not an HTTP(S) URL, or the point cloud fails to load.
 */
export async function addLidarLayerFromUrl(
  app: GeoLibreAppAPI,
  url: string,
  options: { fit?: boolean } = {},
): Promise<string | null> {
  let protocol: string | null = null;
  try {
    protocol = new URL(url).protocol;
  } catch {
    // Reported below with the same message as a non-web scheme.
  }
  if (protocol !== "https:" && protocol !== "http:") {
    throw new Error(
      app.translate?.("addData.lidar.errorUrl", "Enter a valid HTTP or HTTPS LiDAR URL.") ??
        "Enter a valid HTTP or HTTPS LiDAR URL.",
    );
  }
  const load = async () => {
    const opened = await openStandaloneLidarControl(app, { reveal: false });
    if (!opened || !lidarControl) return null;
    const info = await lidarControl.loadPointCloud(url);
    // maplibre-gl-lidar emits `load` synchronously before loadPointCloud
    // resolves, so the load handler has already added the store layer. Fail
    // loudly if an upgrade breaks that, rather than hand back a dangling id.
    if (!useAppStore.getState().layers.some((layer) => layer.id === info.id)) {
      throw new Error(`The LiDAR control did not create a layer for ${url}.`);
    }
    return info.id;
  };
  return (options.fit ?? true) ? load() : withLidarAutoZoomSuppressed(app, load);
}

/** Safety net for {@link waitForPendingLidarRestores}: how long to wait for
 * queued restores to settle before giving up regardless. */
const PENDING_LIDAR_RESTORE_TIMEOUT_MS = 60_000;

/** Resolves once every currently-queued {@link pendingLidarRestores} entry has
 * been consumed by a `load` (or dropped by a `loaderror`) — i.e. once every
 * `restoreLidarLayers` call in flight has actually finished loading its point
 * cloud, not just issued the request. Falls back to a fixed timeout so a
 * leaked entry (a load that never fires either event) cannot wedge a caller
 * forever. */
function waitForPendingLidarRestores(): Promise<void> {
  if (pendingLidarRestores.size === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (
        pendingLidarRestores.size === 0 ||
        Date.now() - start > PENDING_LIDAR_RESTORE_TIMEOUT_MS
      ) {
        resolve();
        return;
      }
      setTimeout(check, 250);
    };
    check();
  });
}

// Nesting guard for withLidarAutoZoomSuppressed: two overlapping callers (e.g.
// clicking "Add to map" on two different tiles before the first one settles)
// must not stomp on each other's snapshot of the pre-suppression value. Only
// the first caller in (depth 0 -> 1) records what autoZoom was, and only the
// last caller out (depth 1 -> 0) restores it — see that function for the bug
// this fixes.
let lidarAutoZoomSuppressionDepth = 0;
let lidarAutoZoomOriginalValue = true;

/**
 * Runs `fn` with the shared LiDAR control's `autoZoom` temporarily disabled,
 * so a point cloud loaded through `fn` does not fly the camera to it.
 * `autoZoom` is a constructor-only option with no public runtime setter, so
 * this reaches into the control's private `_options` the same way
 * maplibre-gl-lidar's own `restoreFromUrl` does internally when it needs to
 * load several point clouds without flying to each one in turn. If a future
 * upgrade removes that private field, the cast below quietly no-ops (runs
 * `fn` unsuppressed) instead of throwing — see docs/maintenance.md for the
 * other upstream internals this app already mirrors by hand.
 *
 * `fn` (via `restoreLidarLayers`) only awaits the request being *issued*, not
 * the point cloud finishing loading, so this also waits for every restore
 * queued during `fn` to actually finish before re-enabling autoZoom —
 * otherwise a still-loading point cloud (typical for a bulk "add several
 * tiles" action, where the earliest ones load before the loop even finishes
 * issuing the rest) fires its `load` event, and hence its fly-to, after
 * autoZoom was already switched back on.
 *
 * Calls can overlap (two "Add to map" clicks in quick succession each run
 * this independently), so a plain snapshot/restore of `options.autoZoom`
 * would corrupt the shared value: whichever call happened to finish last
 * would stomp the flag with *its own* snapshot, which — if that snapshot was
 * taken while another call had already forced it to `false` — could leave
 * autoZoom stuck disabled for the rest of the session (or, in the opposite
 * ordering, re-enable it while a sibling call's point cloud is still
 * loading). The depth counter above fixes this: only the outermost call
 * captures and restores the real original value.
 */
export async function withLidarAutoZoomSuppressed<T>(
  app: GeoLibreAppAPI,
  fn: () => Promise<T>,
): Promise<T> {
  await openStandaloneLidarControl(app, { reveal: false });
  const options = (lidarControl as unknown as { _options?: { autoZoom?: boolean } } | null)
    ?._options;
  if (!options || !("autoZoom" in options)) return fn();
  if (lidarAutoZoomSuppressionDepth === 0) {
    lidarAutoZoomOriginalValue = options.autoZoom ?? true;
  }
  lidarAutoZoomSuppressionDepth++;
  options.autoZoom = false;
  try {
    const result = await fn();
    await waitForPendingLidarRestores();
    return result;
  } finally {
    lidarAutoZoomSuppressionDepth = Math.max(0, lidarAutoZoomSuppressionDepth - 1);
    if (lidarAutoZoomSuppressionDepth === 0) {
      options.autoZoom = lidarAutoZoomOriginalValue;
    }
  }
}

async function openStandaloneLidarControl(
  app: GeoLibreAppAPI,
  options: { reveal?: boolean } = {},
): Promise<boolean> {
  // `reveal` shows and expands the panel (the default, for the Add LiDAR Layer
  // menu action). Project restore mounts the control only to re-stream saved
  // clouds, so it passes `reveal: false` to keep the panel out of the user's
  // way; a freshly created control is hidden so it does not pop open on load.
  const reveal = options.reveal ?? true;
  if (
    app.getMapRenderer?.() === "arcgis" &&
    !(await import("../arcgis-deck/control-adapter")).installArcgisDeckControls(app)
  )
    return false;
  const { LidarControl: LidarControlClass, LidarLayerAdapter: LidarLayerAdapterClass } =
    await getComponentsConstructors();

  const created = !lidarControl;
  lidarControl ??= createLidarControl(LidarControlClass, LidarLayerAdapterClass, app);

  if (!lidarControlMounted) {
    const added = app.addMapControl(lidarControl, lidarControlPosition);
    if (!added) {
      lidarControl = null;
      return false;
    }
    lidarControlMounted = true;
  }

  ensureMercatorProjection(app.getMap?.() ?? app.getMapboxMap?.());
  startLidarThemeSync();
  refreshLidarMeasureMirror(app);

  setTimeout(() => {
    if (reveal) {
      showLidarControl(lidarControl);
      lidarControl?.expand();
    } else if (created) {
      lidarControl?.collapse();
      hideLidarControl(lidarControl);
    }
  }, 0);
  return true;
}

/**
 * Read the source URL of a `lidar-url` layer, preferring the dedicated
 * `sourcePath` and falling back to `source.url`.
 */
function lidarLayerUrl(layer: GeoLibreLayer): string | null {
  if (typeof layer.sourcePath === "string" && layer.sourcePath) {
    return layer.sourcePath;
  }
  const url = (layer.source as { url?: unknown }).url;
  return typeof url === "string" && url ? url : null;
}

/** Whether a restore is already queued or in flight for this specific layer. */
function isLidarRestorePending(layer: GeoLibreLayer): boolean {
  for (const queue of pendingLidarRestores.values()) {
    if (queue.some((pending) => pending.layerId === layer.id)) return true;
  }
  return false;
}

/**
 * Re-stream the point clouds for any restored `lidar-url` layers that are not
 * yet loaded into the LiDAR control (e.g. after opening a saved project). The
 * store only holds the layer metadata, so without this the layer appears in the
 * Layers panel but renders nothing. The loaded cloud is reattached to the saved
 * layer in {@link createLidarLoadHandler}, preserving its visibility, opacity,
 * style, name, and position.
 *
 * Concurrent callers (e.g. two "Add to map" clicks in quick succession) must
 * not silently drop each other's layer: if a restore is already running, this
 * waits for it to finish and then re-runs itself, so a layer added to the
 * store after the first run's `pending` snapshot was taken still gets picked
 * up on the retry instead of `addTileToMap` reporting it as added while it
 * never actually streams.
 */
export async function restoreLidarLayers(app: GeoLibreAppAPI): Promise<void> {
  if (lidarRestoreInFlightPromise) {
    await lidarRestoreInFlightPromise.catch(() => {});
    return restoreLidarLayers(app);
  }

  const pending = useAppStore
    .getState()
    .layers.filter(
      (layer) =>
        isLidarControlLayer(layer) &&
        !hasLidarPointCloud(layer.id) &&
        !isLidarRestorePending(layer),
    );
  if (pending.length === 0) return;

  const run = (async () => {
    const opened = await openStandaloneLidarControl(app, { reveal: false });
    if (!opened || !lidarControl) return;
    // The deck.gl point-cloud overlay only renders under the Mercator
    // projection (the streaming loader's viewport math breaks under the default
    // globe), matching the USGS LiDAR plugin and the other deck.gl controls.
    ensureMercatorProjection(app.getMap?.() ?? app.getMapboxMap?.());

    for (const layer of pending) {
      const url = lidarLayerUrl(layer);
      if (!url) continue;
      // Re-check against the live store: a layer may have been removed, already
      // loaded, or queued while the control was loading asynchronously.
      const current = useAppStore.getState().layers;
      const index = current.findIndex((item) => item.id === layer.id);
      if (index === -1) continue;
      if (hasLidarPointCloud(layer.id) || isLidarRestorePending(layer)) continue;

      const entry: PendingLidarRestore = {
        layerId: layer.id,
        name: layer.name,
        visible: layer.visible,
        opacity: layer.opacity,
        style: layer.style,
        groupId: layer.groupId,
        beforeLayerId: current[index + 1]?.id ?? null,
      };
      const queue = pendingLidarRestores.get(url);
      if (queue) queue.push(entry);
      else pendingLidarRestores.set(url, [entry]);
      lidarControl.loadPointCloud(url).catch((error: unknown) => {
        // Drop only this layer's entry so a sibling restore for the same URL is
        // not lost; clean up the map key once its queue empties.
        const remaining = pendingLidarRestores.get(url);
        if (remaining) {
          const at = remaining.indexOf(entry);
          if (at !== -1) remaining.splice(at, 1);
          if (remaining.length === 0) pendingLidarRestores.delete(url);
        }
        console.warn("[lidar] failed to restore point cloud", url, error);
      });
    }
  })();

  lidarRestoreInFlightPromise = run;
  try {
    await run;
  } finally {
    if (lidarRestoreInFlightPromise === run) lidarRestoreInFlightPromise = null;
  }
}

function createLidarControl(
  LidarControlClass: LidarControlConstructor,
  LidarLayerAdapterClass: LidarLayerAdapterConstructor,
  app: GeoLibreAppAPI,
): LidarControl {
  // Force the LiDAR panel to follow the in-app light/dark theme rather than the
  // system prefers-color-scheme (which can differ), matching how the panel is
  // kept in sync by startLidarThemeSync below.
  const control = new LidarControlClass({
    ...LIDAR_OPTIONS,
    theme: resolveDocumentTheme(),
  });
  if (app.getMapRenderer?.() === "arcgis") {
    // The SDK owns terrain; do not install the plugin's MapLibre DEM source.
    control.setTerrain = (enabled: boolean) => {
      app.setTerrainEnabled?.(enabled);
    };
    control.getTerrain = () => app.isTerrainEnabled?.() ?? false;
  }
  lidarLayerAdapter = new LidarLayerAdapterClass(control);
  const onUnload = createLidarUnloadHandler();
  const onLoad = createLidarLoadHandler();
  const handleLoad: LidarControlEventHandler = (event) => {
    acquireMercatorProjectionLock("lidar", app);
    onLoad(event);
  };
  const onRemove = control.onRemove.bind(control);
  control.onRemove = () => {
    // Mapbox destroys controls when switching engines. Drop singleton handles
    // so project restoration streams onto the new map, not the removed one.
    lidarStoreUnsubscribe?.();
    lidarStoreUnsubscribe = null;
    stopLidarThemeSync();
    pendingLidarRestores.clear();
    lidarRestoreInFlightPromise = null;
    // Stopping a renderer emits unload for every streamed cloud. Preserve
    // project records during teardown so the next engine can restore them.
    control.off("unload", onUnload);
    // A restore still streaming into this control must not land as a fresh
    // layer once its queue entry is gone: the saved record stays in the store
    // and the next engine's restoreLidarLayers re-streams it under its own id.
    control.off("load", handleLoad);
    onRemove();
    releaseMercatorProjectionLock("lidar", app);
    if (lidarControl === control) {
      lidarControl = null;
      lidarControlMounted = false;
      lidarLayerAdapter = null;
    }
    // The overlay the measure mirror was drawing into is gone with the control.
    refreshLidarMeasureMirror(app);
  };
  control.on("collapse", () => hideLidarControl(control));
  control.on("load", handleLoad);
  control.on("unload", onUnload);
  lidarStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    if (state.layers === previous.layers) return;
    if (state.layers.some(isLidarControlLayer)) acquireMercatorProjectionLock("lidar", app);
    else releaseMercatorProjectionLock("lidar", app);
    const currentById = new Map(state.layers.map((layer) => [layer.id, layer]));

    for (const layer of previous.layers) {
      if (!isLidarControlLayer(layer)) continue;

      const currentLayer = currentById.get(layer.id);
      if (!currentLayer) {
        if (hasLidarPointCloud(layer.id)) {
          lidarLayerAdapter?.removeLayer(layer.id);
        }
        continue;
      }

      if (!isLidarControlLayer(currentLayer)) continue;

      if (currentLayer.visible !== layer.visible) {
        lidarLayerAdapter?.setVisibility(currentLayer.id, currentLayer.visible);
      }

      if (currentLayer.opacity !== layer.opacity) {
        lidarLayerAdapter?.setOpacity(currentLayer.id, currentLayer.opacity);
      }
    }
  });
  return control;
}

/**
 * Keep the LiDAR panel theme in sync with the in-app light/dark toggle by
 * observing the `class` attribute of the document element, so the panel follows
 * the app theme rather than the system prefers-color-scheme.
 */
function startLidarThemeSync(): void {
  if (
    lidarThemeObserver ||
    typeof MutationObserver === "undefined" ||
    typeof document === "undefined"
  ) {
    return;
  }
  let lastTheme = resolveDocumentTheme();
  lidarThemeObserver = new MutationObserver(() => {
    const next = resolveDocumentTheme();
    if (next === lastTheme) return;
    lastTheme = next;
    lidarControl?.setTheme(next);
  });
  lidarThemeObserver.observe(document.documentElement, {
    attributeFilter: ["class"],
  });
}

function stopLidarThemeSync(): void {
  lidarThemeObserver?.disconnect();
  lidarThemeObserver = null;
}

export function teardownLidarControl(app: GeoLibreAppAPI): void {
  stopLidarThemeSync();
  // Clear restore bookkeeping so a teardown mid-restore (project reload, map
  // re-init) cannot strand the in-flight guard and block later restores.
  pendingLidarRestores.clear();
  lidarRestoreInFlightPromise = null;
  lidarStoreUnsubscribe?.();
  lidarStoreUnsubscribe = null;
  lidarLayerAdapter?.destroy();
  lidarLayerAdapter = null;
  if (lidarControl && lidarControlMounted) {
    app.removeMapControl(lidarControl);
  }
  lidarControl = null;
  lidarControlMounted = false;
}

function createLidarLoadHandler(): LidarControlEventHandler {
  return (event) => {
    if (!event.pointCloud || !("source" in event.pointCloud)) return;

    const store = useAppStore.getState();
    const layer = createLidarStoreLayer(event.pointCloud);

    // Project restore: this load was triggered to re-stream a saved layer (see
    // restoreLidarLayers). loadPointCloud assigns a fresh id, so swap the inert
    // placeholder (saved id) for the loaded layer in place, carrying over the
    // saved visibility, opacity, style, name, and position.
    const restoreKey = typeof event.pointCloud.source === "string" ? event.pointCloud.source : null;
    const restoreQueue = restoreKey ? pendingLidarRestores.get(restoreKey) : undefined;
    const restore = restoreQueue?.shift();
    if (restore && restoreKey) {
      if (restoreQueue && restoreQueue.length === 0) {
        pendingLidarRestores.delete(restoreKey);
      }
      const restored: GeoLibreLayer = {
        ...layer,
        name: restore.name || layer.name,
        visible: restore.visible,
        opacity: restore.opacity,
        style: restore.style,
        ...(restore.groupId ? { groupId: restore.groupId } : {}),
      };
      if (
        restore.layerId !== restored.id &&
        store.layers.some((item) => item.id === restore.layerId)
      ) {
        store.removeLayer(restore.layerId);
      }
      const beforeLayerId =
        restore.beforeLayerId &&
        useAppStore.getState().layers.some((item) => item.id === restore.beforeLayerId)
          ? restore.beforeLayerId
          : null;
      store.addLayer(restored, beforeLayerId);
      if (!restored.visible) {
        lidarLayerAdapter?.setVisibility(restored.id, false);
      }
      if (restored.opacity !== 1) {
        lidarLayerAdapter?.setOpacity(restored.id, restored.opacity);
      }
      return;
    }

    if (store.layers.some((item) => item.id === layer.id)) {
      store.updateLayer(layer.id, {
        metadata: layer.metadata,
        opacity: layer.opacity,
        source: layer.source,
        visible: layer.visible,
      });
      return;
    }
    store.addLayer(layer);
  };
}

function createLidarUnloadHandler(): LidarControlEventHandler {
  return (event) => {
    const pointCloudId = event.pointCloud?.id;
    if (!pointCloudId) return;

    const store = useAppStore.getState();
    const layer = store.layers.find((item) => item.id === pointCloudId);
    if (layer && isLidarControlLayer(layer)) {
      store.removeLayer(pointCloudId);
    }
  };
}

function createLidarStoreLayer(pointCloud: PointCloudInfo): GeoLibreLayer {
  return {
    id: pointCloud.id,
    name: pointCloud.name || layerNameFromUrl(pointCloud.source, pointCloud.id),
    type: "lidar",
    source: {
      bounds: [
        pointCloud.bounds.minX,
        pointCloud.bounds.minY,
        pointCloud.bounds.maxX,
        pointCloud.bounds.maxY,
      ],
      sourceId: pointCloud.id,
      type: "lidar",
      url: pointCloud.source,
    },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      customLayerType: "lidar",
      externalNativeLayer: true,
      hasClassification: pointCloud.hasClassification,
      hasIntensity: pointCloud.hasIntensity,
      hasRGB: pointCloud.hasRGB,
      identifiable: false,
      pointCount: pointCloud.pointCount,
      sourceId: pointCloud.id,
      sourceKind: LIDAR_SOURCE_KIND,
      wkt: pointCloud.wkt,
    },
    sourcePath: pointCloud.source,
  };
}

function isLidarControlLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "lidar" &&
    layer.metadata.sourceKind === LIDAR_SOURCE_KIND &&
    layer.metadata.externalNativeLayer === true
  );
}

function hideLidarControl(control: LidarControl | null): void {
  const container = control?.getContainer();
  if (container) container.style.display = "none";
}

function showLidarControl(control: LidarControl | null): void {
  const container = control?.getContainer();
  if (container) container.style.display = "";
  // Restored clouds can update state while the toggle is hidden. Recompute
  // panel placement after showing it, even if expand() would be a no-op.
  control?.setState({});
}

function hasLidarPointCloud(id: string): boolean {
  return lidarControl?.getPointClouds().some((pointCloud) => pointCloud.id === id) ?? false;
}
