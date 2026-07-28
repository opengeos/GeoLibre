import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  resolvePluginAssetUrl,
  withPluginAssetCacheToken,
} from "../apps/geolibre-desktop/src/lib/plugin-asset-url";

describe("plugin asset URLs", () => {
  it("appends a cache token to resolved plugin asset URLs", () => {
    const assetUrl = resolvePluginAssetUrl(
      "https://example.com/plugins/nasa-opera/plugin.json",
      "dist/index.js",
    );

    assert.equal(
      withPluginAssetCacheToken(assetUrl, 'geolibre-nasa-opera|0.3.0|W/"abc"'),
      "https://example.com/plugins/nasa-opera/dist/index.js?__geolibre_plugin_cache=geolibre-nasa-opera%7C0.3.0%7CW%2F%22abc%22",
    );
  });

  it("leaves plugin asset URLs unchanged without a cache token", () => {
    const assetUrl = "https://example.com/plugins/nasa-opera/dist/style.css";

    assert.equal(withPluginAssetCacheToken(assetUrl, ""), assetUrl);
  });
});
