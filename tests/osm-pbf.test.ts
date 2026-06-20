import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  type OsmPbfProgress,
  parseOsmPbf,
} from "../apps/geolibre-desktop/src/lib/osm-pbf";

const fixturePath = fileURLToPath(
  new URL("./fixtures/sample.osm.pbf", import.meta.url),
);

// These fixtures are produced by scripts/gen-osm-fixture.mjs.
const untaggedWayFixturePath = fileURLToPath(
  new URL("./fixtures/untagged-way.osm.pbf", import.meta.url),
);
const untaggedRelationFixturePath = fileURLToPath(
  new URL("./fixtures/untagged-relation.osm.pbf", import.meta.url),
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

  it("reports the combined bounds of all features", async () => {
    const bytes = new Uint8Array(readFileSync(fixturePath));
    const result = await parseOsmPbf(bytes);

    // Fixture coordinates span lng 0..2, lat 0..3.
    assert.deepEqual(result.bounds, [0, 0, 2, 3]);
  });

  it("skips untagged geometry-vertex nodes from the points layer", async () => {
    const bytes = new Uint8Array(readFileSync(fixturePath));
    const result = await parseOsmPbf(bytes);

    // The fixture has 6 nodes but only 1 is tagged; the other 5 are way
    // vertices and must not appear as standalone points.
    assert.equal(result.counts.nodes, 6);
    assert.equal(result.counts.points, 1);
  });

  it("skips untagged ways (relation-member geometry, not features)", async () => {
    // The fixture has two line ways, one tagged (highway=path) and one
    // untagged. The untagged way is the kind of geometry that exists only to
    // build relations on a real extract and would otherwise flood the lines
    // layer and balloon memory, so it must not become a standalone feature.
    const bytes = new Uint8Array(readFileSync(untaggedWayFixturePath));
    const result = await parseOsmPbf(bytes);

    // Both ways are in the index, but only the tagged one becomes a feature.
    assert.equal(result.counts.ways, 2);
    assert.equal(result.lines.features.length, 1);
    assert.equal(result.lines.features[0].properties?.highway, "path");
  });

  it("skips untagged relations (only tagged ones become features)", async () => {
    // The fixture has two relations over the same member ways: one tagged
    // (a bus route -> MultiLineString) and one untagged. Only the tagged one
    // must become a feature; the untagged one stays in the index but is not
    // emitted.
    const bytes = new Uint8Array(readFileSync(untaggedRelationFixturePath));
    const result = await parseOsmPbf(bytes);

    assert.equal(result.counts.relations, 2);
    assert.equal(result.lines.features.length, 1);
    assert.equal(result.lines.features[0].properties?.name, "Tagged Route");
  });

  it("reports progress through the classification phase", async () => {
    const bytes = new Uint8Array(readFileSync(fixturePath));
    const updates: OsmPbfProgress[] = [];
    await parseOsmPbf(bytes, (progress) => updates.push(progress));

    // A final update always fires; its processed count equals the total number
    // of entities (nodes + ways + relations) and never exceeds the total.
    assert.ok(updates.length >= 1);
    const last = updates[updates.length - 1];
    assert.equal(last.processed, last.total);
    assert.ok(updates.every((u) => u.processed <= u.total));
  });
});
