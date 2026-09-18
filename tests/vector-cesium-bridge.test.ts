import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { parseHTML } from "linkedom";
import { VectorControl, type VectorLayerInfo } from "maplibre-gl-vector";
import { DUCKDB_VECTOR_FEATURE_WARN_COUNT, useAppStore } from "@geolibre/core";
import {
  bridgeVectorControlToStore,
  exceedsCesiumVectorLimit,
} from "../packages/plugins/src/plugins/vector-cesium-bridge";
import {
  syncVectorLayersToStore,
  unwireVectorStoreSync,
} from "../packages/plugins/src/plugins/vector-layer-sync";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { FeatureCollection } from "geojson";

const original = Object.getOwnPropertyDescriptors(globalThis);
afterEach(() => {
  unwireVectorStoreSync();
  for (const key of ["window", "document", "HTMLElement", "requestAnimationFrame"]) {
    if (original[key]) Object.defineProperty(globalThis, key, original[key]);
    else Reflect.deleteProperty(globalThis, key);
  }
  useAppStore.setState({ layers: [] });
});

it("imports polygon geometry through the real vector control without MapLibre source calls", async () => {
  const { window, document } = parseHTML("<html><body><div id='map'></div></body></html>");
  Object.assign(globalThis, {
    window,
    document,
    HTMLElement: window.HTMLElement,
    requestAnimationFrame: () => 0,
  });
  const container = document.getElementById("map")!;
  const unsupported = () => {
    throw new Error("CesiumControlHost: addSource is not supported on the globe.");
  };
  const host = {
    getContainer: () => container,
    getCanvas: () => container,
    on() {},
    off() {},
    addSource: unsupported,
    addLayer: unsupported,
  } as unknown as MapLibreMap;
  const fitted: unknown[] = [];
  const control = new VectorControl({ enablePicker: false });
  bridgeVectorControlToStore(control, {
    fitBounds: (bounds) => fitted.push(bounds),
  } as GeoLibreAppAPI);
  for (const event of ["layeradded", "layerupdated", "layerremoved"] as const) {
    control.on(event, () => syncVectorLayersToStore(control));
  }
  container.appendChild(control.onAdd(host));
  const data: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "polygon" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        },
      },
    ],
  };
  const info = await control.addData(data, { name: "polygon" });
  assert.deepEqual(useAppStore.getState().layers[0].geojson, data);
  assert.deepEqual(await control.getLayerGeoJSON(info.id), data);
  assert.deepEqual(fitted, [[0, 0, 1, 1]]);
  control.setLayerOpacity(info.id, 0.4);
  control.setLayerVisibility(info.id, false);
  assert.equal(useAppStore.getState().layers[0].opacity, 0.4);
  assert.equal(useAppStore.getState().layers[0].visible, false);
  control.setLayerStyle(info.id, { fillColor: "#ff0000" });
  assert.equal(useAppStore.getState().layers[0].style.fillColor, "#ff0000");
  control.removeLayer(info.id);
  assert.equal(useAppStore.getState().layers.length, 0);
  control.onRemove();
});

const polygon: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
    },
  ],
};

function tiledInfo(id: string, extra: Partial<VectorLayerInfo> = {}): VectorLayerInfo {
  return {
    id,
    name: id,
    source: { kind: "file", fileName: `${id}.gpkg` },
    format: "geopackage",
    renderMode: "tiles",
    geometryType: "polygon",
    visible: true,
    opacity: 1,
    picker: false,
    ingestMode: "table",
    style: {},
    sourceId: `${id}-source`,
    layerIds: [`${id}-fill`],
    ...extra,
  } as VectorLayerInfo;
}

it("bounds the tiled export by the DuckDB routing limits and streams", () => {
  assert.equal(exceedsCesiumVectorLimit({ ingestMode: "table", featureCount: 10 }), false);
  assert.equal(exceedsCesiumVectorLimit({ ingestMode: "table" }), false);
  assert.equal(exceedsCesiumVectorLimit({ ingestMode: "stream", featureCount: 10 }), true);
  assert.equal(
    exceedsCesiumVectorLimit({
      ingestMode: "table",
      featureCount: DUCKDB_VECTOR_FEATURE_WARN_COUNT + 1,
    }),
    true,
  );
  assert.equal(
    exceedsCesiumVectorLimit({ ingestMode: "table", byteSize: 101 * 1024 * 1024 }),
    true,
  );
});

it("materializes small tiled layers as GeoJSON records and leaves oversize ones 2D-only", async () => {
  const handlers = new Map<string, Array<() => void>>();
  const exported: string[] = [];
  let infos: VectorLayerInfo[] = [];
  let bridged: MapLibreMap | undefined;
  const control = {
    onAdd(map: MapLibreMap) {
      bridged = map;
      for (const id of ["small", "big"]) {
        map.addSource(`${id}-source`, { type: "vector", tiles: [`duckdb://${id}/{z}/{x}/{y}`] });
      }
      return {} as HTMLElement;
    },
    onRemove() {},
    on(event: string, handler: () => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    getLayers: () => infos,
    async getLayerGeoJSON(id: string) {
      exported.push(id);
      return polygon;
    },
    removeLayer() {},
    setLayerOpacity() {},
    setLayerVisibility() {},
    setLayerStyle() {},
  };
  const warnings: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args[0]);
  try {
    bridgeVectorControlToStore(control as unknown as VectorControl, {} as GeoLibreAppAPI);
    control.on("layeradded", () => syncVectorLayersToStore(control));
    control.onAdd({} as MapLibreMap);
    infos = [
      tiledInfo("small", { featureCount: 1 }),
      tiledInfo("big", { featureCount: DUCKDB_VECTOR_FEATURE_WARN_COUNT + 1 }),
    ];
    const emit = () => handlers.get("layeradded")?.forEach((handler) => handler());
    emit();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(exported, ["small"]);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]), /"big" is too large/);
    const [small, big] = useAppStore.getState().layers;
    assert.equal(small.type, "geojson");
    assert.equal(small.source.type, "geojson");
    assert.equal(small.geojson, polygon);
    assert.equal((small.metadata.vectorState as { renderMode?: string }).renderMode, "tiles");
    assert.equal(big.type, "vector-tiles");
    assert.equal(big.geojson, undefined);
    // One export per source revision: a repeat event neither re-reads nor re-warns.
    emit();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(exported, ["small"]);
    assert.equal(warnings.length, 1);
    // A reload that comes back oversize is a new source revision: the cached
    // collection must go with the old one rather than keep drawing stale data.
    bridged!.addSource("small-source", { type: "vector", tiles: ["duckdb://small2/{z}/{x}/{y}"] });
    infos = [tiledInfo("small", { ingestMode: "stream", featureCount: 1 }), infos[1]];
    emit();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(exported, ["small"]);
    assert.equal(warnings.length, 2);
    const reloaded = useAppStore.getState().layers[0];
    assert.equal(reloaded.type, "vector-tiles");
    assert.equal(reloaded.geojson, undefined);
  } finally {
    console.warn = originalWarn;
  }
});
