import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PLUGIN_DEEP_LINK_PARAM,
  pluginDeepLinkFromSearch,
  pluginDeepLinkNames,
} from "../apps/geolibre-desktop/src/lib/plugin-deep-link";
import { whiteboxToolFromSearch } from "../apps/geolibre-desktop/src/lib/whitebox-tool-url";

const IDS = [
  "maplibre-gl-swipe",
  "maplibre-gl-time-slider",
  "maplibre-h3-grid",
  "geolibre-sun",
  "gods-eye-view",
];

describe("pluginDeepLinkFromSearch", () => {
  it("uses the `plugin` query parameter", () => {
    assert.equal(PLUGIN_DEEP_LINK_PARAM, "plugin");
  });

  it("returns null when the parameter is absent or empty", () => {
    assert.equal(pluginDeepLinkFromSearch("", IDS), null);
    assert.equal(pluginDeepLinkFromSearch("?url=https://example.com/p.json", IDS), null);
    assert.equal(pluginDeepLinkFromSearch("?plugin=", IDS), null);
    assert.equal(pluginDeepLinkFromSearch("?plugin=%20,%20", IDS), null);
  });

  it("resolves a full plugin id", () => {
    assert.deepEqual(pluginDeepLinkFromSearch("?plugin=maplibre-gl-swipe", IDS), {
      pluginIds: ["maplibre-gl-swipe"],
      unknown: [],
    });
    // An id without a known prefix has no short name, only its full id.
    assert.deepEqual(pluginDeepLinkFromSearch("plugin=gods-eye-view", IDS), {
      pluginIds: ["gods-eye-view"],
      unknown: [],
    });
  });

  it("resolves short names without the maplibre-gl-, maplibre-, or geolibre- prefix", () => {
    assert.deepEqual(pluginDeepLinkFromSearch("?plugin=swipe,h3-grid,sun,Time-Slider", IDS), {
      pluginIds: [
        "maplibre-gl-swipe",
        "maplibre-h3-grid",
        "geolibre-sun",
        "maplibre-gl-time-slider",
      ],
      unknown: [],
    });
  });

  it("reads repeated parameters and drops duplicates in link order", () => {
    assert.deepEqual(
      pluginDeepLinkFromSearch("?plugin=sun&plugin=swipe,geolibre-sun&plugin=swipe", IDS),
      { pluginIds: ["geolibre-sun", "maplibre-gl-swipe"], unknown: [] },
    );
  });

  it("reports names that match no allowed plugin", () => {
    assert.deepEqual(pluginDeepLinkFromSearch("?plugin=swipe,nope,maplibre-gl-directions", IDS), {
      pluginIds: ["maplibre-gl-swipe"],
      unknown: ["nope", "maplibre-gl-directions"],
    });
  });

  it("keeps full ids case-sensitive", () => {
    assert.deepEqual(pluginDeepLinkFromSearch("?plugin=MAPLIBRE-GL-SWIPE", IDS), {
      pluginIds: [],
      unknown: ["MAPLIBRE-GL-SWIPE"],
    });
  });

  it("does not resolve a short name two plugins share", () => {
    const ids = ["maplibre-gl-grid", "geolibre-grid", "maplibre-gl-swipe"];
    assert.deepEqual(pluginDeepLinkFromSearch("?plugin=grid,swipe", ids), {
      pluginIds: ["maplibre-gl-swipe"],
      unknown: ["grid"],
    });
    // The full ids still work.
    assert.deepEqual(pluginDeepLinkFromSearch("?plugin=geolibre-grid", ids)?.pluginIds, [
      "geolibre-grid",
    ]);
  });
});

describe("pluginDeepLinkNames", () => {
  it("lists each plugin by its short name, or its id when it has none, sorted", () => {
    assert.deepEqual(pluginDeepLinkNames(IDS), [
      "gods-eye-view",
      "h3-grid",
      "sun",
      "swipe",
      "time-slider",
    ]);
  });

  it("falls back to the full id for a short name two plugins share", () => {
    assert.deepEqual(pluginDeepLinkNames(["maplibre-gl-grid", "geolibre-grid", "geolibre-sun"]), [
      "geolibre-grid",
      "maplibre-gl-grid",
      "sun",
    ]);
  });

  it("names only plugins the parser resolves back to the same id", () => {
    for (const name of pluginDeepLinkNames(IDS)) {
      assert.equal(pluginDeepLinkFromSearch(`?plugin=${name}`, IDS)?.pluginIds.length, 1, name);
    }
  });
});

describe("?plugin= alongside a ?tool= deep link", () => {
  it("is not forwarded to the Whitebox tool as a parameter", () => {
    assert.deepEqual(whiteboxToolFromSearch("?tool=slope&plugin=swipe&z_factor=2")?.parameters, {
      z_factor: "2",
    });
  });
});
