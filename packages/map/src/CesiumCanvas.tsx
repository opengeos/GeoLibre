import {
  applyGroupEffects,
  useAppStore,
  type GeoLibreLayer,
  type MapViewState,
} from "@geolibre/core";
import type { Viewer } from "cesium";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  applyMapViewToCamera,
  isSameView,
  readMapViewFromCamera,
} from "./cesium-camera";
import { CesiumLayerSync } from "./cesium-layer-sync";

// The Cesium 3D-globe view (see private/cesium-view-plan.md). M1 wired the
// build, token, and split-pane mount; M2 synced the camera with the shared store
// `mapView`; M3 (this) renders the store's data layers on the globe — GeoJSON,
// XYZ/WMS/WMTS raster tiles, and 3D Tiles — reusing the same per-pane
// layer-visibility overrides as SecondaryMapCanvas. The whole Cesium engine is
// loaded lazily inside the mount effect so it stays in its own build chunk and
// never touches the 2D boot path.

/**
 * Where copy-cesium-assets.ts stages Cesium's Workers/Assets/Widgets. Derived
 * from the app's base path (not a hardcoded `/cesium`) so it resolves under a
 * sub-path deploy — e.g. the `/demo/` build served with a relative base, where
 * an absolute `/cesium` would 404 the Workers/Assets and crash the render loop.
 */
const APP_BASE_URL =
  (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL ??
  "/";
const CESIUM_BASE_URL = `${APP_BASE_URL}cesium`;
/** id for the one-time <link> to Cesium's widget stylesheet (served from base). */
const CESIUM_CSS_LINK_ID = "cesium-widgets-css";

export interface CesiumCanvasProps {
  /** Id of the `secondaryMapViews` entry this pane renders (label/telemetry). */
  viewId: string;
  /**
   * Cesium Ion access token. When present the globe uses Ion world imagery +
   * terrain; when empty it falls back to keyless OpenStreetMap imagery on the
   * plain ellipsoid. The app injects this from the CESIUM_TOKEN env var.
   */
  ionToken?: string;
}

/**
 * Ensure Cesium can find its runtime assets and stylesheet before the engine
 * loads. Cesium reads `window.CESIUM_BASE_URL` at import time to locate its
 * Workers/Assets, and its widgets pull in a stylesheet we serve from the same
 * base (copied into public/cesium/ by the copy-cesium-assets Vite plugin).
 */
function prepareCesiumEnvironment(): void {
  const globalWindow = window as typeof window & { CESIUM_BASE_URL?: string };
  globalWindow.CESIUM_BASE_URL ??= CESIUM_BASE_URL;
  if (!document.getElementById(CESIUM_CSS_LINK_ID)) {
    const link = document.createElement("link");
    link.id = CESIUM_CSS_LINK_ID;
    link.rel = "stylesheet";
    link.href = `${CESIUM_BASE_URL}/Widgets/widgets.css`;
    document.head.appendChild(link);
  }
}

/**
 * A 3D-globe map pane rendered with CesiumJS, mounted alongside the MapLibre
 * panes in the multi-map grid. Mirrors {@link SecondaryMapCanvas}'s conventions:
 * the viewer is created exactly once in a dependency-free effect, torn down on
 * unmount, and its camera is kept in step with the shared store camera.
 */
export const CesiumCanvas = memo(function CesiumCanvas({
  viewId,
  ionToken,
}: CesiumCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const cesiumRef = useRef<typeof import("cesium") | null>(null);
  const layerSyncRef = useRef<CesiumLayerSync | null>(null);
  // The last view we pushed into the camera. Applying a view fires Cesium's
  // moveEnd with a (rounding-drifted) echo of that same view; comparing against
  // this lets the moveEnd handler tell a real user move from that echo.
  const lastAppliedRef = useRef<MapViewState | null>(null);
  // Set by real pointer/wheel/touch input on the globe canvas and consumed by
  // the moveEnd handler. Cesium's camera.moveEnd carries no user-driven flag
  // (unlike MapLibre's moveend.originalEvent), so this stands in for it: an
  // autonomous camera settle (terrain streaming in, a container resize) leaves
  // it false and must not mark the project dirty.
  const userMovedRef = useRef(false);
  // Flips true once the viewer exists so the store-driven apply effects re-run
  // and drive the freshly created camera.
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read the viewId/token through refs so the setup effect stays dependency-free
  // (a token change should not tear down and recreate the globe).
  const viewIdRef = useRef(viewId);
  viewIdRef.current = viewId;
  const ionTokenRef = useRef(ionToken);
  ionTokenRef.current = ionToken;

  // Camera sync inputs, mirrored from SecondaryMapCanvas: the shared global
  // camera when sync is on, otherwise this pane's own saved camera.
  const syncView = useAppStore((s) => s.mapLayout.syncView);
  const globalView = useAppStore((s) => s.mapView);
  const entryView = useAppStore(
    (s) => s.secondaryMapViews.find((p) => p.id === viewId)?.view,
  );

  // Layer sync inputs, mirrored from SecondaryMapCanvas: the shared layers with
  // this pane's per-layer visibility overrides, then group effects folded in.
  const layers = useAppStore((s) => s.layers);
  const layerGroups = useAppStore((s) => s.layerGroups);
  const layerVisibility = useAppStore(
    (s) => s.secondaryMapViews.find((p) => p.id === viewId)?.layerVisibility,
  );
  const paneLayers = useMemo<GeoLibreLayer[]>(() => {
    const withOverrides = !layerVisibility
      ? layers
      : layers.map((layer) => {
          const override = layerVisibility[layer.id];
          return override === undefined || override === layer.visible
            ? layer
            : { ...layer, visible: override };
        });
    return applyGroupEffects(withOverrides, layerGroups);
  }, [layers, layerVisibility, layerGroups]);
  // Read the latest layers from the mount effect's initial sync without making
  // that dependency-free effect re-run.
  const paneLayersRef = useRef(paneLayers);
  paneLayersRef.current = paneLayers;

  // Push a store view into the camera and remember it as the expected echo.
  function applyView(view: MapViewState): void {
    const Cesium = cesiumRef.current;
    const viewer = viewerRef.current;
    if (!Cesium || !viewer || viewer.isDestroyed()) return;
    lastAppliedRef.current = view;
    applyMapViewToCamera(Cesium, viewer, view);
  }

  // Create the viewer exactly once. The deps are intentionally empty; everything
  // it reads is captured from the latest store state at mount/ready time.
  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return;
    const container = containerRef.current;
    let cancelled = false;
    let cleanupInput: (() => void) | undefined;

    prepareCesiumEnvironment();

    void (async () => {
      try {
        const Cesium = await import("cesium");
        // The effect may have been cleaned up (StrictMode double-mount, fast
        // unmount) while the chunk loaded; bail before creating a viewer whose
        // container is gone.
        if (cancelled || !container.isConnected) return;

        const token = ionTokenRef.current?.trim();
        if (token) Cesium.Ion.defaultAccessToken = token;

        const viewer = new Cesium.Viewer(container, {
          // A focused globe: no base-layer picker, geocoder, timeline, or
          // animation widget — this pane is a viewport, not a full Cesium app.
          baseLayerPicker: false,
          geocoder: false,
          homeButton: false,
          sceneModePicker: false,
          navigationHelpButton: false,
          timeline: false,
          animation: false,
          fullscreenButton: false,
          // No default click popup / selection outline: clicking a GeoJSON
          // feature must not pop Cesium's unstyled InfoBox (it isn't wired to
          // GeoLibre's identify UI and would overflow a small grid pane).
          infoBox: false,
          selectionIndicator: false,
          // Without an Ion token, fall back to keyless OpenStreetMap imagery so
          // the globe still renders (Ion's default imagery requires a token).
          // MapGrid only mounts this pane once a token is set, but CesiumCanvas
          // is a public @geolibre/map export with an optional `ionToken`, so the
          // no-token path stays supported for that direct use.
          baseLayer: token
            ? undefined
            : Cesium.ImageryLayer.fromProviderAsync(
                Promise.resolve(
                  new Cesium.OpenStreetMapImageryProvider({
                    url: "https://tile.openstreetmap.org/",
                  }),
                ),
                {},
              ),
        });
        if (cancelled) {
          viewer.destroy();
          return;
        }
        cesiumRef.current = Cesium;
        viewerRef.current = viewer;
        layerSyncRef.current = new CesiumLayerSync(Cesium, viewer);

        // Drop Cesium's default double-click "track entity" gesture: it flies to
        // and camera-locks a picked feature, which fights the store-driven camera
        // sync and isn't wired to GeoLibre. Removing it also means every camera
        // move now comes through the pointer/wheel/touch input the moveEnd
        // handler watches, so a real move is never mistaken for an autonomous one.
        viewer.screenSpaceEventHandler.removeInputAction(
          Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
        );

        // Flag genuine camera-moving input on the globe so the moveEnd handler
        // can tell a real move from an autonomous settle. Only motion events
        // count: Cesium's moveEnd fires solely on actual camera movement, so a
        // plain click/tap (pointerdown/touchstart) that doesn't move the camera
        // must NOT arm the flag — otherwise a later autonomous settle (terrain,
        // resize) would consume that stale flag and dirty the project. A hover
        // isn't a move either, so pointermove only counts while a button is down.
        const markUserMove = () => {
          userMovedRef.current = true;
        };
        const markUserDrag = (event: PointerEvent) => {
          if (event.buttons !== 0) userMovedRef.current = true;
        };
        const canvas = viewer.canvas;
        const opts: AddEventListenerOptions = { passive: true };
        canvas.addEventListener("pointermove", markUserDrag, opts);
        canvas.addEventListener("wheel", markUserMove, opts);
        canvas.addEventListener("touchmove", markUserMove, opts);
        cleanupInput = () => {
          canvas.removeEventListener("pointermove", markUserDrag, opts);
          canvas.removeEventListener("wheel", markUserMove, opts);
          canvas.removeEventListener("touchmove", markUserMove, opts);
        };

        // With a token, add Cesium World Terrain so tilted views show relief.
        if (token) {
          try {
            viewer.terrainProvider = await Cesium.createWorldTerrainAsync();
          } catch {
            // Terrain is best-effort; the globe still renders without it.
          }
        }
        // The unmount cleanup may have run during the terrain await (destroying
        // the viewer); re-check before touching it, mirroring the guard after the
        // dynamic import above and CesiumLayerSync's post-await checks. Otherwise
        // the seed/sync/moveEnd below would run against a dead viewer and leave a
        // moveEnd listener that cleanupInput never removes.
        if (cancelled || viewer.isDestroyed()) return;

        // Seed the camera from the shared store camera before the first frame.
        const state = useAppStore.getState();
        const pane = state.secondaryMapViews.find(
          (p) => p.id === viewIdRef.current,
        );
        applyView(state.mapLayout.syncView ? state.mapView : pane?.view ?? state.mapView);

        // Render the store layers on the globe before the first frame.
        layerSyncRef.current?.sync(paneLayersRef.current);

        // Mirror a user's globe navigation back into the shared camera. Echoes
        // of our own applyView are filtered by the isSameView guard.
        viewer.camera.moveEnd.addEventListener(() => {
          if (!cesiumRef.current || viewer.isDestroyed()) return;
          const view = readMapViewFromCamera(cesiumRef.current, viewer);
          if (lastAppliedRef.current && isSameView(view, lastAppliedRef.current)) {
            return;
          }
          lastAppliedRef.current = view;
          // Only the moves that follow real user input dirty the project; an
          // autonomous settle still syncs the camera (markDirty=false) so the
          // panes stay in step without flipping isDirty on a freshly opened
          // project. Mirrors SecondaryMapCanvas's `userDriven` semantics.
          const userDriven = userMovedRef.current;
          userMovedRef.current = false;
          const live = useAppStore.getState();
          // Write only when the view actually differs from the stored camera:
          // `setMapView` has no same-camera guard in the store, and
          // `setSecondaryMapView`'s guard uses exact equality (which Cesium's
          // lossy readback never hits), so both are gated here with isSameView.
          if (live.mapLayout.syncView && !isSameView(view, live.mapView)) {
            live.setMapView(view, userDriven);
          }
          const paneView = live.secondaryMapViews.find(
            (p) => p.id === viewIdRef.current,
          )?.view;
          if (!paneView || !isSameView(view, paneView)) {
            live.setSecondaryMapView(viewIdRef.current, view, userDriven);
          }
        });

        if (!cancelled) setReady(true);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      cleanupInput?.();
      layerSyncRef.current?.destroy();
      layerSyncRef.current = null;
      const viewer = viewerRef.current;
      if (viewer && !viewer.isDestroyed()) viewer.destroy();
      viewerRef.current = null;
      cesiumRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconcile the store layers (with this pane's overrides) onto the globe
  // whenever they change. `ready` re-runs this once the viewer exists; the
  // mount effect's initial sync already covers the value captured at ready time.
  useEffect(() => {
    if (!ready) return;
    layerSyncRef.current?.sync(paneLayers);
  }, [ready, paneLayers]);

  // Synced: follow the shared global camera. Depend on primitives so an
  // equal-valued mapView object does not re-apply. `ready` re-runs this once the
  // viewer exists (the initial seed above already covers the mount value).
  useEffect(() => {
    if (!ready || !syncView) return;
    applyView(globalView);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    ready,
    syncView,
    globalView.center[0],
    globalView.center[1],
    globalView.zoom,
    globalView.bearing,
    globalView.pitch,
  ]);

  // Not synced: follow this pane's own saved camera.
  useEffect(() => {
    if (!ready || syncView || !entryView) return;
    applyView(entryView);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    ready,
    syncView,
    entryView?.center[0],
    entryView?.center[1],
    entryView?.zoom,
    entryView?.bearing,
    entryView?.pitch,
  ]);

  return (
    <div
      className="relative h-full w-full"
      data-testid="cesium-canvas"
      data-view-id={viewId}
    >
      <div ref={containerRef} className="h-full w-full" />
      {error ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-destructive">
          {error}
        </div>
      ) : null}
    </div>
  );
});
