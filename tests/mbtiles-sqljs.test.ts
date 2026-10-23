import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { before, describe, it } from "node:test";
import { gzipSync, zlibSync } from "fflate";
import initSqlJs from "sql.js";
import type { Database, SqlJsStatic } from "sql.js";
import {
  BROWSER_MBTILES_KEY_PREFIX,
  browserMbtilesKeyFromTileUrl,
  browserMbtilesKeysInLayers,
  createBrowserMbtilesKeyGenerator,
  createMbtilesTileReader,
  decompressTileData,
  readMbtilesMetadataFromDb,
  sniffTileFormat,
} from "../apps/geolibre-desktop/src/lib/mbtiles-sqljs";

const require = createRequire(import.meta.url);

let SQL: SqlJsStatic;

before(async () => {
  const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
  SQL = await initSqlJs({ locateFile: () => wasmPath });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface TileRow {
  z: number;
  x: number;
  row: number;
  data: Uint8Array;
}

function buildMbtiles(options: {
  metadata?: Record<string, string> | null;
  tiles?: TileRow[];
  tilesAsView?: boolean;
}): Database {
  const db = new SQL.Database();
  if (options.metadata !== null) {
    db.run("CREATE TABLE metadata (name TEXT, value TEXT)");
    for (const [name, value] of Object.entries(options.metadata ?? {})) {
      db.run("INSERT INTO metadata VALUES (?, ?)", [name, value]);
    }
  }
  if (options.tilesAsView) {
    db.run(
      "CREATE TABLE raw (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)",
    );
    db.run("CREATE VIEW tiles AS SELECT * FROM raw");
  } else {
    db.run(
      "CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)",
    );
  }
  const target = options.tilesAsView ? "raw" : "tiles";
  for (const tile of options.tiles ?? []) {
    db.run(`INSERT INTO ${target} VALUES (?, ?, ?, ?)`, [tile.z, tile.x, tile.row, tile.data]);
  }
  return db;
}

describe("readMbtilesMetadataFromDb", () => {
  it("reads the spec metadata of a vector file", () => {
    const db = buildMbtiles({
      metadata: {
        Name: "Roads",
        format: "pbf",
        minzoom: "2",
        maxzoom: "14",
        bounds: "-10.5,20,30,45.25",
        center: "5,30,6",
        json: JSON.stringify({ vector_layers: [{ id: "road" }, { id: "water" }] }),
      },
    });
    assert.deepEqual(readMbtilesMetadataFromDb(db, "fallback"), {
      name: "Roads",
      format: "pbf",
      tileType: "vector",
      sourceLayers: ["road", "water"],
      minZoom: 2,
      maxZoom: 14,
      bounds: [-10.5, 20, 30, 45.25],
      center: [5, 30, 6],
      scheme: "tms",
    });
  });

  it("treats non-vector formats as raster and honours the xyz scheme", () => {
    const db = buildMbtiles({ metadata: { format: "PNG", scheme: "XYZ" } });
    const metadata = readMbtilesMetadataFromDb(db, "fallback");
    assert.equal(metadata.tileType, "raster");
    assert.equal(metadata.format, "png");
    assert.equal(metadata.scheme, "xyz");
    assert.equal(metadata.name, "fallback");
    assert.deepEqual(metadata.sourceLayers, []);
    assert.equal(metadata.bounds, null);
    assert.equal(metadata.minZoom, null);
  });

  it("works without a metadata table, sniffing the format from a tile", () => {
    const db = buildMbtiles({
      metadata: null,
      tiles: [{ z: 0, x: 0, row: 0, data: PNG }],
    });
    const metadata = readMbtilesMetadataFromDb(db, "plain");
    assert.equal(metadata.format, "png");
    assert.equal(metadata.tileType, "raster");
    assert.equal(metadata.name, "plain");
  });

  it("accepts a tiles view", () => {
    const db = buildMbtiles({ metadata: { format: "pbf" }, tilesAsView: true });
    assert.equal(readMbtilesMetadataFromDb(db, "view").tileType, "vector");
  });

  it("falls back for malformed numbers and layer JSON", () => {
    const db = buildMbtiles({
      metadata: { format: "pbf", minzoom: "abc", bounds: "1,2,3", json: "{not json" },
    });
    const metadata = readMbtilesMetadataFromDb(db, "x");
    assert.equal(metadata.minZoom, null);
    assert.equal(metadata.bounds, null);
    assert.deepEqual(metadata.sourceLayers, []);
  });

  it("rejects a database without a tiles table", () => {
    const db = new SQL.Database();
    db.run("CREATE TABLE other (a INTEGER)");
    assert.throws(() => readMbtilesMetadataFromDb(db, "x"), /Unsupported MBTiles schema/);
  });

  it("rejects a tiles table missing required columns", () => {
    const db = new SQL.Database();
    db.run("CREATE TABLE tiles (zoom_level INTEGER, tile_data BLOB)");
    assert.throws(() => readMbtilesMetadataFromDb(db, "x"), /must contain zoom_level/);
  });

  it("rejects bytes that are not a SQLite database", () => {
    const db = new SQL.Database(new Uint8Array(512).fill(7));
    assert.throws(() => readMbtilesMetadataFromDb(db, "x"), /not a valid MBTiles/);
  });
});

describe("createMbtilesTileReader", () => {
  const tile = new Uint8Array([1, 2, 3, 4]);

  it("flips the XYZ row for the default TMS scheme", () => {
    // XYZ (z=2, x=1, y=0) is stored at TMS row 3.
    const db = buildMbtiles({ tiles: [{ z: 2, x: 1, row: 3, data: tile }] });
    const reader = createMbtilesTileReader(db, "tms");
    assert.deepEqual(reader.readTile(2, 1, 0), tile);
    assert.equal(reader.readTile(2, 1, 3).length, 0);
    reader.close();
  });

  it("reads rows as-is for the xyz scheme", () => {
    const db = buildMbtiles({ tiles: [{ z: 2, x: 1, row: 0, data: tile }] });
    const reader = createMbtilesTileReader(db, "xyz");
    assert.deepEqual(reader.readTile(2, 1, 0), tile);
    reader.close();
  });

  it("returns an empty tile when missing or out of range, and is reusable", () => {
    const db = buildMbtiles({ tiles: [{ z: 1, x: 0, row: 1, data: tile }] });
    const reader = createMbtilesTileReader(db, "tms");
    assert.equal(reader.readTile(5, 3, 3).length, 0);
    assert.equal(reader.readTile(1, 0, 5).length, 0); // y beyond the grid → negative row
    assert.deepEqual(reader.readTile(1, 0, 0), tile);
    assert.deepEqual(reader.readTile(1, 0, 0), tile); // statement was reset
    reader.close();
  });

  it("rejects a corrupt gzip tile but keeps serving the others", () => {
    const good = new Uint8Array([1, 2, 3]);
    const corrupt = new Uint8Array([0x1f, 0x8b, 8, 0, 0xde, 0xad, 0xbe, 0xef, 1, 2, 3]);
    const db = buildMbtiles({
      tiles: [
        { z: 0, x: 0, row: 0, data: corrupt },
        { z: 1, x: 0, row: 0, data: good },
      ],
    });
    const reader = createMbtilesTileReader(db, "tms");
    assert.throws(() => reader.readTile(0, 0, 0));
    // The shared statement was reset, so the next lookup is unaffected.
    assert.deepEqual(reader.readTile(1, 0, 1), good);
    reader.close();
  });

  it("inflates gzip-compressed vector tiles", () => {
    const payload = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1]);
    const db = buildMbtiles({ tiles: [{ z: 0, x: 0, row: 0, data: gzipSync(payload) }] });
    const reader = createMbtilesTileReader(db, "tms");
    assert.deepEqual(reader.readTile(0, 0, 0), payload);
    reader.close();
  });
});

describe("decompressTileData / sniffTileFormat", () => {
  it("inflates zlib and passes other payloads through", () => {
    const payload = new Uint8Array([5, 5, 5, 5, 5, 5, 5, 5]);
    assert.deepEqual(decompressTileData(zlibSync(payload)), payload);
    assert.equal(decompressTileData(PNG), PNG);
    // Starts with 0x78 but is not a zlib stream: returned untouched.
    const fake = new Uint8Array([0x78, 1, 2, 3, 4]);
    assert.equal(decompressTileData(fake), fake);
  });

  it("detects common tile formats", () => {
    assert.equal(sniffTileFormat(PNG), "png");
    assert.equal(sniffTileFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "jpg");
    assert.equal(sniffTileFormat(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0])), "webp");
    assert.equal(sniffTileFormat(new Uint8Array([0x1f, 0x8b, 8, 0])), "pbf");
    assert.equal(sniffTileFormat(null), "pbf");
  });
});

describe("browser database keys in layers", () => {
  // Mirrors mbtilesTileUrl() in mbtiles.ts (not importable here: it pulls in MapLibre).
  const tileUrl = (path: string) =>
    `geolibre-mbtiles://tile/{z}/{x}/{y}?path=${encodeURIComponent(path)}`;
  const layer = (...tiles: unknown[]) => ({ source: { tiles } });

  it("extracts the key from a browser tile URL and ignores everything else", () => {
    const key = `${BROWSER_MBTILES_KEY_PREFIX}3/my map.mbtiles`;
    assert.equal(browserMbtilesKeyFromTileUrl(tileUrl(key)), key);
    // A desktop file path is not a browser key.
    assert.equal(browserMbtilesKeyFromTileUrl(tileUrl("C:\\data\\world.mbtiles")), null);
    assert.equal(browserMbtilesKeyFromTileUrl("https://example.com/{z}/{x}/{y}.png"), null);
    assert.equal(browserMbtilesKeyFromTileUrl("not a url"), null);
  });

  it("generates keys that differ per file, and per session for the same file name", () => {
    const sessionA = createBrowserMbtilesKeyGenerator("aaaaaaaaaaaa");
    const sessionB = createBrowserMbtilesKeyGenerator("bbbbbbbbbbbb");

    // Two same-named files in one session must not share a database.
    assert.notEqual(sessionA("a.mbtiles"), sessionA("a.mbtiles"));
    // A saved key from an earlier session must not match the same file name
    // opened first in a later one (both counters start at 1).
    const saved = createBrowserMbtilesKeyGenerator("aaaaaaaaaaaa")("a.mbtiles");
    assert.notEqual(saved, sessionB("a.mbtiles"));

    // Still recognised as a browser key, with the file name kept for display.
    const key = sessionA("my map.mbtiles");
    assert.ok(key.startsWith(BROWSER_MBTILES_KEY_PREFIX));
    assert.ok(key.endsWith("/my map.mbtiles"));
    assert.equal(browserMbtilesKeyFromTileUrl(tileUrl(key)), key);
  });

  it("gives each default generator its own random session id", () => {
    const first = createBrowserMbtilesKeyGenerator()("a.mbtiles");
    const second = createBrowserMbtilesKeyGenerator()("a.mbtiles");
    assert.notEqual(first, second);
    assert.match(first, /^browser-mbtiles-[0-9a-f]{12}-1\/a\.mbtiles$/);
  });

  it("collects keys across live layers and history snapshots", () => {
    const live = `${BROWSER_MBTILES_KEY_PREFIX}1/a.mbtiles`;
    const undoable = `${BROWSER_MBTILES_KEY_PREFIX}2/b.mbtiles`;
    const keys = browserMbtilesKeysInLayers([
      [layer(tileUrl(live)), layer("https://example.com/{z}/{x}/{y}.png")],
      // A removed layer still referenced by an undo snapshot stays reachable.
      [layer(tileUrl(undoable))],
      [layer(tileUrl(live))],
    ]);
    assert.deepEqual([...keys].sort(), [live, undoable]);
  });

  it("tolerates layers without tile arrays", () => {
    const keys = browserMbtilesKeysInLayers([
      [{ source: {} }, { source: { tiles: "nope" } }, layer(42, null)],
    ]);
    assert.equal(keys.size, 0);
  });
});
