import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NLDI_API,
  buildBasinUrl,
  buildFlowtraceBody,
  buildHydrolocationUrl,
  buildNavigationSourceUrl,
  buildNavigationUrl,
  parseFlowtraceResponse,
} from "../packages/plugins/src/plugins/maplibre-usgs-nldi";

describe("USGS NLDI URL builders", () => {
  it("asks for JSON and encodes the click as WKT", () => {
    const url = new URL(buildHydrolocationUrl(-122.45, 37.77));
    assert.equal(url.origin + url.pathname, `${NLDI_API}/linked-data/hydrolocation`);
    assert.equal(url.searchParams.get("f"), "json");
    assert.equal(url.searchParams.get("coords"), "POINT(-122.45 37.77)");
  });

  it("defaults the basin request to the simplified geometry", () => {
    const url = new URL(buildBasinUrl("comid", "1234567"));
    assert.equal(url.pathname, "/nldi/linked-data/comid/1234567/basin");
    assert.equal(url.searchParams.get("simplified"), "true");
    assert.equal(
      new URL(buildBasinUrl("comid", "1234567", { simplified: false })).searchParams.get(
        "simplified",
      ),
      "false",
    );
  });

  it("percent-encodes feature sources and ids that carry path separators", () => {
    const url = new URL(buildBasinUrl("nmwdi-st", "a/b?c"));
    assert.equal(url.pathname, "/nldi/linked-data/nmwdi-st/a%2Fb%3Fc/basin");
    assert.ok(buildNavigationUrl("a/b").includes("a%2Fb"));
  });

  it("keeps the navigation URL's own query when adding options", () => {
    const source = `${NLDI_API}/linked-data/comid/9/navigation/UM/nwissite?f=json`;
    const url = new URL(
      buildNavigationSourceUrl(source, {
        distance: 25,
        trimStart: true,
        stopComid: "42",
        trimTolerance: 0.5,
      }),
    );
    assert.equal(url.searchParams.get("f"), "json");
    assert.equal(url.searchParams.get("distance"), "25");
    assert.equal(url.searchParams.get("trimStart"), "true");
    assert.equal(url.searchParams.get("stopComid"), "42");
    assert.equal(url.searchParams.get("trimTolerance"), "0.5");
  });

  it("defaults the navigation distance and omits the optional flags", () => {
    const url = new URL(buildNavigationSourceUrl(`${NLDI_API}/linked-data/comid/9/navigation/UM`));
    assert.equal(url.searchParams.get("distance"), "500");
    assert.equal(url.searchParams.get("trimStart"), null);
    assert.equal(url.searchParams.get("stopComid"), null);
    assert.equal(url.searchParams.get("trimTolerance"), null);
  });

  it("builds the flowtrace body with lat/lon and a default direction", () => {
    assert.deepEqual(JSON.parse(buildFlowtraceBody(-90.1, 38.6)), {
      inputs: { lat: 38.6, lon: -90.1, direction: "none" },
    });
    assert.deepEqual(JSON.parse(buildFlowtraceBody(-90.1, 38.6, "up")), {
      inputs: { lat: 38.6, lon: -90.1, direction: "up" },
    });
  });
});

describe("parseFlowtraceResponse", () => {
  const line = {
    type: "Feature" as const,
    geometry: {
      type: "LineString" as const,
      coordinates: [[0, 0] as [number, number], [1, 1] as [number, number]],
    },
    properties: { comid: 987 },
  };

  it("reads the flowline, raindrop path and COMID from a process response", () => {
    const parsed = parseFlowtraceResponse({
      flowline: { type: "FeatureCollection", features: [line] },
      raindropPath: { type: "FeatureCollection", features: [] },
    });
    assert.equal(parsed.flowline.features.length, 1);
    assert.equal(parsed.raindropPath.features.length, 0);
    assert.equal(parsed.comid, "987");
  });

  it("accepts a bare FeatureCollection as the flowline", () => {
    const parsed = parseFlowtraceResponse({ type: "FeatureCollection", features: [line] });
    assert.equal(parsed.flowline.features.length, 1);
    assert.equal(parsed.comid, "987");
  });

  it("wraps a lone Feature and a bare geometry into a collection", () => {
    assert.equal(parseFlowtraceResponse({ flowline: line }).flowline.features.length, 1);
    const geometry = parseFlowtraceResponse({ flowline: line.geometry });
    assert.equal(geometry.flowline.features.length, 1);
    assert.equal(geometry.flowline.features[0]?.geometry.type, "LineString");
  });

  it("falls back to a top-level COMID and tolerates the uppercase spelling", () => {
    assert.equal(
      parseFlowtraceResponse({
        COMID: 55,
        flowline: { type: "FeatureCollection", features: [] },
      }).comid,
      "55",
    );
  });

  it("returns empty collections for junk input", () => {
    for (const value of [null, undefined, 7, "nope"]) {
      const parsed = parseFlowtraceResponse(value);
      assert.equal(parsed.flowline.features.length, 0);
      assert.equal(parsed.raindropPath.features.length, 0);
      assert.equal(parsed.comid, undefined);
    }
  });
});
