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

  it("treats a percent-encoded dot segment (%2e%2e) as a literal file name", () => {
    // The path is a bundle-relative file path, so "%" is encoded like any other
    // name character: "%2e%2e" names a folder literally called "%2e%2e" inside
    // the plugin directory (as a desktop bundle read would), never "..".
    assert.equal(
      pluginAssetUrlFromSource("https://geolibre.app/plugins/x/plugin.json", "%2e%2e/secrets"),
      "https://geolibre.app/plugins/x/%252e%252e/secrets",
    );
  });

  it("rejects empty and dot segments", () => {
    for (const path of ["", "a//b", "./a", "a/./b", "a/../b", "C:/x", "a\\b"]) {
      assert.equal(
        pluginAssetUrlFromSource("https://geolibre.app/plugins/x/plugin.json", path),
        null,
        path,
      );
    }
  });

  it("keeps #, ?, % and spaces as literal file name characters (#3448)", () => {
    // Unencoded, "#" and "?" would cut the URL into a fragment or a query and
    // fetch a different resource than the file the plugin named.
    const url = pluginAssetUrlFromSource(
      "https://geolibre.app/plugins/x/plugin.json",
      "data/run #1/what? 100%.json",
    );
    assert.equal(url, "https://geolibre.app/plugins/x/data/run%20%231/what%3F%20100%25.json");
    const parsed = new URL(url!);
    assert.equal(parsed.hash, "");
    assert.equal(parsed.search, "");
    assert.equal(decodeURIComponent(parsed.pathname), "/plugins/x/data/run #1/what? 100%.json");
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
