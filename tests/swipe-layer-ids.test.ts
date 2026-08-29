import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  circleLayerId,
  fillLayerId,
  lineLayerId,
  nativeLayerIdPrefix,
} from "@geolibre/map/style-layer-ids";
import { pmtilesVectorLayerId } from "@geolibre/map/pmtiles-layer";
import {
  resolveSwipeSideIds,
  styleLayerIdsForProjectLayer,
  type SwipeProjectLayer,
  type SwipeStyleLayer,
} from "../packages/plugins/src/plugins/swipe-layer-ids";

// A basemap layer is on every map and belongs to no store layer, so every case
// below includes one: nothing may pull it onto a side.
const basemap: SwipeStyleLayer[] = [{ id: "background" }, { id: "water", source: "openmaptiles" }];

function geojsonStyleLayers(layerId: string): SwipeStyleLayer[] {
  return [
    { id: fillLayerId(layerId), source: `source-${layerId}` },
    { id: lineLayerId(layerId), source: `source-${layerId}` },
    { id: circleLayerId(layerId), source: `source-${layerId}` },
  ];
}

describe("nativeLayerIdPrefix", () => {
  it("is the prefix the derived style layer id builders share", () => {
    const prefix = nativeLayerIdPrefix("abc");
    for (const id of [fillLayerId("abc"), lineLayerId("abc"), circleLayerId("abc")]) {
      assert.ok(id.startsWith(prefix), `${id} should start with ${prefix}`);
    }
    // The vector-tile and MBTiles builders live in layer-sync and follow the
    // same scheme; spelled out here so a rename there fails a test rather than
    // silently dropping those types out of the swipe.
    assert.ok(`layer-abc-vector-roads-fill`.startsWith(prefix));
    assert.ok(`layer-abc-mbtiles-roads-line`.startsWith(prefix));
    assert.ok(`layer-abc-raster`.startsWith(prefix));
  });
});

describe("styleLayerIdsForProjectLayer", () => {
  it("finds every style layer a GeoJSON layer draws through", () => {
    const styleLayers = [...basemap, ...geojsonStyleLayers("red"), ...geojsonStyleLayers("blue")];

    assert.deepEqual(styleLayerIdsForProjectLayer("red", styleLayers), [
      "layer-red-fill",
      "layer-red-line",
      "layer-red-circle",
    ]);
  });

  it("finds a layer's derived label and mask sources", () => {
    const styleLayers: SwipeStyleLayer[] = [
      ...basemap,
      { id: "layer-red-fill", source: "source-red" },
      { id: "decoration-red", source: "source-red-label" },
    ];

    assert.deepEqual(styleLayerIdsForProjectLayer("red", styleLayers), [
      "layer-red-fill",
      "decoration-red",
    ]);
  });

  it("finds the ids a control recorded in metadata.nativeLayerIds", () => {
    const styleLayers: SwipeStyleLayer[] = [
      ...basemap,
      { id: "vector-control-red-1", source: "vector-red" },
      { id: "vector-control-blue-1", source: "vector-blue" },
    ];
    const layer: SwipeProjectLayer = {
      id: "red",
      metadata: { nativeLayerIds: ["vector-control-red-1"] },
    };

    assert.deepEqual(styleLayerIdsForProjectLayer("red", styleLayers, layer), [
      "vector-control-red-1",
    ]);
  });

  it("finds a PMTiles layer's own source layers and not a sibling's", () => {
    // Two store layers reading one archive: matching on the shared source alone
    // would put both layers' style layers on the same side.
    const archive = "archive-1";
    const roads: SwipeProjectLayer = {
      id: "roads",
      source: { sourceId: archive, sourceLayers: ["roads"] },
      metadata: { sourceId: archive, sourceLayers: ["roads"], nativeLayerIds: [archive] },
    };
    const styleLayers: SwipeStyleLayer[] = [
      ...basemap,
      { id: pmtilesVectorLayerId(archive, "roads", "fill"), source: archive },
      { id: pmtilesVectorLayerId(archive, "roads", "line"), source: archive },
      { id: pmtilesVectorLayerId(archive, "water", "fill"), source: archive },
    ];

    assert.deepEqual(styleLayerIdsForProjectLayer("roads", styleLayers, roads), [
      pmtilesVectorLayerId(archive, "roads", "fill"),
      pmtilesVectorLayerId(archive, "roads", "line"),
    ]);
  });
});

describe("resolveSwipeSideIds", () => {
  const projectLayers: SwipeProjectLayer[] = [{ id: "red" }, { id: "blue" }];
  const styleLayers = [...basemap, ...geojsonStyleLayers("red"), ...geojsonStyleLayers("blue")];

  it("expands a project layer id into the style layer ids that draw it", () => {
    const resolved = resolveSwipeSideIds(["red"], { styleLayers, projectLayers });

    assert.deepEqual(resolved.ids, ["red", "layer-red-fill", "layer-red-line", "layer-red-circle"]);
    assert.deepEqual(resolved.contributed.get("red"), [
      "layer-red-fill",
      "layer-red-line",
      "layer-red-circle",
    ]);
    assert.equal(resolved.changed, true);
  });

  it("picks up the style layers a layer gains after the first pass", () => {
    // A layer's style layers are added one `map.addLayer` at a time, each firing
    // its own `styledata`, so a pass can catch the layer part-drawn.
    const first = resolveSwipeSideIds(["red"], {
      styleLayers: [...basemap, { id: "layer-red-fill", source: "source-red" }],
      projectLayers,
    });
    assert.deepEqual(first.ids, ["red", "layer-red-fill"]);

    const second = resolveSwipeSideIds(first.ids, {
      styleLayers,
      projectLayers,
      contributed: new Map([["red", new Set(first.contributed.get("red"))]]),
    });

    assert.deepEqual(second.ids, ["red", "layer-red-fill", "layer-red-line", "layer-red-circle"]);
    assert.deepEqual(second.contributed.get("red"), ["layer-red-line", "layer-red-circle"]);
    assert.equal(second.changed, true);
  });

  it("leaves a side that already names style layer ids untouched", () => {
    // What #2155 writes for a raster layer: the project id plus the one style
    // layer id it can derive. Expanding the project id must not duplicate it,
    // and nothing changed, so the control is not touched.
    const rasterStyleLayers: SwipeStyleLayer[] = [
      ...basemap,
      { id: "layer-osm-raster", source: "source-osm" },
    ];
    const resolved = resolveSwipeSideIds(["osm", "layer-osm-raster"], {
      styleLayers: rasterStyleLayers,
      projectLayers: [{ id: "osm" }],
    });

    assert.deepEqual(resolved.ids, ["osm", "layer-osm-raster"]);
    assert.equal(resolved.changed, false);
  });

  it("contributes nothing for a project layer the style has not caught up with", () => {
    const resolved = resolveSwipeSideIds(["red"], { styleLayers: basemap, projectLayers });

    assert.deepEqual(resolved.ids, ["red"]);
    assert.equal(resolved.contributed.size, 0);
    assert.equal(resolved.changed, false);
  });

  it("passes through an id that names nothing in the project", () => {
    // The control's grouped basemap entry, which it resolves itself.
    const resolved = resolveSwipeSideIds(["__basemap__"], { styleLayers, projectLayers });

    assert.deepEqual(resolved.ids, ["__basemap__"]);
    assert.equal(resolved.changed, false);
  });

  it("passes through a provider layer id", () => {
    // A deck.gl COG raster is listed by its store id and assigned by the
    // provider, so it is already the id the control needs.
    const resolved = resolveSwipeSideIds(["cog"], {
      styleLayers,
      projectLayers: [...projectLayers, { id: "cog" }],
      providerLayerIds: new Set(["cog"]),
    });

    assert.deepEqual(resolved.ids, ["cog"]);
    assert.equal(resolved.contributed.size, 0);
  });

  it("does not re-add a style layer id the user has since unchecked", () => {
    const resolved = resolveSwipeSideIds(["red"], {
      styleLayers,
      projectLayers,
      contributed: new Map([
        ["red", new Set(["layer-red-fill", "layer-red-line", "layer-red-circle"])],
      ]),
    });

    assert.deepEqual(resolved.ids, ["red"]);
    assert.equal(resolved.changed, false);
  });

  it("keeps the two sides apart", () => {
    const left = resolveSwipeSideIds(["red"], { styleLayers, projectLayers });
    const right = resolveSwipeSideIds(["blue"], { styleLayers, projectLayers });

    assert.equal(
      left.ids.some((id) => right.ids.includes(id)),
      false,
    );
  });
});
