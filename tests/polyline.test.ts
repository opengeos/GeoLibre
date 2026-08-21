import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  batchDecodePolylines,
  decodePolyline,
  encodePolyline,
  geoJSONToPolylineStr,
  polylineStrToGeoJSON,
  unescapePolyline,
} from "@geolibre/core";
import type { Feature, FeatureCollection, LineString, MultiLineString } from "geojson";

describe("polyline codec", () => {
  describe("decodePolyline", () => {
    it("decodes the canonical Google precision-5 example to [lon, lat] pairs", () => {
      // Google docs example:
      // (38.5, -120.2), (40.7, -120.95), (43.252, -126.453)
      // Polyline string: "_p~iF~ps|U_ulLnnqC_mqNvxq`@"
      const coords = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@", 5);
      assert.equal(coords.length, 3);
      assert.ok(Math.abs(coords[0][0] - -120.2) < 1e-5);
      assert.ok(Math.abs(coords[0][1] - 38.5) < 1e-5);
      assert.ok(Math.abs(coords[1][0] - -120.95) < 1e-5);
      assert.ok(Math.abs(coords[1][1] - 40.7) < 1e-5);
      assert.ok(Math.abs(coords[2][0] - -126.453) < 1e-5);
      assert.ok(Math.abs(coords[2][1] - 43.252) < 1e-5);
    });

    it("defaults to precision 5", () => {
      const coords = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
      assert.equal(coords.length, 3);
      assert.ok(Math.abs(coords[0][0] - -120.2) < 1e-5);
      assert.ok(Math.abs(coords[0][1] - 38.5) < 1e-5);
    });

    it("decodes a Valhalla precision-6 polyline", () => {
      // Sequence with 6 digits precision: [[-77.05, 38.88], [-77.04, 38.89], [-77.02, 38.9]]
      const coords = decodePolyline("_o`diA~gw}qC_pR_pR_pR_af@", 6);
      assert.equal(coords.length, 3);
      assert.ok(Math.abs(coords[0][0] - -77.05) < 1e-6);
      assert.ok(Math.abs(coords[0][1] - 38.88) < 1e-6);
      assert.ok(Math.abs(coords[1][0] - -77.04) < 1e-6);
      assert.ok(Math.abs(coords[1][1] - 38.89) < 1e-6);
      assert.ok(Math.abs(coords[2][0] - -77.02) < 1e-6);
      assert.ok(Math.abs(coords[2][1] - 38.9) < 1e-6);
    });

    it("returns an empty array for an empty or invalid string", () => {
      assert.deepEqual(decodePolyline(""), []);
      assert.deepEqual(decodePolyline(null as unknown as string), []);
      assert.deepEqual(decodePolyline(undefined as unknown as string), []);
    });

    it("drops a truncated trailing chunk instead of emitting NaN", () => {
      // Truncated mid-varint
      const coords = decodePolyline("_p~iF~ps|U_ulLnnqC_mqN", 5);
      assert.ok(Array.isArray(coords));
      assert.ok(coords.length >= 1);
      for (const [lon, lat] of coords) {
        assert.ok(Number.isFinite(lon));
        assert.ok(Number.isFinite(lat));
      }
    });

    it("rejects overlong varint input '_______?' exceeding 30-bit shift bounds", () => {
      assert.deepEqual(decodePolyline("_______?", 5), []);
    });
  });

  describe("encodePolyline", () => {
    it("encodes coordinate array to standard precision-5 polyline", () => {
      const coords: [number, number][] = [
        [-120.2, 38.5],
        [-120.95, 40.7],
        [-126.453, 43.252],
      ];
      const encoded = encodePolyline(coords, 5);
      assert.equal(encoded, "_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    });

    it("encodes coordinate array to precision-6 polyline", () => {
      const coords: [number, number][] = [
        [-77.05, 38.88],
        [-77.04, 38.89],
        [-77.02, 38.9],
      ];
      const encoded = encodePolyline(coords, 6);
      assert.equal(encoded, "_o`diA~gw}qC_pR_pR_pR_af@");
    });

    it("returns empty string for empty input", () => {
      assert.equal(encodePolyline([]), "");
      assert.equal(encodePolyline(null as unknown as [number, number][]), "");
    });

    it("skips non-finite coordinates cleanly", () => {
      const coords: [number, number][] = [
        [-120.2, 38.5],
        [NaN, 40.0],
        [-120.95, 40.7],
      ];
      const encoded = encodePolyline(coords, 5);
      const decoded = decodePolyline(encoded, 5);
      assert.equal(decoded.length, 2);
    });

    it("round-trips arbitrary coordinates accurately at precision 5 and 6", () => {
      const original5: [number, number][] = [
        [106.6297, 10.8231],
        [106.635, 10.828],
        [106.64, 10.835],
      ];
      const encoded5 = encodePolyline(original5, 5);
      const decoded5 = decodePolyline(encoded5, 5);
      assert.equal(decoded5.length, original5.length);
      for (let i = 0; i < original5.length; i++) {
        assert.ok(Math.abs(decoded5[i][0] - original5[i][0]) < 1e-5);
        assert.ok(Math.abs(decoded5[i][1] - original5[i][1]) < 1e-5);
      }

      const original6: [number, number][] = [
        [-73.985131, 40.748817],
        [-73.984012, 40.749521],
        [-73.982103, 40.750614],
      ];
      const encoded6 = encodePolyline(original6, 6);
      const decoded6 = decodePolyline(encoded6, 6);
      assert.equal(decoded6.length, original6.length);
      for (let i = 0; i < original6.length; i++) {
        assert.ok(Math.abs(decoded6[i][0] - original6[i][0]) < 1e-6);
        assert.ok(Math.abs(decoded6[i][1] - original6[i][1]) < 1e-6);
      }
    });
  });

  describe("unescapePolyline", () => {
    it("unescapes double-escaped backslashes and escape sequences", () => {
      const escaped = "_p~iF~ps|U_ulLnnqC_mqNvxq\\\\`@";
      assert.equal(unescapePolyline(escaped), "_p~iF~ps|U_ulLnnqC_mqNvxq\\`@");
      const decoded = decodePolyline(escaped, 5, true);
      assert.equal(decoded.length, 3);
    });

    it("preserves literal \\n, \\r, and \\t sequences without converting to control characters", () => {
      assert.equal(unescapePolyline("abc\\ndef"), "abc\\ndef");
      assert.equal(unescapePolyline("abc\\rdef"), "abc\\rdef");
      assert.equal(unescapePolyline("abc\\tdef"), "abc\\tdef");
      assert.equal(unescapePolyline("a\\\"b\\'c\\\\d"), "a\"b'c\\d");
    });
  });

  describe("batchDecodePolylines", () => {
    it("decodes newline-separated polylines into LineString features", () => {
      const text = "_p~iF~ps|U_ulLnnqC_mqNvxq`@\n_p~iF~ps|U_ulLnnqC_mqNvxq`@";
      const fc = batchDecodePolylines(text, { precision: 5 });
      assert.equal(fc.type, "FeatureCollection");
      assert.equal(fc.features.length, 2);
      assert.equal(fc.features[0].geometry.type, "LineString");
    });

    it("decodes semicolon-separated polylines with custom delimiter", () => {
      const text = "_p~iF~ps|U_ulLnnqC_mqNvxq`@;_p~iF~ps|U_ulLnnqC_mqNvxq`@";
      const fc = batchDecodePolylines(text, { precision: 5, delimiter: ";" });
      assert.equal(fc.features.length, 2);
    });

    it("supports asMultiLine to merge into a single MultiLineString feature", () => {
      const text = "_p~iF~ps|U_ulLnnqC_mqNvxq`@\n_p~iF~ps|U_ulLnnqC_mqNvxq`@";
      const fc = batchDecodePolylines(text, { precision: 5, asMultiLine: true });
      assert.equal(fc.features.length, 1);
      assert.equal(fc.features[0].geometry.type, "MultiLineString");
      assert.equal((fc.features[0].geometry as MultiLineString).coordinates.length, 2);
    });

    it("skips malformed, truncated, or invalid lines in batch decoding", () => {
      const text = [
        "_p~iF~ps|U_ulLnnqC_mqNvxq`@", // valid line (3 points)
        "invalid/character/in/line", // invalid chars (< 63)
        "_p~iF~ps|U_ulLnnqC_mqN", // truncated varint
        "_______?", // overlong varint shift
        "_p~iF~ps|U_ulLnnqC_mqNvxq`@", // valid line (3 points)
      ].join("\n");
      const fc = batchDecodePolylines(text, { precision: 5 });
      assert.equal(fc.features.length, 2);
      assert.equal(fc.features[0].geometry.coordinates.length, 3);
      assert.equal(fc.features[1].geometry.coordinates.length, 3);
    });
  });

  describe("polylineStrToGeoJSON", () => {
    it("creates a GeoJSON LineString Feature from polyline string", () => {
      const str = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";
      const feat = polylineStrToGeoJSON(str, 5, { name: "Route 1" });
      assert.equal(feat.type, "Feature");
      assert.equal(feat.geometry.type, "LineString");
      assert.equal(feat.geometry.coordinates.length, 3);
      assert.equal(feat.properties?.name, "Route 1");
    });
  });

  describe("geoJSONToPolylineStr", () => {
    it("converts LineString geometry to polyline string", () => {
      const line: LineString = {
        type: "LineString",
        coordinates: [
          [-120.2, 38.5],
          [-120.95, 40.7],
          [-126.453, 43.252],
        ],
      };
      assert.equal(geoJSONToPolylineStr(line, 5), "_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    });

    it("converts MultiLineString geometry to array of polyline strings", () => {
      const multiLine: MultiLineString = {
        type: "MultiLineString",
        coordinates: [
          [
            [-120.2, 38.5],
            [-120.95, 40.7],
          ],
          [
            [-122.4194, 37.7749],
            [-122.4174, 37.7769],
          ],
        ],
      };
      const result = geoJSONToPolylineStr(multiLine, 5);
      assert.ok(Array.isArray(result));
      assert.equal(result.length, 2);
    });

    it("converts FeatureCollection of lines", () => {
      const fc: FeatureCollection<LineString> = {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: {
              type: "LineString",
              coordinates: [
                [-120.2, 38.5],
                [-120.95, 40.7],
              ],
            },
          },
        ],
      };
      const result = geoJSONToPolylineStr(fc, 5);
      assert.ok(Array.isArray(result));
      assert.equal(result.length, 1);
    });
  });

  describe("processing tools", () => {
    it("decodePolylineTool decodes polyline attribute into LineString layer", async () => {
      const { decodePolylineTool } = await import("@geolibre/processing");
      const layerWithPolyline = {
        id: "test-poly-layer",
        name: "Polyline Test",
        type: "geojson" as const,
        visible: true,
        opacity: 1,
        style: {} as any,
        metadata: {},
        source: { type: "geojson" as const },
        geojson: {
          type: "FeatureCollection" as const,
          features: [
            {
              type: "Feature" as const,
              properties: { routeId: "R1", poly: "_p~iF~ps|U_ulLnnqC_mqNvxq`@" },
              geometry: null as any,
            },
          ],
        },
      };

      let resultName = "";
      let resultFc: FeatureCollection | undefined;
      const logs: string[] = [];

      decodePolylineTool.run({
        layers: [layerWithPolyline as any],
        parameters: {
          layer: "test-poly-layer",
          field: "poly",
          precision: "5",
        },
        log: (msg) => logs.push(msg),
        addResultLayer: (name, fc) => {
          resultName = name;
          resultFc = fc;
        },
      });

      assert.equal(resultName, "Decoded polylines");
      assert.ok(resultFc);
      assert.equal(resultFc.features.length, 1);
      assert.equal(resultFc.features[0].geometry.type, "LineString");
      assert.equal((resultFc.features[0].geometry as LineString).coordinates.length, 3);
      assert.equal(resultFc.features[0].properties?.routeId, "R1");
    });

    it("encodePolylineTool encodes line geometries into attribute field", async () => {
      const { encodePolylineTool } = await import("@geolibre/processing");
      const lineLayer = {
        id: "test-line-layer",
        name: "Line Test",
        type: "geojson" as const,
        visible: true,
        opacity: 1,
        style: {} as any,
        metadata: {},
        source: { type: "geojson" as const },
        geojson: {
          type: "FeatureCollection" as const,
          features: [
            {
              type: "Feature" as const,
              properties: { name: "Route A" },
              geometry: {
                type: "LineString" as const,
                coordinates: [
                  [-120.2, 38.5],
                  [-120.95, 40.7],
                  [-126.453, 43.252],
                ],
              },
            },
          ],
        },
      };

      let resultName = "";
      let resultFc: FeatureCollection | undefined;
      const logs: string[] = [];

      encodePolylineTool.run({
        layers: [lineLayer as any],
        parameters: {
          layer: "test-line-layer",
          precision: "5",
          targetField: "encoded_geom",
        },
        log: (msg) => logs.push(msg),
        addResultLayer: (name, fc) => {
          resultName = name;
          resultFc = fc;
        },
      });

      assert.equal(resultName, "Encoded polylines");
      assert.ok(resultFc);
      assert.equal(resultFc.features.length, 1);
      assert.equal(resultFc.features[0].properties?.encoded_geom, "_p~iF~ps|U_ulLnnqC_mqNvxq`@");
      assert.equal(resultFc.features[0].properties?.name, "Route A");
    });

    it("decodePolylineTool skips malformed polyline string containing invalid characters like '/'", async () => {
      const { decodePolylineTool } = await import("@geolibre/processing");
      const layerWithInvalidPoly = {
        id: "test-poly-layer-invalid",
        name: "Invalid Polyline",
        type: "geojson" as const,
        visible: true,
        opacity: 1,
        style: {} as any,
        metadata: {},
        source: { type: "geojson" as const },
        geojson: {
          type: "FeatureCollection" as const,
          features: [
            {
              type: "Feature" as const,
              properties: { routeId: "Bad", poly: "_p~iF/invalid" },
              geometry: null as any,
            },
          ],
        },
      };

      let resultFc: FeatureCollection | undefined;
      const logs: string[] = [];

      decodePolylineTool.run({
        layers: [layerWithInvalidPoly as any],
        parameters: {
          layer: "test-poly-layer-invalid",
          field: "poly",
          precision: "5",
        },
        log: (msg) => logs.push(msg),
        addResultLayer: (_name, fc) => {
          resultFc = fc;
        },
      });

      assert.ok(resultFc);
      assert.equal(resultFc.features.length, 0);
      assert.ok(logs.some((msg) => msg.includes("Skipped 1 feature(s)")));
    });

    it("round-trips MultiLineString features through encodePolylineTool and decodePolylineTool", async () => {
      const { encodePolylineTool, decodePolylineTool } = await import("@geolibre/processing");
      const multiLineLayer = {
        id: "test-multi-layer",
        name: "MultiLine Test",
        type: "geojson" as const,
        visible: true,
        opacity: 1,
        style: {} as any,
        metadata: {},
        source: { type: "geojson" as const },
        geojson: {
          type: "FeatureCollection" as const,
          features: [
            {
              type: "Feature" as const,
              properties: { routeGroup: "Multi1" },
              geometry: {
                type: "MultiLineString" as const,
                coordinates: [
                  [
                    [-120.2, 38.5],
                    [-120.95, 40.7],
                  ],
                  [
                    [-77.05, 38.88],
                    [-77.04, 38.89],
                  ],
                ],
              },
            },
          ],
        },
      };

      let encodedFc: FeatureCollection | undefined;
      encodePolylineTool.run({
        layers: [multiLineLayer as any],
        parameters: {
          layer: "test-multi-layer",
          precision: "5",
          targetField: "poly_str",
        },
        log: () => {},
        addResultLayer: (_name, fc) => {
          encodedFc = fc;
        },
      });

      assert.ok(encodedFc);
      assert.equal(encodedFc.features.length, 1);
      const encodedProp = encodedFc.features[0].properties?.poly_str;
      assert.ok(typeof encodedProp === "string" && encodedProp.includes(";"));

      const encodedLayer = {
        id: "test-encoded-layer",
        name: "Encoded",
        type: "geojson" as const,
        visible: true,
        opacity: 1,
        style: {} as any,
        metadata: {},
        source: { type: "geojson" as const },
        geojson: encodedFc,
      };

      let decodedFc: FeatureCollection | undefined;
      decodePolylineTool.run({
        layers: [encodedLayer as any],
        parameters: {
          layer: "test-encoded-layer",
          field: "poly_str",
          precision: "5",
        },
        log: () => {},
        addResultLayer: (_name, fc) => {
          decodedFc = fc;
        },
      });

      assert.ok(decodedFc);
      assert.equal(decodedFc.features.length, 1);
      const decodedGeom = decodedFc.features[0].geometry;
      assert.ok(decodedGeom);
      assert.equal(decodedGeom.type, "MultiLineString");
      assert.equal((decodedGeom as MultiLineString).coordinates.length, 2);
      assert.equal(decodedFc.features[0].properties?.routeGroup, "Multi1");
    });

    it("decodePolylineTool skips oversized-varint input that exceeds coordinate bounds", async () => {
      const { decodePolylineTool } = await import("@geolibre/processing");
      const layerWithOversizedPoly = {
        id: "test-poly-layer-oversized",
        name: "Oversized Polyline",
        type: "geojson" as const,
        visible: true,
        opacity: 1,
        style: {} as any,
        metadata: {},
        source: { type: "geojson" as const },
        geojson: {
          type: "FeatureCollection" as const,
          features: [
            {
              type: "Feature" as const,
              properties: { routeId: "Oversized", poly: "_o`diA~gw}qC_pR_pR_pR_af@" },
              geometry: null as any,
            },
          ],
        },
      };

      let resultFc: FeatureCollection | undefined;
      const logs: string[] = [];

      decodePolylineTool.run({
        layers: [layerWithOversizedPoly as any],
        parameters: {
          layer: "test-poly-layer-oversized",
          field: "poly",
          precision: "5",
        },
        log: (msg) => logs.push(msg),
        addResultLayer: (_name, fc) => {
          resultFc = fc;
        },
      });

      assert.ok(resultFc);
      assert.equal(resultFc.features.length, 0);
      assert.ok(logs.some((msg) => msg.includes("Skipped 1 feature(s)")));
    });

    it("decodePolylineTool skips valid polyline with an appended incomplete coordinate", async () => {
      const { decodePolylineTool } = await import("@geolibre/processing");
      const layerWithIncompletePoly = {
        id: "test-poly-layer-incomplete",
        name: "Incomplete Polyline",
        type: "geojson" as const,
        visible: true,
        opacity: 1,
        style: {} as any,
        metadata: {},
        source: { type: "geojson" as const },
        geojson: {
          type: "FeatureCollection" as const,
          features: [
            {
              type: "Feature" as const,
              properties: {
                routeId: "Incomplete",
                poly: "_p~iF~ps|U_ulLnnqC_mqNvxq`@_mqN",
              },
              geometry: null as any,
            },
          ],
        },
      };

      let resultFc: FeatureCollection | undefined;
      const logs: string[] = [];

      decodePolylineTool.run({
        layers: [layerWithIncompletePoly as any],
        parameters: {
          layer: "test-poly-layer-incomplete",
          field: "poly",
          precision: "5",
        },
        log: (msg) => logs.push(msg),
        addResultLayer: (_name, fc) => {
          resultFc = fc;
        },
      });

      assert.ok(resultFc);
      assert.equal(resultFc.features.length, 0);
      assert.ok(logs.some((msg) => msg.includes("Skipped 1 feature(s)")));
    });

    it("decodePolylineTool skips overlong varint input '_______?' and does not accept it as LineString", async () => {
      const { decodePolylineTool } = await import("@geolibre/processing");
      const layerWithOverlongPoly = {
        id: "test-poly-layer-overlong",
        name: "Overlong Polyline",
        type: "geojson" as const,
        visible: true,
        opacity: 1,
        style: {} as any,
        metadata: {},
        source: { type: "geojson" as const },
        geojson: {
          type: "FeatureCollection" as const,
          features: [
            {
              type: "Feature" as const,
              properties: {
                routeId: "Overlong",
                poly: "_______?",
              },
              geometry: null as any,
            },
          ],
        },
      };

      let resultFc: FeatureCollection | undefined;
      const logs: string[] = [];

      decodePolylineTool.run({
        layers: [layerWithOverlongPoly as any],
        parameters: {
          layer: "test-poly-layer-overlong",
          field: "poly",
          precision: "5",
        },
        log: (msg) => logs.push(msg),
        addResultLayer: (_name, fc) => {
          resultFc = fc;
        },
      });

      assert.ok(resultFc);
      assert.equal(resultFc.features.length, 0);
      assert.ok(logs.some((msg) => msg.includes("Skipped 1 feature(s)")));
    });
  });

  describe("drag and drop file ingestion", () => {
    it("loads dropped .polyline files directly into FeatureCollection layers", async () => {
      const { loadDroppedVectorFiles } = await import("../apps/geolibre-desktop/src/lib/tauri-io");
      const mockPolylineFile = new File(
        ["_p~iF~ps|U_ulLnnqC_mqNvxq`@\n_p~iF~ps|U_ulLnnqC_mqNvxq`@"],
        "Polyline.polyline",
        { type: "text/plain" },
      );

      const loaded = await loadDroppedVectorFiles([mockPolylineFile]);
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].name, "Polyline");
      assert.equal(loaded[0].data.type, "FeatureCollection");
      assert.equal(loaded[0].data.features.length, 2);
      assert.equal(loaded[0].data.features[0].geometry.type, "LineString");
    });
  });

  describe("layer export geometry restrictions", () => {
    it("layerSupportsPolylineExport returns true only for line layers", async () => {
      const { layerSupportsPolylineExport } =
        await import("../apps/geolibre-desktop/src/lib/vector-export");

      const lineLayer = {
        id: "l1",
        name: "Line Layer",
        type: "geojson" as const,
        visible: true,
        opacity: 1,
        style: {} as any,
        metadata: {},
        source: { type: "geojson" as const },
        geojson: {
          type: "FeatureCollection" as const,
          features: [
            {
              type: "Feature" as const,
              properties: {},
              geometry: {
                type: "LineString" as const,
                coordinates: [
                  [0, 0],
                  [1, 1],
                ],
              },
            },
          ],
        },
      };

      const pointLayer = {
        id: "p1",
        name: "Point Layer",
        type: "geojson" as const,
        visible: true,
        opacity: 1,
        style: {} as any,
        metadata: { geometryType: "point" },
        source: { type: "geojson" as const },
        geojson: {
          type: "FeatureCollection" as const,
          features: [
            {
              type: "Feature" as const,
              properties: {},
              geometry: {
                type: "Point" as const,
                coordinates: [0, 0],
              },
            },
          ],
        },
      };

      const polygonLayer = {
        id: "poly1",
        name: "Polygon Layer",
        type: "geojson" as const,
        visible: true,
        opacity: 1,
        style: {} as any,
        metadata: { geometryType: "polygon" },
        source: { type: "geojson" as const },
        geojson: {
          type: "FeatureCollection" as const,
          features: [
            {
              type: "Feature" as const,
              properties: {},
              geometry: {
                type: "Polygon" as const,
                coordinates: [
                  [
                    [0, 0],
                    [1, 0],
                    [1, 1],
                    [0, 1],
                    [0, 0],
                  ],
                ],
              },
            },
          ],
        },
      };

      const mixedLayer = {
        id: "m1",
        name: "Mixed Layer",
        type: "geojson" as const,
        visible: true,
        opacity: 1,
        style: {} as any,
        metadata: {},
        source: { type: "geojson" as const },
        geojson: {
          type: "FeatureCollection" as const,
          features: [
            {
              type: "Feature" as const,
              properties: {},
              geometry: {
                type: "LineString" as const,
                coordinates: [
                  [0, 0],
                  [1, 1],
                ],
              },
            },
            {
              type: "Feature" as const,
              properties: {},
              geometry: {
                type: "Point" as const,
                coordinates: [0, 0],
              },
            },
          ],
        },
      };

      assert.equal(layerSupportsPolylineExport(lineLayer as any), true);
      assert.equal(layerSupportsPolylineExport(pointLayer as any), false);
      assert.equal(layerSupportsPolylineExport(polygonLayer as any), false);
      assert.equal(layerSupportsPolylineExport(mixedLayer as any), false);
    });
  });
});
