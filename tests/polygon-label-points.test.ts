import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureCollection, Polygon, Position } from "geojson";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, type LabelStyle } from "@geolibre/core";
import { syncLayer } from "../packages/map/src/layer-sync";
import {
  MAX_POLYGON_LABEL_FEATURES,
  MAX_POLYGON_LABEL_VERTICES,
  POLYGON_LABEL_AREA_PROPERTY,
  polygonLabelPoint,
  polygonLabelPoints,
} from "../packages/map/src/polygon-label-points";

// One label per polygon (GH discussion #3554): MapLibre labels every polygon
// part and repeats the label in each tile, so the label layer reads a derived
// one-point-per-feature source instead.

function square(x: number, y: number, size: number): Position[] {
  return [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
    [x, y],
  ];
}

function insidePolygon([px, py]: Position, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[j];
    if (ay > py !== by > py && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

describe("polygonLabelPoint", () => {
  it("centers a square", () => {
    const point = polygonLabelPoint({ type: "Polygon", coordinates: [square(0, 0, 2)] })!;
    assert.ok(Math.abs(point[0] - 1) < 0.01);
    assert.ok(Math.abs(point[1] - 1) < 0.01);
  });

  it("labels only the largest part of a multipolygon", () => {
    const point = polygonLabelPoint({
      type: "MultiPolygon",
      coordinates: [[square(10, 0, 1)], [square(0, 0, 4)], [square(20, 0, 0.5)]],
    })!;
    assert.ok(insidePolygon(point, square(0, 0, 4)), `${point} should be in the big part`);
  });

  it("keeps the label inside a concave shape whose centroid falls outside", () => {
    // A U shape: the centroid sits in the notch, outside the polygon.
    const u: Position[] = [
      [0, 0],
      [3, 0],
      [3, 3],
      [2, 3],
      [2, 1],
      [1, 1],
      [1, 3],
      [0, 3],
      [0, 0],
    ];
    const point = polygonLabelPoint({ type: "Polygon", coordinates: [u] })!;
    assert.ok(insidePolygon(point, u), `${point} should be inside the U`);
  });

  it("avoids a hole", () => {
    const outer = square(0, 0, 10);
    const hole = square(3, 3, 4).reverse();
    const point = polygonLabelPoint({ type: "Polygon", coordinates: [outer, hole] })!;
    assert.ok(insidePolygon(point, outer));
    assert.ok(!insidePolygon(point, hole), `${point} should not be in the hole`);
  });

  it("finds the interior of a U thinner than the search precision", () => {
    const u: Position[] = [
      [0, 0],
      [100, 0],
      [100, 1],
      [99.9999, 1],
      [99.9999, 0.0001],
      [0.0001, 0.0001],
      [0.0001, 1],
      [0, 1],
      [0, 0],
    ];
    const point = polygonLabelPoint({ type: "Polygon", coordinates: [u] })!;
    assert.ok(insidePolygon(point, u), `${point} should be inside the thin U`);
  });

  it("thins a very detailed outline for the search and still lands inside", () => {
    // A 40,000-vertex circle.
    const ring: Position[] = [];
    for (let i = 0; i < 40_000; i += 1) {
      const t = (i / 40_000) * 2 * Math.PI;
      ring.push([Math.cos(t), Math.sin(t)]);
    }
    ring.push(ring[0]);
    const start = Date.now();
    const point = polygonLabelPoint({ type: "Polygon", coordinates: [ring] })!;
    assert.ok(Math.hypot(point[0], point[1]) < 0.05, `${point} should be near the center`);
    assert.ok(Date.now() - start < 1000);
  });

  it("ranks parts by ground size, not Mercator size", () => {
    // A high-latitude part that is larger in Mercator but smaller on the ground.
    const north = square(0, 70, 4);
    const south = square(20, 0, 3);
    const point = polygonLabelPoint({ type: "MultiPolygon", coordinates: [[north], [south]] })!;
    assert.ok(insidePolygon(point, south), `${point} should be in the equatorial part`);
  });

  it("stays inside when thinning the outline drops a deep notch", () => {
    // A square with a notch reaching almost to the bottom edge, which carries
    // ~2,000 vertices so the thinned search copy loses the notch tip.
    const bottom: Position[] = [];
    for (let i = 0; i < 1997; i += 1) bottom.push([(i / 1996) * 2, 0]);
    const ring: Position[] = [...bottom, [2, 2], [1.8, 2], [1, 0.1], [0.2, 2], [0, 2], [0, 0]];
    const point = polygonLabelPoint({ type: "Polygon", coordinates: [ring] })!;
    assert.ok(insidePolygon(point, ring), `${point} should be inside the notched square`);
  });

  it("stays fast on a long flat sliver", () => {
    const start = Date.now();
    const point = polygonLabelPoint({
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 0.0000001],
          [0, 0.0000001],
          [0, 0],
        ],
      ],
    });
    assert.ok(point);
    assert.ok(Date.now() - start < 1000, "the starting grid is bounded");
  });

  it("returns null for a zero-area polygon", () => {
    const flat: Position[] = [
      [0, 0],
      [1, 1],
      [2, 2],
      [0, 0],
    ];
    assert.equal(polygonLabelPoint({ type: "Polygon", coordinates: [flat] }), null);
  });

  it("returns null for non-polygons and degenerate rings", () => {
    assert.equal(polygonLabelPoint({ type: "Point", coordinates: [0, 0] }), null);
    assert.equal(polygonLabelPoint(null), null);
    assert.equal(
      polygonLabelPoint({
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 1],
          ],
        ],
      }),
      null,
    );
  });
});

describe("polygonLabelPoints", () => {
  const collection: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: 7,
        properties: { NAME: "Netherlands" },
        geometry: {
          type: "MultiPolygon",
          coordinates: [[square(4, 51, 3)], [square(5, 53.2, 0.2)]],
        },
      },
      {
        type: "Feature",
        properties: { NAME: "Road" },
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
      },
    ],
  };

  it("turns each polygon feature into one point, keeping id and properties", () => {
    const result = polygonLabelPoints(collection)!;
    assert.equal(result.features.length, 2);
    const [country, road] = result.features;
    assert.equal(country.geometry.type, "Point");
    assert.equal(country.id, 7);
    const { [POLYGON_LABEL_AREA_PROPERTY]: area, ...properties } = country.properties!;
    assert.deepEqual(properties, { NAME: "Netherlands" });
    // 9 square degrees at ~52.5° N, scaled by cos(lat).
    assert.ok(Math.abs((area as number) - 9 * Math.cos((52.5 * Math.PI) / 180)) < 0.01);
    assert.equal(road, collection.features[1], "non-polygons pass through unchanged");
  });

  it("memoizes by collection reference", () => {
    assert.equal(polygonLabelPoints(collection), polygonLabelPoints(collection));
  });

  it("skips layers past the vertex budget", () => {
    // A few very detailed outlines: under the polygon budget, over the vertex one.
    const perRing = Math.ceil(MAX_POLYGON_LABEL_VERTICES / 4) + 1;
    const circle: Position[] = [];
    for (let k = 0; k < perRing - 1; k += 1) {
      const t = (k / (perRing - 1)) * 2 * Math.PI;
      circle.push([Math.cos(t), Math.sin(t)]);
    }
    circle.push(circle[0]);
    const detailed: FeatureCollection = {
      type: "FeatureCollection",
      features: Array.from({ length: 4 }, (_, i) => ({
        type: "Feature" as const,
        properties: { i },
        geometry: { type: "Polygon" as const, coordinates: [circle] },
      })),
    };
    const start = Date.now();
    assert.equal(polygonLabelPoints(detailed), null);
    assert.ok(Date.now() - start < 1000, "the budget is checked before any search");
  });

  it("skips layers past the polygon budget", () => {
    const many: FeatureCollection = {
      type: "FeatureCollection",
      features: Array.from({ length: MAX_POLYGON_LABEL_FEATURES + 1 }, (_, i) => ({
        type: "Feature" as const,
        properties: { i },
        geometry: { type: "Polygon" as const, coordinates: [square(i * 0.01, 0, 0.005)] },
      })),
    };
    assert.equal(polygonLabelPoints(many), null);
  });
});

function makeMap() {
  const sources = new Map<string, Record<string, unknown>>();
  const layers = new Map<string, Record<string, unknown>>();
  const map = {
    getSource: (id: string) =>
      sources.has(id)
        ? {
            type: sources.get(id)?.type,
            setData: (data: unknown) => {
              sources.get(id)!.data = data;
            },
          }
        : undefined,
    addSource: (id: string, spec: Record<string, unknown>) => {
      sources.set(id, spec);
    },
    removeSource: (id: string) => sources.delete(id),
    getLayer: (id: string) => (layers.has(id) ? { id, ...layers.get(id) } : undefined),
    addLayer: (spec: Record<string, unknown>) => {
      layers.set(spec.id as string, spec);
    },
    removeLayer: (id: string) => layers.delete(id),
    getFilter: (id: string) => layers.get(id)?.filter,
    setFilter: (id: string, filter: unknown) => {
      const layer = layers.get(id);
      if (layer) layer.filter = filter;
    },
    setPaintProperty: (id: string, key: string, value: unknown) => {
      const layer = layers.get(id);
      if (layer) (layer.paint as Record<string, unknown>)[key] = value;
    },
    setLayoutProperty: (id: string, key: string, value: unknown) => {
      const layer = layers.get(id);
      if (layer) (layer.layout as Record<string, unknown>)[key] = value;
    },
    setLayerZoomRange: () => {},
    moveLayer: () => {},
    getStyle: () => ({
      layers: [{ type: "symbol", layout: { "text-field": ["get", "x"] } }],
      sources: Object.fromEntries(sources),
    }),
    once: () => {},
  };
  return { map, layers, sources };
}

const LABEL_ID = "layer-lyr-label";
const LABEL_SOURCE_ID = "source-lyr-label";

function polygonLayer(labelPatch: Partial<LabelStyle>): GeoLibreLayer {
  return {
    id: "lyr",
    name: "Countries",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: {
      ...DEFAULT_LAYER_STYLE,
      labels: { ...DEFAULT_LAYER_STYLE.labels, enabled: true, field: "NAME", ...labelPatch },
    },
    metadata: {},
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { NAME: "Netherlands", pop: 18 },
          geometry: {
            type: "MultiPolygon",
            coordinates: [[square(4, 51, 3)], [square(5, 53.2, 0.2)]],
          },
        },
      ],
    },
  };
}

describe("one label per polygon (layer sync)", () => {
  it("is on by default", () => {
    assert.equal(DEFAULT_LAYER_STYLE.labels.onePerPolygon, true);
  });

  it("labels a polygon layer from a one-point-per-feature source", () => {
    const { map, layers, sources } = makeMap();
    syncLayer(map as never, polygonLayer({ sizeExpression: '["get", "pop"]' }));

    const label = layers.get(LABEL_ID) as {
      source: string;
      filter: unknown;
      layout: Record<string, unknown>;
    };
    assert.equal(label.source, LABEL_SOURCE_ID);
    assert.equal(label.layout["symbol-placement"], "point");
    // The points keep their attributes, so overrides and filters still apply.
    assert.deepEqual(label.layout["text-field"], ["to-string", ["coalesce", ["get", "NAME"], ""]]);
    assert.deepEqual(label.layout["text-size"], ["get", "pop"]);
    assert.ok(label.filter, "the label filter is kept");
    const data = (sources.get(LABEL_SOURCE_ID) as { data: FeatureCollection }).data;
    assert.equal(data.features.length, 1);
    const point = data.features[0].geometry as unknown as { type: string; coordinates: Position };
    assert.equal(point.type, "Point");
    assert.ok(insidePolygon(point.coordinates, square(4, 51, 3)));
  });

  it("places larger polygons first unless a priority expression is set", () => {
    const { map, layers } = makeMap();
    syncLayer(map as never, polygonLayer({}));
    const label = () => layers.get(LABEL_ID) as { layout: Record<string, unknown> };
    assert.deepEqual(label().layout["symbol-sort-key"], [
      "-",
      ["coalesce", ["get", POLYGON_LABEL_AREA_PROPERTY], 0],
    ]);

    syncLayer(map as never, polygonLayer({ priorityExpression: '["get", "pop"]' }));
    assert.deepEqual(label().layout["symbol-sort-key"], ["get", "pop"]);
  });

  it("keeps the default label order on a mixed-geometry layer", () => {
    const { map, layers } = makeMap();
    const layer = polygonLayer({});
    layer.geojson!.features.push({
      type: "Feature",
      properties: { NAME: "Amsterdam" },
      geometry: { type: "Point", coordinates: [4.9, 52.37] },
    });
    syncLayer(map as never, layer);
    const label = layers.get(LABEL_ID) as { source: string; layout: Record<string, unknown> };
    assert.equal(label.source, LABEL_SOURCE_ID, "still one label per polygon");
    assert.equal(label.layout["symbol-sort-key"], undefined, "no area ranking");
  });

  it("keeps MapLibre placement when a filter tests the geometry type", () => {
    // The derived label feature is a Point, so a Polygon-only filter would hide it.
    const { map, layers, sources } = makeMap();
    const layer = polygonLayer({});
    layer.filterExpression = ["==", ["geometry-type"], "Polygon"];
    syncLayer(map as never, layer);
    assert.equal((layers.get(LABEL_ID) as { source: string }).source, "source-lyr");
    assert.ok(!sources.has(LABEL_SOURCE_ID));

    const { map: map2, layers: layers2 } = makeMap();
    syncLayer(map2 as never, polygonLayer({ visibilityExpression: '["==", "$type", "Polygon"]' }));
    assert.equal((layers2.get(LABEL_ID) as { source: string }).source, "source-lyr");
  });

  it("keeps a time filter on the label layer instead of skipping the option", () => {
    const { map, layers } = makeMap();
    const layer = polygonLayer({});
    layer.timeFilter = ["<=", ["get", "t"], 5] as unknown[];
    syncLayer(map as never, layer);
    const label = layers.get(LABEL_ID) as { source: string; filter: unknown };
    assert.equal(label.source, LABEL_SOURCE_ID);
    assert.match(JSON.stringify(label.filter), /"t"/);
  });

  it("preserves original polygons for containment and distance filters", () => {
    const boundary = { type: "Polygon", coordinates: [square(-1, -1, 2)] };
    for (const filter of [
      ["within", boundary],
      ["<", ["distance", { type: "Point", coordinates: [0, 0] }], 1000],
    ]) {
      const { map, layers, sources } = makeMap();
      const layer = polygonLayer({});
      // The anchor [0, 0] is within the filter but the polygon extends outside
      // it. Evaluating on a derived point would show a label for a hidden shape.
      layer.geojson!.features[0].geometry = {
        type: "Polygon",
        coordinates: [square(-2, -2, 4)],
      };
      layer.filterExpression = filter;
      syncLayer(map as never, layer);
      assert.equal((layers.get(LABEL_ID) as { source: string }).source, "source-lyr");
      assert.ok(!sources.has(LABEL_SOURCE_ID));
      assert.match(JSON.stringify(layers.get(LABEL_ID)?.filter), /within|distance/);
    }
  });

  it("preserves original geometry for label overrides as well as layer filters", () => {
    for (const patch of [
      {
        visibilityExpression:
          '["within", {"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}]',
      },
      { sizeExpression: '["distance", {"type":"Point","coordinates":[0,0]}]' },
    ]) {
      const { map, layers, sources } = makeMap();
      syncLayer(map as never, polygonLayer(patch));
      assert.equal((layers.get(LABEL_ID) as { source: string }).source, "source-lyr");
      assert.ok(!sources.has(LABEL_SOURCE_ID));
    }
  });

  it("does not confuse attribute names or literal arrays with geometry operators", () => {
    for (const expression of [
      '["get", "distance"]',
      '["get", "within"]',
      '["get", "geometry-type"]',
      '["get", "$type"]',
      '["to-string", ["literal", ["within", "distance"]]]',
    ]) {
      const { map, layers } = makeMap();
      const layer = polygonLayer({ expression });
      layer.filterExpression = ["==", ["get", "distance"], 5];
      syncLayer(map as never, layer);
      assert.equal((layers.get(LABEL_ID) as { source: string }).source, LABEL_SOURCE_ID);
    }
  });

  it("recognizes geometry operators in overrides with accepted trailing commas", () => {
    const { map, layers, sources } = makeMap();
    syncLayer(
      map as never,
      polygonLayer({
        visibilityExpression:
          '["within", {"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]},]',
      }),
    );
    assert.equal((layers.get(LABEL_ID) as { source: string }).source, "source-lyr");
    assert.ok(!sources.has(LABEL_SOURCE_ID));
  });

  it("falls back to MapLibre placement when turned off, and drops the label source", () => {
    const { map, layers, sources } = makeMap();
    syncLayer(map as never, polygonLayer({}));
    assert.ok(sources.has(LABEL_SOURCE_ID));

    syncLayer(map as never, polygonLayer({ onePerPolygon: false }));
    const label = layers.get(LABEL_ID) as { source: string };
    assert.equal(label.source, "source-lyr");
    assert.ok(!sources.has(LABEL_SOURCE_ID));
  });

  it("keeps outline labels for line placement", () => {
    const { map, layers, sources } = makeMap();
    syncLayer(map as never, polygonLayer({ placement: "line" }));
    const label = layers.get(LABEL_ID) as { source: string; layout: Record<string, unknown> };
    assert.equal(label.source, "source-lyr");
    assert.equal(label.layout["symbol-placement"], "line");
    assert.ok(!sources.has(LABEL_SOURCE_ID));
  });

  it("treats a saved project without the key as on", () => {
    const { map, layers } = makeMap();
    const layer = polygonLayer({});
    delete (layer.style.labels as Partial<LabelStyle>).onePerPolygon;
    syncLayer(map as never, layer);
    assert.equal((layers.get(LABEL_ID) as { source: string }).source, LABEL_SOURCE_ID);
  });
});
