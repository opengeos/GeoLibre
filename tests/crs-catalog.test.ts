import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CRS_CATALOG,
  crsEntryForCode,
  formatCrsLabel,
  parseEpsgCode,
  searchCrsCatalog,
} from "../apps/geolibre-desktop/src/lib/crs-catalog";

describe("CRS_CATALOG", () => {
  it("names the generated zone families the way EPSG does", () => {
    // The zone families are produced by a loop, so a wrong code base or a
    // hemisphere mix-up would mislabel a hundred entries at once.
    const expected: [number, string][] = [
      [32601, "WGS 84 / UTM zone 1N"],
      [32617, "WGS 84 / UTM zone 17N"],
      [32660, "WGS 84 / UTM zone 60N"],
      [32701, "WGS 84 / UTM zone 1S"],
      [32760, "WGS 84 / UTM zone 60S"],
      [26917, "NAD83 / UTM zone 17N"],
      [25832, "ETRS89 / UTM zone 32N"],
      [28355, "GDA94 / MGA zone 55"],
      [7855, "GDA2020 / MGA zone 55"],
      [6669, "JGD2011 / Japan Plane Rectangular CS I"],
      [6687, "JGD2011 / Japan Plane Rectangular CS XIX"],
      [4491, "CGCS2000 / Gauss-Kruger zone 13"],
      [4501, "CGCS2000 / Gauss-Kruger zone 23"],
    ];
    for (const [code, name] of expected) {
      assert.equal(crsEntryForCode(code)?.name, name, `EPSG:${code}`);
    }
  });

  it("holds no duplicate codes", () => {
    const codes = CRS_CATALOG.map((entry) => entry.code);
    assert.equal(new Set(codes).size, codes.length);
  });

  it("classifies the two kinds the picker groups by", () => {
    assert.equal(crsEntryForCode(4326)?.kind, "geographic");
    assert.equal(crsEntryForCode(3857)?.kind, "projected");
    assert.equal(crsEntryForCode(32617)?.kind, "projected");
    // Both groups have to be populated for the split list to make sense.
    assert.ok(CRS_CATALOG.some((entry) => entry.kind === "geographic"));
    assert.ok(CRS_CATALOG.some((entry) => entry.kind === "projected"));
  });
});

describe("parseEpsgCode", () => {
  it("reads a code from the forms a user types or pastes", () => {
    assert.equal(parseEpsgCode("4326"), 4326);
    assert.equal(parseEpsgCode("EPSG:32617"), 32617);
    assert.equal(parseEpsgCode("epsg:3857 "), 3857);
    assert.equal(parseEpsgCode("urn:ogc:def:crs:EPSG::26911"), 26911);
  });

  it("returns null for text with no code in it", () => {
    // A partially typed field must not resolve to a name, which would flash a
    // misleading CRS under the input while the user is still typing.
    assert.equal(parseEpsgCode(""), null);
    assert.equal(parseEpsgCode("326"), null);
    assert.equal(parseEpsgCode("WGS 84"), null);
    assert.equal(parseEpsgCode(undefined), null);
  });
});

describe("searchCrsCatalog", () => {
  it("returns the whole catalog, in curated order, for a blank query", () => {
    const results = searchCrsCatalog("");
    assert.equal(results[0].code, 4326);
    // The default limit has to cover the catalog: a limit shorter than it would
    // drop whole zone families off the end of the picker's default list, and
    // they only reappear once the user types something specific.
    assert.equal(results.length, CRS_CATALOG.length);
    for (const code of [32760, 26923, 25838, 28358, 7859, 6687, 4501]) {
      assert.ok(
        results.some((entry) => entry.code === code),
        `EPSG:${code} missing from the blank-query list`,
      );
    }
  });

  it("ignores an EPSG prefix written with or without a colon", () => {
    // "EPSG 4326" is a natural way to type a code; leaving `epsg` as a token
    // would match no name or code and reject every entry.
    for (const query of ["EPSG 4326", "epsg4326", "EPSG:4326", "epsg :: 4326"]) {
      assert.equal(searchCrsCatalog(query)[0]?.code, 4326, query);
    }
  });

  it("ranks an exact code match first", () => {
    // "3857" is also a prefix of nothing else, but 4326 vs 43261-style prefixes
    // are why the exact match has to outrank a prefix hit.
    assert.equal(searchCrsCatalog("3857")[0].code, 3857);
    assert.equal(searchCrsCatalog("EPSG:32617")[0].code, 32617);
    assert.equal(searchCrsCatalog("4326")[0].code, 4326);
  });

  it("narrows on every token, so a name and a zone can be combined", () => {
    const results = searchCrsCatalog("utm 17n");
    assert.ok(results.length > 0);
    for (const entry of results) {
      assert.match(entry.name, /UTM zone 17N/);
    }
    // Both datums that have a zone 17N are offered, not just the first.
    assert.ok(results.some((entry) => entry.code === 32617));
    assert.ok(results.some((entry) => entry.code === 26917));
  });

  it("finds a system by name", () => {
    assert.ok(searchCrsCatalog("british national grid").some((entry) => entry.code === 27700));
    assert.ok(searchCrsCatalog("pseudo-mercator").some((entry) => entry.code === 3857));
  });

  it("returns nothing when no entry matches every token", () => {
    assert.deepEqual(searchCrsCatalog("utm mercator british"), []);
    assert.deepEqual(searchCrsCatalog("nosuchcrs"), []);
  });

  it("honors the result limit", () => {
    assert.equal(searchCrsCatalog("", 5).length, 5);
  });
});

describe("formatCrsLabel", () => {
  it("shows the name with its parenthesized code", () => {
    assert.equal(
      formatCrsLabel({ code: 32617, name: "WGS 84 / UTM zone 17N", kind: "projected" }),
      "WGS 84 / UTM zone 17N (EPSG:32617)",
    );
  });
});
