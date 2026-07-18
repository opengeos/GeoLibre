import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDelimitedTextRows } from "../apps/geolibre-desktop/src/lib/delimited-text";
import {
  autoDetectFieldMapping,
  computeDeckVizBounds,
  detectAndParseDeckVizInput,
} from "../apps/geolibre-desktop/src/lib/deck-viz-input";
import {
  DEFAULT_DECK_VIZ_SCENEGRAPH,
  DEFAULT_DECK_VIZ_STYLE,
  getDeckVizLayerDef,
  listDeckVizLayerDefs,
} from "../packages/plugins/src/plugins/deckgl-viz/registry";
import {
  createDeckVizStoreLayer,
  isDeckVizLayer,
  readDeckVizConfig,
} from "../packages/plugins/src/plugins/deckgl-viz/store-layer";

describe("parseDelimitedTextRows", () => {
  it("returns header fields and one record per data row", () => {
    const { fields, rows } = parseDelimitedTextRows(
      "lng,lat,value\n-73.9,40.7,5\n-74.0,40.6,9\n",
      ",",
    );
    assert.deepEqual(fields, ["lng", "lat", "value"]);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { lng: "-73.9", lat: "40.7", value: "5" });
    assert.equal(rows[1].value, "9");
  });

  it("honours quoted fields and a tab delimiter", () => {
    const { fields, rows } = parseDelimitedTextRows('name\tlng\n"Smith, John"\t-1.5\n', "\t");
    assert.deepEqual(fields, ["name", "lng"]);
    assert.equal(rows[0].name, "Smith, John");
  });

  it("throws without a header and data row", () => {
    assert.throws(() => parseDelimitedTextRows("lng,lat\n", ","));
  });
});

describe("detectAndParseDeckVizInput", () => {
  it("detects CSV rows with sampled column labels", () => {
    const parsed = detectAndParseDeckVizInput("lng,lat\n-1,2\n-3,4\n");
    assert.equal(parsed.format, "csv-rows");
    assert.equal(parsed.rowCount, 2);
    assert.deepEqual(
      parsed.columns.map((column) => column.value),
      ["lng", "lat"],
    );
  });

  it("detects a JSON array of tuples with numeric column indices", () => {
    const parsed = detectAndParseDeckVizInput("[[-73.9,40.7,1],[-74,40.6,2]]");
    assert.equal(parsed.format, "json-array");
    assert.deepEqual(
      parsed.columns.map((column) => column.value),
      [0, 1, 2],
    );
    assert.equal(parsed.rowCount, 2);
  });

  it("detects a JSON array of objects with key columns", () => {
    const parsed = detectAndParseDeckVizInput('[{"path":[[0,0]],"timestamps":[1,2]}]');
    assert.equal(parsed.format, "json-objects");
    assert.deepEqual(
      parsed.columns.map((column) => column.value),
      ["path", "timestamps"],
    );
  });

  it("detects a GeoJSON FeatureCollection and collects property keys", () => {
    const parsed = detectAndParseDeckVizInput(
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [0, 0] },
            properties: { height: 12, growth: 0.1 },
          },
        ],
      }),
    );
    assert.equal(parsed.format, "geojson");
    assert.ok(parsed.geojson);
    assert.deepEqual(parsed.columns.map((column) => column.value).sort(), ["growth", "height"]);
  });

  it("throws on empty or unsupported input", () => {
    assert.throws(() => detectAndParseDeckVizInput("   "));
    assert.throws(() => detectAndParseDeckVizInput("[1, 2, 3]"));
  });
});

describe("autoDetectFieldMapping", () => {
  const pointRoles = getDeckVizLayerDef("scatterplot")!.roles;
  const odRoles = getDeckVizLayerDef("arc")!.roles;

  it("maps named columns by detection hints", () => {
    const parsed = detectAndParseDeckVizInput("Longitude,Latitude,Magnitude\n-1,2,3\n");
    const mapping = autoDetectFieldMapping(pointRoles, parsed.columns);
    assert.equal(mapping.lng, "Longitude");
    assert.equal(mapping.lat, "Latitude");
    assert.equal(mapping.weight, "Magnitude");
  });

  it("does not let the short 'y' token grab an unrelated column", () => {
    const parsed = detectAndParseDeckVizInput("city,lng,lat\nNY,-1,2\n");
    const mapping = autoDetectFieldMapping(pointRoles, parsed.columns);
    assert.equal(mapping.lat, "lat");
    assert.equal(mapping.lng, "lng");
  });

  it("falls back to positional mapping for tuple arrays", () => {
    const parsed = detectAndParseDeckVizInput("[[-1,2,9]]");
    const mapping = autoDetectFieldMapping(pointRoles, parsed.columns);
    assert.equal(mapping.lng, 0);
    assert.equal(mapping.lat, 1);
    assert.equal(mapping.weight, 2);
  });

  it("maps origin-destination columns without reusing a column", () => {
    const parsed = detectAndParseDeckVizInput("lon1,lat1,lon2,lat2\n-1,2,-3,4\n");
    const mapping = autoDetectFieldMapping(odRoles, parsed.columns);
    assert.deepEqual(mapping, {
      sourceLng: "lon1",
      sourceLat: "lat1",
      targetLng: "lon2",
      targetLat: "lat2",
    });
  });
});

describe("computeDeckVizBounds", () => {
  it("bounds point rows by lng/lat keys", () => {
    const bounds = computeDeckVizBounds(
      [
        { lng: -10, lat: 5 },
        { lng: 20, lat: -3 },
      ],
      { lng: "lng", lat: "lat" },
    );
    assert.deepEqual(bounds, [-10, -3, 20, 5]);
  });

  it("includes both endpoints for origin-destination rows", () => {
    const bounds = computeDeckVizBounds([[-5, 0, 30, 40]], {
      sourceLng: 0,
      sourceLat: 1,
      targetLng: 2,
      targetLat: 3,
    });
    assert.deepEqual(bounds, [-5, 0, 30, 40]);
  });

  it("walks Trips path arrays", () => {
    const bounds = computeDeckVizBounds(
      [
        {
          path: [
            [-2, 1],
            [4, 9],
          ],
        },
      ],
      { path: "path" },
    );
    assert.deepEqual(bounds, [-2, 1, 4, 9]);
  });

  it("returns null when no finite coordinates are present", () => {
    assert.equal(
      computeDeckVizBounds([{ lng: "x", lat: "y" }], {
        lng: "lng",
        lat: "lat",
      }),
      null,
    );
  });
});

describe("deck-viz registry & store layer", () => {
  it("exposes every layer with an example url and required roles", () => {
    const defs = listDeckVizLayerDefs();
    assert.ok(defs.length >= 12);
    for (const def of defs) {
      assert.match(def.example.url, /^https:\/\//);
      assert.ok(typeof def.build === "function");
      // Required roles in the example mapping must be present.
      for (const role of def.roles) {
        if (role.required) {
          assert.notEqual(
            def.example.fieldMapping[role.key],
            undefined,
            `${def.kind} example must map required role ${role.key}`,
          );
        }
      }
    }
  });

  it("creates a detectable store layer carrying the viz config", () => {
    const scatterplotDef = getDeckVizLayerDef("scatterplot")!;
    const layer = createDeckVizStoreLayer({
      name: "Test",
      config: {
        layerKind: "scatterplot",
        format: "json-array",
        fieldMapping: { lng: 0, lat: 1 },
        style: { ...DEFAULT_DECK_VIZ_STYLE, ...(scatterplotDef.example.style ?? {}) },
      },
      rows: [[-1, 2]],
      sourcePath: "memory://test",
    });
    assert.equal(layer.type, "deckgl-viz");
    assert.equal(layer.metadata.externalDeckLayer, true);
    assert.equal(layer.metadata.customLayerType, "scatterplot");
    assert.ok(isDeckVizLayer(layer));

    const config = readDeckVizConfig(layer);
    assert.ok(config);
    assert.equal(config.layerKind, "scatterplot");
    assert.equal(config.fieldMapping.lat, 1);
  });

  it("readDeckVizConfig fills missing style with defaults and rejects junk", () => {
    const layer = createDeckVizStoreLayer({
      name: "Partial",
      config: {
        layerKind: "heatmap",
        format: "json-array",
        fieldMapping: { lng: 0, lat: 1 },
        // deliberately partial style
        style: { color: "#ff0000" } as never,
      },
      rows: [],
    });
    const config = readDeckVizConfig(layer);
    assert.ok(config);
    assert.equal(config.style.color, "#ff0000");
    assert.equal(typeof config.style.radius, "number");

    const broken = { ...layer, metadata: { ...layer.metadata, vizConfig: {} } };
    assert.equal(readDeckVizConfig(broken), null);
  });

  it("readDeckVizConfig rejects a config missing a required role mapping", () => {
    const layer = createDeckVizStoreLayer({
      name: "Corrupt",
      config: {
        layerKind: "scatterplot",
        format: "json-array",
        // lat is required but absent (e.g. a hand-edited project file)
        fieldMapping: { lng: 0 },
        style: DEFAULT_DECK_VIZ_STYLE,
      },
      rows: [],
    });
    assert.equal(readDeckVizConfig(layer), null);
  });
});

describe("scenegraph (glTF 3D model) layer", () => {
  const def = getDeckVizLayerDef("scenegraph")!;

  it("declares a glTF model example with required point roles", () => {
    assert.ok(def);
    assert.equal(def.category, "models");
    assert.ok(def.example.scenegraph);
    assert.match(def.example.scenegraph.modelUrl, /\.glb$/);
    assert.equal(def.example.fieldMapping.lng, "longitude");
    assert.equal(def.example.fieldMapping.lat, "latitude");
    // A default single-location coordinate pre-fills the dialog's lng/lat.
    assert.ok(def.example.scenegraphLocation);
    const [lng, lat] = def.example.scenegraphLocation;
    assert.ok(lng >= -180 && lng <= 180);
    assert.ok(lat >= -90 && lat <= 90);
  });

  it("round-trips the model URL and transform through the store layer", () => {
    const layer = createDeckVizStoreLayer({
      name: "Plane",
      config: {
        layerKind: "scenegraph",
        format: "csv-rows",
        fieldMapping: { lng: "lng", lat: "lat" },
        style: { ...DEFAULT_DECK_VIZ_STYLE },
        scenegraph: {
          modelUrl: "https://example.com/model.glb",
          sizeScale: 250,
          bearing: 45,
          altitude: 100,
        },
      },
      rows: [{ lng: -122.4, lat: 37.8 }],
      sourcePath: "https://example.com/model.glb",
    });
    assert.equal(layer.metadata.customLayerType, "scenegraph");
    const config = readDeckVizConfig(layer);
    assert.ok(config?.scenegraph);
    assert.equal(config.scenegraph.modelUrl, "https://example.com/model.glb");
    assert.equal(config.scenegraph.sizeScale, 250);
    assert.equal(config.scenegraph.sizeMinPixels, 1);
    assert.equal(config.scenegraph.bearing, 45);
    assert.equal(config.scenegraph.orientationRoll, 90);
    assert.deepEqual(config.scenegraph.translation, [0, 0, 0]);
    assert.equal(config.scenegraph.altitude, 100);
  });

  it("fills scenegraph defaults for a partial persisted config", () => {
    const layer = createDeckVizStoreLayer({
      name: "Partial",
      config: {
        layerKind: "scenegraph",
        format: "csv-rows",
        fieldMapping: { lng: "lng", lat: "lat" },
        style: { ...DEFAULT_DECK_VIZ_STYLE },
        scenegraph: { modelUrl: "https://example.com/m.glb" } as never,
      },
      rows: [],
    });
    const config = readDeckVizConfig(layer);
    assert.equal(config?.scenegraph?.sizeScale, DEFAULT_DECK_VIZ_SCENEGRAPH.sizeScale);
    assert.equal(config?.scenegraph?.sizeMinPixels, 1);
    assert.equal(config?.scenegraph?.bearing, 0);
    assert.equal(config?.scenegraph?.orientationRoll, 90);
    assert.deepEqual(config?.scenegraph?.translation, [0, 0, 0]);
  });

  it("builds a ScenegraphLayer whose accessors fold in transform + columns", () => {
    const captured: { props?: Record<string, unknown> } = {};
    const fakeDeck = {
      meshLayers: {
        ScenegraphLayer: class {
          constructor(props: Record<string, unknown>) {
            captured.props = props;
          }
        },
      },
    } as unknown as Parameters<typeof def.build>[0];

    def.build(fakeDeck, "sg-1", {
      rows: [{ lng: -122.4, lat: 37.8, alt: 50, heading: 90 }],
      fieldMapping: {
        lng: "lng",
        lat: "lat",
        altitude: "alt",
        bearing: "heading",
      },
      style: { ...DEFAULT_DECK_VIZ_STYLE },
      opacity: 0.5,
      scenegraph: {
        modelUrl: "https://example.com/model.glb",
        sizeScale: 300,
        sizeMinPixels: 0,
        bearing: 10,
        orientationRoll: 0,
        translation: [0, 0, -500],
        altitude: 25,
      },
    });

    const props = captured.props!;
    assert.equal(props.scenegraph, "https://example.com/model.glb");
    assert.equal(props.sizeScale, 300);
    assert.equal(props.sizeMinPixels, 0);
    assert.equal(props.opacity, 0.5);
    const record = { lng: -122.4, lat: 37.8, alt: 50, heading: 90 };
    const position = (props.getPosition as (r: unknown) => number[])(record);
    // altitude column (50) + base altitude (25)
    assert.deepEqual(position, [-122.4, 37.8, 75]);
    const orientation = (props.getOrientation as (r: unknown) => number[])(record);
    // bearing column (90) drives yaw; configured roll lets KML models opt out
    assert.deepEqual(orientation, [0, 90, 0]);
    assert.deepEqual(props.getTranslation, [0, 0, -500]);
  });

  it("uses the constant bearing/altitude when no columns are mapped", () => {
    const captured: { props?: Record<string, unknown> } = {};
    const fakeDeck = {
      meshLayers: {
        ScenegraphLayer: class {
          constructor(props: Record<string, unknown>) {
            captured.props = props;
          }
        },
      },
    } as unknown as Parameters<typeof def.build>[0];

    def.build(fakeDeck, "sg-2", {
      rows: [{ lng: 1, lat: 2 }],
      fieldMapping: { lng: "lng", lat: "lat" },
      style: { ...DEFAULT_DECK_VIZ_STYLE },
      opacity: 1,
      scenegraph: {
        modelUrl: "https://example.com/model.glb",
        sizeScale: 100,
        bearing: 30,
        altitude: 12,
      },
    });
    const props = captured.props!;
    const record = { lng: 1, lat: 2 };
    assert.deepEqual((props.getPosition as (r: unknown) => number[])(record), [1, 2, 12]);
    assert.deepEqual((props.getOrientation as (r: unknown) => number[])(record), [0, 30, 90]);
  });
});

describe("detectAndParseDeckVizInput tuple width", () => {
  it("offers columns from a later, wider tuple row", () => {
    const parsed = detectAndParseDeckVizInput("[[-1,2],[-3,4,9]]");
    assert.equal(parsed.format, "json-array");
    assert.deepEqual(
      parsed.columns.map((column) => column.value),
      [0, 1, 2],
    );
  });

  it("sniffs a tab delimiter for TSV content", () => {
    const parsed = detectAndParseDeckVizInput("lng\tlat\n-1\t2\n");
    assert.equal(parsed.format, "csv-rows");
    assert.deepEqual(
      parsed.columns.map((column) => column.value),
      ["lng", "lat"],
    );
  });
});
