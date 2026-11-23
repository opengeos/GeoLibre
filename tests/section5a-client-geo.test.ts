import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import { DEFAULT_LAYER_STYLE } from "@geolibre/core";
import {
  reprojectFeatureCollectionToWgs84,
  resolveCrsDefinition,
} from "../packages/processing/src";
import { reprojectTool } from "../packages/processing/src/vector-tools";

describe("client-side vector reprojection (proj4)", () => {
  it("resolves EPSG:3857, UTM EPSG:32617, and raw PROJ strings", async () => {
    const merc = await resolveCrsDefinition("EPSG:3857");
    assert.ok(merc);
    assert.equal(merc.definition, "EPSG:3857");

    const utm = await resolveCrsDefinition("epsg:32617");
    assert.ok(utm);
    assert.match(utm.definition, /\+proj=(?:utm|tmerc)/);
    assert.match(utm.definition, /\+lon_0=-81\b/);

    const unknown = await resolveCrsDefinition("EPSG:999999");
    assert.equal(unknown, null);
  });

  it("reprojects Point, LineString, Polygon, and preserves Z coordinates and properties", async () => {
    const input: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "Mercator point" },
          geometry: {
            type: "Point",
            coordinates: [-8800000, 4200000, 325.5],
          },
        },
        {
          type: "Feature",
          properties: { name: "Mercator line" },
          geometry: {
            type: "LineString",
            coordinates: [
              [-8800000, 4200000],
              [-8700000, 4300000],
            ],
          },
        },
      ],
    };
    const out = await reprojectFeatureCollectionToWgs84(input, "EPSG:3857");
    assert.equal(out.features.length, 2);
    const pt = out.features[0];
    assert.equal(pt.properties?.name, "Mercator point");
    assert.equal(pt.geometry?.type, "Point");
    if (pt.geometry?.type === "Point") {
      assert.ok(Math.abs(pt.geometry.coordinates[0] - -79.05174500251788) < 1e-6);
      assert.ok(Math.abs(pt.geometry.coordinates[1] - 35.26535092860737) < 1e-6);
      assert.equal(pt.geometry.coordinates[2], 325.5);
    }
  });

  it("reprojectTool runs natively without requiresSidecar and supports UTM", async () => {
    assert.notEqual(reprojectTool.requiresSidecar, true);
    const logs: string[] = [];
    let result: FeatureCollection | null = null;
    await reprojectTool.run({
      layers: [
        {
          id: "l1",
          name: "UTM Points",
          type: "geojson",
          source: { type: "geojson" },
          visible: true,
          opacity: 1,
          style: { ...DEFAULT_LAYER_STYLE },
          metadata: {},
          geojson: {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                properties: { city: "Knoxville" },
                geometry: { type: "Point", coordinates: [236000, 3983000] },
              },
            ],
          },
        },
      ],
      parameters: { layer: "l1", source_crs: "EPSG:32617" },
      log: (msg) => logs.push(msg),
      addResultLayer: (_name, fc) => {
        result = fc;
      },
    });
    assert.ok(result, `Expected reprojected layer, logs: ${logs.join("; ")}`);
    const feat = (result as FeatureCollection).features[0];
    assert.equal(feat.geometry?.type, "Point");
    if (feat.geometry?.type === "Point") {
      const [lon, lat] = feat.geometry.coordinates;
      assert.ok(lon > -84.5 && lon < -83.5, `unexpected lon ${lon}`);
      assert.ok(lat > 35.5 && lat < 36.5, `unexpected lat ${lat}`);
    }
  });

  it("raster-client.ts and raster-expr.ts do not call new Function or eval", () => {
    for (const rel of [
      "../packages/processing/src/raster-client.ts",
      "../packages/processing/src/raster-expr.ts",
    ]) {
      const src = readFileSync(new URL(rel, import.meta.url), "utf8").replace(
        /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
        "",
      );
      assert.equal(/\bnew\s+Function\s*\(/.test(src), false, `${rel} must not call new Function`);
      assert.equal(/\beval\s*\(/.test(src), false, `${rel} must not call eval`);
    }
  });
});
