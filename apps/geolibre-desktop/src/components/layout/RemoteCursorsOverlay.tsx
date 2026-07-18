import { useAppStore, type CollaborationPresence } from "@geolibre/core";
import maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { MapController } from "@geolibre/map";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import type { Feature, FeatureCollection, Polygon } from "geojson";

const VIEWPORT_SOURCE_ID = "__geolibre_collab_viewports";
const VIEWPORT_LAYER_ID = "__geolibre_collab_viewports_line";

/**
 * Renders remote participants' presence on the map during a live session:
 * cursors as MapLibre Markers and viewports as a dedicated GeoJSON line layer.
 *
 * Non-visual component (returns null) — it imperatively attaches to the live map
 * via the controller ref, mirroring how plugins reach the map through
 * `getMap()`. It owns and tears down only its own markers/source/layer, so it is
 * independent of the deck.gl overlay's lifecycle.
 *
 * @param mapControllerRef - Ref to the live map controller.
 */
export function RemoteCursorsOverlay({
  mapControllerRef,
}: {
  mapControllerRef: RefObject<MapController | null>;
}): null {
  const presence = useAppStore((s) => s.collaboration.presence);
  const isActive = useAppStore((s) => s.collaboration.isActive);
  const markersRef = useRef<Map<string, maplibregl.Marker>>(new Map());

  useEffect(() => {
    const map = mapControllerRef.current?.getMap() ?? null;
    if (!map || !isActive) {
      // Clean up any lingering markers/layer when the session ends.
      safely(() => clearAll(map, markersRef.current));
      return;
    }

    // Never let presence rendering throw out of a React effect/map event — the
    // map style mutates concurrently (layer add/remove, basemap reload) and a
    // transient failure must not trip the Map error boundary. The next presence
    // update or styledata event retries.
    const render = () => safely(() => renderPresence(map, presence, markersRef.current));
    render();
    // Re-apply after a style reload (basemap change) wipes the source/layer.
    map.on("styledata", render);
    return () => {
      map.off("styledata", render);
    };
  }, [presence, isActive, mapControllerRef]);

  // Remove everything on unmount.
  useEffect(
    () => () =>
      safely(() => clearAll(mapControllerRef.current?.getMap() ?? null, markersRef.current)),
    [mapControllerRef],
  );

  return null;
}

// Runs a map mutation that may throw while the style is mid-change, swallowing
// the error so presence rendering can never trip the Map error boundary. Logs
// in dev so a persistent bug isn't hidden.
function safely(fn: () => void): void {
  try {
    fn();
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn("[GeoLibre] collab presence overlay error", error);
    }
  }
}

function renderPresence(
  map: MapLibreMap,
  presence: Record<string, CollaborationPresence>,
  markers: Map<string, maplibregl.Marker>,
): void {
  const ids = new Set(Object.keys(presence));

  // Drop markers for participants who left.
  for (const [id, marker] of markers) {
    if (!ids.has(id)) {
      marker.remove();
      markers.delete(id);
    }
  }

  // Add/update a cursor marker per participant that has a cursor position.
  for (const [id, p] of Object.entries(presence)) {
    if (!p.cursor) {
      markers.get(id)?.remove();
      markers.delete(id);
      continue;
    }
    let marker = markers.get(id);
    if (!marker) {
      marker = new maplibregl.Marker({
        element: createCursorElement(p),
        anchor: "top-left",
      });
      markers.set(id, marker);
      marker.addTo(map);
    } else {
      updateCursorElement(marker.getElement(), p);
    }
    marker.setLngLat([p.cursor.lng, p.cursor.lat]);
  }

  // Adding/updating the viewport source+layer mutates the style, so only touch
  // it once the style is loaded; markers above are DOM and always safe.
  if (map.isStyleLoaded()) {
    ensureViewportLayer(map);
    const source = map.getSource(VIEWPORT_SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(viewportCollection(presence));
  }
}

function viewportCollection(
  presence: Record<string, CollaborationPresence>,
): FeatureCollection<Polygon> {
  const features: Feature<Polygon>[] = [];
  for (const p of Object.values(presence)) {
    const bbox = p.view?.bbox;
    if (!bbox) continue;
    const [w, s, e, n] = bbox;
    // When the viewport crosses the antimeridian the bbox comes back with
    // east < west; unwrap east past 180° so the polygon stays the narrow actual
    // viewport instead of winding the long way around the globe. MapLibre
    // renders longitudes > 180° correctly in wrapped tile mode.
    const safeE = e < w ? e + 360 : e;
    features.push({
      type: "Feature",
      properties: { color: p.color },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [w, s],
            [safeE, s],
            [safeE, n],
            [w, n],
            [w, s],
          ],
        ],
      },
    });
  }
  return { type: "FeatureCollection", features };
}

function ensureViewportLayer(map: MapLibreMap): void {
  if (!map.getSource(VIEWPORT_SOURCE_ID)) {
    map.addSource(VIEWPORT_SOURCE_ID, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getLayer(VIEWPORT_LAYER_ID)) {
    map.addLayer({
      id: VIEWPORT_LAYER_ID,
      type: "line",
      source: VIEWPORT_SOURCE_ID,
      paint: {
        "line-color": ["get", "color"],
        "line-width": 2,
        "line-dasharray": [2, 1],
        "line-opacity": 0.8,
      },
    });
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

// `color` and `displayName` come from a remote participant and are stored and
// re-broadcast by the relay without trust. Build the cursor with DOM/SVG APIs
// and set the color as an attribute/style property (never interpolated into
// markup) so a hostile value can't become executable markup — the server also
// validates `color`, but this is the defense-in-depth client half.
function createCursorElement(p: CollaborationPresence): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "geolibre-collab-cursor";
  el.style.cssText =
    "pointer-events:none;display:flex;align-items:flex-start;gap:2px;transform:translate(-2px,-2px);will-change:transform;";
  el.appendChild(createCursorSvg(p.color));
  const label = document.createElement("span");
  label.className = "geolibre-collab-cursor-label";
  label.style.cssText =
    "color:#fff;font-size:11px;line-height:1;padding:2px 5px;border-radius:6px;white-space:nowrap;margin-top:10px;box-shadow:0 1px 2px rgba(0,0,0,.3);";
  label.style.background = p.color;
  label.textContent = p.displayName;
  el.appendChild(label);
  return el;
}

function updateCursorElement(el: HTMLElement, p: CollaborationPresence): void {
  // Keep the arrow color in sync too, not just the label (the color can change).
  const path = el.querySelector<SVGPathElement>("path");
  if (path) path.setAttribute("fill", p.color);
  const label = el.querySelector<HTMLElement>(".geolibre-collab-cursor-label");
  if (label) {
    label.style.background = p.color;
    label.textContent = p.displayName;
  }
}

// Inline SVG arrow cursor tinted with the participant's color, built with DOM
// APIs so the color is set as an attribute rather than injected into markup.
function createCursorSvg(color: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M3 2l7.5 18 2.2-7.3L20 10.5 3 2z");
  path.setAttribute("fill", color);
  path.setAttribute("stroke", "#fff");
  path.setAttribute("stroke-width", "1.2");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  return svg;
}

function clearAll(map: MapLibreMap | null, markers: Map<string, maplibregl.Marker>): void {
  for (const marker of markers.values()) marker.remove();
  markers.clear();
  if (map) {
    if (map.getLayer(VIEWPORT_LAYER_ID)) map.removeLayer(VIEWPORT_LAYER_ID);
    if (map.getSource(VIEWPORT_SOURCE_ID)) map.removeSource(VIEWPORT_SOURCE_ID);
  }
}
