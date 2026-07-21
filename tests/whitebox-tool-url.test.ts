import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isKnownWhiteboxToolId,
  WHITEBOX_TOOL_PARAM,
  whiteboxToolFromSearch,
} from "../apps/geolibre-desktop/src/lib/whitebox-tool-url";

describe("isKnownWhiteboxToolId", () => {
  it("accepts ids present in the checked-in menu catalog", () => {
    // A Whitebox catalog tool, a terrain tool, and a GeoLibre-authored WASM
    // tool — all three families the catalog merges.
    assert.equal(isKnownWhiteboxToolId("adaptive_filter"), true);
    assert.equal(isKnownWhiteboxToolId("slope"), true);
    assert.equal(isKnownWhiteboxToolId("write_geoparquet"), true);
  });

  it("rejects ids not in the catalog", () => {
    assert.equal(isKnownWhiteboxToolId("not_a_real_tool"), false);
    assert.equal(isKnownWhiteboxToolId(""), false);
    // Case-sensitive: catalog ids are lowercase snake_case.
    assert.equal(isKnownWhiteboxToolId("Adaptive_Filter"), false);
  });
});

describe("whiteboxToolFromSearch", () => {
  it("parses a known tool id and marks it known with no parameters", () => {
    assert.deepEqual(whiteboxToolFromSearch("?tool=adaptive_filter"), {
      toolId: "adaptive_filter",
      known: true,
      parameters: {},
    });
  });

  it("returns a present-but-unknown id with known=false rather than dropping it", () => {
    assert.deepEqual(whiteboxToolFromSearch("?tool=not_a_real_tool"), {
      toolId: "not_a_real_tool",
      known: false,
      parameters: {},
    });
  });

  it("trims surrounding whitespace before matching", () => {
    assert.deepEqual(whiteboxToolFromSearch("?tool=%20adaptive_filter%20"), {
      toolId: "adaptive_filter",
      known: true,
      parameters: {},
    });
  });

  it("returns null when the tool parameter is absent or empty", () => {
    assert.equal(whiteboxToolFromSearch(""), null);
    assert.equal(whiteboxToolFromSearch("?foo=bar"), null);
    assert.equal(whiteboxToolFromSearch("?tool="), null);
    assert.equal(whiteboxToolFromSearch("?tool=%20%20"), null);
  });

  it("reads the parameter with or without a leading question mark", () => {
    assert.equal(whiteboxToolFromSearch(`${WHITEBOX_TOOL_PARAM}=slope`)?.toolId, "slope");
    assert.equal(whiteboxToolFromSearch(`?${WHITEBOX_TOOL_PARAM}=slope`)?.toolId, "slope");
  });

  it("uses the first value when the tool parameter is repeated", () => {
    assert.equal(whiteboxToolFromSearch("?tool=slope&tool=aspect")?.toolId, "slope");
  });

  it("collects remaining query params as tool parameters, including url", () => {
    // The geolibre-rust-style deep link: url + a decoded value + a plain param.
    const target = whiteboxToolFromSearch(
      "?tool=extract_cog_subset&url=https%3A%2F%2Fdata.source.coop%2Fgiswqs%2Fopengeos%2Fdem.tif&bbox_crs=4326",
    );
    assert.deepEqual(target, {
      toolId: "extract_cog_subset",
      known: true,
      parameters: {
        url: "https://data.source.coop/giswqs/opengeos/dem.tif",
        bbox_crs: "4326",
      },
    });
  });

  it("excludes app/embed params from the tool parameters", () => {
    const target = whiteboxToolFromSearch(
      "?tool=slope&theme=dark&maponly=1&locale=fr&panels=none&z_factor=2",
    );
    // Only the genuine tool parameter survives; app chrome keeps its own meaning.
    assert.deepEqual(target?.parameters, { z_factor: "2" });
  });

  it("uses the first value when a tool parameter is repeated", () => {
    assert.equal(
      whiteboxToolFromSearch("?tool=extract_cog_subset&url=a&url=b")?.parameters.url,
      "a",
    );
  });
});
