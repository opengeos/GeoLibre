import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  managedUrlSourcesForIds,
  pluginAssetUrlFromSource,
} from "../apps/geolibre-desktop/src/lib/plugin-asset-url";

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

describe("managedUrlSourcesForIds", () => {
  // A plugin id -> loaded-source map covering every source kind the loader
  // records: a manifest-URL install, a desktop bundled drop-in, a desktop
  // filesystem plugin, and a web "install from file" archive.
  const SOURCES: Record<string, string> = {
    "url-plugin": "https://data.example.com/url-plugin/plugin.json",
    "bundled-plugin": "tauri://localhost/plugins/bundled-plugin/plugin.json",
    "filesystem-plugin": "/home/user/.local/share/org.geolibre.desktop/plugins/fs-plugin",
    "web-archive-plugin": "web-archive:web-archive-plugin",
  };
  const sourceOf = (pluginId: string) => SOURCES[pluginId];

  it("returns the manifest URL for a plugin installed from a URL", () => {
    assert.deepEqual(managedUrlSourcesForIds(["url-plugin"], sourceOf), [
      "https://data.example.com/url-plugin/plugin.json",
    ]);
  });

  it("ignores built-in plugins, which have no recorded source", () => {
    assert.deepEqual(managedUrlSourcesForIds(["maplibre-3d-tiles"], sourceOf), []);
  });

  it("skips sources a recipient could never fetch", () => {
    // A filesystem path is local to the author's machine and a web archive
    // source is a synthetic id; recording either in a shared project would
    // raise a trust prompt that can never be satisfied.
    assert.deepEqual(
      managedUrlSourcesForIds(["filesystem-plugin", "web-archive-plugin"], sourceOf),
      [],
    );
  });

  it("preserves order and de-duplicates repeated ids", () => {
    assert.deepEqual(
      managedUrlSourcesForIds(
        ["bundled-plugin", "url-plugin", "bundled-plugin", "filesystem-plugin"],
        sourceOf,
      ),
      [
        "tauri://localhost/plugins/bundled-plugin/plugin.json",
        "https://data.example.com/url-plugin/plugin.json",
      ],
    );
  });

  it("returns nothing when the project uses no plugins", () => {
    assert.deepEqual(managedUrlSourcesForIds([], sourceOf), []);
  });
});
