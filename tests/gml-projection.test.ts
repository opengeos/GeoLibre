import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DOMParser } from "linkedom";
import type { Point, Polygon } from "geojson";
import { GmlUnsupportedCrsError } from "../apps/geolibre-desktop/src/lib/gml";
import {
  parseGmlWithReprojection,
  resolveEpsgCrs,
} from "../apps/geolibre-desktop/src/lib/gml-projection";

globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser;

const close = (actual: number[], expected: number[], tolerance = 1e-3) =>
  assert.ok(
    actual.every((value, index) => Math.abs(value - expected[index]) < tolerance),
    `${actual} is not ${expected}`,
  );

function point(srsName: string, body: string): string {
  return `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:ms="urn:ms">
    <wfs:member><ms:f><ms:g><gml:Point srsName="${srsName}">${body}</gml:Point></ms:g><ms:n>1</ms:n></ms:f></wfs:member>
  </wfs:FeatureCollection>`;
}

describe("parseGmlWithReprojection", () => {
  it("reprojects a GML 3 EPSG:2180 URN position, north first", async () => {
    const collection = await parseGmlWithReprojection(
      point("urn:ogc:def:crs:EPSG::2180", "<gml:pos>683828.4757 179194.1117</gml:pos>"),
    );
    close((collection.features[0].geometry as Point).coordinates, [14.112, 53.919]);
    assert.equal(collection.features[0].properties?.n, 1);
  });

  it("reads a legacy EPSG:25832 name east first", async () => {
    // UTM 32N: 500000 E is the 9°E central meridian.
    const collection = await parseGmlWithReprojection(
      point("EPSG:25832", "<gml:pos>500000 5540000</gml:pos>"),
    );
    close((collection.features[0].geometry as Point).coordinates, [9, 50.0123]);
  });

  it("resolves several CRSs in one document", async () => {
    const gml = `<FeatureCollection xmlns:gml="http://www.opengis.net/gml">
      <featureMember><f><g><gml:Polygon srsName="EPSG:25833"><gml:outerBoundaryIs><gml:LinearRing>
        <gml:coordinates>500000,5540000 500100,5540000 500100,5540100 500000,5540000</gml:coordinates>
      </gml:LinearRing></gml:outerBoundaryIs></gml:Polygon></g></f></featureMember>
      <featureMember><f><g><gml:Point srsName="EPSG:2180"><gml:coordinates>500000,500000</gml:coordinates></gml:Point></g></f></featureMember>
    </FeatureCollection>`;
    const [polygon, center] = (await parseGmlWithReprojection(gml)).features;
    close((polygon.geometry as Polygon).coordinates[0][0], [15, 50.0123]);
    close((center.geometry as Point).coordinates, [19, 52.366]);
  });

  it("still rejects a CRS the tables do not know", async () => {
    await assert.rejects(
      parseGmlWithReprojection(point("EPSG:999999", "<gml:pos>1 2</gml:pos>")),
      (error: Error) => error instanceof GmlUnsupportedCrsError && /999999/.test(error.message),
    );
    await assert.rejects(
      parseGmlWithReprojection(point("urn:ogc:def:crs:ESRI::102100x", "<gml:pos>1 2</gml:pos>")),
      GmlUnsupportedCrsError,
    );
  });
});

describe("resolveEpsgCrs", () => {
  it("applies EPSG axis order only to URN names of north-first CRSs", async () => {
    assert.equal((await resolveEpsgCrs("urn:ogc:def:crs:EPSG::2180"))?.swapAxes, true);
    assert.equal((await resolveEpsgCrs("EPSG:2180"))?.swapAxes, false);
    assert.equal((await resolveEpsgCrs("urn:ogc:def:crs:EPSG::25832"))?.swapAxes, false);
    // A geographic CRS the built-ins do not cover (NZGD2000) is latitude first.
    assert.equal((await resolveEpsgCrs("urn:ogc:def:crs:EPSG::4167"))?.swapAxes, true);
    assert.equal(await resolveEpsgCrs("not-a-crs"), null);
  });
});
