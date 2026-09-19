import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DOMParser } from "linkedom";
import { parseLandXml } from "../apps/geolibre-desktop/src/lib/landxml";

const originalParser = Object.getOwnPropertyDescriptor(globalThis, "DOMParser");
Object.defineProperty(globalThis, "DOMParser", { configurable: true, value: DOMParser });
process.on("exit", () => {
  if (originalParser) Object.defineProperty(globalThis, "DOMParser", originalParser);
  else Reflect.deleteProperty(globalThis, "DOMParser");
});

const SAMPLE = `<?xml version="1.0"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
  <CoordinateSystem name="NAD83 UTM 10N" epsgCode="26910" />
  <CgPoints>
    <CgPoint name="MON-1" code="CTRL">45 -122 11</CgPoint>
  </CgPoints>
  <Surfaces>
    <Surface name="Existing Ground">
      <Definition surfType="TIN">
        <Pnts>
          <P id="1">45.0000 -122.0000 10</P>
          <P id="2">45.0000 -121.9990 12</P>
          <P id="3">45.0010 -122.0000 14</P>
        </Pnts>
        <Faces>
          <F>1 2 3</F>
          <F>1 2 999</F>
        </Faces>
      </Definition>
    </Surface>
  </Surfaces>
  <Alignments>
    <Alignment name="Main Road" staStart="100" length="200">
      <CoordGeom>
        <Line><Start>45 -122 10</Start><End>45 -121.999 11</End></Line>
        <Curve rot="ccw"><Start>45 -121.999 11</Start><Center>45.001 -121.999 11</Center><End>45.001 -121.998 12</End></Curve>
        <Spiral><Start>45.001 -121.998 12</Start><PI>45.0015 -121.9975 13</PI><End>45.002 -121.997 14</End></Spiral>
      </CoordGeom>
      <Profile>
        <ProfAlign name="Finished Grade">
          <PVI>100 10</PVI>
          <PVI>300 14</PVI>
        </ProfAlign>
      </Profile>
    </Alignment>
  </Alignments>
</LandXML>`;

describe("LandXML parser", () => {
  it("parses TIN faces, alignments, profiles, points, and coordinate metadata", () => {
    const result = parseLandXml(SAMPLE);

    assert.equal(result.detectedCrs, "EPSG:26910");
    assert.match(result.coordinateSystem ?? "", /NAD83 UTM 10N/);
    assert.equal(result.coordinatesLookGeographic, true);
    assert.equal(result.surfaceCount, 1);
    assert.equal(result.alignmentCount, 1);
    assert.equal(result.pointCount, 1);
    assert.equal(result.profileCount, 1);
    assert.equal(result.layers.length, 3);

    const surface = result.layers.find((layer) => layer.kind === "surface");
    assert.ok(surface);
    assert.equal(surface.features.features.length, 1, "invalid face references are skipped");
    assert.deepEqual(surface.features.features[0].geometry, {
      type: "Polygon",
      coordinates: [
        [
          [-122, 45, 10],
          [-121.999, 45, 12],
          [-122, 45.001, 14],
          [-122, 45, 10],
        ],
      ],
    });

    const alignments = result.layers.find((layer) => layer.kind === "alignment");
    assert.ok(alignments);
    const alignment = alignments.features.features[0];
    assert.equal(alignment.properties?.profile_names, "Finished Grade");
    assert.equal(alignment.properties?.profile_pvi_count, 2);
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
      coordinates: [-122, 45, 11],
    });
  });

  it("marks projected coordinates as requiring a CRS", () => {
    const result = parseLandXml(`
      <LandXML><CgPoints><CgPoint name="P1">500000 600000 25</CgPoint></CgPoints></LandXML>
    `);
    assert.equal(result.coordinatesLookGeographic, false);
    assert.equal(result.detectedCrs, undefined);
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
