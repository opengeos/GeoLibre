import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DOMParser } from "linkedom";
import {
  classifyCswResource,
  createCswGetRecordsUrl,
  isCswFeatureCollection,
  isHttpCswEndpoint,
  parseCswRecords,
} from "../apps/geolibre-desktop/src/components/layout/add-data/csw";

globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser;

describe("CSW catalog helpers", () => {
  it("builds a keyword GetRecords request and replaces stale operation parameters", () => {
    const url = new URL(
      createCswGetRecordsUrl("https://catalog.test/csw?request=GetCapabilities", "water"),
    );
    assert.equal(url.searchParams.get("request"), "GetRecords");
    assert.equal(url.searchParams.get("typeNames"), "csw:Record");
    assert.match(url.searchParams.get("constraint") ?? "", /water/);
  });

  it("parses Dublin Core records and classifies their online resources", () => {
    const records = parseCswRecords(`
      <csw:GetRecordsResponse xmlns:csw="http://www.opengis.net/cat/csw/2.0.2"
        xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dct="http://purl.org/dc/terms/">
        <csw:SearchResults>
          <csw:Record>
            <dc:identifier>roads</dc:identifier><dc:title>Roads</dc:title>
            <dct:abstract>Road centerlines</dct:abstract>
            <dc:URI protocol="OGC:WMS" name="transport:roads">https://maps.test/ows</dc:URI>
            <dc:references scheme="WWW:DOWNLOAD-1.0-http--download">https://data.test/roads.geojson</dc:references>
          </csw:Record>
        </csw:SearchResults>
      </csw:GetRecordsResponse>`);
    assert.equal(records[0].title, "Roads");
    assert.deepEqual(
      records[0].resources.map(({ kind }) => kind),
      ["wms", "geojson"],
    );
    assert.equal(records[0].resources[0].name, "transport:roads");
  });

  it("rejects endpoints that createCswGetRecordsUrl cannot parse", () => {
    assert.equal(isHttpCswEndpoint("https://catalog.test/csw"), true);
    assert.equal(isHttpCswEndpoint("https://"), false);
    assert.equal(isHttpCswEndpoint("ftp://catalog.test/csw"), false);
    assert.equal(isHttpCswEndpoint("catalog.test/csw"), false);
  });

  it("requires a features array, not just a FeatureCollection type", () => {
    assert.equal(isCswFeatureCollection({ type: "FeatureCollection", features: [] }), true);
    assert.equal(isCswFeatureCollection({ type: "FeatureCollection" }), false);
    assert.equal(isCswFeatureCollection({ type: "Feature", geometry: null }), false);
    assert.equal(isCswFeatureCollection({ type: "FeatureCollection", features: [null] }), false);
    assert.equal(isCswFeatureCollection(null), false);
  });

  it("recognizes ArcGIS and WFS resource URLs", () => {
    assert.equal(classifyCswResource("https://x.test/FeatureServer/0"), "arcgis");
    assert.equal(classifyCswResource("https://x.test/ows?service=WFS"), "wfs");
  });

  it("parses SummaryRecord responses from servers that ignore elementSetName", () => {
    const records = parseCswRecords(`
      <csw:GetRecordsResponse xmlns:csw="http://www.opengis.net/cat/csw/2.0.2"
        xmlns:dc="http://purl.org/dc/elements/1.1/">
        <csw:SearchResults>
          <csw:SummaryRecord>
            <dc:identifier>rivers</dc:identifier><dc:title>Rivers</dc:title>
            <dc:URI protocol="OGC:WFS">https://maps.test/ows</dc:URI>
          </csw:SummaryRecord>
        </csw:SearchResults>
      </csw:GetRecordsResponse>`);
    assert.equal(records.length, 1);
    assert.equal(records[0].title, "Rivers");
    assert.equal(records[0].resources[0].kind, "wfs");
  });

  it("reads a bare service token from the scheme but not from the URL", () => {
    assert.equal(classifyCswResource("https://x.test/ows", "OGC:WMS"), "wms");
    assert.equal(classifyCswResource("https://x.test/docs/wms-user-guide.pdf"), "unknown");
    assert.equal(classifyCswResource("https://x.test/geoserver/wms"), "wms");
  });
});
