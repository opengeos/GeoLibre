import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  createEmptyProject,
  DEFAULT_LAYER_STYLE,
  inferLayerCapabilities,
  normalizeLayerCapabilities,
  parseProject,
  redactCredentials,
  resolveLayerCapabilities,
  serializeProject,
  type GeoLibreLayer,
} from "@geolibre/core";
import { canEditLayerGeometry } from "../packages/plugins/src/plugins/geo-editor-geometry";

function makeLayer(overrides: Partial<GeoLibreLayer>): GeoLibreLayer {
  return {
    id: "layer-1",
    name: "Layer 1",
    type: "geojson",
    source: {},
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "f1",
          geometry: { type: "Point", coordinates: [0, 0] },
          properties: { name: "Feature 1" },
        },
      ],
    },
    ...overrides,
  };
}

describe("Layer capabilities", () => {
  describe("inferLayerCapabilities", () => {
    test("infers full capabilities for standard in-memory GeoJSON layer", () => {
      const layer = makeLayer({});
      assert.deepEqual(inferLayerCapabilities(layer), {
        query: true,
        create: true,
        update: true,
        delete: true,
        export: true,
      });
    });

    test("infers read-only for raster layers", () => {
      const layer = makeLayer({ type: "raster", geojson: undefined });
      assert.deepEqual(inferLayerCapabilities(layer), {
        query: true,
        create: false,
        update: false,
        delete: false,
        export: true,
      });
    });

    test("infers read-only for DuckDB query layers", () => {
      const layer = makeLayer({
        metadata: { sourceKind: "duckdb-query", query: "SELECT 1" },
      });
      assert.deepEqual(inferLayerCapabilities(layer), {
        query: true,
        create: false,
        update: false,
        delete: false,
        export: true,
      });
    });

    // The Load-into-Editor gate in LayerPanel depends on this: a tile layer
    // infers `create: false`, so gating that action on `create` would remove
    // it from every vector-tiles/pmtiles/mbtiles layer by default. It is gated
    // on `export` instead.
    test("infers create/update/delete false but export true for tile layers", () => {
      for (const type of ["vector-tiles", "pmtiles", "mbtiles"] as const) {
        const layer = makeLayer({ type, geojson: undefined });
        assert.deepEqual(
          inferLayerCapabilities(layer),
          {
            query: true,
            create: false,
            update: false,
            delete: false,
            export: true,
          },
          type,
        );
      }
    });

    test("infers read-only for external native vector layers", () => {
      const layer = makeLayer({
        metadata: { externalNativeLayer: true, sourceKind: "xyz" },
      });
      assert.deepEqual(inferLayerCapabilities(layer), {
        query: true,
        create: false,
        update: false,
        delete: false,
        export: true,
      });
    });
  });

  describe("resolveLayerCapabilities", () => {
    test("returns all false when layer is undefined", () => {
      assert.deepEqual(resolveLayerCapabilities(undefined), {
        query: false,
        create: false,
        update: false,
        delete: false,
        export: false,
      });
    });

    test("applies explicit capability overrides", () => {
      const layer = makeLayer({
        capabilities: {
          update: false,
          delete: false,
          export: false,
        },
      });
      assert.deepEqual(resolveLayerCapabilities(layer), {
        query: true,
        create: true,
        update: false,
        delete: false,
        export: false,
      });
    });
  });

  describe("normalizeLayerCapabilities", () => {
    test("parses valid boolean properties", () => {
      assert.deepEqual(
        normalizeLayerCapabilities({ query: true, update: false, export: true, extra: 123 }),
        { query: true, update: false, export: true },
      );
    });

    test("returns undefined for invalid inputs", () => {
      assert.equal(normalizeLayerCapabilities(null), undefined);
      assert.equal(normalizeLayerCapabilities([]), undefined);
      assert.equal(normalizeLayerCapabilities("string"), undefined);
      assert.equal(normalizeLayerCapabilities({}), undefined);
    });
  });

  describe("canEditLayerGeometry with capabilities", () => {
    test("returns true for normal editable layer", () => {
      const layer = makeLayer({});
      assert.equal(canEditLayerGeometry(layer), true);
    });

    test("returns false when capabilities.update is false", () => {
      const layer = makeLayer({ capabilities: { update: false } });
      assert.equal(canEditLayerGeometry(layer), false);
    });
  });

  describe("project serialization and export redaction", () => {
    test("round-trips layer capabilities in project format", () => {
      const project = createEmptyProject("Capabilities Project");
      const layer = makeLayer({
        capabilities: {
          update: false,
          export: false,
        },
      });
      project.layers = [layer];

      const serialized = serializeProject(project);
      const parsed = parseProject(serialized);

      assert.deepEqual(parsed.layers[0].capabilities, {
        update: false,
        export: false,
      });
    });

    test("drops a malformed capabilities value rather than carrying it through", () => {
      const project = createEmptyProject("Malformed Capabilities");
      project.layers = [
        makeLayer({
          capabilities: { bogus: "yes" } as unknown as GeoLibreLayer["capabilities"],
        }),
      ];

      const parsed = parseProject(serializeProject(project));

      assert.equal(parsed.layers[0].capabilities, undefined);
    });

    test("redactCredentials strips geojson when export capability is false", () => {
      const project = createEmptyProject("Share Test");
      const exportAllowedLayer = makeLayer({ id: "l1", capabilities: { export: true } });
      const noExportLayer = makeLayer({
        id: "l2",
        capabilities: { export: false },
        metadata: { embeddedGeoJSON: { type: "FeatureCollection", features: [] } },
      });

      project.layers = [exportAllowedLayer, noExportLayer];

      const redacted = redactCredentials(project);
      assert.ok(redacted.layers[0].geojson !== undefined);
      assert.equal(redacted.layers[1].geojson, undefined);
      assert.equal(redacted.layers[1].metadata.embeddedGeoJSON, undefined);
    });
  });
});
