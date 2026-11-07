import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature, FeatureCollection, LineString } from "geojson";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { createLayerSync } from "../packages/map/src/headless";

// MapLibre reads a property that was reset to its default back as `undefined`,
// not as the `null` that set it. This stub mirrors that, so a solid line whose
// `line-dasharray` is already unset must not be reset again on every sync.
function makeMapStub() {
  const layers: { id: string; source?: string }[] = [];
  const sources = new Map<string, Record<string, unknown>>();
  const paint = new Map<string, Record<string, unknown>>();
  const dashCalls: { id: string; value: unknown }[] = [];
  const map = {
    getStyle: () => ({ layers: [...layers], sources: Object.fromEntries(sources) }),
    getLayersOrder: () => layers.map(({ id }) => id),
    getLayer: (id: string) => layers.find((layer) => layer.id === id),
    getSource: (id: string) => {
      const spec = sources.get(id);
      return spec ? { ...spec, setData: () => {} } : undefined;
    },
    addSource: (id: string, spec: Record<string, unknown>) => {
      sources.set(id, spec);
    },
    addLayer: (spec: { id: string; source?: string }, beforeId?: string) => {
      const index = beforeId ? layers.findIndex((layer) => layer.id === beforeId) : -1;
      if (index >= 0) layers.splice(index, 0, spec);
      else layers.push(spec);
      paint.set(spec.id, {});
    },
    removeLayer: (id: string) => {
      const index = layers.findIndex((layer) => layer.id === id);
      if (index >= 0) layers.splice(index, 1);
    },
    removeSource: (id: string) => {
      sources.delete(id);
    },
    moveLayer: () => {},
    getFilter: (id: string) => layers.find((layer) => layer.id === id)?.filter,
    setFilter: () => {},
    getPaintProperty: (id: string, key: string) => paint.get(id)?.[key],
    setPaintProperty: (id: string, key: string, value: unknown) => {
      if (key === "line-dasharray") dashCalls.push({ id, value });
      const props = paint.get(id);
      if (!props) return;
      if (value === null) delete props[key];
      else props[key] = value;
    },
    setLayoutProperty: () => {},
    getLayoutProperty: () => undefined,
    setLayerZoomRange: () => {},
  };
  return { map, dashCalls };
}

function lineLayer(id: string, strokeDash: number[]): GeoLibreLayer {
  const line: Feature<LineString> = {
    type: "Feature",
    properties: {},
    geometry: {
      type: "LineString",
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    },
  };
  const geojson: FeatureCollection = { type: "FeatureCollection", features: [line] };
  return {
    id,
    name: id,
    type: "geojson",
    source: { type: "geojson", data: geojson },
    geojson,
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE, strokeDash },
    metadata: {},
  } as GeoLibreLayer;
}

describe("layer sync dash reset", () => {
  it("does not reset a solid line's dash again on every sync", () => {
    const { map, dashCalls } = makeMapStub();
    const sync = createLayerSync(map as never);

    sync.sync([lineLayer("roads", [])]);
    dashCalls.length = 0;

    sync.sync([lineLayer("roads", [])]);
    sync.sync([lineLayer("roads", [])]);
    assert.deepEqual(dashCalls, []);
  });
});
