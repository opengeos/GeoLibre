import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pluginAssetUrlFromSource } from "../apps/geolibre-desktop/src/lib/plugin-asset-url";

describe("pluginAssetUrlFromSource", () => {
  it("resolves an asset against a bundled plugin's manifest URL", () => {
    assert.equal(
      pluginAssetUrlFromSource(
        "https://geolibre.app/plugins/demo-plugin/plugin.json",
        "dist/sample-data",
      ),
      "https://geolibre.app/plugins/demo-plugin/dist/sample-data",
    );
  });

  it("respects a non-root app base in the manifest URL", () => {
    assert.equal(
      pluginAssetUrlFromSource(
        "https://example.com/geolibre/plugins/x/plugin.json",
        "dist/sample-data",
      ),
      "https://example.com/geolibre/plugins/x/dist/sample-data",
    );
  });

  it("resolves against a tauri:// manifest URL (desktop bundled build)", () => {
    assert.equal(
      pluginAssetUrlFromSource("tauri://localhost/plugins/x/plugin.json", "dist/sample-data"),
      "tauri://localhost/plugins/x/dist/sample-data",
    );
  });

  it("returns null for a desktop filesystem source (no URL base)", () => {
    assert.equal(
      pluginAssetUrlFromSource(
        "/home/user/.local/share/org.geolibre.desktop/plugins/x",
        "dist/sample-data",
      ),
      null,
    );
  });

  it("returns null when the source is missing", () => {
    assert.equal(pluginAssetUrlFromSource(undefined, "dist/sample-data"), null);
  });

  it("rejects paths that escape the plugin directory", () => {
    assert.equal(
      pluginAssetUrlFromSource("https://geolibre.app/plugins/x/plugin.json", "../secrets"),
      null,
    );
  });

  it("rejects absolute paths", () => {
    assert.equal(
      pluginAssetUrlFromSource("https://geolibre.app/plugins/x/plugin.json", "/etc/passwd"),
      null,
    );
  });

  it("rejects percent-encoded path traversal (%2e%2e)", () => {
    // The literal-segment checks pass "%2e%2e", but URL normalization decodes
    // it to ".." and the resolved URL lands outside the plugin directory, so
    // the directory-containment guard still rejects it.
    assert.equal(
      pluginAssetUrlFromSource("https://geolibre.app/plugins/x/plugin.json", "%2e%2e/secrets"),
      null,
    );
  });
});
