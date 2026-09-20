import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DOMParser } from "linkedom";
import { parseLandXml } from "../apps/geolibre-desktop/src/lib/landxml";

const originalParser = Object.getOwnPropertyDescriptor(globalThis, "DOMParser");
Object.defineProperty(globalThis, "DOMParser", { configurable: true, value: DOMParser });
process.on("exit", () => {
  if (originalParser) Object.defineProperty(globalThis, "DOMParser", originalParser);
  else Reflect.deleteProperty(globalThis, "DOMParser");
});

const SAMPLE = readFileSync(
  fileURLToPath(new URL("./fixtures/landxml-wgs84.xml", import.meta.url)),
  "utf8",
);

describe("LandXML parser", () => {
  it("parses TIN faces, alignments, profiles, points, and coordinate metadata", () => {
    const result = parseLandXml(SAMPLE);

    assert.equal(result.detectedCrs, "EPSG:4326");
    assert.match(result.coordinateSystem ?? "", /WGS 84/);
    assert.equal(result.linearUnit, undefined);
    assert.equal(result.coordinatesLookGeographic, true);
    assert.equal(result.surfaceCount, 1);
    assert.equal(result.alignmentCount, 1);
    assert.equal(result.pointCount, 2);
    assert.equal(result.profileCount, 1);
    assert.equal(result.layers.length, 3);
    assert.deepEqual(result.warnings, [
      "Existing Ground: skipped 0 invalid surface point(s) and 1 invalid TIN face(s).",
    ]);

    const surface = result.layers.find((layer) => layer.kind === "surface");
    assert.ok(surface);
    assert.equal(
      surface.features.features.length,
      3,
      "hidden edges are retained and invalid face references are skipped",
    );
    assert.deepEqual(surface.features.features[0].geometry, {
      type: "Polygon",
      coordinates: [
        [
          [-71.064, 42.358, 10],
          [-71.054, 42.358, 16],
          [-71.064, 42.366, 20],
          [-71.064, 42.358, 10],
        ],
      ],
    });

    const alignments = result.layers.find((layer) => layer.kind === "alignment");
    assert.ok(alignments);
    const alignment = alignments.features.features[0];
    assert.equal(alignment.properties?.profile_names, "Finished Grade");
    assert.equal(alignment.properties?.profile_pvi_count, 3);
    assert.equal(alignment.geometry?.type, "LineString");
    assert.ok(
      alignment.geometry &&
        alignment.geometry.type === "LineString" &&
        alignment.geometry.coordinates.length > 6,
      "the circular curve is sampled between its source endpoints",
    );

    const points = result.layers.find((layer) => layer.kind === "points");
    assert.deepEqual(points?.features.features[0].geometry, {
      type: "Point",
      coordinates: [-71.06, 42.36, 18],
    });
  });

  it("smoothly approximates spiral alignments without using the PI as a vertex", () => {
    const result = parseLandXml(`
      <LandXML>
        <Alignments><Alignment name="Spiral"><CoordGeom><Spiral>
          <Start>0 0</Start><PI>0 10</PI><End>10 10</End>
        </Spiral></CoordGeom></Alignment></Alignments>
      </LandXML>
    `);
    const alignment = result.layers[0]?.features.features[0]?.geometry;
    assert.equal(alignment?.type, "LineString");
    if (!alignment || alignment.type !== "LineString") return;
    assert.equal(alignment.coordinates.length, 17);
    assert.deepEqual(alignment.coordinates[0], [0, 0]);
    assert.deepEqual(alignment.coordinates.at(-1), [10, 10]);
    assert.equal(
      alignment.coordinates.some((position) => position[0] === 10 && position[1] === 0),
      false,
    );
  });

  it("retains a full-circle curve when malformed input omits its rotation", () => {
    const result = parseLandXml(`
      <LandXML>
        <Alignments><Alignment name="Circle"><CoordGeom><Curve>
          <Start>0 1</Start><Center>0 0</Center><End>0 1</End>
        </Curve></CoordGeom></Alignment></Alignments>
      </LandXML>
    `);
    const alignment = result.layers[0]?.features.features[0]?.geometry;
    assert.equal(alignment?.type, "LineString");
    if (!alignment || alignment.type !== "LineString") return;
    assert.equal(alignment.coordinates.length, 73);
    assert.deepEqual(alignment.coordinates[0], [1, 0]);
    assert.deepEqual(alignment.coordinates.at(-1), [1, 0]);
    assert.equal(
      alignment.coordinates.some((position) => position[0] < -0.99),
      true,
    );
  });

  it("marks projected coordinates as requiring a CRS", () => {
    const result = parseLandXml(`
      <LandXML><CgPoints><CgPoint name="P1">500000 600000 25</CgPoint></CgPoints></LandXML>
    `);
    assert.equal(result.coordinatesLookGeographic, false);
    assert.equal(result.detectedCrs, undefined);
  });

  it("reports a declared non-meter coordinate unit", () => {
    const result = parseLandXml(`
      <LandXML>
        <Units><Imperial linearUnit="USSurveyFoot" /></Units>
        <CgPoints><CgPoint name="P1">40 -75 10</CgPoint></CgPoints>
      </LandXML>
    `);
    assert.equal(result.linearUnit, "USSurveyFoot");
    assert.deepEqual(result.warnings, [
      'LandXML declares linear unit "USSurveyFoot". Verify that the selected CRS uses the same coordinate unit.',
    ]);
  });

  it("prefers the canonical EPSG attribute over conflicting descriptive text", () => {
    const result = parseLandXml(`
      <LandXML>
        <CoordinateSystem name="Legacy EPSG:4326 label" epsgCode="26915" desc="EPSG:3857" />
        <CgPoints><CgPoint name="P1">4978000 479000 25</CgPoint></CgPoints>
      </LandXML>
    `);
    assert.equal(result.detectedCrs, "EPSG:26915");
  });

  it("rejects malformed and oversized coordinate tuples", () => {
    assert.throws(
      () =>
        parseLandXml(`
          <LandXML><CgPoints><CgPoint name="P1">45 invalid -122</CgPoint></CgPoints></LandXML>
        `),
      /No supported LandXML/,
    );
    assert.throws(
      () =>
        parseLandXml(`
          <LandXML><CgPoints><CgPoint name="P1">45 -122 10 999</CgPoint></CgPoints></LandXML>
        `),
      /No supported LandXML/,
    );
  });

  it("rejects non-LandXML and empty LandXML documents", () => {
    assert.throws(() => parseLandXml("<root />"), /does not contain a LandXML document/);
    assert.throws(() => parseLandXml("<LandXML />"), /No supported LandXML/);
  });
});
