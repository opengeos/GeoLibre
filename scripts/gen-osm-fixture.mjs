// One-off generator for a tiny OSM PBF test fixture.
// Run with: node scripts/gen-osm-fixture.mjs
// Produces tests/fixtures/sample.osm.pbf with one tagged point, one line way,
// and one polygon (closed/building way). Uses osmix's writer; not shipped.
import { mkdirSync, writeFileSync } from "node:fs";
import { Osm, toPbfBuffer } from "osmix";

const osm = new Osm({ id: "fixture" });

// Tagged node -> becomes a Point feature.
osm.nodes.addNode({ id: 1, lon: 0, lat: 0, tags: { amenity: "cafe", name: "Test Cafe" } });

// Untagged vertices for the line way.
osm.nodes.addNode({ id: 2, lon: 1, lat: 1 });
osm.nodes.addNode({ id: 3, lon: 2, lat: 1 });

// Untagged vertices for the polygon way (a closed triangle).
osm.nodes.addNode({ id: 4, lon: 0, lat: 2 });
osm.nodes.addNode({ id: 5, lon: 1, lat: 2 });
osm.nodes.addNode({ id: 6, lon: 1, lat: 3 });

osm.nodes.buildIndex();

// Open way -> LineString.
osm.ways.addWay({ id: 10, refs: [2, 3], tags: { highway: "path", name: "Test Path" } });

// Closed way with an area tag -> Polygon.
osm.ways.addWay({ id: 11, refs: [4, 5, 6, 4], tags: { building: "yes", name: "Test Building" } });

osm.buildIndexes();

const bytes = await toPbfBuffer(osm);
mkdirSync("tests/fixtures", { recursive: true });
writeFileSync("tests/fixtures/sample.osm.pbf", bytes);
console.log(`Wrote tests/fixtures/sample.osm.pbf (${bytes.length} bytes)`);

// A second fixture with one tagged and one untagged way, to verify untagged
// ways (relation-member geometry on real extracts) are not emitted as features.
const untagged = new Osm({ id: "fixture-untagged" });
untagged.nodes.addNode({ id: 1, lon: 0, lat: 0, tags: { amenity: "cafe" } });
untagged.nodes.addNode({ id: 2, lon: 1, lat: 1 });
untagged.nodes.addNode({ id: 3, lon: 2, lat: 1 });
untagged.nodes.addNode({ id: 4, lon: 3, lat: 1 });
untagged.nodes.addNode({ id: 5, lon: 4, lat: 1 });
untagged.nodes.buildIndex();
untagged.ways.addWay({ id: 10, refs: [2, 3], tags: { highway: "path" } });
untagged.ways.addWay({ id: 11, refs: [4, 5] }); // untagged -> must be skipped
untagged.buildIndexes();

const untaggedBytes = await toPbfBuffer(untagged);
writeFileSync("tests/fixtures/untagged-way.osm.pbf", untaggedBytes);
console.log(
  `Wrote tests/fixtures/untagged-way.osm.pbf (${untaggedBytes.length} bytes)`,
);

// A third fixture with one tagged and one untagged relation (both over the same
// untagged member ways), to verify untagged relations are not emitted as
// features either. The tagged relation yields a MultiLineString feature.
const relations = new Osm({ id: "fixture-relations" });
relations.nodes.addNode({ id: 1, lon: 0, lat: 0 });
relations.nodes.addNode({ id: 2, lon: 1, lat: 0 });
relations.nodes.addNode({ id: 3, lon: 1, lat: 1 });
relations.nodes.addNode({ id: 4, lon: 0, lat: 1 });
relations.nodes.buildIndex();
relations.ways.addWay({ id: 10, refs: [1, 2] });
relations.ways.addWay({ id: 11, refs: [3, 4] });
const members = [
  { type: "way", ref: 10, role: "" },
  { type: "way", ref: 11, role: "" },
];
relations.relations.addRelation({
  id: 100,
  members,
  tags: { type: "route", route: "bus", name: "Tagged Route" },
});
relations.relations.addRelation({ id: 101, members, tags: {} }); // untagged
relations.buildIndexes();

const relationBytes = await toPbfBuffer(relations);
writeFileSync("tests/fixtures/untagged-relation.osm.pbf", relationBytes);
console.log(
  `Wrote tests/fixtures/untagged-relation.osm.pbf (${relationBytes.length} bytes)`,
);
