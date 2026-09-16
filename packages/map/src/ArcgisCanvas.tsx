import { useEffect, useRef, useState, type RefObject } from "react";
import { applyGroupEffects, useAppStore, type MapProjection } from "@geolibre/core";
import type { MapEngine } from "./map-engine";
import {
  ArcgisEngine,
  arcgisSceneMode,
  bearingToRotation,
  viewPlacementState,
} from "./arcgis-engine";
import {
  ensureArcgisCss,
  loadArcgisSceneSdk,
  loadArcgisSdk,
  redactArcgisError,
  type ArcgisHandle,
  type ArcgisSdk,
  type ArcgisView,
} from "./arcgis-sdk";

export interface ArcgisCanvasProps {
  /**
   * ArcGIS API key. Optional: the map draws the translated project basemap and
   * every non-Esri layer without one; a key unlocks Esri's basemap styles and
   * location services and is required by Esri for those.
   */
  apiKey?: string;
  viewId?: string;
  engineRef?: RefObject<MapEngine | null>;
  onEngineReady?: () => void;
  /** Translated accessible name for the identify popup's close button. */
  closeLabel?: string;
}

/**
 * The ArcGIS Maps SDK for JavaScript as a map pane (issue #2421).
 *
 * The SDK loads from Esri's CDN on first mount (see `arcgis-sdk.ts`), so
 * nothing ArcGIS-specific is in the app bundle. The component owns
 * construction — `Map`, `MapView`, the store subscription and the pointer
 * handlers — and hands everything after that to {@link ArcgisEngine}, the way
 * `MapboxCanvas` does for Mapbox GL JS.
 *
 * The SDK draws 2D and 3D through different view classes, so the view is
 * chosen from the project's projection and terrain preferences
 * ({@link arcgisSceneMode}) and the whole map is rebuilt when that choice
 * changes: a globe or terrain gets a `SceneView` (whose modules load only
 * then), a flat Mercator map a `MapView`. The camera carries over through the
 * store. A split pane's globe toggle stays local to the pane, as on MapLibre.
 * The outgoing view stays on screen, frozen, until the new one has drawn, so
 * switching between 2D and 3D does not flash an empty pane.
 */
export function ArcgisCanvas({
  apiKey,
  viewId,
  engineRef,
  onEngineReady,
  closeLabel = "Close",
}: ArcgisCanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  // Views replaced by a 2D/3D switch, kept on screen until the new view draws.
  const retiring = useRef<{ element: HTMLElement; engine: ArcgisEngine }[]>([]);
  const readyCallback = useRef(onEngineReady);
  readyCallback.current = onEngineReady;
  // Read through a ref so a language change reaches the next popup without
  // recreating the map.
  const closeLabelRef = useRef(closeLabel);
  closeLabelRef.current = closeLabel;
  const [error, setError] = useState<string | null>(null);
  const sharedProjection = useAppStore((s) => s.preferences.map.projection);
  const terrainEnabled = useAppStore((s) => s.preferences.map.terrainEnabled);
  // A split pane's toggle overrides the shared projection for that pane only.
  const [paneProjection, setPaneProjection] = useState<MapProjection | null>(null);
  const projection = (viewId ? paneProjection : null) ?? sharedProjection;
  const sceneMode = arcgisSceneMode(projection, terrainEnabled);
  useEffect(() => {
    let cancelled = false;
    let engine: ArcgisEngine | undefined;
    let cleanup = () => {};
    setError(null);
    // Each view gets its own element: the SDK owns its container's contents,
    // and the outgoing view must keep drawing in its own until this one is up.
    const element = document.createElement("div");
    element.className = "absolute inset-0";
    container.current?.prepend(element);
    const retire = () => {
      for (const old of retiring.current.splice(0)) {
        old.engine.destroy();
        old.element.remove();
      }
    };
    const dark = document.documentElement.classList.contains("dark");
    void Promise.all([
      loadArcgisSdk(),
      sceneMode === "2d" ? Promise.resolve(undefined) : loadArcgisSceneSdk(),
      ensureArcgisCss(dark ? "dark" : "light"),
    ])
      .then(([sdk, scene]) => {
        if (cancelled || !element.isConnected) return;
        sdk.config.apiKey = apiKey?.trim() || null;
        const state = useAppStore.getState();
        const pane = state.secondaryMapViews.find((p) => p.id === viewId);
        const view =
          viewId && !state.mapLayout.syncView ? (pane?.view ?? state.mapView) : state.mapView;
        const map = new sdk.Map({});
        const common = {
          container: element,
          map,
          center: view.center,
          zoom: view.zoom,
          // The engine mounts the built-in controls the Controls menu governs.
          ui: { components: [] },
          // Identify goes through the engine's hit test, not the SDK popup.
          popupEnabled: false,
          highlightOptions: { color: [250, 204, 21, 1] },
        };
        const mapView: ArcgisView = scene
          ? new scene.SceneView({
              ...common,
              viewingMode: sceneMode === "global" ? "global" : "local",
              // The initial heading and tilt are applied by `settleView` once
              // the view is ready; a camera needs a position the store lacks.
              environment: {
                atmosphereEnabled: true,
                starsEnabled: sceneMode === "global",
                // The default is a simulated sun at a fixed date and time,
                // which leaves part of the globe (typically a polar region)
                // on the night side. Virtual lighting follows the camera, so
                // the whole visible map is lit, as on the MapLibre globe.
                lighting: { type: "virtual" },
              },
            })
          : new sdk.MapView({
              ...common,
              rotation: bearingToRotation(view.bearing),
              // Fractional zooms are what the shared camera carries; snapping
              // would nudge every synchronized pane to the nearest level.
              constraints: { snapToZoom: false, rotationEnabled: true },
            });
        engine = new ArcgisEngine(sdk, map, mapView, {
          hasApiKey: Boolean(apiKey?.trim()),
          controlVisibility: viewId ? { "layer-control": false } : undefined,
          ...(scene ? { scene } : {}),
          onProjectionToggle: (next) => {
            if (cancelled) return;
            if (viewId) {
              setPaneProjection(next);
              return;
            }
            // Persisted like MapLibre's globe toggle, so the project reopens in
            // this projection; the store change rebuilds the view.
            useAppStore.setState((s) =>
              s.preferences.map.projection === next
                ? s
                : {
                    preferences: {
                      ...s.preferences,
                      map: { ...s.preferences.map, projection: next },
                    },
                    isDirty: true,
                  },
            );
          },
        });
        const current = engine;
        let applying = false;
        // Until the initial camera has landed, `stationary` reports the view's
        // default camera, which must not be written back to the store.
        let settled = false;
        let selectionKey: string | null = null;
        let popupDispose: (() => void) | null = null;
        const removePopup = () => {
          popupDispose?.();
          popupDispose = null;
        };
        const update = (next: typeof state, previous?: typeof state) => {
          if (cancelled) return;
          const targetPane = next.secondaryMapViews.find((p) => p.id === viewId);
          const previousPane = previous?.secondaryMapViews.find((p) => p.id === viewId);
          applying = true;
          try {
            if (
              !previous ||
              next.basemapStyleUrl !== previous.basemapStyleUrl ||
              next.preferences.map.arcgisBasemap !== previous.preferences.map.arcgisBasemap
            )
              current.setBasemap(next.basemapStyleUrl, next.preferences.map.arcgisBasemap);
            if (!previous || next.preferences.map !== previous.preferences.map)
              current.applyMapPreferences(next.preferences.map);
            if (!previous || next.basemapVisible !== previous.basemapVisible)
              current.setBasemapVisible(next.basemapVisible);
            if (!previous || next.basemapOpacity !== previous.basemapOpacity)
              current.setBasemapOpacity(next.basemapOpacity);
            if (!previous || next.blankBackgroundColor !== previous.blankBackgroundColor)
              current.setBlankBackgroundColor(next.blankBackgroundColor);
            if (
              !previous ||
              next.layers !== previous.layers ||
              next.layerGroups !== previous.layerGroups ||
              targetPane?.layerVisibility !== previousPane?.layerVisibility
            ) {
              const layers = targetPane
                ? next.layers.map((layer) => ({
                    ...layer,
                    visible: targetPane.layerVisibility[layer.id] ?? layer.visible,
                  }))
                : next.layers;
              current.syncLayers(applyGroupEffects(layers, next.layerGroups));
            }
            if (
              !previous ||
              next.mapView !== previous.mapView ||
              targetPane?.view !== previousPane?.view ||
              next.mapLayout.syncView !== previous.mapLayout.syncView
            ) {
              current.applyView(
                viewId && !next.mapLayout.syncView
                  ? (targetPane?.view ?? next.mapView)
                  : next.mapView,
              );
            }
            if (
              !viewId &&
              (!previous ||
                next.selectedFeatureId !== previous.selectedFeatureId ||
                next.selectedFeatureIds !== previous.selectedFeatureIds ||
                next.selectedLayerId !== previous.selectedLayerId)
            ) {
              const ids = next.selectedFeatureIds?.length
                ? next.selectedFeatureIds
                : next.selectedFeatureId;
              // Frame a newly selected feature when the attribute table's
              // "Zoom to selection" is on, as MapCanvas does; a re-render with
              // the same selection only redraws the highlight.
              const key =
                next.selectedLayerId && ids !== null && (Array.isArray(ids) ? ids.length : true)
                  ? `${next.selectedLayerId}:${Array.isArray(ids) ? ids.join("\u0000") : ids}`
                  : null;
              const fit = Boolean(
                next.ui.zoomToSelectedFeature && key && key !== selectionKey && previous,
              );
              selectionKey = key;
              current.highlightFeature(
                next.layers.find((l) => l.id === next.selectedLayerId),
                ids,
                { fit },
              );
            }
            if (previous && next.identifyLayerId !== previous.identifyLayerId) removePopup();
          } finally {
            applying = false;
          }
        };
        const unsubscribe = useAppStore.subscribe(update);
        cleanup = unsubscribe;
        update(state);
        update(useAppStore.getState(), state);
        const handles: ArcgisHandle[] = [];
        // `stationary` flips true at the end of every pan, zoom and rotation,
        // which is the SDK's `moveend`.
        handles.push(
          sdk.reactiveUtils.when(
            () => mapView.stationary,
            () => {
              if (applying || cancelled || !settled || !mapView.ready) return;
              const next = useAppStore.getState(),
                camera = current.readView();
              // Shared view first (as the other canvases do), so a synchronized
              // pane never reads the changed pane against a stale `mapView`.
              if (!viewId || next.mapLayout.syncView) next.setMapView(camera, true);
              if (viewId) next.setSecondaryMapView(viewId, camera, true);
              // A MapView reports null, which clears a value an earlier
              // renderer (or scene) left in the status bar.
              else next.setCameraAltitude(current.readCameraAltitude());
            },
          ),
        );
        handles.push(
          mapView.on("pointer-move", (event) => {
            if (viewId) return;
            const point = mapView.toMap({ x: event.x, y: event.y });
            useAppStore
              .getState()
              .setPointerCoords(point ? [point.longitude, point.latitude] : null);
          }),
        );
        handles.push(
          mapView.on("pointer-leave", () => {
            if (!viewId) useAppStore.getState().setPointerCoords(null);
          }),
        );
        handles.push(
          mapView.on("click", (event) => {
            if (viewId) return;
            const next = useAppStore.getState();
            if (!next.identifyLayerId) return;
            const layerId = next.layers.some((l) => l.id === next.identifyLayerId)
              ? next.identifyLayerId
              : undefined;
            void current
              .identifyFeaturesAt({ x: event.x, y: event.y }, layerId)
              .catch(() => [] as Awaited<ReturnType<typeof current.identifyFeaturesAt>>)
              .then((matches) => {
                if (cancelled) return;
                const match = matches[0];
                removePopup();
                const latest = useAppStore.getState();
                if (!match) {
                  latest.selectFeature(null);
                  return;
                }
                latest.selectLayer(match.layerId);
                latest.selectFeature(match.featureId);
                const point = mapView.toMap({ x: event.x, y: event.y });
                if (!point || !mapView.container) return;
                const content = document.createElement("div");
                content.className = "geolibre-arcgis-popup";
                const title = document.createElement("strong");
                title.textContent = latest.layers.find((l) => l.id === match.layerId)?.name ?? "";
                content.append(title);
                for (const [key, value] of Object.entries(match.properties)) {
                  const row = document.createElement("div");
                  row.textContent = `${key}: ${
                    typeof value === "object" ? JSON.stringify(value) : String(value)
                  }`;
                  content.append(row);
                }
                const close = document.createElement("button");
                close.type = "button";
                close.className = "geolibre-arcgis-popup-close";
                close.setAttribute("aria-label", closeLabelRef.current);
                close.title = closeLabelRef.current;
                close.textContent = "×";
                close.onclick = removePopup;
                content.prepend(close);
                popupDispose = anchorPopup(sdk, mapView, content, [
                  point.longitude,
                  point.latitude,
                ]);
              });
          }),
        );
        void mapView
          .when()
          .then(() => {
            if (cancelled) return;
            const latest = useAppStore.getState();
            const pane = latest.secondaryMapViews.find((p) => p.id === viewId);
            return current.settleView(
              viewId && !latest.mapLayout.syncView
                ? (pane?.view ?? latest.mapView)
                : latest.mapView,
            );
          })
          .then(() => {
            if (cancelled) return;
            settled = true;
            if (!viewId) useAppStore.getState().setCameraAltitude(current.readCameraAltitude());
            if (engineRef) engineRef.current = current;
            readyCallback.current?.();
            // A flat map is one click away from a globe; fetch the 3D modules
            // while the page is idle so that first switch does not also wait
            // on the network. A failure here is retried by the switch itself.
            if (!scene) whenIdle(() => void loadArcgisSceneSdk().catch(() => {}));
            return whenDrawn(sdk, mapView);
          })
          .then(() => {
            if (!cancelled) retire();
          })
          .catch((error: unknown) => {
            // A view that never becomes ready (a lost WebGL context, say)
            // would otherwise leave the old view frozen over an empty pane.
            if (cancelled) return;
            retire();
            setError(redactArcgisError(error instanceof Error ? error.message : String(error)));
          });
        const status = window.setInterval(() => {
          if (cancelled) return;
          const errors = current.getRenderStatus().errors;
          setError(errors.length ? errors.join("; ") : null);
        }, 1000);
        // The SDK ships one stylesheet per theme; follow the app's dark-mode
        // class so the widgets restyle with the rest of the chrome.
        const theme = new MutationObserver(() => {
          void ensureArcgisCss(
            document.documentElement.classList.contains("dark") ? "dark" : "light",
          ).catch(() => {});
        });
        theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
        cleanup = () => {
          unsubscribe();
          for (const handle of handles) handle.remove();
          window.clearInterval(status);
          theme.disconnect();
          removePopup();
        };
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // A frozen old view would hide that the new one failed.
        retire();
        setError(redactArcgisError(error instanceof Error ? error.message : String(error)));
      });
    return () => {
      cancelled = true;
      cleanup();
      if (engineRef && engineRef.current === engine) engineRef.current = null;
      if (engine) {
        // Keep the last frame visible above the next view, inert, until that
        // view has drawn (or the canvas unmounts).
        // Newer frames above older ones when switches overlap, all below the
        // error banner (z-10).
        element.style.zIndex = String(Math.min(9, retiring.current.length + 1));
        element.style.pointerEvents = "none";
        retiring.current.push({ element, engine });
      } else element.remove();
    };
  }, [apiKey, viewId, engineRef, sceneMode]);
  // Declared after the effect above so an unmount runs its cleanup (which
  // queues the last view) before this flushes every queued view.
  useEffect(
    () => () => {
      for (const old of retiring.current.splice(0)) {
        old.engine.destroy();
        old.element.remove();
      }
    },
    [],
  );
  return (
    <div className="relative h-full w-full" data-testid="arcgis-canvas">
      <div ref={container} className="relative h-full w-full" />
      {error && (
        <div
          role="alert"
          className="absolute bottom-10 end-2 z-10 max-h-32 max-w-[75%] overflow-auto rounded border border-input bg-background p-2 text-xs text-foreground shadow"
        >
          {error}
        </div>
      )}
    </div>
  );
}

/** Run `task` when the page is idle (or soon, where idle callbacks are missing). */
function whenIdle(task: () => void): void {
  if (typeof window.requestIdleCallback === "function")
    window.requestIdleCallback(task, { timeout: 5000 });
  else window.setTimeout(task, 1000);
}

/**
 * Resolve once a freshly settled view shows a map: when its basemap tiles have
 * drawn, or after `timeoutMs`. Waiting for the whole view to stop updating
 * held the outgoing view up for another second or so while data layers,
 * terrain and neighbouring globe tiles streamed in, which read as a slow
 * button; those fill in on the live view instead. A view with no basemap
 * layers (the Blank basemap) waits for everything.
 */
export function whenDrawn(
  sdk: Pick<ArcgisSdk, "reactiveUtils">,
  view: Pick<ArcgisView, "basemapView" | "updating">,
  timeoutMs = 3000,
): Promise<void> {
  return new Promise((resolve) => {
    let handle: ArcgisHandle | undefined;
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      handle?.remove();
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(done, timeoutMs);
    // Two frames so the view has scheduled its first tile requests; before
    // that nothing reads as updating over an empty canvas.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (finished) return;
        handle = sdk.reactiveUtils.when(
          () => {
            const base = view.basemapView?.baseLayerViews;
            return base && base.length > 0
              ? base.every((layerView) => !layerView.updating)
              : !view.updating;
          },
          done,
          { initial: true, once: true },
        );
      }),
    );
  });
}

/**
 * Pin a popup element above a location and follow the view. The SDK's own
 * popup is a web component in 5.x that this pane deliberately leaves out; a
 * plain element positioned through `toScreen` keeps the identify popup the
 * same DOM the other engines produce.
 */
function anchorPopup(
  sdk: Awaited<ReturnType<typeof loadArcgisSdk>>,
  view: ArcgisView,
  element: HTMLElement,
  lngLat: [number, number],
): () => void {
  if (!view.container) return () => {};
  element.style.position = "absolute";
  element.style.zIndex = "5";
  element.style.transform = "translate(-50%, calc(-100% - 12px))";
  view.container.append(element);
  const point = new sdk.Point({
    longitude: lngLat[0],
    latitude: lngLat[1],
    spatialReference: { wkid: 4326 },
  });
  const place = () => {
    const screen = view.toScreen(point);
    if (!screen) return;
    element.style.left = `${screen.x}px`;
    element.style.top = `${screen.y}px`;
  };
  place();
  const handle = sdk.reactiveUtils.watch(() => viewPlacementState(view), place);
  return () => {
    handle.remove();
    element.remove();
  };
}
