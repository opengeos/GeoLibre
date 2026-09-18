import { DUCKDB_VECTOR_FEATURE_WARN_COUNT, DUCKDB_VECTOR_ROUTE_BYTES } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import type { Map as MapLibreMap, SourceSpecification, LayerSpecification } from "maplibre-gl";
import type { VectorControl, VectorLayerInfo } from "maplibre-gl-vector";
import type { GeoLibreAppAPI } from "../types";
import { setVectorGeometryReader, syncVectorLayersToStore } from "./vector-layer-sync";

/**
 * Whether a tiled layer is too large to read out of DuckDB as one
 * FeatureCollection for the globe. Cesium draws a collection as entities, so
 * the export is bounded by the same numbers that route an import to tiles
 * (`DUCKDB_VECTOR_ROUTE_BYTES` / `DUCKDB_VECTOR_FEATURE_WARN_COUNT`), and a
 * streamed GeoParquet is never read whole: its rows live at the remote source.
 * An oversize layer stays in the panel and is flagged 2D-only until the
 * renderer switches back to MapLibre.
 *
 * @param info - The control's snapshot of the layer.
 * @returns True when the layer must not be materialized.
 */
export function exceedsCesiumVectorLimit(
  info: Pick<VectorLayerInfo, "ingestMode" | "featureCount" | "byteSize">,
): boolean {
  return (
    info.ingestMode === "stream" ||
    (info.featureCount ?? 0) > DUCKDB_VECTOR_FEATURE_WARN_COUNT ||
    (info.byteSize ?? 0) > DUCKDB_VECTOR_ROUTE_BYTES
  );
}

/**
 * Retain the vector panel's presentation records while a non-MapLibre renderer
 * (the Cesium globe or the Mapbox engine) renders their geometry through the
 * app store. The bridge is renderer-agnostic: it fakes the MapLibre `Map`
 * surface the control expects and syncs the materialized layers to the store,
 * which every engine draws. This adapter belongs only to VectorControl; the
 * host engines still reject unsupported MapLibre operations by other controls.
 * The overrides cover every map call maplibre-gl-vector 0.11 makes beyond the
 * host's own events, canvas, and container (re-check on a version bump).
 */
export function bridgeVectorControlToStore(control: VectorControl, app: GeoLibreAppAPI): void {
  const sources = new Map<string, { serialize: () => SourceSpecification }>();
  const layers = new Map<string, LayerSpecification>();
  const images = new Set<string>();
  const collections = new Map<string, FeatureCollection>();
  const pending = new Map<string, object>();
  let removed = false;
  const originalOnAdd = control.onAdd.bind(control);
  control.onAdd = (host) => {
    removed = false;
    const overrides = {
      addSource(id: string, spec: SourceSpecification) {
        sources.set(id, { serialize: () => spec });
      },
      getSource: (id: string) => sources.get(id),
      removeSource(id: string) {
        sources.delete(id);
      },
      addLayer(layer: LayerSpecification) {
        layers.set(layer.id, { ...layer });
      },
      getLayer: (id: string) => layers.get(id),
      removeLayer(id: string) {
        layers.delete(id);
      },
      moveLayer() {}, // Ordering is applied by the Cesium store reconciler.
      // KML icon sprites: Cesium has no MapLibre image registry to fill.
      hasImage: (id: string) => images.has(id),
      addImage(id: string) {
        images.add(id);
      },
      setPaintProperty(id: string, key: string, value: unknown) {
        const layer = layers.get(id);
        if (layer) layer.paint = { ...layer.paint, [key]: value } as LayerSpecification["paint"];
      },
      setLayoutProperty(id: string, key: string, value: unknown) {
        const layer = layers.get(id);
        if (layer) layer.layout = { ...layer.layout, [key]: value } as LayerSpecification["layout"];
      },
      getStyle: () => ({
        version: 8,
        sources: Object.fromEntries([...sources].map(([id, source]) => [id, source.serialize()])),
        layers: [...layers.values()],
      }),
      fitBounds(bounds: [[number, number], [number, number]]) {
        app.fitBounds?.([...bounds[0], ...bounds[1]]);
      },
    };
    const map = new Proxy(host, {
      get(target, key) {
        if (key in overrides) return Reflect.get(overrides, key);
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return originalOnAdd(map as MapLibreMap);
  };

  setVectorGeometryReader(control, (info) => {
    const spec = sources.get(info.sourceId)?.serialize();
    if (
      spec?.type === "geojson" &&
      typeof spec.data === "object" &&
      spec.data.type === "FeatureCollection"
    ) {
      return spec.data;
    }
    return collections.get(info.id);
  });

  // Tiled inputs live in DuckDB. Export once per source revision, including
  // refresh and render-mode changes, and ignore completions after removal. A
  // source revision that yields nothing (an oversize layer, or one the control
  // holds no data for) stays pending on purpose: retrying cannot change the
  // answer until the control adds a new source for the layer.
  const syncGeometry = () => {
    const infos = control.getLayers();
    const ids = new Set(infos.map((info) => info.id));
    for (const id of collections.keys()) if (!ids.has(id)) collections.delete(id);
    for (const id of pending.keys()) if (!ids.has(id)) pending.delete(id);
    for (const info of infos) {
      const source = sources.get(info.sourceId);
      if (!source || source.serialize().type === "geojson" || pending.get(info.id) === source)
        continue;
      // A new revision must not keep drawing the previous one's features.
      collections.delete(info.id);
      pending.set(info.id, source);
      if (exceedsCesiumVectorLimit(info)) {
        // Console-only: the plugin layer has no notification API; the layer
        // panel shows the 2D-only badge for the record.
        console.warn(
          `[GeoLibre] Vector layer "${info.name}" is too large to render on the globe and stays 2D-only.`,
        );
        continue;
      }
      void control
        .getLayerGeoJSON(info.id)
        .then((data) => {
          if (removed || pending.get(info.id) !== source || sources.get(info.sourceId) !== source)
            return;
          if (data) collections.set(info.id, data);
          syncVectorLayersToStore(control);
        })
        .catch((error: unknown) => {
          console.error("[GeoLibre] Failed to prepare vector geometry for Cesium", error);
          if (pending.get(info.id) === source) pending.delete(info.id);
        });
    }
  };
  for (const event of ["layeradded", "layerremoved", "layerupdated"] as const) {
    control.on(event, syncGeometry);
  }
  const originalOnRemove = control.onRemove.bind(control);
  control.onRemove = () => {
    removed = true;
    try {
      originalOnRemove();
    } finally {
      sources.clear();
      layers.clear();
      images.clear();
      collections.clear();
      pending.clear();
    }
  };
}
