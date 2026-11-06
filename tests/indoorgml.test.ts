import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Polygon, Position } from "geojson";
import { DOMParser } from "linkedom";
import {
  epsgFromSrsName,
  floorsFromElevations,
  parseIndoorGml,
  placeLocalCoordinates,
} from "../apps/geolibre-desktop/src/lib/indoorgml";
import { indoorGmlCellColorExpression } from "../apps/geolibre-desktop/src/lib/indoorgml-layers";

const originalParser = Object.getOwnPropertyDescriptor(globalThis, "DOMParser");
Object.defineProperty(globalThis, "DOMParser", { configurable: true, value: DOMParser });
process.on("exit", () => {
  if (originalParser) Object.defineProperty(globalThis, "DOMParser", originalParser);
  else Reflect.deleteProperty(globalThis, "DOMParser");
});

const NS =
  'xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
  'xmlns:core="http://www.opengis.net/indoorgml/1.0/core" ' +
  'xmlns:navi="http://www.opengis.net/indoorgml/1.0/navigation"';

/** A ring of `pos` elements. */
function ring(points: Position[]): string {
  return `<gml:LinearRing>${points.map((p) => `<gml:pos>${p.join(" ")}</gml:pos>`).join("")}</gml:LinearRing>`;
}

/** A `gml:Solid` box from (x0, y0, z0) to (x1, y1, z1): a floor, a ceiling and four walls. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): string {
  const face = (points: Position[]) =>
    `<gml:surfaceMember><gml:Polygon><gml:exterior>${ring([...points, points[0]])}</gml:exterior></gml:Polygon></gml:surfaceMember>`;
  return `<core:Geometry3D><gml:Solid><gml:exterior><gml:Shell>${[
    face([
      [x0, y0, z0],
      [x0, y1, z0],
      [x1, y1, z0],
      [x1, y0, z0],
    ]),
    face([
      [x0, y0, z1],
      [x1, y0, z1],
      [x1, y1, z1],
      [x0, y1, z1],
    ]),
    face([
      [x0, y0, z0],
      [x1, y0, z0],
      [x1, y0, z1],
      [x0, y0, z1],
    ]),
    face([
      [x1, y0, z0],
      [x1, y1, z0],
      [x1, y1, z1],
      [x1, y0, z1],
    ]),
    face([
      [x1, y1, z0],
      [x0, y1, z0],
      [x0, y1, z1],
      [x1, y1, z1],
    ]),
    face([
      [x0, y1, z0],
      [x0, y0, z0],
      [x0, y0, z1],
      [x0, y1, z1],
    ]),
  ].join("")}</gml:Shell></gml:exterior></gml:Solid></core:Geometry3D>`;
}

/** A cell member. */
function cell(id: string, geometry: string, extra = "", type = "core:CellSpace"): string {
  return `<core:cellSpaceMember><${type} gml:id="${id}">${extra}<core:cellSpaceGeometry>${geometry}</core:cellSpaceGeometry></${type}></core:cellSpaceMember>`;
}

/** A whole document from its cells and (optional) graph. */
function document(cells: string, graph = "", rootAttributes = ""): string {
  return `<?xml version="1.0"?><core:IndoorFeatures ${NS} gml:id="IF" ${rootAttributes}><core:primalSpaceFeatures><core:PrimalSpaceFeatures gml:id="PS">${cells}</core:PrimalSpaceFeatures></core:primalSpaceFeatures>${graph}</core:IndoorFeatures>`;
}

/** A state and the graph around it. */
function graph(states: [string, string, Position][], transitions: [string, string, string][]) {
  const position = new Map(states.map(([id, , p]) => [id, p]));
  return `<core:multiLayeredGraph><core:MultiLayeredGraph gml:id="MLG"><core:spaceLayers gml:id="SLs"><core:spaceLayerMember><core:SpaceLayer gml:id="SL"><core:nodes gml:id="N">${states
    .map(
      ([id, cellId, p]) =>
        `<core:stateMember><core:State gml:id="${id}"><core:duality xlink:href="#${cellId}"/><core:geometry><gml:Point><gml:pos>${p.join(" ")}</gml:pos></gml:Point></core:geometry></core:State></core:stateMember>`,
    )
    .join("")}</core:nodes><core:edges gml:id="E">${transitions
    .map(
      ([id, a, b]) =>
        `<core:transitionMember><core:Transition gml:id="${id}"><core:weight>1</core:weight><core:connects xlink:href="#${a}"/><core:connects xlink:href="#${b}"/><core:geometry><gml:LineString><gml:pos>${position.get(a)!.join(" ")}</gml:pos><gml:pos>${position.get(b)!.join(" ")}</gml:pos></gml:LineString></core:geometry></core:Transition></core:transitionMember>`,
    )
    .join(
      "",
    )}</core:edges></core:SpaceLayer></core:spaceLayerMember></core:spaceLayers></core:MultiLayeredGraph></core:multiLayeredGraph>`;
}

describe("parseIndoorGml", () => {
  // A two-storey house in a projected frame: a basement room at -2.5 m, a
  // ground-floor room at 0, a stair (its own floor, 0 to 5.5 m) and an upper room at 2.9.
  const house = document(
    cell("B1", box(500000, 5400000, -2.5, 500005, 5400004, 0), "<gml:name>Cellar</gml:name>") +
      cell("G1", box(500000, 5400000, 0, 500005, 5400004, 2.6)) +
      cell("S1", box(500005, 5400000, 0, 500006, 5400004, 5.5), "", "navi:TransitionSpace") +
      cell("U1", box(500000, 5400000, 2.9, 500005, 5400004, 5.5)),
    graph(
      [
        ["sG", "G1", [500002, 5400002, 1]],
        ["sU", "U1", [500002, 5400002, 4]],
      ],
      [["t1", "sG", "sU"]],
    ),
  );

  it("reads cells as footprints with their real base and roof", () => {
    const result = parseIndoorGml(house);
    assert.equal(result.cells.features.length, 4);
    const cellar = result.cells.features[0];
    assert.equal(cellar.properties?.name, "Cellar");
    assert.equal(cellar.properties?.kind, "CellSpace");
    // Measured from the lowest point of the building (the cellar floor at -2.5 m).
    assert.equal(cellar.properties?.base_z, 0);
    assert.equal(cellar.properties?.top_z, 2.5);
    const upper = result.cells.features[3];
    assert.equal(upper.properties?.base_z, 5.4);
    assert.equal(upper.properties?.top_z, 8);
    // The footprint is the floor face, as a closed counter-clockwise 2D ring.
    const footprint = (cellar.geometry as Polygon).coordinates[0];
    assert.equal(footprint.length, 5);
    assert.ok(footprint.every((p) => p.length === 2));
    assert.deepEqual(footprint[0], footprint[4]);
    assert.equal(result.cells.features[2].properties?.kind, "TransitionSpace");
  });

  it("numbers floors from elevation when no storey is named, ground floor nearest zero", () => {
    const result = parseIndoorGml(house);
    assert.equal(result.levelSource, "elevation");
    assert.deepEqual(
      result.cells.features.map((feature) => feature.properties?.level),
      ["-1", "0", "0", "1"],
    );
  });

  it("puts the navigation graph on the floors of its cells, keeping Z", () => {
    const result = parseIndoorGml(house);
    assert.deepEqual(
      result.states.features.map((feature) => feature.properties?.level),
      ["0", "1"],
    );
    const edge = result.transitions.features[0];
    assert.equal(edge.properties?.level, "0;1");
    assert.equal(edge.properties?.weight, 1);
    assert.deepEqual(
      (edge.geometry as { coordinates: Position[] }).coordinates.map((p) => p[2]),
      [3.5, 6.5],
    );
  });

  it("has no CRS and is not lon/lat for a projected file without srsName", () => {
    const result = parseIndoorGml(house);
    assert.equal(result.detectedCrs, undefined);
    assert.equal(result.coordinatesLookGeographic, false);
  });

  it("uses the storey a cell names, including a range for a staircase", () => {
    const result = parseIndoorGml(
      document(
        cell(
          "R1",
          box(0, 0, 0, 4, 4, 3),
          '<gml:description>storey="1":indoor="room":</gml:description>',
        ) +
          cell("R2", box(0, 0, 3, 4, 4, 6), '<gml:description>storey="2"</gml:description>') +
          cell("S", box(4, 0, 0, 5, 4, 6), '<gml:description>storey="1-2"</gml:description>'),
      ),
    );
    assert.equal(result.levelSource, "storey");
    assert.deepEqual(
      result.cells.features.map((feature) => feature.properties?.level),
      ["1", "2", "1-2"],
    );
    // A local frame a few metres wide fits lon/lat bounds but is not lon/lat.
    assert.equal(result.coordinatesLookGeographic, false);
  });

  it("reads a 2D cell, posList rings and an srsName, latitude first for an EPSG URN", () => {
    // urn:ogc:def:crs:EPSG::4326 is latitude, longitude.
    const polygon = `<core:Geometry2D><gml:Polygon srsName="urn:ogc:def:crs:EPSG::4326"><gml:exterior><gml:LinearRing><gml:posList srsDimension="2">49.1 8.43 49.1 8.4301 49.1001 8.4301 49.1 8.43 </gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></core:Geometry2D>`;
    const result = parseIndoorGml(document(cell("F", polygon)));
    assert.equal(result.detectedCrs, "EPSG:4326");
    assert.equal(result.coordinatesLookGeographic, true);
    assert.equal(result.levelSource, "none");
    const feature = result.cells.features[0];
    const ring = (feature.geometry as Polygon).coordinates[0];
    assert.equal(ring.length, 4);
    assert.deepEqual(ring[0], [8.43, 49.1]);
    assert.equal(feature.properties?.top_z, 3);
    assert.equal(feature.properties?.level, null);
  });

  it("keeps longitude first for a short EPSG:4326 srsName", () => {
    const polygon = `<core:Geometry2D><gml:Polygon srsName="EPSG:4326"><gml:exterior><gml:LinearRing><gml:posList srsDimension="2">8.43 49.1 8.4301 49.1 8.4301 49.1001 8.43 49.1</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></core:Geometry2D>`;
    const ring = (
      parseIndoorGml(document(cell("F", polygon))).cells.features[0].geometry as Polygon
    ).coordinates[0];
    assert.deepEqual(ring[0], [8.43, 49.1]);
  });

  it("reads an untagged 2D posList as 2D, whatever its ordinate count", () => {
    // Six numbers: three 2D positions, not two 3D ones.
    const polygon = `<core:Geometry2D><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>0 0 4 0 4 3</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></core:Geometry2D>`;
    const ring = (
      parseIndoorGml(document(cell("T", polygon))).cells.features[0].geometry as Polygon
    ).coordinates[0];
    assert.deepEqual(ring.slice(0, 3), [
      [0, 0],
      [4, 0],
      [4, 3],
    ]);
  });

  it("reads an untagged 2D cell as 2D in a document that also has solids", () => {
    const flat = `<core:Geometry2D><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>0 0 4 0 4 3</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></core:Geometry2D>`;
    const result = parseIndoorGml(document(cell("S", box(10, 0, 0, 12, 2, 3)) + cell("T", flat)));
    assert.equal(result.cells.features.length, 2);
    assert.deepEqual((result.cells.features[1].geometry as Polygon).coordinates[0][1], [4, 0]);
  });

  it("resolves solid surfaces referenced with xlink:href", () => {
    const floor = `<gml:Polygon gml:id="floor-1"><gml:exterior>${ring([
      [0, 0, 0],
      [0, 2, 0],
      [2, 2, 0],
      [2, 0, 0],
      [0, 0, 0],
    ])}</gml:exterior></gml:Polygon>`;
    const roof = `<gml:Polygon gml:id="roof-1"><gml:exterior>${ring([
      [0, 0, 3],
      [2, 0, 3],
      [2, 2, 3],
      [0, 2, 3],
      [0, 0, 3],
    ])}</gml:exterior></gml:Polygon>`;
    const solid = `<core:Geometry3D><gml:Solid><gml:exterior><gml:Shell><gml:surfaceMember>${floor}</gml:surfaceMember><gml:surfaceMember xlink:href="#roof-1"/></gml:Shell></gml:exterior></gml:Solid></core:Geometry3D>`;
    const other = `<core:Geometry3D><gml:Solid><gml:exterior><gml:Shell><gml:surfaceMember>${roof}</gml:surfaceMember></gml:Shell></gml:exterior></gml:Solid></core:Geometry3D>`;
    const result = parseIndoorGml(document(cell("R", solid) + cell("O", other)));
    // The roof the first cell references gives it its height.
    assert.equal(result.cells.features[0].properties?.top_z, 3);
  });

  it("keeps a missing transition weight missing, and finds a state's cell from the cell side", () => {
    const withDuality = (id: string, z0: number, z1: number, state: string) =>
      cell(id, box(0, 0, z0, 4, 4, z1), `<core:duality xlink:href="#${state}"/>`);
    const graphXml = `<core:multiLayeredGraph><core:MultiLayeredGraph gml:id="M"><core:spaceLayers gml:id="L"><core:spaceLayerMember><core:SpaceLayer gml:id="S"><core:nodes gml:id="N"><core:stateMember><core:State gml:id="a"><core:geometry><gml:Point><gml:pos>2 2 1</gml:pos></gml:Point></core:geometry></core:State></core:stateMember><core:stateMember><core:State gml:id="b"><core:geometry><gml:Point><gml:pos>2 2 4</gml:pos></gml:Point></core:geometry></core:State></core:stateMember></core:nodes><core:edges gml:id="E"><core:transitionMember><core:Transition gml:id="t"><core:connects xlink:href="#a"/><core:connects xlink:href="#b"/><core:geometry><gml:LineString><gml:pos>2 2 1</gml:pos><gml:pos>2 2 4</gml:pos></gml:LineString></core:geometry></core:Transition></core:transitionMember></core:edges></core:SpaceLayer></core:spaceLayerMember></core:spaceLayers></core:MultiLayeredGraph></core:multiLayeredGraph>`;
    const result = parseIndoorGml(
      document(withDuality("c0", 0, 3, "a") + withDuality("c1", 3, 6, "b"), graphXml),
    );
    assert.deepEqual(
      result.states.features.map((feature) => feature.properties?.level),
      ["0", "1"],
    );
    const edge = result.transitions.features[0];
    assert.equal(edge.properties?.weight, null);
    assert.equal(edge.properties?.level, "0;1");
  });

  it("skips a cell with no geometry and reports it", () => {
    const result = parseIndoorGml(
      document(
        cell("ok", box(0, 0, 0, 1, 1, 1)) +
          `<core:cellSpaceMember><core:CellSpace gml:id="empty"/></core:cellSpaceMember>`,
      ),
    );
    assert.equal(result.cells.features.length, 1);
    assert.match(result.warnings[0], /empty/);
  });

  it("rejects a document that is not IndoorGML or has no cells", () => {
    assert.throws(() => parseIndoorGml("<gml:FeatureCollection xmlns:gml='x'/>"), /IndoorGML/);
    assert.throws(() => parseIndoorGml(document("")), /no cells/);
  });
});

describe("floorsFromElevations", () => {
  it("groups bases into floors and counts from the one nearest zero", () => {
    assert.deepEqual(floorsFromElevations([-3, 0, 0.2, 3, 6.1, 0], 0), [-1, 0, 0, 1, 2, 0]);
    assert.deepEqual(floorsFromElevations([10, 13.5], 0), [0, 1]);
  });
});

describe("epsgFromSrsName", () => {
  it("reads the usual GML spellings", () => {
    assert.equal(epsgFromSrsName("EPSG:25832"), "EPSG:25832");
    assert.equal(epsgFromSrsName("urn:ogc:def:crs:EPSG::7415"), "EPSG:7415");
    assert.equal(epsgFromSrsName("http://www.opengis.net/def/crs/EPSG/0/4326"), "EPSG:4326");
    assert.equal(epsgFromSrsName("local"), undefined);
    assert.equal(epsgFromSrsName(null), undefined);
  });
});

describe("placeLocalCoordinates", () => {
  it("centres a local model on a point and turns metres into degrees, keeping Z", () => {
    const [placed] = placeLocalCoordinates(
      [
        {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: {},
              geometry: {
                type: "LineString",
                coordinates: [
                  [0, 0, 1],
                  [111.32, 222.64, 2],
                ],
              },
            },
          ],
        },
      ],
      [10, 0],
    );
    const coords = (placed.features[0].geometry as { coordinates: Position[] }).coordinates;
    assert.ok(Math.abs(coords[0][0] - (10 - 0.0005)) < 1e-9);
    assert.ok(Math.abs(coords[1][1] - 0.001) < 1e-9);
    assert.equal(coords[1][2], 2);
  });

  it("widens degrees of longitude away from the equator", () => {
    const [placed] = placeLocalCoordinates(
      [
        {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: {},
              geometry: {
                type: "LineString",
                coordinates: [
                  [0, 0],
                  [111.32, 0],
                ],
              },
            },
          ],
        },
      ],
      [10, 60],
    );
    const coords = (placed.features[0].geometry as { coordinates: Position[] }).coordinates;
    // 111.32 m spans 0.001° at the equator and twice that at 60° (cos 60° = 0.5).
    assert.ok(Math.abs(coords[1][0] - coords[0][0] - 0.002) < 1e-9);
  });
});

describe("indoorGmlCellColorExpression", () => {
  it("colours cells by kind with a fallback", () => {
    const expression = indoorGmlCellColorExpression("#000");
    assert.deepEqual(expression.slice(0, 2), ["match", ["get", "kind"]]);
    assert.equal(expression.at(-1), "#000");
    assert.ok(expression.includes("TransitionSpace"));
  });
});
