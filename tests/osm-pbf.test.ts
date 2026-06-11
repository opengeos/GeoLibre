import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { parseOsmPbf } from "../apps/geolibre-desktop/src/lib/osm-pbf";

const fixturePath = fileURLToPath(
  new URL("./fixtures/sample.osm.pbf", import.meta.url),
);

describe("OSM PBF parsing", () => {
  it("splits a PBF into point, line, and polygon layers by geometry", async () => {
    const bytes = new Uint8Array(readFileSync(fixturePath));
    const result = await parseOsmPbf(bytes);

    // Fixture: one tagged node, one line way, one closed (building) way.
    assert.equal(result.points.features.length, 1);
    assert.equal(result.lines.features.length, 1);
    assert.equal(result.polygons.features.length, 1);

    assert.equal(result.points.features[0].geometry.type, "Point");
    assert.equal(result.lines.features[0].geometry.type, "LineString");
    assert.equal(result.polygons.features[0].geometry.type, "Polygon");
  });

  it("keeps OSM tags as feature properties", async () => {
    const bytes = new Uint8Array(readFileSync(fixturePath));
    const result = await parseOsmPbf(bytes);

    const cafe = result.points.features[0];
    assert.equal(cafe.properties?.amenity, "cafe");
    assert.equal(cafe.properties?.name, "Test Cafe");
  });

  it("skips untagged geometry-vertex nodes from the points layer", async () => {
    const bytes = new Uint8Array(readFileSync(fixturePath));
    const result = await parseOsmPbf(bytes);

    // The fixture has 6 nodes but only 1 is tagged; the other 5 are way
    // vertices and must not appear as standalone points.
    assert.equal(result.counts.nodes, 6);
    assert.equal(result.counts.points, 1);
  });
});
