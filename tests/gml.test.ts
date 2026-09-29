import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DOMParser } from "linkedom";
import type { LineString, MultiPolygon, Point, Polygon } from "geojson";
import {
  GmlUnsupportedCrsError,
  coordinateTransform,
  looksLikeGmlFeatureCollection,
  parseGmlFeatureCollection,
} from "../apps/geolibre-desktop/src/lib/gml";

globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser;

// Trimmed from a real MapServer WFS 2.0.0 response (Polish PRG service,
// srsName=EPSG:4326): GML 3.2, wfs:member, lat/lon posList under a URN CRS.
const MAPSERVER_GML32 = `<?xml version='1.0' encoding="UTF-8" ?>
<wfs:FeatureCollection xmlns:ms="http://mapserver.gis.umn.edu/mapserver"
  xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:wfs="http://www.opengis.net/wfs/2.0"
  numberMatched="unknown" numberReturned="1">
  <wfs:boundedBy>
    <gml:Envelope srsName="urn:ogc:def:crs:EPSG::4326">
      <gml:lowerCorner>53.925963 14.069640</gml:lowerCorner>
      <gml:upperCorner>54.441141 14.323909</gml:upperCorner>
    </gml:Envelope>
  </wfs:boundedBy>
  <!-- WARNING: FeatureId item 'ptid' not found in typename 'W10_Reda'. -->
  <wfs:member>
    <ms:W10_Reda>
      <gml:boundedBy>
        <gml:Envelope srsName="urn:ogc:def:crs:EPSG::4326">
          <gml:lowerCorner>53.925963 14.069640</gml:lowerCorner>
          <gml:upperCorner>54.441141 14.323909</gml:upperCorner>
        </gml:Envelope>
      </gml:boundedBy>
      <ms:msGeometry>
        <gml:Polygon gml:id=".1" srsName="urn:ogc:def:crs:EPSG::4326">
          <gml:exterior>
            <gml:LinearRing>
              <gml:posList srsDimension="2">54.44 14.11 54.27 14.06 53.92 14.27 54.44 14.11</gml:posList>
            </gml:LinearRing>
          </gml:exterior>
        </gml:Polygon>
      </ms:msGeometry>
      <ms:DESCRIPTIO></ms:DESCRIPTIO>
      <ms:FULL_NAME>Reda Portu Świnoujście</ms:FULL_NAME>
      <ms:IIP_PRZEST>PL.ZIPGM.6686</ms:IIP_PRZEST>
    </ms:W10_Reda>
  </wfs:member>
</wfs:FeatureCollection>`;

// GeoServer-style WFS 1.1.0 / GML 3.1.1: legacy EPSG:4326 name (lon/lat),
// gml:featureMembers, typed-looking attributes, a code with a leading zero.
const GEOSERVER_GML31 = `<?xml version="1.0" encoding="UTF-8"?>
<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs" xmlns:gml="http://www.opengis.net/gml"
  xmlns:topp="http://www.openplans.org/topp" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <gml:featureMembers>
    <topp:cities gml:id="cities.1">
      <topp:the_geom>
        <gml:Point srsName="http://www.opengis.net/gml/srs/epsg.xml#4326">
          <gml:pos>-83.92 35.96</gml:pos>
        </gml:Point>
      </topp:the_geom>
      <topp:name>Knoxville</topp:name>
      <topp:population>190740</topp:population>
      <topp:ratio>-1.5e3</topp:ratio>
      <topp:fips>047</topp:fips>
      <topp:capital>false</topp:capital>
      <topp:notes xsi:nil="true"/>
    </topp:cities>
    <topp:cities gml:id="cities.2">
      <topp:the_geom>
        <gml:LineString srsName="EPSG:4326">
          <gml:posList>-84 35 -83 36 -82 37</gml:posList>
        </gml:LineString>
      </topp:the_geom>
      <topp:name>Route</topp:name>
    </topp:cities>
  </gml:featureMembers>
</wfs:FeatureCollection>`;

describe("looksLikeGmlFeatureCollection", () => {
  it("recognizes a feature collection behind a prolog and comments", () => {
    assert.equal(looksLikeGmlFeatureCollection(MAPSERVER_GML32), true);
    assert.equal(looksLikeGmlFeatureCollection("<!-- c --><?pi x?><FeatureCollection/>"), true);
  });

  it("rejects exception reports and capabilities documents", () => {
    assert.equal(
      looksLikeGmlFeatureCollection('<?xml version="1.0"?><ows:ExceptionReport/>'),
      false,
    );
    assert.equal(looksLikeGmlFeatureCollection("<wfs:WFS_Capabilities/>"), false);
  });
});

describe("parseGmlFeatureCollection", () => {
  it("reads a MapServer GML 3.2 response and swaps URN EPSG:4326 lat/lon", () => {
    const collection = parseGmlFeatureCollection(MAPSERVER_GML32);
    assert.equal(collection.features.length, 1);
    const [feature] = collection.features;
    const polygon = feature.geometry as Polygon;
    assert.equal(polygon.type, "Polygon");
    assert.deepEqual(polygon.coordinates[0][0], [14.11, 54.44]);
    assert.deepEqual(feature.properties, {
      DESCRIPTIO: null,
      FULL_NAME: "Reda Portu Świnoujście",
      IIP_PRZEST: "PL.ZIPGM.6686",
    });
    assert.equal("boundedBy" in (feature.properties ?? {}), false);
  });

  it("keeps legacy EPSG:4326 lon/lat, ids, and typed attribute values", () => {
    const collection = parseGmlFeatureCollection(GEOSERVER_GML31);
    assert.equal(collection.features.length, 2);
    const [city, route] = collection.features;
    assert.equal(city.id, "cities.1");
    assert.deepEqual((city.geometry as Point).coordinates, [-83.92, 35.96]);
    assert.deepEqual(city.properties, {
      name: "Knoxville",
      population: 190740,
      ratio: -1500,
      fips: "047",
      capital: false,
      notes: null,
    });
    assert.deepEqual((route.geometry as LineString).coordinates, [
      [-84, 35],
      [-83, 36],
      [-82, 37],
    ]);
  });

  it("types a column only when every value in it qualifies", () => {
    const gml = `<FeatureCollection xmlns:gml="http://www.opengis.net/gml">
      <featureMember><f><code>08</code><n>1.5</n><flag>true</flag><gap/></f></featureMember>
      <featureMember><f><code>32</code><n>2</n><flag>no</flag><gap>7</gap></f></featureMember>
    </FeatureCollection>`;
    const [first, second] = parseGmlFeatureCollection(gml).features;
    // "08" keeps the whole code column text; n is numeric throughout; a single
    // non-boolean keeps flag text; an empty value does not block typing.
    assert.deepEqual(first.properties, { code: "08", n: 1.5, flag: "true", gap: null });
    assert.deepEqual(second.properties, { code: "32", n: 2, flag: "no", gap: 7 });
  });

  it("reads GML 2 coordinates, featureMember, and inner rings", () => {
    const gml = `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs"
      xmlns:gml="http://www.opengis.net/gml" xmlns:ns="urn:x">
      <gml:featureMember>
        <ns:parcel fid="parcel.7">
          <ns:geom>
            <gml:Polygon srsName="EPSG:4326">
              <gml:outerBoundaryIs><gml:LinearRing>
                <gml:coordinates>0,0 10,0 10,10 0,10 0,0</gml:coordinates>
              </gml:LinearRing></gml:outerBoundaryIs>
              <gml:innerBoundaryIs><gml:LinearRing>
                <gml:coordinates decimal="," cs=";" ts=" ">2,5;2 4;2 4;4 2,5;2</gml:coordinates>
              </gml:LinearRing></gml:innerBoundaryIs>
            </gml:Polygon>
          </ns:geom>
        </ns:parcel>
      </gml:featureMember>
    </wfs:FeatureCollection>`;
    const [feature] = parseGmlFeatureCollection(gml).features;
    assert.equal(feature.id, "parcel.7");
    const polygon = feature.geometry as Polygon;
    assert.equal(polygon.coordinates.length, 2);
    assert.deepEqual(polygon.coordinates[0][1], [10, 0]);
    assert.deepEqual(polygon.coordinates[1][0], [2.5, 2]);
  });

  it("flattens MultiSurface of Surface patches and Curve segments", () => {
    const gml = `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0"
      xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:au="urn:au">
      <wfs:member>
        <au:Unit gml:id="u1">
          <au:geometry>
            <gml:MultiSurface srsName="http://www.opengis.net/def/crs/EPSG/0/4258">
              <gml:surfaceMember>
                <gml:Surface>
                  <gml:patches>
                    <gml:PolygonPatch>
                      <gml:exterior>
                        <gml:Ring>
                          <gml:curveMember>
                            <gml:Curve>
                              <gml:segments>
                                <gml:LineStringSegment><gml:posList>50 10 50 11 51 11</gml:posList></gml:LineStringSegment>
                                <gml:LineStringSegment><gml:posList>51 11 50 10</gml:posList></gml:LineStringSegment>
                              </gml:segments>
                            </gml:Curve>
                          </gml:curveMember>
                        </gml:Ring>
                      </gml:exterior>
                    </gml:PolygonPatch>
                  </gml:patches>
                </gml:Surface>
              </gml:surfaceMember>
              <gml:surfaceMember>
                <gml:Polygon>
                  <gml:exterior><gml:LinearRing>
                    <gml:pos>40 0</gml:pos><gml:pos>40 1</gml:pos><gml:pos>41 1</gml:pos><gml:pos>40 0</gml:pos>
                  </gml:LinearRing></gml:exterior>
                </gml:Polygon>
              </gml:surfaceMember>
            </gml:MultiSurface>
          </au:geometry>
          <au:name><au:GeographicalName><au:text>Nowa   Wieś</au:text></au:GeographicalName></au:name>
          <au:upper xlink:href="#u0" xmlns:xlink="http://www.w3.org/1999/xlink"/>
        </au:Unit>
      </wfs:member>
    </wfs:FeatureCollection>`;
    const [feature] = parseGmlFeatureCollection(gml).features;
    const multi = feature.geometry as MultiPolygon;
    assert.equal(multi.type, "MultiPolygon");
    assert.equal(multi.coordinates.length, 2);
    // The shared vertex between the two segments is not duplicated, and the
    // ETRS89 URN is lat/lon, so it is swapped.
    assert.deepEqual(multi.coordinates[0][0], [
      [10, 50],
      [11, 50],
      [11, 51],
      [10, 50],
    ]);
    assert.deepEqual(multi.coordinates[1][0][1], [1, 40]);
    assert.equal(feature.properties?.name, "Nowa Wieś");
    assert.equal(feature.properties?.upper, "#u0");
  });

  it("falls back to the request srsName and keeps a 3D posList's height", () => {
    const gml = `<FeatureCollection xmlns:gml="http://www.opengis.net/gml/3.2">
      <member><f><g><gml:Point><gml:pos srsDimension="3">45 7 120</gml:pos></gml:Point></g></f></member>
    </FeatureCollection>`;
    const [feature] = parseGmlFeatureCollection(gml, {
      defaultSrsName: "urn:ogc:def:crs:EPSG::4326",
    }).features;
    assert.deepEqual((feature.geometry as Point).coordinates, [7, 45, 120]);
  });

  it("unprojects Web Mercator", () => {
    const gml = `<FeatureCollection xmlns:gml="http://www.opengis.net/gml">
      <featureMember><f><g><gml:Point srsName="EPSG:3857"><gml:pos>0 0</gml:pos></gml:Point></g></f></featureMember>
    </FeatureCollection>`;
    const [feature] = parseGmlFeatureCollection(gml).features;
    const [lon, lat] = (feature.geometry as Point).coordinates;
    assert.ok(Math.abs(lon) < 1e-9 && Math.abs(lat) < 1e-9);
  });

  it("rejects a projected CRS it cannot convert, naming it", () => {
    // MapServer answers WFS 1.0.0 in its native CRS whatever srsName says.
    const gml = `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs" xmlns:gml="http://www.opengis.net/gml">
      <gml:featureMember><ms:f xmlns:ms="urn:ms"><ms:g>
        <gml:Point srsName="urn:ogc:def:crs:EPSG::2180"><gml:coordinates>179194.1,683828.4</gml:coordinates></gml:Point>
      </ms:g></ms:f></gml:featureMember>
    </wfs:FeatureCollection>`;
    assert.throws(
      () => parseGmlFeatureCollection(gml),
      (error: Error) => error instanceof GmlUnsupportedCrsError && /EPSG::2180/.test(error.message),
    );
  });

  it("rejects a document that is not a feature collection", () => {
    assert.throws(() => parseGmlFeatureCollection("<ows:ExceptionReport xmlns:ows='urn:o'/>"));
  });

  it("returns an empty collection for zero members", () => {
    const gml = `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" numberReturned="0"/>`;
    assert.deepEqual(parseGmlFeatureCollection(gml).features, []);
  });
});

describe("coordinateTransform", () => {
  it("treats CRS84 and a missing name as lon/lat", () => {
    assert.deepEqual(coordinateTransform(undefined)([1, 2]), [1, 2]);
    assert.deepEqual(coordinateTransform("urn:ogc:def:crs:OGC:1.3:CRS84")([1, 2]), [1, 2]);
    assert.deepEqual(coordinateTransform("urn:x-ogc:def:crs:EPSG:6.9:4326")([2, 1]), [1, 2]);
  });
});
