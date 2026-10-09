import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { writeArrayBuffer } from "geotiff";
import { toProj4 } from "geotiff-geokeys-to-proj4";
import { initTools } from "geolibre-wasm/tools";
import proj4 from "proj4";
import {
  datumShiftFor,
  installCogTilerDatumShift,
  withDatumShift,
  withGeoKeysDatumShift,
} from "@geolibre/core";
import { polygonizeLabels } from "@geolibre/processing";
import { datumShiftEpsgResolver } from "../packages/plugins/src/plugins/epsg-datum-resolver";

/** The British National Grid as the EPSG tables give it (no datum shift). */
const bng = () =>
  (toProj4({ ProjectedCSTypeGeoKey: 27700 } as never).proj4 ?? "").replace(/\+axis=\w+\s*/g, "");

/** Metres between two lon/lat points (small distances). */
const metres = ([x1, y1]: number[], [x2, y2]: number[]) =>
  Math.hypot((x1 - x2) * 111320 * Math.cos((y1 * Math.PI) / 180), (y1 - y2) * 111320);

// PROJ (pyproj 3, best available OSGB36 to WGS84 transformation) for the
// British National Grid point (292100, 329590).
const PROJ_LONLAT = [-3.6038184838898335, 52.85297290276153];

describe("datum shifts", () => {
  it("adds the British National Grid's shift, which the EPSG tables leave out", () => {
    const raw = bng();
    assert.doesNotMatch(raw, /towgs84/);
    const shifted = withDatumShift(raw, 27700);
    assert.match(shifted, /\+towgs84=446\.448,-125\.157,542\.06/);
    // Without the shift proj4 is about 86 m off; with it, within 2 m (PROJ uses
    // the finer OSTN15 grid).
    const plain = proj4(raw, "EPSG:4326", [292100, 329590]);
    const fixed = proj4(shifted, "EPSG:4326", [292100, 329590]);
    assert.ok(metres(plain, PROJ_LONLAT) > 80);
    assert.ok(metres(fixed, PROJ_LONLAT) < 2);
  });

  it("leaves definitions that already shift, and codes it does not know", () => {
    assert.equal(withDatumShift("+proj=tmerc +towgs84=1,2,3", 27700), "+proj=tmerc +towgs84=1,2,3");
    assert.equal(
      withDatumShift("+proj=utm +zone=31 +datum=WGS84", 27700),
      "+proj=utm +zone=31 +datum=WGS84",
    );
    assert.equal(
      withDatumShift("+proj=utm +zone=31 +ellps=WGS84", 32631),
      "+proj=utm +zone=31 +ellps=WGS84",
    );
    assert.equal(datumShiftFor(32631), null);
    assert.equal(datumShiftFor(3857), null);
  });

  it("finds the code in GeoTIFF geokeys, or the datum of a user-defined CRS", () => {
    assert.match(withGeoKeysDatumShift("+proj=tmerc", { ProjectedCSTypeGeoKey: 27700 }), /towgs84/);
    assert.match(
      withGeoKeysDatumShift("+proj=longlat", { GeographicTypeGeoKey: 4314 }),
      /towgs84=598\.1/,
    );
    // User-defined projection (32767) on the Amersfoort datum (6289).
    assert.match(
      withGeoKeysDatumShift("+proj=sterea", {
        ProjectedCSTypeGeoKey: 32767,
        GeogGeodeticDatumGeoKey: 6289,
      }),
      /towgs84=565\.417/,
    );
    assert.equal(withGeoKeysDatumShift("+proj=tmerc", {}), "+proj=tmerc");
    assert.equal(withGeoKeysDatumShift("+proj=tmerc", null), "+proj=tmerc");
  });

  it("installs the cog-tiler hook, leaving WKT alone", () => {
    let hook: ((def: string, keys: Record<string, unknown>) => string | null | undefined) | null =
      null;
    installCogTilerDatumShift({ setSourceCrsResolver: (fn) => (hook = fn) });
    assert.ok(hook);
    const resolve = hook as (def: string, keys: Record<string, unknown>) => string;
    assert.match(resolve(bng(), { ProjectedCSTypeGeoKey: 27700 }), /towgs84/);
    const wkt = 'PROJCS["OSGB 1936 / British National Grid"]';
    assert.equal(resolve(wkt, { ProjectedCSTypeGeoKey: 27700 }), wkt);
    // An older tiler without the hook is left as it is.
    assert.doesNotThrow(() => installCogTilerDatumShift({}));
  });

  it("resolves datum-shifted codes offline for deck.gl COG layers, others through the fallback", async () => {
    const asked: number[] = [];
    const resolver = datumShiftEpsgResolver(async (epsg) => {
      asked.push(epsg);
      return { projName: "fallback" } as never;
    });
    const def = (await resolver(27700)) as unknown as Record<string, unknown>;
    assert.equal(def.units, "m");
    assert.deepEqual((def.datum_params as number[]).slice(0, 3), [446.448, -125.157, 542.06]);
    const lonLat = proj4(def as never, "EPSG:4326", [292100, 329590]);
    assert.ok(metres(lonLat, PROJ_LONLAT) < 2);
    assert.deepEqual(asked, []);
    assert.equal(((await resolver(32631)) as unknown as { projName: string }).projName, "fallback");
    assert.deepEqual(asked, [32631]);
  });

  it("places polygonized objects through the raster's datum-shifted CRS", async () => {
    await initTools(
      readFileSync(new URL("../node_modules/geolibre-wasm/geolibre-cli.wasm", import.meta.url)),
    );
    // A 4 × 2 label raster on the British National Grid, 15 m pixels: object 1
    // on the left half, object 2 on the right.
    const labels = new Float32Array([1, 1, 2, 2, 1, 1, 2, 2]);
    const tiff = writeArrayBuffer(labels, {
      width: 4,
      height: 2,
      ModelPixelScale: [15, 15, 0],
      ModelTiepoint: [0, 0, 0, 292100, 329590, 0],
      ProjectedCSTypeGeoKey: 27700,
      GTModelTypeGeoKey: 1,
      GTRasterTypeGeoKey: 1,
    } as Parameters<typeof writeArrayBuffer>[1]) as ArrayBuffer;
    const objects = await polygonizeLabels(new Uint8Array(tiff));
    assert.equal(objects.features.length, 2);
    const ring = (id: number) => {
      const geometry = objects.features.find((f) => f.properties?.segment_id === id)?.geometry;
      return geometry?.type === "Polygon" ? geometry.coordinates[0] : [];
    };
    // Object 1's north-west corner is the raster's corner, where PROJ puts it.
    const west = Math.min(...ring(1).map((p) => p[0]));
    const north = Math.max(...ring(1).map((p) => p[1]));
    assert.ok(metres([west, north], PROJ_LONLAT) < 2, `corner ${west}, ${north}`);
    // Object 2 starts 30 m (2 pixels) east of it.
    const west2 = Math.min(...ring(2).map((p) => p[0]));
    assert.ok(Math.abs(metres([west2, north], [west, north]) - 30) < 0.5);
  });
});
