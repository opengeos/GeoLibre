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
    // A hand-edited project with non-numeric cluster settings gets the defaults.
    const guarded = planPointRendering(
      pointLayer(10, {
        style: { pointRenderer: "cluster", clusterRadius: NaN, clusterMaxZoom: "x" as never },
      }),
    );
    assert.equal(guarded.clusterRadius, DEFAULT_LAYER_STYLE.clusterRadius);
    assert.equal(guarded.clusterMaxZoom, DEFAULT_LAYER_STYLE.clusterMaxZoom);
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
    constructor(public options?: { scene?: unknown }) {}
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
  class LabelCollection {
    labels: Array<Record<string, unknown>> = [];
    constructor(public options?: { scene?: unknown }) {}
    add(options: Record<string, unknown>) {
      const label = { ...options };
      this.labels.push(label);
      return label;
    }
  }
  class Primitive {
    constructor(public options: Record<string, unknown>) {}
  }
  class GeometryInstance {
    constructor(public options: Record<string, unknown>) {}
  }
  class PolylineGeometry {
    constructor(public options: Record<string, unknown>) {}
  }
  class PolylineColorAppearance {
    static VERTEX_FORMAT = "polyline-color";
    constructor(public options: Record<string, unknown>) {}
  }
  class Cartesian3 {
    constructor(
      public x: number,
      public y: number,
      public z: number,
    ) {}
    static fromDegrees(lng: number, lat: number, z: number) {
      return { lng, lat, z };
    }
  }
  class Cartesian2 {
    constructor(
      public x: number,
      public y: number,
    ) {}
  }
  const color = (css: string, alpha = 1) => ({
    css,
    alpha,
    withAlpha: (nextAlpha: number) => ({ css, alpha: nextAlpha }),
  });
  return {
    PointPrimitiveCollection,
    LabelCollection,
    Primitive,
    GeometryInstance,
    PolylineGeometry,
    PolylineColorAppearance,
    ColorGeometryInstanceAttribute: {
      fromColor: (value: unknown) => ({ value }),
    },
    Cartesian3,
    Cartesian2,
    Color: {
      fromCssColorString: (css: string) => color(css),
      clone: (value: { css: string; alpha: number }) => color(value.css, value.alpha),
      WHITE: color("WHITE"),
      BLACK: color("BLACK"),
    },
    Material: { fromType: (type: string, uniforms: unknown) => ({ type, uniforms }) },
    LabelStyle: { FILL: 0, FILL_AND_OUTLINE: 2 },
    HorizontalOrigin: { CENTER: 0, RIGHT: 1, LEFT: -1 },
    VerticalOrigin: { CENTER: 0 },
    HeightReference: { NONE: 0, CLAMP_TO_GROUND: 1, RELATIVE_TO_GROUND: 2 },
    ColorMaterialProperty: class {
      constructor(public color: unknown) {}
    },
    ConstantProperty: class {
      constructor(public value: unknown) {}
    },
    Rectangle: { fromDegrees: () => ({}) },
    JulianDate: {
      fromDate: (d: Date) => d,
      toDate: () => new Date("2026-09-20T00:00:00.000Z"),
    },
    SceneTransforms: {
      worldToWindowCoordinates: (_scene: unknown, position: { x: number; y: number }) => ({
        x: position.x,
        y: position.y,
      }),
    },
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
    const scene = { fake: "scene" };
    const collection = buildPointBatch(
      Cesium as never,
      layer,
      createFeatureStyleResolver(layer.style),
      0.5,
      0,
      { scene: scene as never, clampToGround: true },
    ) as unknown as InstanceType<typeof Cesium.PointPrimitiveCollection>;
    assert.equal(collection.options?.scene, scene, "the collection knows its scene");
    assert.equal(collection.length, 5, "a MultiPoint contributes one primitive per point");
    const first = collection.get(0) as {
      pixelSize: number;
      color: { css: string; alpha: number };
      heightReference: number;
      id: { geolibreLayerId: string; index: number; primitive?: unknown };
    };
    assert.equal(first.pixelSize, 10);
    assert.ok(Math.abs(first.color.alpha - 0.25) < 1e-9, "fill opacity × layer opacity");
    assert.equal(first.heightReference, 1, "clamped to ground like the entity path");
    assert.ok(isBatchedPointRef(first.id));
    assert.equal(first.id.geolibreLayerId, "pts");
    assert.equal(first.id.index, 0);
    assert.equal(first.id.primitive, first, "the reference points back at its primitive");
    const fifth = collection.get(4) as { id: { index: number } };
    assert.equal(fifth.id.index, 3);
    // Without a scene or clamping (3D-elevated layers) heights stay as given.
    const raised = buildPointBatch(
      Cesium as never,
      layer,
      createFeatureStyleResolver(layer.style),
      0.5,
      0,
    ) as unknown as InstanceType<typeof Cesium.PointPrimitiveCollection>;
    assert.equal(raised.options, undefined);
    assert.equal((raised.get(0) as { heightReference: number }).heightReference, 0);
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
        strokeOpacity: 0.5,
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
    assert.deepEqual(
      cluster.point.outlineColor,
      { css: "#000000", alpha: 0.5 },
      "the outline takes the stroke opacity, as the 2D bubble's circle-stroke-opacity",
    );
    assert.equal(cluster.label.text, "5");
    opacity = 0.5;
    handle.refresh();
    assert.deepEqual(writes, [true, false, true], "refresh flips enabled to dirty the clusterer");
    listeners[0](Array.from({ length: 250 }), cluster);
    assert.equal(cluster.point.pixelSize, 60);
    assert.deepEqual(cluster.point.color, { css: "#00ff00", alpha: 0.3 });
    assert.deepEqual(cluster.point.outlineColor, { css: "#000000", alpha: 0.25 });
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
  const preRenderListeners = new Set<() => void>();
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
      canvas: {
        clientWidth: 800,
        clientHeight: 600,
        width: 800,
        height: 600,
        getBoundingClientRect: () => ({ left: 0 }),
      },
      mode: 3,
      primitives: {
        add: (p: unknown) => primitives.push(p),
        remove: (p: unknown) => primitives.splice(primitives.indexOf(p), 1),
      },
      preRender: {
        addEventListener: (listener: () => void) => preRenderListeners.add(listener),
        removeEventListener: (listener: () => void) => preRenderListeners.delete(listener),
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
  return {
    viewer,
    Cesium,
    primitives,
    dataSources,
    flush,
    cameraListeners,
    preRenderListeners,
  };
}

describe("CesiumLayerSync point rendering", () => {
  it("connects a plugin-owned moving point batch to table identify and selection", async () => {
    const f = makeViewer();
    const sync = new CesiumLayerSync(f.Cesium as never, f.viewer as never, () => 10);
    const layer = pointLayer(2);
    const [feature, secondFeature] = layer.geojson?.features ?? [];
    assert.ok(feature && secondFeature);
    feature.id = "moving-1";
    feature.properties = { name: "STARLINK TEST", catalogNumber: "44713" };
    secondFeature.id = "moving-2";
    secondFeature.properties = { name: "STARLINK TEST 2", catalogNumber: "44714" };
    sync.sync([layer]);
    await f.flush();

    const collection = new f.Cesium.PointPrimitiveCollection();
    const ref: { geolibreLayerId: string; index: number; primitive?: unknown } = {
      geolibreLayerId: layer.id,
      index: 0,
    };
    const position = { x: 1, y: 2, z: 3 };
    const originalColor = { css: "#54697f", alpha: 0.9 };
    const primitive = collection.add({ position, color: originalColor, id: ref });
    // Cesium's real PointPrimitive setter clones into its existing internal
    // Color object. Holding the getter result as the "original" therefore
    // aliases the value the yellow assignment mutates.
    const storedColor = { ...originalColor };
    Object.defineProperty(primitive, "color", {
      get: () => storedColor,
      set: (value: { css: string; alpha?: number }) => Object.assign(storedColor, value),
      configurable: true,
    });
    ref.primitive = primitive;
    const secondRef: { geolibreLayerId: string; index: number; primitive?: unknown } = {
      geolibreLayerId: layer.id,
      index: 1,
    };
    const secondPrimitive = collection.add({
      position: { x: 4, y: 5, z: 6 },
      color: { ...originalColor },
      id: secondRef,
    });
    secondRef.primitive = secondPrimitive;
    const unregister = sync.registerMovingPointLayer(layer.id, collection as never, [
      {
        name: "STARLINK TEST",
        tleLine1:
          "1 44713U 19074A   26262.50000000  .00001200  00000+0  90000-4 0  9991",
        tleLine2:
          "2 44713  53.0500 210.0000 0001500  85.0000 275.0000 15.06000000300000",
        orbitalPeriodMinutes: 95.62,
      },
      {
        name: "STARLINK TEST 2",
        tleLine1:
          "1 44714U 19074B   26262.50000000  .00001200  00000+0  90000-4 0  9992",
        tleLine2:
          "2 44714  53.0500 211.0000 0001500  85.0000 275.0000 15.06000000300001",
        orbitalPeriodMinutes: 95.62,
      },
    ]);

    assert.deepEqual(sync.resolveFeature(ref), {
      layerId: "pts",
      featureId: "moving-1",
      properties: { name: "STARLINK TEST", catalogNumber: "44713" },
      geometry: feature.geometry,
    });
    assert.deepEqual(sync.featurePositions(layer.id, ["moving-1"]), [position]);
    sync.highlight(layer.id, ["moving-1"]);
    assert.equal((primitive.color as { css: string }).css, "#facc15");
    sync.highlight(layer.id, ["moving-2"]);
    assert.deepEqual(
      {
        css: (primitive.color as { css: string }).css,
        alpha: (primitive.color as { alpha: number }).alpha,
      },
      originalColor,
      "selecting another point restores the first point's real pre-highlight color",
    );
    assert.equal(f.primitives.length, 2, "the selected moving satellite receives an orbit and label");
    const orbit = f.primitives.find((candidate) => candidate instanceof f.Cesium.Primitive) as {
      options: {
        geometryInstances: {
          options: {
            geometry: {
              options: { positions: Array<{ x: number; y: number; z: number }> };
            };
          };
        };
        depthFailAppearance?: unknown;
      };
    };
    const positions = orbit.options.geometryInstances.options.geometry.options.positions;
    assert.equal(positions.length, 181);
    assert.deepEqual(positions.at(-1), positions[0]);
    assert.ok(orbit.options.depthFailAppearance);
    const labels = f.primitives.find(
      (candidate) => candidate instanceof f.Cesium.LabelCollection,
    ) as { labels: Array<Record<string, unknown>> };
    assert.ok(labels, "dense selection adds a label collection");
    assert.equal(labels.labels.length, 1);
    assert.equal(labels.labels[0].text, "STARLINK TEST 2");
    assert.equal(labels.labels[0].horizontalOrigin, f.Cesium.HorizontalOrigin.RIGHT);
    assert.deepEqual(
      {
        x: (labels.labels[0].pixelOffset as { x: number; y: number }).x,
        y: (labels.labels[0].pixelOffset as { x: number; y: number }).y,
      },
      { x: -16, y: -19 },
    );
    assert.deepEqual(labels.labels[0].position, secondPrimitive.position);
    secondPrimitive.position = { x: 7, y: 8, z: 9 };
    for (const listener of f.preRenderListeners) listener();
    assert.deepEqual(
      labels.labels[0].position,
      secondPrimitive.position,
      "the selected label follows the moving satellite",
    );
    secondPrimitive.position = { x: 700, y: 8, z: 9 };
    for (const listener of f.preRenderListeners) listener();
    assert.equal(labels.labels[0].horizontalOrigin, f.Cesium.HorizontalOrigin.LEFT);
    assert.deepEqual(
      {
        x: (labels.labels[0].pixelOffset as { x: number; y: number }).x,
        y: (labels.labels[0].pixelOffset as { x: number; y: number }).y,
      },
      { x: 16, y: -19 },
    );
    sync.highlight(undefined, []);
    assert.equal(f.primitives.length, 0, "clearing selection removes the selected orbit");
    assert.equal(f.preRenderListeners.size, 0, "clearing selection removes the label updater");

    unregister();
    assert.equal(sync.resolveFeature(ref), null);
  });

  it("renders a large point layer as one primitive batch that picks and filters", async () => {
    const f = makeViewer();
    const sync = new CesiumLayerSync(f.Cesium as never, f.viewer as never, () => 10);
    const layer = pointLayer(MAX_ENTITY_POINT_FEATURES + 5, { opacity: 0.8 });
    sync.sync([layer]);
    await f.flush();
    assert.equal(f.primitives.length, 1, "one PointPrimitiveCollection in the scene");
    const collection = f.primitives[0] as {
      options?: { scene?: unknown };
      length: number;
      get(i: number): {
        id: unknown;
        show: boolean;
        color: { alpha: number };
        heightReference: number;
      };
    };
    assert.equal(collection.options?.scene, f.viewer.scene, "built against the viewer's scene");
    assert.equal(collection.get(0).heightReference, 1, "flat points clamp to the ground");
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
    assert.ok(sync.resolveFeature(collection.get(2).id as object), "a shown primitive picks");
    assert.equal(
      sync.resolveFeature(collection.get(3).id as object),
      null,
      "a primitive the filter hid is not pickable, like a hidden entity",
    );
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

  it("re-clusters when an in-place restyle changes the bubbles' appearance", async () => {
    const f = makeViewer();
    const sync = new CesiumLayerSync(f.Cesium as never, f.viewer as never, () => 5);
    const layer = pointLayer(20, { style: { pointRenderer: "cluster" } });
    sync.sync([layer]);
    await f.flush();
    await f.flush();
    const clustering = f.dataSources[0].clustering;
    let enabled = clustering.enabled;
    const writes: boolean[] = [];
    Object.defineProperty(clustering, "enabled", {
      get: () => enabled,
      set: (value: boolean) => {
        writes.push(value);
        enabled = value;
      },
    });
    // An unrelated sync leaves the clusterer alone.
    sync.sync([layer]);
    assert.deepEqual(writes, []);
    // An opacity edit restyles in place, and the bubbles must follow without
    // a camera move: the clusterer is dirtied by an off/on flip.
    sync.sync([{ ...layer, opacity: 0.5 }]);
    assert.deepEqual(writes, [false, true]);
    assert.equal(enabled, true);
  });
});
