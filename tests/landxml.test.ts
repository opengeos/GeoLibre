import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { FeatureCollection, Position } from "geojson";
import { DOMParser } from "linkedom";
import { parseLandXml, reprojectLandXmlCollection } from "../apps/geolibre-desktop/src/lib/landxml";

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
      1,
      "a TIN surface is one MultiPolygon, not one feature per face",
    );
    const surfaceFeature = surface.features.features[0];
    assert.equal(surfaceFeature.geometry.type, "MultiPolygon");
    assert.equal(surfaceFeature.properties?.landxml_kind, "surface");
    assert.equal(surfaceFeature.properties?.surface_name, "Existing Ground");
    assert.equal(
      surfaceFeature.properties?.face_count,
      3,
      "hidden edges are retained and invalid face references are skipped",
    );
    assert.equal(
      surfaceFeature.geometry.type === "MultiPolygon" && surfaceFeature.geometry.coordinates.length,
      3,
    );
    assert.deepEqual(
      surfaceFeature.geometry.type === "MultiPolygon" && surfaceFeature.geometry.coordinates[0],
      [
        [
          [-71.064, 42.358, 10],
          [-71.054, 42.358, 16],
          [-71.064, 42.366, 20],
          [-71.064, 42.358, 10],
        ],
      ],
    );

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

describe("LandXML reprojection", () => {
  const TIN = `
    <LandXML>
      <Surfaces><Surface name="Grid"><Definition surfType="TIN">
        <Pnts>
          <P id="1">0 0 5</P><P id="2">0 10 6</P><P id="3">10 0 7</P><P id="4">10 10 8</P>
        </Pnts>
        <Faces><F>1 2 3</F><F>2 3 4</F></Faces>
      </Definition></Surface></Surfaces>
    </LandXML>
  `;

  it("transforms each distinct vertex once, however many faces reuse it", async () => {
    const collection = parseLandXml(TIN).layers[0].features;
    const batches: Position[][] = [];
    const out = await reprojectLandXmlCollection(collection, async (positions) => {
      batches.push(positions);
      return positions.map(([x, y, z]) => (z === undefined ? [x + 100, y] : [x + 100, y, z]));
    });

    // Two triangles use six corners between them, but the TIN has four points.
    assert.equal(batches.length, 1);
    assert.equal(batches[0].length, 4);

    const geometry = out.features[0].geometry;
    assert.equal(geometry.type, "MultiPolygon");
    if (geometry.type !== "MultiPolygon") return;
    assert.equal(geometry.coordinates.length, 2);
    // Ring order, closure, and Z survive the rebuild.
    assert.deepEqual(geometry.coordinates[0], [
      [
        [100, 0, 5],
        [110, 0, 6],
        [100, 10, 7],
        [100, 0, 5],
      ],
    ]);
    assert.equal(out.features[0].properties?.face_count, 2);
  });

  it("keeps points that share an XY but differ in Z distinct", async () => {
    const collection: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: [
              [1, 2, 10],
              [1, 2, 20],
            ],
          },
        },
      ],
    };
    const seen: Position[][] = [];
    const out = await reprojectLandXmlCollection(collection, async (positions) => {
      seen.push(positions);
      return positions.map(([x, y, z]) => [x, y, z as number]);
    });
    assert.equal(seen[0].length, 2, "a shared XY with two elevations is two vertices");
    const geometry = out.features[0].geometry;
    assert.equal(geometry.type === "LineString" && geometry.coordinates.length, 2);
  });

  it("batches 2D and 3D positions separately so a missing elevation stays missing", async () => {
    // An alignment whose curve carries no elevation, beside CgPoints that do.
    const collection: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: [
              [0, 0],
              [10, 10],
            ],
          },
        },
        {
          type: "Feature",
          properties: {},
          geometry: { type: "Point", coordinates: [20, 20, 5] },
        },
      ],
    };

    const batches: Position[][] = [];
    const out = await reprojectLandXmlCollection(collection, async (positions) => {
      batches.push(positions);
      // Mirrors the engine's homogenization: one dimension for the whole batch.
      const dimension = Math.max(...positions.map((position) => position.length));
      assert.equal(
        positions.every((position) => position.length === dimension),
        true,
        "a batch must not mix 2D and 3D positions",
      );
      return positions.map((position) => [...position]);
    });

    assert.equal(batches.length, 2, "one batch per coordinate dimension");
    assert.deepEqual(batches.map((batch) => batch.length).sort(), [1, 2]);
    const line = out.features[0].geometry;
    assert.equal(line.type === "LineString" && line.coordinates[0].length, 2, "2D stays 2D");
    const point = out.features[1].geometry;
    assert.deepEqual(point.type === "Point" && point.coordinates, [20, 20, 5]);
  });

  it("gives every occurrence of a shared vertex its own coordinate array", async () => {
    const parsed = parseLandXml(TIN).layers[0].features;
    const collect = (collection: FeatureCollection): Position[] => {
      const geometry = collection.features[0].geometry;
      if (geometry.type !== "MultiPolygon") return [];
      return geometry.coordinates.flatMap((part) => part[0]);
    };

    // Two triangles share two vertices, and each ring repeats its first point.
    const parsedSlots = collect(parsed);
    assert.equal(new Set(parsedSlots).size, parsedSlots.length, "parsed geometry does not alias");

    const out = await reprojectLandXmlCollection(parsed, async (positions) =>
      positions.map((position) => [...position]),
    );
    const slots = collect(out);
    assert.equal(slots.length, 8);
    assert.equal(new Set(slots).size, slots.length, "reprojected geometry does not alias");
  });

  it("rejects a projector that drops or fabricates an ordinate", async () => {
    const collection = parseLandXml(TIN).layers[0].features;
    await assert.rejects(
      // Z silently dropped: the exact shape the dimension grouping guards against.
      () =>
        reprojectLandXmlCollection(collection, async (positions) =>
          positions.map(([x, y]) => [x, y]),
        ),
      /invalid coordinate/,
    );
    await assert.rejects(
      () =>
        reprojectLandXmlCollection(collection, async (positions) =>
          positions.map(([x, , z]) => [x, Number.NaN, z as number]),
        ),
      /invalid coordinate/,
    );
  });

  it("rejects a projector that does not return one position per input", async () => {
    const collection = parseLandXml(TIN).layers[0].features;
    await assert.rejects(
      () => reprojectLandXmlCollection(collection, async () => []),
      /different number of coordinates/,
    );
  });
});
