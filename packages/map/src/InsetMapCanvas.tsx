import { useEffect, useRef } from "react";
import { createMapEngineHandle } from "./engine/handle";
import type { LngLat, MapEngine, MapMarkerHandle, Unsubscribe } from "./engine/types";

const INSET_CONTROLS = [
  "navigation",
  "fullscreen",
  "compass",
  "geolocate",
  "globe",
  "terrain",
  "scale",
  "attribution",
  "logo",
  "layer-control",
] as const;

export interface InsetMapMarker {
  readonly lngLat: LngLat;
  readonly visible?: boolean;
  /** CSS class applied to the engine-owned marker element. */
  readonly className?: string;
}

export interface InsetMapCanvasProps {
  readonly center: LngLat;
  readonly zoom?: number;
  /** A renderer-neutral basemap input passed to the engine configuration. */
  readonly basemapStyleUrl: string;
  readonly marker?: InsetMapMarker;
  readonly className?: string;
}

interface InsetMapState {
  readonly center: LngLat;
  readonly marker?: InsetMapMarker;
}

export interface InsetMapSession {
  update(state: InsetMapState): void;
  destroy(): void;
}

function markerElement(className: string | undefined): HTMLElement {
  const element = document.createElement("div");
  if (className) element.className = className;
  return element;
}

/**
 * Mount the deliberately small, non-interactive story inset through a regular
 * engine handle. Keeping this lifecycle here ensures secondary renderer views
 * never leak a concrete SDK object to React consumers.
 */
export async function mountInsetMap(
  engine: MapEngine,
  container: HTMLElement,
  options: Pick<InsetMapCanvasProps, "center" | "zoom" | "basemapStyleUrl" | "marker">,
): Promise<InsetMapSession> {
  engine.configure({
    basemapStyleUrl: options.basemapStyleUrl,
    basemapVisible: true,
    basemapOpacity: 1,
  });
  for (const control of INSET_CONTROLS)
    engine.controls.setBuiltInState(control, { visible: false });

  let marker: MapMarkerHandle | null = null;
  let markerClassName: string | undefined;
  let restoreNavigation: Unsubscribe = () => undefined;
  let destroyed = false;

  const removeMarker = (): void => {
    marker?.remove();
    marker = null;
    markerClassName = undefined;
  };

  const sync = (state: InsetMapState): void => {
    if (destroyed) return;
    const view = engine.camera.readView();
    engine.camera.applyView({ ...view, center: state.center }, { mode: "jump" });

    const requestedMarker = state.marker;
    if (!requestedMarker || requestedMarker.visible === false) {
      removeMarker();
      return;
    }

    if (!marker || markerClassName !== requestedMarker.className) {
      removeMarker();
      marker = engine.interactions.createMarker({
        lngLat: requestedMarker.lngLat,
        element: markerElement(requestedMarker.className),
      });
      markerClassName = requestedMarker.className;
      return;
    }
    marker.setLngLat(requestedMarker.lngLat);
  };

  try {
    await engine.mount(container, {
      center: options.center,
      zoom: options.zoom ?? 1,
      bearing: 0,
      pitch: 0,
    });
    restoreNavigation = engine.interactions.suspendNavigation();
    sync({ center: options.center, marker: options.marker });
  } catch (error) {
    removeMarker();
    engine.destroy();
    throw error;
  }

  return {
    update: sync,
    destroy: (): void => {
      if (destroyed) return;
      destroyed = true;
      removeMarker();
      restoreNavigation();
      engine.destroy();
    },
  };
}

/** A small, engine-owned map view for story presentation context. */
export function InsetMapCanvas({
  center,
  zoom,
  basemapStyleUrl,
  marker,
  className = "h-full w-full",
}: InsetMapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<InsetMapSession | null>(null);
  const latestStateRef = useRef<InsetMapState>({ center, marker });
  latestStateRef.current = { center, marker };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const engine = createMapEngineHandle("maplibre");
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;

    void mountInsetMap(engine, container, { center, zoom, basemapStyleUrl, marker })
      .then((session) => {
        if (disposed) {
          session.destroy();
          return;
        }
        sessionRef.current = session;
        session.update(latestStateRef.current);
        resizeObserver = new ResizeObserver(() => engine.invoke("viewport.resize", undefined));
        resizeObserver.observe(container);
      })
      .catch((error: unknown) => {
        if (!disposed) console.warn("Could not mount the story inset map.", error);
      });

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      sessionRef.current?.destroy();
      sessionRef.current = null;
      // mountInsetMap destroys a mounted engine; this covers unmount while its
      // lazy adapter is still resolving.
      engine.destroy();
    };
  }, [basemapStyleUrl, zoom]);

  useEffect(() => {
    sessionRef.current?.update({ center, marker });
  }, [center, marker]);

  return <div ref={containerRef} className={className} data-testid="story-inset-map" />;
}
