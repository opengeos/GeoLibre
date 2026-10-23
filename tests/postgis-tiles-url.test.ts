import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  MAX_TILES_IN_FLIGHT,
  POSTGIS_TILES_SOURCE_KIND,
  parsePostgisTileUrl,
  postgisTilesConnectionLabels,
  postgisTilesUrl,
} from "../apps/geolibre-desktop/src/lib/postgis-tiles-url";

const source = {
  connectionLabel: "postgresql://gis:****@db.example.com:5432/city",
  schema: "public",
  table: "roads & paths",
  geometryColumn: "geom",
};

function expand(template: string, z: number, x: number, y: number): string {
  return template.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
}

describe("postgisTilesUrl", () => {
  it("round-trips a source and tile coordinates", () => {
    const url = expand(postgisTilesUrl(source), 12, 2048, 1361);
    assert.deepEqual(parsePostgisTileUrl(url), {
      ...source,
      defaultSrid: undefined,
      z: 12,
      x: 2048,
      y: 1361,
    });
  });

  it("keeps the default SRID only when set", () => {
    assert.ok(!postgisTilesUrl({ ...source, defaultSrid: " " }).includes("srid="));
    const url = expand(postgisTilesUrl({ ...source, defaultSrid: "4326" }), 0, 0, 0);
    assert.equal(parsePostgisTileUrl(url).defaultSrid, "4326");
  });

  it("never contains a password", () => {
    const template = postgisTilesUrl(source);
    assert.ok(template.includes(encodeURIComponent("****")));
    assert.ok(template.startsWith("geolibre-pgtiles://tile/{z}/{x}/{y}?"));
  });
});

describe("parsePostgisTileUrl", () => {
  it("rejects other protocols, bad coordinates and missing parameters", () => {
    const good = expand(postgisTilesUrl(source), 1, 0, 1);
    assert.throws(() => parsePostgisTileUrl(good.replace("geolibre-pgtiles:", "https:")));
    assert.throws(() => parsePostgisTileUrl(expand(postgisTilesUrl(source), 1, -1, 0)));
    assert.throws(() => parsePostgisTileUrl(expand(postgisTilesUrl(source), 1, 0.5, 0)));
    assert.throws(() => parsePostgisTileUrl(good.replace(/&geom=[^&]*/, "")));
    assert.throws(() => parsePostgisTileUrl("geolibre-pgtiles://tile/1/0?conn=a"));
    assert.throws(() => parsePostgisTileUrl(good.replace("://tile/", "://other/")));
  });

  it("does not depend on the URL parser finding a host", () => {
    // Chromium before 130 parsed non-special schemes as an opaque path, so
    // `hostname` was empty; the parser must not read it.
    const url = expand(postgisTilesUrl(source), 3, 4, 5);
    const realUrl = globalThis.URL;
    globalThis.URL = class extends realUrl {
      get hostname() {
        return "";
      }
      get pathname() {
        return "//tile/3/4/5";
      }
    } as typeof URL;
    try {
      assert.deepEqual(parsePostgisTileUrl(url), {
        ...source,
        defaultSrid: undefined,
        z: 3,
        x: 4,
        y: 5,
      });
    } finally {
      globalThis.URL = realUrl;
    }
  });
});

describe("postgisTilesConnectionLabels", () => {
  it("collects the connection labels of native PostGIS tile layers only", () => {
    const labels = postgisTilesConnectionLabels([
      { metadata: { sourceKind: POSTGIS_TILES_SOURCE_KIND, postgisConnectionLabel: "a" } },
      { metadata: { sourceKind: POSTGIS_TILES_SOURCE_KIND, postgisConnectionLabel: "a" } },
      { metadata: { sourceKind: POSTGIS_TILES_SOURCE_KIND, postgisConnectionLabel: "b" } },
      // An editable PostGIS layer carries a label too, but holds no tile pool.
      { metadata: { postgisConnectionLabel: "c" } },
      { metadata: { sourceKind: POSTGIS_TILES_SOURCE_KIND } },
      {},
    ]);
    assert.deepEqual([...labels], ["a", "b"]);
  });
});

describe("MAX_TILES_IN_FLIGHT", () => {
  it("matches the backend's per-connection pool size", () => {
    // More requests than pooled connections would only queue inside the
    // backend, where MapLibre's aborts can no longer drop them.
    const rust = readFileSync(
      fileURLToPath(
        new URL("../apps/geolibre-desktop/src-tauri/src/postgis_tiles.rs", import.meta.url),
      ),
      "utf8",
    );
    const poolSize = /const POOL_SIZE: usize = (\d+);/.exec(rust)?.[1];
    assert.equal(Number(poolSize), MAX_TILES_IN_FLIGHT);
  });
});
