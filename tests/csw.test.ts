import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DOMParser } from "linkedom";
import { CSW_SAMPLES } from "../apps/geolibre-desktop/src/components/layout/add-data/constants";
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

  it("claims Esri REST endpoints but not UMN MapServer CGI", () => {
    assert.equal(classifyCswResource("https://x.test/rest/services/A/MapServer/0"), "arcgis");
    assert.equal(classifyCswResource("http://x.test/cgi-bin/mapserver.cgi?map=foo"), "unknown");
  });
});

/**
 * The Add CSW Catalog dialog offers these as one-click samples. A CSW endpoint
 * is unguessable, so a sample the search step rejects before it ever leaves the
 * browser reads as a broken panel. These checks run the entries through the same
 * validation and request builder the dialog uses; whether a catalog is reachable
 * is a network question the suite deliberately leaves alone.
 */
describe("Add Data CSW catalog samples", () => {
  it("offers samples with unique labels and endpoints", () => {
    assert.ok(CSW_SAMPLES.length > 0, "no CSW samples are offered");
    assert.equal(new Set(CSW_SAMPLES.map((s) => s.label)).size, CSW_SAMPLES.length);
    assert.equal(new Set(CSW_SAMPLES.map((s) => s.endpoint)).size, CSW_SAMPLES.length);
  });

  for (const sample of CSW_SAMPLES) {
    it(`builds a GetRecords request for ${sample.label}`, () => {
      // The dialog trims before validating, so a stray space would still search;
      // it would also be a typo, and every other field is compared untrimmed.
      assert.equal(sample.endpoint, sample.endpoint.trim());
      assert.ok(isHttpCswEndpoint(sample.endpoint), "endpoint is not an http(s) URL");
      const url = new URL(createCswGetRecordsUrl(sample.endpoint, sample.keyword));
      const endpoint = new URL(sample.endpoint);
      assert.equal(url.origin, endpoint.origin);
      assert.equal(url.pathname, endpoint.pathname);
      assert.equal(url.searchParams.get("request"), "GetRecords");
      assert.equal(url.searchParams.get("service"), "CSW");
      // A keyword only reaches the server as a CQL constraint, so an entry that
      // ships one must produce it (and one that doesn't must not send an empty
      // constraint the server would reject).
      if (sample.keyword) {
        assert.match(url.searchParams.get("constraint") ?? "", new RegExp(sample.keyword, "i"));
      } else {
        assert.equal(url.searchParams.get("constraint"), null);
      }
    });
  }
});
