import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { partitionProjectPluginManifestUrls } from "../apps/geolibre-desktop/src/lib/plugin-trust";

// Security regression coverage for #1062: a `.geolibre.json` project is opened
// as data, so its plugin manifest URLs must never be fetched or imported until
// the user makes an explicit trust decision. The load path only ever scans the
// TRUSTED set (installed settings URLs + bundled drop-ins), so verifying that a
// project's URLs are partitioned as "untrusted" proves the auto-loader never
// sees them.
describe("partitionProjectPluginManifestUrls", () => {
  it("treats a project URL not in settings or bundled as untrusted", () => {
    const { trusted, untrusted } = partitionProjectPluginManifestUrls(
      ["https://evil.example.com/plugin.json"],
      [],
      [],
    );
    assert.deepEqual(untrusted, ["https://evil.example.com/plugin.json"]);
    assert.deepEqual(trusted, []);
  });

  it("trusts a project URL the user has already installed in settings", () => {
    const url = "https://plugins.example.com/plugin.json";
    const { trusted, untrusted } = partitionProjectPluginManifestUrls([url], [url], []);
    assert.deepEqual(trusted, [url]);
    assert.deepEqual(untrusted, []);
  });

  it("trusts a project URL that ships as a bundled drop-in", () => {
    const url = "https://geolibre.app/plugins/demo/plugin.json";
    const { trusted, untrusted } = partitionProjectPluginManifestUrls([url], [], [url]);
    assert.deepEqual(trusted, [url]);
    assert.deepEqual(untrusted, []);
  });

  it("splits a mix of trusted and untrusted project URLs", () => {
    const installed = "https://plugins.example.com/installed/plugin.json";
    const unknown = "https://third-party.example.com/plugin.json";
    const { trusted, untrusted } = partitionProjectPluginManifestUrls(
      [installed, unknown],
      [installed],
      [],
    );
    assert.deepEqual(trusted, [installed]);
    assert.deepEqual(untrusted, [unknown]);
  });

  it("drops disallowed schemes so they never reach the trust prompt", () => {
    // Non-HTTPS, non-loopback URLs can never load, so they must not surface as
    // untrusted (a prompt the user could approve but that would still fail).
    const { trusted, untrusted } = partitionProjectPluginManifestUrls(
      [
        "http://evil.example.com/plugin.json",
        "ftp://evil.example.com/plugin.json",
        "javascript:alert(1)",
      ],
      [],
      [],
    );
    assert.deepEqual(trusted, []);
    assert.deepEqual(untrusted, []);
  });

  it("allows an http loopback URL for local plugin development", () => {
    const url = "http://localhost:8000/plugin.json";
    const { untrusted } = partitionProjectPluginManifestUrls([url], [], []);
    assert.deepEqual(untrusted, [url]);
  });

  it("de-duplicates and trims project URLs", () => {
    const url = "https://plugins.example.com/plugin.json";
    const { untrusted } = partitionProjectPluginManifestUrls([url, `  ${url}  `, url], [], []);
    assert.deepEqual(untrusted, [url]);
  });

  it("matches a trusted settings URL that carries surrounding whitespace", () => {
    const url = "https://plugins.example.com/plugin.json";
    const { trusted, untrusted } = partitionProjectPluginManifestUrls([url], [`  ${url}  `], []);
    assert.deepEqual(trusted, [url]);
    assert.deepEqual(untrusted, []);
  });
});
