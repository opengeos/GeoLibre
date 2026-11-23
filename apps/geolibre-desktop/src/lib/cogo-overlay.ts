import type { FeatureCollection } from "geojson";
import type * as maplibregl from "maplibre-gl";

/**
 * The COGO and trace panel's transient preview (#3530): the path built so
 * far, a polygon's dashed closing edge, the vertices, and a pending trace
 * start. Drawn as an internal map source like the Line of Sight overlay, and
 * re-added after a basemap switch; the finished shape goes to the editor or a
 * layer through the store, never through this overlay.
 */

const SOURCE_ID = "geolibre-cogo-preview";
const CASING_LAYER = `${SOURCE_ID}-casing`;
const PATH_LAYER = `${SOURCE_ID}-path`;
const CLOSING_LAYER = `${SOURCE_ID}-closing`;
const POINT_LAYER = `${SOURCE_ID}-points`;
const LAYER_IDS = [CASING_LAYER, PATH_LAYER, CLOSING_LAYER, POINT_LAYER];

const PATH_COLOR = "#ea580c";
const TRACE_COLOR = "#7c3aed";

/** Marks the overlay's style layers as internal, so layer lists skip them. */
const INTERNAL_METADATA = { "geolibre:internal": true };

function ensureOverlay(map: maplibregl.Map, data: FeatureCollection): void {
  if (!map.isStyleLoaded()) return;
  if (!map.getSource(SOURCE_ID)) map.addSource(SOURCE_ID, { type: "geojson", data });
  const add = (layer: maplibregl.LayerSpecification) => {
    if (!map.getLayer(layer.id)) map.addLayer({ ...layer, metadata: INTERNAL_METADATA });
  };
  add({
    id: CASING_LAYER,
    type: "line",
    source: SOURCE_ID,
    filter: ["==", ["get", "role"], "path"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ffffff", "line-width": 6, "line-opacity": 0.85 },
  });
  add({
    id: PATH_LAYER,
    type: "line",
    source: SOURCE_ID,
    filter: ["==", ["get", "role"], "path"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": PATH_COLOR, "line-width": 3 },
  });
  add({
    id: CLOSING_LAYER,
    type: "line",
    source: SOURCE_ID,
    filter: ["==", ["get", "role"], "closing"],
    paint: { "line-color": PATH_COLOR, "line-width": 2, "line-dasharray": [2, 2] },
  });
  add({
    id: POINT_LAYER,
    type: "circle",
    source: SOURCE_ID,
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-radius": ["match", ["get", "role"], "vertex", 4, 6],
      "circle-color": ["match", ["get", "role"], "trace", TRACE_COLOR, PATH_COLOR],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2,
    },
  });
}

function removeOverlay(map: maplibregl.Map): void {
  try {
    for (const id of LAYER_IDS) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  } catch {
    // Mid-style-switch the overlay already went with the old style.
  }
}

/** The panel's drawing on one map. */
export interface CogoOverlay {
  setData(data: FeatureCollection): void;
  remove(): void;
}

/**
 * Draw the preview as a transient source on a MapLibre map, re-adding it
 * after a basemap switch.
 *
 * @param map - The live MapLibre map.
 * @returns The overlay handle.
 */
export function createCogoOverlay(map: maplibregl.Map): CogoOverlay {
  let data: FeatureCollection = { type: "FeatureCollection", features: [] };
  let removed = false;
  const apply = () => {
    if (removed) return;
    ensureOverlay(map, data);
    const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    void source?.setData(data);
  };
  const onStyleData = () => {
    if (!map.getSource(SOURCE_ID)) apply();
  };
  map.on("styledata", onStyleData);
  return {
    setData(next) {
      data = next;
      apply();
    },
    remove() {
      if (removed) return;
      removed = true;
      map.off("styledata", onStyleData);
      removeOverlay(map);
    },
  };
}
