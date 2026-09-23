import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature, FeatureCollection } from "geojson";
import {
  compileMapboxLayer,
  mapboxUnsupportedStyleSettings,
} from "../packages/map/src/mapbox-layers";
import { geojsonLayer } from "./helpers/layer-fixtures";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";

const point = (id: number, kind: string): Feature => ({
  type: "Feature",
  id,
  properties: { kind },
  geometry: { type: "Point", coordinates: [id, id] },
});

function pointLayer(style: Partial<GeoLibreLayer["style"]> = {}): GeoLibreLayer {
  const geojson: FeatureCollection = {
    type: "FeatureCollection",
    features: [point(1, "a"), point(2, "b"), point(3, "a")],
  };
  return geojsonLayer({ id: "pts", geojson, style: { ...DEFAULT_LAYER_STYLE, ...style } });
}

describe("Mapbox point renderers", () => {
  it("draws the heatmap renderer as one heatmap layer and no circles", () => {
    const layer = pointLayer({ pointRenderer: "heatmap", heatmapRadius: 25 });
    layer.opacity = 0.5;
    const plan = compileMapboxLayer(layer);
    assert.deepEqual(
      plan.layers.map((spec) => spec.type),
      ["heatmap"],
    );
    const [heatmap] = plan.layers;
    assert.equal(heatmap.paint?.["heatmap-radius"], 25);
    assert.equal(heatmap.paint?.["heatmap-opacity"], 0.5);
    assert.match(JSON.stringify(heatmap.paint?.["heatmap-color"]), /heatmap-density/);
    if (plan.source.type === "geojson") assert.equal(plan.source.cluster, undefined);
  });

  it("clusters the source and draws bubbles, counts and unclustered points", () => {
    const layer = pointLayer({ pointRenderer: "cluster", clusterRadius: 60, clusterMaxZoom: 12 });
    const plan = compileMapboxLayer(layer, { textFont: ["Noto Sans Regular"] });
    assert.equal(plan.source.type, "geojson");
    if (plan.source.type !== "geojson") return;
    assert.equal(plan.source.cluster, true);
    assert.equal(plan.source.clusterRadius, 60);
    assert.equal(plan.source.clusterMaxZoom, 12);
    assert.equal(plan.source.data, layer.geojson);
    const byId = new Map(plan.layers.map((spec) => [spec.id, spec]));
    const bubble = byId.get("geolibre-mapbox-pts-geojson-cluster")!;
    const count = byId.get("geolibre-mapbox-pts-geojson-cluster-count")!;
    const single = byId.get("geolibre-mapbox-pts-geojson-circle")!;
    assert.deepEqual(bubble.filter, ["has", "point_count"]);
    assert.equal(bubble.type, "circle");
    assert.equal(count.type, "symbol");
    assert.deepEqual(count.layout?.["text-font"], ["Noto Sans Regular"]);
    assert.deepEqual(count.layout?.["text-field"], ["get", "point_count_abbreviated"]);
    assert.deepEqual(single.filter, ["!", ["has", "point_count"]]);
  });

  it("narrows the clustered data by the authored filter so hidden points leave the counts", () => {
    const layer = pointLayer({ pointRenderer: "cluster" });
    layer.filterExpression = ["==", ["get", "kind"], "a"];
    const plan = compileMapboxLayer(layer, { zoom: 3 });
    if (plan.source.type !== "geojson") return assert.fail("expected a GeoJSON source");
    const data = plan.source.data as FeatureCollection;
    assert.deepEqual(
      data.features.map((feature) => feature.id),
      [1, 3],
    );
    // The bubble and count aggregate clusters, which carry no properties.
    const bubble = plan.layers.find((spec) => spec.id.endsWith("-cluster"))!;
    assert.deepEqual(bubble.filter, ["has", "point_count"]);
    // A second compile of the same record reuses the filtered collection, so
    // the engine does not re-cluster on every sync.
    const again = compileMapboxLayer(layer, { zoom: 3 });
    if (again.source.type === "geojson") assert.equal(again.source.data, data);
    // A compile-only check (no live zoom) leaves the data unfiltered.
    const dryRun = compileMapboxLayer(layer);
    if (dryRun.source.type === "geojson") assert.equal(dryRun.source.data, layer.geojson);
  });

  it("ignores the point renderer on layers that also carry lines or polygons", () => {
    const layer = pointLayer({ pointRenderer: "heatmap" });
    layer.geojson!.features.push({
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
    const plan = compileMapboxLayer(layer);
    assert.ok(!plan.layers.some((spec) => spec.type === "heatmap"));
    assert.ok(plan.layers.some((spec) => spec.type === "circle"));
  });
});

describe("mapboxUnsupportedStyleSettings", () => {
  it("names nothing for a default style", () => {
    assert.deepEqual(mapboxUnsupportedStyleSettings(pointLayer()), []);
  });

  it("names every enabled setting the Mapbox compiler does not draw", () => {
    const layer = pointLayer({
      markerEnabled: true,
      fillPattern: "hatch",
      invertedFillEnabled: true,
      lineDecoration: "arrow",
      geometryGenerator: "centroid",
      blendMode: "multiply",
      labels: {
        ...DEFAULT_LAYER_STYLE.labels,
        enabled: true,
        field: "kind",
        dedupe: "unique",
        sizeExpression: '["get", "size"]',
      },
    } as Partial<GeoLibreLayer["style"]>);
    assert.deepEqual(mapboxUnsupportedStyleSettings(layer), [
      "markerIcons",
      "fillPattern",
      "invertedFill",
      "lineDecoration",
      "geometryGenerator",
      "blendMode",
      "labelDedupe",
      "labelExpressions",
    ]);
  });

  it("does not name marker icons under the heatmap or cluster renderer", () => {
    for (const pointRenderer of ["heatmap", "cluster"] as const) {
      const layer = pointLayer({ markerEnabled: true, pointRenderer });
      assert.deepEqual(mapboxUnsupportedStyleSettings(layer), []);
    }
  });

  it("ignores label settings while labels are off", () => {
    const layer = pointLayer({
      labels: { ...DEFAULT_LAYER_STYLE.labels, dedupe: "unique", colorExpression: '"red"' },
    });
    assert.deepEqual(mapboxUnsupportedStyleSettings(layer), []);
  });
});
