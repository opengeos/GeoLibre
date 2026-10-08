import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CZML_SOURCE_KIND, DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection, LineString, Polygon } from "geojson";
import {
  aggregateBins,
  deckVizGlobeLayer,
  headingQuaternion,
  interpolateGreatCircle,
  isGlobeDeckVizLayer,
} from "../packages/map/src/cesium-deck-viz";
import { isCesiumSupportedLayerType } from "../packages/map/src/cesium-layer-sync";

// Deck.gl Layer builder records (issue #2261) are drawn on the Cesium globe by
// rewriting them into the GeoJSON or CZML records the globe already renders.

function vizLayer(
  layerKind: string,
  fieldMapping: Record<string, string | number>,
  data: { rows?: unknown[]; geojson?: FeatureCollection } = {},
  over: { style?: Record<string, unknown>; scenegraph?: Record<string, unknown> } = {},
): GeoLibreLayer {
  return {
    id: `viz-${layerKind}`,
    name: `Viz ${layerKind}`,
    type: "deckgl-viz",
    source: { type: "deckgl-viz", ...(data.rows ? { data: data.rows } : {}) },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE, fillColor: "#ff0000", circleRadius: 40, strokeWidth: 3 },
    geojson: data.geojson,
    metadata: {
      sourceKind: "deckgl-viz",
      customLayerType: layerKind,
      externalDeckLayer: true,
      identifiable: false,
      vizConfig: {
        layerKind,
        format: "csv-rows",
        fieldMapping,
        style: {
          color: "#3b82f6",
          radius: 40,
          cellSize: 1000,
          lineWidth: 2,
          extruded: true,
          elevationScale: 30,
          ...over.style,
        },
        ...(over.scenegraph ? { scenegraph: over.scenegraph } : {}),
      },
    },
  } as GeoLibreLayer;
}

const OD_MAPPING = { sourceLng: "lon1", sourceLat: "lat1", targetLng: "lon2", targetLat: "lat2" };

describe("deckVizGlobeLayer", () => {
  it("draws scatterplot rows as points and skips rows without a position", () => {
    const layer = vizLayer(
      "scatterplot",
      { lng: 0, lat: 1 },
      {
        rows: [
          [-74, 40.7],
          [-73.9, 40.8],
          [null, 40],
          ["", ""],
        ],
      },
    );
    const derived = deckVizGlobeLayer(layer);
    assert.ok(derived);
    assert.equal(derived.type, "geojson");
    assert.equal(derived.id, layer.id);
    assert.deepEqual(
      derived.geojson?.features.map((f) => (f.geometry as { coordinates: number[] }).coordinates),
      [
        [-74, 40.7],
        [-73.9, 40.8],
      ],
    );
    // The Style panel's fill colour wins over the dialog's, as in 2D.
    assert.equal(derived.style.fillColor, "#ff0000");
    assert.equal(derived.style.circleRadius, 2);
    // The deck overlay markers are dropped, so no 2D path treats it as plugin-owned.
    assert.equal(derived.metadata.externalDeckLayer, undefined);
    assert.equal(derived.metadata.customLayerType, undefined);
    assert.equal(derived.metadata.sourceKind, undefined);
    assert.equal(isCesiumSupportedLayerType(derived), true);
  });

  it("returns the same derived record and data for an unchanged store record", () => {
    const layer = vizLayer("scatterplot", { lng: 0, lat: 1 }, { rows: [[1, 2]] });
    assert.equal(deckVizGlobeLayer(layer), deckVizGlobeLayer(layer));
    // An opacity drag makes a new store record over the same rows: the
    // FeatureCollection must be reused, or the globe reloads every tick.
    const faded = { ...layer, opacity: 0.5 };
    const a = deckVizGlobeLayer(layer);
    const b = deckVizGlobeLayer(faded);
    assert.notEqual(a, b);
    assert.equal(a?.geojson, b?.geojson);
    assert.equal(b?.opacity, 0.5);
  });

  it("labels text rows from the mapped column and hides the anchor dot", () => {
    const layer = vizLayer(
      "text",
      { lng: "longitude", lat: "latitude", text: "name" },
      { rows: [{ longitude: 2.35, latitude: 48.85, name: "Paris" }] },
    );
    const derived = deckVizGlobeLayer(layer);
    assert.ok(derived);
    const props = derived.geojson?.features[0].properties ?? {};
    assert.equal(props["geolibre:label"], "Paris");
    assert.equal(props.name, "Paris");
    assert.equal(derived.style.labels.enabled, true);
    assert.equal(derived.style.labels.field, "geolibre:label");
    assert.equal(derived.style.circleRadius, 0);
  });

  it("draws icon rows as pin markers in the layer colour", () => {
    const layer = vizLayer("icon", { lng: 0, lat: 1 }, { rows: [[10, 20]] });
    const derived = deckVizGlobeLayer(layer);
    assert.equal(derived?.style.markerEnabled, true);
    assert.equal(derived?.style.markerShape, "pin");
    assert.equal(derived?.style.markerColor, "#ff0000");
  });

  it("lifts arcs off the ground and keeps lines and great circles on it", () => {
    const rows = [{ lon1: 0, lat1: 0, lon2: 10, lat2: 0 }];
    const arc = deckVizGlobeLayer(vizLayer("arc", OD_MAPPING, { rows }));
    const coords = (arc?.geojson?.features[0].geometry as LineString).coordinates;
    assert.equal(coords.length, 33);
    assert.deepEqual(coords[0], [0, 0, 0]);
    assert.ok(Math.abs(coords[32][0] - 10) < 1e-9);
    assert.ok(coords[16][2] > 100_000, "the arc peaks well above the ground");
    assert.equal(arc?.style.strokeWidth, 3);

    for (const kind of ["line", "great-circle"]) {
      const flat = deckVizGlobeLayer(vizLayer(kind, OD_MAPPING, { rows }));
      assert.deepEqual((flat?.geojson?.features[0].geometry as LineString).coordinates, [
        [0, 0],
        [10, 0],
      ]);
    }
  });

  it("draws each trip's path as a static 2D line without its timestamps", () => {
    const layer = vizLayer(
      "trips",
      { path: "path", timestamps: "timestamps" },
      {
        rows: [
          { vendor: 1, path: [[0, 0, 5], [1, 1, 6], "bad"], timestamps: [0, 10, 20] },
          { vendor: 2, path: [[0, 0]], timestamps: [0] },
        ],
      },
    );
    const derived = deckVizGlobeLayer(layer);
    assert.equal(derived?.geojson?.features.length, 1);
    const feature = derived?.geojson?.features[0];
    assert.deepEqual((feature?.geometry as LineString).coordinates, [
      [0, 0],
      [1, 1],
    ]);
    assert.deepEqual(feature?.properties, { vendor: 1 });
  });

  it("aggregates hexagon rows into extruded, ramp-coloured bins", () => {
    const rows = [
      { lng: -122.4, lat: 37.78 },
      { lng: -122.4, lat: 37.78 },
      { lng: -122.4, lat: 37.78 },
      { lng: -121.0, lat: 37.0 },
    ];
    const derived = deckVizGlobeLayer(vizLayer("hexagon", { lng: "lng", lat: "lat" }, { rows }));
    assert.ok(derived);
    const features = derived.geojson?.features ?? [];
    assert.equal(features.length, 2);
    const values = features.map((f) => f.properties?.value).sort();
    assert.deepEqual(values, [1, 3]);
    const top = features.find((f) => f.properties?.value === 3);
    assert.equal(top?.properties?.["geolibre:color"], "#bd0026");
    assert.equal(top?.properties?.["geolibre:elevation"], 1000 * 30);
    assert.equal((top?.geometry as Polygon).coordinates[0].length, 7);
    assert.equal(derived.style.extrusionEnabled, true);
    assert.equal(derived.style.vectorStyleMode, "expression");
    assert.equal(derived.style.extrusionHeightExpression, '["get","geolibre:elevation"]');
  });

  it("keeps a flat grid at zero height when extrusion is off", () => {
    const layer = vizLayer(
      "grid",
      { lng: "lng", lat: "lat", weight: "w" },
      { rows: [{ lng: 0, lat: 0, w: 5 }] },
      { style: { extruded: false } },
    );
    const derived = deckVizGlobeLayer(layer);
    const props = derived?.geojson?.features[0].properties;
    assert.equal(props?.value, 5);
    assert.equal(props?.["geolibre:elevation"], 0);
    assert.equal(derived?.style.extrusionEnabled, false);
  });

  it("passes a GeoJSON viz through with its extrusion property", () => {
    const geojson: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { valuePerSqm: 12 },
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
    const derived = deckVizGlobeLayer(
      vizLayer("geojson", { elevation: "valuePerSqm" }, { geojson }),
    );
    assert.equal(derived?.geojson, geojson);
    assert.equal(derived?.style.extrusionEnabled, true);
    assert.equal(derived?.style.extrusionHeightProperty, "valuePerSqm");
  });

  it("places glTF models through a CZML document", () => {
    const layer = vizLayer(
      "scenegraph",
      { lng: "lng", lat: "lat", bearing: "heading", altitude: "alt" },
      { rows: [{ lng: -122.379, lat: 37.6213, heading: 90, alt: 100 }] },
      {
        scenegraph: {
          modelUrl: "https://example.com/plane.glb",
          sizeScale: 3000,
          sizeMinPixels: 0,
          bearing: 0,
          altitude: 5,
        },
      },
    );
    const derived = deckVizGlobeLayer(layer);
    assert.ok(derived);
    assert.equal(derived.metadata.sourceKind, CZML_SOURCE_KIND);
    const packets = derived.source.czmlData as Record<string, unknown>[];
    assert.equal(packets[0].id, "document");
    const model = packets[1].model as Record<string, unknown>;
    assert.equal(model.gltf, "https://example.com/plane.glb");
    assert.equal(model.scale, 3000);
    assert.equal(model.minimumPixelSize, 0);
    assert.deepEqual(
      (packets[1].position as { cartographicDegrees: number[] }).cartographicDegrees,
      [-122.379, 37.6213, 105],
    );
    assert.equal(isCesiumSupportedLayerType(derived), true);
  });

  it("leaves a model layer without a model URL undrawn", () => {
    const layer = vizLayer(
      "scenegraph",
      { lng: "lng", lat: "lat" },
      { rows: [{ lng: 0, lat: 0 }] },
      { scenegraph: { modelUrl: "" } },
    );
    assert.deepEqual(deckVizGlobeLayer(layer)?.source.czmlData, []);
  });

  it("keeps the screen-space and density kinds 2D-only", () => {
    for (const kind of ["heatmap", "screen-grid", "contour"]) {
      const layer = vizLayer(kind, { lng: 0, lat: 1 }, { rows: [[0, 0]] });
      assert.equal(deckVizGlobeLayer(layer), null, kind);
      assert.equal(isGlobeDeckVizLayer(layer), false, kind);
      assert.equal(isCesiumSupportedLayerType(layer), false, kind);
    }
  });

  it("flags drawable viz kinds as globe-capable before conversion", () => {
    const layer = vizLayer("scatterplot", { lng: 0, lat: 1 }, { rows: [[0, 0]] });
    assert.equal(isCesiumSupportedLayerType(layer), true);
    // A record with no viz config (a hand-edited project) stays 2D-only.
    assert.equal(
      isCesiumSupportedLayerType({ ...layer, metadata: { sourceKind: "deckgl-viz" } }),
      false,
    );
  });
});

describe("deck viz globe geometry helpers", () => {
  it("interpolates along the great circle", () => {
    assert.deepEqual(interpolateGreatCircle([0, 0], [90, 0], 0.5), [45, 0]);
    const [lng, lat] = interpolateGreatCircle([-90, 45], [90, 45], 0.5);
    assert.ok(Math.abs(lat - 90) < 1e-9, `crosses the pole, got ${lng},${lat}`);
  });

  it("bins rows into square cells of the requested size", () => {
    // Two points ~500 m apart share a 1 km cell; one ~5 km away does not.
    const rows = [
      { x: 0.001, y: 0.001 },
      { x: 0.005, y: 0.001 },
      { x: 0.05, y: 0.001 },
    ];
    const bins = aggregateBins(rows, { lng: "x", lat: "y" }, 1000, false);
    assert.deepEqual(bins.map((b) => b.value).sort(), [1, 2]);
  });

  it("orients a model's nose along the bearing", () => {
    // At (0, 0) east is +Y and north is +Z in Earth-fixed coordinates; rotate
    // the model's +X axis by the quaternion and compare.
    const rotateX = ([x, y, z, w]: number[]) => [
      1 - 2 * (y * y + z * z),
      2 * (x * y + z * w),
      2 * (x * z - y * w),
    ];
    const close = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
    assert.ok(close(rotateX(headingQuaternion(0, 0, 0)), [0, 0, 1]), "bearing 0 faces north");
    assert.ok(close(rotateX(headingQuaternion(0, 0, 90)), [0, 1, 0]), "bearing 90 faces east");
  });
});
