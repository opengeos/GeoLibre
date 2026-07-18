import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { zipSync, strToU8 } from "fflate";

// tauri-io statically pulls in shpjs, whose bundle reads the browser `self`
// global at module-eval time; shim it before the dynamic import.
(globalThis as { self?: unknown }).self ??= globalThis;

type ShapefileShapeType = (shp: Uint8Array) => number;
type ReadShapefileZipForDuckDb = (data: ArrayBuffer | Uint8Array) => Promise<{
  file: { name: string; extension: string; siblingFiles?: { name: string }[] };
  sidecar: Record<string, Uint8Array>;
  isMultiPatch: boolean;
} | null>;

let shapefileShapeType: ShapefileShapeType;
let readShapefileZipForDuckDb: ReadShapefileZipForDuckDb;

before(async () => {
  const mod = await import("../apps/geolibre-desktop/src/lib/tauri-io");
  shapefileShapeType = mod.shapefileShapeType;
  readShapefileZipForDuckDb = mod.readShapefileZipForDuckDb;
});

/** A minimal 100-byte `.shp` header with `shapeType` at byte 32 (LE). */
function shpHeader(shapeType: number): Uint8Array {
  const bytes = new Uint8Array(100);
  new DataView(bytes.buffer).setInt32(32, shapeType, true);
  return bytes;
}

describe("shapefileShapeType", () => {
  it("reads the ESRI shape type from a .shp header", () => {
    assert.equal(shapefileShapeType(shpHeader(31)), 31); // MultiPatch
    assert.equal(shapefileShapeType(shpHeader(5)), 5); // Polygon
  });

  it("returns -1 for a buffer too short to hold a header", () => {
    assert.equal(shapefileShapeType(new Uint8Array(10)), -1);
  });
});

describe("readShapefileZipForDuckDb", () => {
  it("flags a MultiPatch shapefile and registers flat siblings", async () => {
    const zip = zipSync({
      "buildings.shp": shpHeader(31),
      "buildings.dbf": strToU8("dbf"),
      "buildings.shx": strToU8("shx"),
      "buildings.prj": strToU8("prj"),
    });
    const result = await readShapefileZipForDuckDb(zip);
    assert.ok(result);
    assert.equal(result.isMultiPatch, true);
    assert.equal(result.file.name, "buildings.shp");
    assert.deepEqual(result.file.siblingFiles?.map((s) => s.name).sort(), [
      "buildings.dbf",
      "buildings.prj",
      "buildings.shx",
    ]);
  });

  it("does not flag a non-MultiPatch (Polygon) shapefile", async () => {
    const zip = zipSync({
      "areas.shp": shpHeader(5),
      "areas.dbf": strToU8("dbf"),
    });
    const result = await readShapefileZipForDuckDb(zip);
    assert.ok(result);
    assert.equal(result.isMultiPatch, false);
  });

  it("ignores macOS __MACOSX / AppleDouble entries and picks the real .shp", async () => {
    const zip = zipSync({
      "__MACOSX/._buildings.shp": strToU8("appledouble-junk"),
      "__MACOSX/._buildings.dbf": strToU8("appledouble-junk"),
      "buildings.shp": shpHeader(31),
      "buildings.dbf": strToU8("dbf"),
      "buildings.shx": strToU8("shx"),
    });
    const result = await readShapefileZipForDuckDb(zip);
    assert.ok(result);
    assert.equal(result.isMultiPatch, true);
    // Only the real sidecars register; no AppleDouble shadows leak in.
    assert.deepEqual(result.file.siblingFiles?.map((s) => s.name).sort(), [
      "buildings.dbf",
      "buildings.shx",
    ]);
  });

  it("handles a shapefile nested in a subdirectory", async () => {
    const zip = zipSync({
      "data/roads.shp": shpHeader(3),
      "data/roads.dbf": strToU8("dbf"),
      "data/roads.shx": strToU8("shx"),
      "data/readme.txt": strToU8("hi"),
    });
    const result = await readShapefileZipForDuckDb(zip);
    assert.ok(result);
    assert.equal(result.file.name, "roads.shp");
    // The unrelated readme is not a sidecar; only the shapefile components.
    assert.deepEqual(result.file.siblingFiles?.map((s) => s.name).sort(), [
      "roads.dbf",
      "roads.shx",
    ]);
  });

  it("returns null when the archive contains no .shp", async () => {
    const zip = zipSync({ "notes.txt": strToU8("hi") });
    assert.equal(await readShapefileZipForDuckDb(zip), null);
  });
});
