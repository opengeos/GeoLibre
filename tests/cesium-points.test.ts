import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "../packages/core/src/types";
import { createFeatureStyleResolver } from "../packages/map/src/cesium-feature-style";
import { CesiumLayerSync } from "../packages/map/src/cesium-layer-sync";
import {
  MAX_ENTITY_POINT_FEATURES,
  abbreviateCount,
  buildPointBatch,
  clusterActiveAtZoom,
  clusterPixelSize,
  configureClustering,
  isBatchedPointRef,
  planPointRendering,
} from "../packages/map/src/cesium-points";

// Clustering and batched point primitives on the globe (issue #2282). The
// clusterer and the primitive collection are faked at the Cesium boundary;
// the plan, the count formatting, the bubble sizing, and the layer-sync
// routing are exercised for real.

function point(lng: number, lat: number, properties: Record<string, unknown> = {}) {
  return {
    type: "Feature" as const,
    properties,
    geometry: { type: "Point" as const, coordinates: [lng, lat] },
  };
}

function pointLayer(count: number, patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  const features = Array.from({ length: count }, (_, i) =>
    point((i % 360) - 180, (i % 170) - 85, { n: i }),
  );
  return {
    id: "pts",
    name: "Points",
    type: "geojson",
    source: {},
    visible: true,
    opacity: 1,
    style: {},
    metadata: {},
    geojson: { type: "FeatureCollection", features } as never,
    ...patch,
  };
}

describe("point rendering plan", () => {
  it("abbreviates counts like geojson-vt", () => {
    assert.equal(abbreviateCount(7), "7");
    assert.equal(abbreviateCount(1500), "1.5k");
    assert.equal(abbreviateCount(12_345), "12k");
  });

  it("sizes cluster bubbles by the 2D map's radius steps", () => {
    assert.equal(clusterPixelSize(2), 32);
    assert.equal(clusterPixelSize(50), 44);
    assert.equal(clusterPixelSize(500), 60);
  });

  it("clusters point-only layers that ask for it and stops past clusterMaxZoom", () => {
    const plan = planPointRendering(
      pointLayer(10, {
        style: { pointRenderer: "cluster", clusterRadius: 60, clusterMaxZoom: 12 },
      }),
    );
    assert.equal(plan.cluster, true);
    assert.equal(plan.batched, false);
    assert.equal(plan.clusterRadius, 60);
    assert.equal(clusterActiveAtZoom(plan, 8), true);
    assert.equal(clusterActiveAtZoom(plan, 12), false);
  });

  it("does not cluster or batch a mixed-geometry layer", () => {
    const layer = pointLayer(3, { style: { pointRenderer: "cluster" } });
    (layer.geojson as { features: unknown[] }).features.push({
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
    });
    const plan = planPointRendering(layer);
    assert.equal(plan.pointsOnly, false);
    assert.equal(plan.cluster, false);
    assert.equal(plan.batched, false);
  });

  it("batches large point-only layers unless markers or 3D elevation apply", () => {
    const big = pointLayer(MAX_ENTITY_POINT_FEATURES + 1);
    assert.equal(planPointRendering(big).batched, true);
    assert.equal(planPointRendering(pointLayer(MAX_ENTITY_POINT_FEATURES)).batched, false);
    assert.equal(planPointRendering({ ...big, style: { markerEnabled: true } }).batched, false);
    assert.equal(
      planPointRendering({ ...big, style: { pointRenderer: "cluster" } }).batched,
      false,
    );
  });
});

/** A fake namespace with the Cesium classes the point code constructs. */
function makeCesium() {
  class PointPrimitiveCollection {
    show = true;
    points: Array<Record<string, unknown>> = [];
    get length() {
      return this.points.length;
    }
    add(options: Record<string, unknown>) {
      const primitive = { show: true, ...options };
      this.points.push(primitive);
      return primitive;
    }
    get(index: number) {
      return this.points[index];
    }
  }
  return {
    PointPrimitiveCollection,
    Cartesian3: { fromDegrees: (lng: number, lat: number, z: number) => ({ lng, lat, z }) },
    Color: {
      fromCssColorString: (css: string) => ({
        css,
        alpha: 1,
        withAlpha: (alpha: number) => ({ css, alpha }),
      }),
      WHITE: { withAlpha: (alpha: number) => ({ css: "WHITE", alpha }) },
    },
    LabelStyle: { FILL: 0 },
    HorizontalOrigin: { CENTER: 0 },
    VerticalOrigin: { CENTER: 0 },
    HeightReference: { NONE: 0, CLAMP_TO_GROUND: 1, RELATIVE_TO_GROUND: 2 },
    ColorMaterialProperty: class {
      constructor(public color: unknown) {}
    },
    ConstantProperty: class {
      constructor(public value: unknown) {}
    },
    Rectangle: { fromDegrees: () => ({}) },
    JulianDate: { fromDate: (d: Date) => d },
  };
}

describe("buildPointBatch", () => {
  it("creates one tagged primitive per point with the resolved symbol", () => {
    const Cesium = makeCesium();
    const layer = pointLayer(3, {
      style: { circleRadius: 5, fillColor: "#ff0000", fillOpacity: 0.5 },
    });
    (layer.geojson as { features: unknown[] }).features.push({
      type: "Feature",
      properties: {},
      geometry: {
        type: "MultiPoint",
        coordinates: [
          [1, 1],
          [2, 2],
        ],
      },
    });
    const collection = buildPointBatch(
      Cesium as never,
      layer,
      createFeatureStyleResolver(layer.style),
      0.5,
      0,
    ) as unknown as InstanceType<typeof Cesium.PointPrimitiveCollection>;
    assert.equal(collection.length, 5, "a MultiPoint contributes one primitive per point");
    const first = collection.get(0) as {
      pixelSize: number;
      color: { css: string; alpha: number };
      id: unknown;
    };
    assert.equal(first.pixelSize, 10);
    assert.ok(Math.abs(first.color.alpha - 0.25) < 1e-9, "fill opacity × layer opacity");
    assert.ok(isBatchedPointRef(first.id));
    assert.deepEqual(first.id, { geolibreLayerId: "pts", index: 0 });
    assert.deepEqual((collection.get(4) as { id: unknown }).id, {
      geolibreLayerId: "pts",
      index: 3,
    });
  });
});

describe("configureClustering", () => {
  it("styles each cluster like the 2D bubble and re-clusters on refresh", () => {
    const Cesium = makeCesium();
    const listeners: Array<(entities: unknown[], cluster: unknown) => void> = [];
    const clustering = {
      enabled: false,
      pixelRange: 80,
      minimumClusterSize: 2,
      clusterPoints: false,
      clusterBillboards: false,
      clusterLabels: false,
      clusterEvent: {
        addEventListener: (fn: (entities: unknown[], cluster: unknown) => void) => {
          listeners.push(fn);
          return () => listeners.splice(listeners.indexOf(fn), 1);
        },
      },
    };
    const writes: boolean[] = [];
    Object.defineProperty(clustering, "enabled", {
      get: () => writes[writes.length - 1] ?? false,
      set: (v: boolean) => writes.push(v),
    });
    const layer = pointLayer(4, {
      style: { pointRenderer: "cluster", clusterRadius: 45, fillColor: "#00ff00", strokeWidth: 2 },
    });
    let opacity = 1;
    const handle = configureClustering(
      Cesium as never,
      { clustering } as never,
      planPointRendering(layer),
      () => ({
        fill: "#00ff00",
        fillOpacity: 0.6,
        stroke: "#000000",
        strokeWidth: 2,
        textColor: "#111111",
        opacity,
      }),
    );
    assert.equal(clustering.pixelRange, 45);
    assert.equal(clustering.clusterPoints, true);
    assert.deepEqual(writes, [true]);
    const cluster = {
      billboard: { show: true },
      point: {} as Record<string, unknown>,
      label: {} as Record<string, unknown>,
    };
    listeners[0]([1, 2, 3, 4, 5], cluster);
    assert.equal(cluster.billboard.show, false);
    assert.equal(cluster.point.show, true);
    assert.equal(cluster.point.pixelSize, 32);
    assert.deepEqual(cluster.point.color, { css: "#00ff00", alpha: 0.6 });
    assert.equal(cluster.label.text, "5");
    opacity = 0.5;
    handle.refresh();
    assert.deepEqual(writes, [true, false, true], "refresh flips enabled to dirty the clusterer");
    listeners[0](Array.from({ length: 250 }), cluster);
    assert.equal(cluster.point.pixelSize, 60);
    assert.deepEqual(cluster.point.color, { css: "#00ff00", alpha: 0.3 });
    handle.setEnabled(false);
    assert.equal(writes[writes.length - 1], false);
    handle.dispose();
    assert.equal(listeners.length, 0);
  });
});

/** A viewer whose data sources cluster and whose primitives collect. */
function makeViewer() {
  const primitives: unknown[] = [];
  const cameraListeners = new Set<() => void>();
  const dataSources: Array<{ clustering: Record<string, unknown> & { enabled: boolean } }> = [];
  const viewer = {
    clock: { currentTime: { dayNumber: 0, secondsOfDay: 0 } },
    camera: {
      moveEnd: {
        addEventListener: (l: () => void) => cameraListeners.add(l),
        removeEventListener: (l: () => void) => cameraListeners.delete(l),
      },
      changed: {
        addEventListener: (l: () => void) => cameraListeners.add(l),
        removeEventListener: (l: () => void) => cameraListeners.delete(l),
      },
    },
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600, width: 800, height: 600 },
      mode: 3,
      primitives: {
        add: (p: unknown) => primitives.push(p),
        remove: (p: unknown) => primitives.splice(primitives.indexOf(p), 1),
      },
      requestRender: () => {},
    },
    imageryLayers: { addImageryProvider: () => ({}), remove: () => {}, raiseToTop: () => {} },
    dataSources: { add: async (ds: unknown) => ds, remove: () => {} },
  };
  const Cesium = {
    ...makeCesium(),
    GeoJsonDataSource: {
      load: (data: { features: Array<{ properties?: Record<string, unknown> }> }) => {
        const values = data.features.map((f, index) => ({
          properties: {
            ...f.properties,
            __geolibre_cesium_feature_index: { getValue: () => index },
          },
          show: true,
          billboard: { color: undefined },
        }));
        const ds = {
          entities: { values, contains: (e: unknown) => values.includes(e as never) },
          show: true,
          isLoading: false,
          clustering: {
            enabled: false,
            pixelRange: 80,
            minimumClusterSize: 2,
            clusterPoints: false,
            clusterBillboards: false,
            clusterLabels: false,
            clusterEvent: { addEventListener: () => () => {} },
          },
        };
        dataSources.push(ds);
        return Promise.resolve(ds);
      },
    },
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { viewer, Cesium, primitives, dataSources, flush, cameraListeners };
}

describe("CesiumLayerSync point rendering", () => {
  it("renders a large point layer as one primitive batch that picks and filters", async () => {
    const f = makeViewer();
    const sync = new CesiumLayerSync(f.Cesium as never, f.viewer as never, () => 10);
    const layer = pointLayer(MAX_ENTITY_POINT_FEATURES + 5, { opacity: 0.8 });
    sync.sync([layer]);
    await f.flush();
    assert.equal(f.primitives.length, 1, "one PointPrimitiveCollection in the scene");
    const collection = f.primitives[0] as {
      length: number;
      get(i: number): { id: unknown; show: boolean; color: { alpha: number } };
    };
    assert.equal(collection.length, MAX_ENTITY_POINT_FEATURES + 5);
    assert.deepEqual(sync.getRenderStatus(), { pending: [], errors: [] });
    // Picking resolves the primitive's id back to its feature.
    const picked = sync.resolveFeature(collection.get(7).id as object);
    assert.equal(picked?.layerId, "pts");
    assert.deepEqual(picked?.properties, { n: 7 });
    // A quick filter hides the primitives it excludes.
    sync.sync([
      {
        ...layer,
        quickFilters: [{ id: "q", field: "n", kind: "range", min: null, max: 2 }],
      } as never,
    ]);
    assert.equal(collection.get(2).show, true);
    assert.equal(collection.get(3).show, false);
    // Opacity restyles in place.
    sync.sync([{ ...layer, opacity: 0.2 }]);
    assert.ok(
      Math.abs(collection.get(0).color.alpha - 0.2 * DEFAULT_LAYER_STYLE.fillOpacity) < 1e-9,
    );
    assert.equal(f.primitives.length, 1);
    // Removal takes the batch out of the scene.
    sync.sync([]);
    assert.equal(f.primitives.length, 0);
  });

  it("clusters a point layer that asks for it and follows clusterMaxZoom", async () => {
    const f = makeViewer();
    let zoom = 5;
    const sync = new CesiumLayerSync(f.Cesium as never, f.viewer as never, () => zoom);
    sync.sync([
      pointLayer(20, { style: { pointRenderer: "cluster", clusterRadius: 50, clusterMaxZoom: 9 } }),
    ]);
    await f.flush();
    await f.flush();
    const clustering = f.dataSources[0].clustering;
    assert.equal(clustering.enabled, true);
    assert.equal(clustering.pixelRange, 50);
    zoom = 12;
    for (const listener of f.cameraListeners) listener();
    assert.equal(clustering.enabled, false, "past clusterMaxZoom the points show individually");
    zoom = 6;
    for (const listener of f.cameraListeners) listener();
    assert.equal(clustering.enabled, true);
    sync.sync([]);
    assert.equal(clustering.enabled, false, "removal switches the clusterer off");
  });
});
