import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import { bundleFromZipBytes } from "../apps/geolibre-desktop/src/lib/plugin-archive-unpack";

const VALID_MANIFEST = {
  id: "demo-plugin",
  name: "Demo Plugin",
  version: "1.0.0",
  entry: "dist/plugin.js",
  style: "dist/plugin.css",
};

function makeZip(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, contents] of Object.entries(files)) {
    entries[name] = strToU8(contents);
  }
  return zipSync(entries);
}

describe("bundleFromZipBytes", () => {
  it("unpacks a valid archive with entry and style", async () => {
    const zip = makeZip({
      "plugin.json": JSON.stringify(VALID_MANIFEST),
      "dist/plugin.js": "export default {};",
      "dist/plugin.css": ".demo {}",
    });
    const bundle = await bundleFromZipBytes("demo.zip", zip);
    assert.equal(bundle.archiveName, "demo.zip");
    assert.equal(bundle.manifest.id, "demo-plugin");
    assert.equal(bundle.entrySource, "export default {};");
    assert.equal(bundle.styleSource, ".demo {}");
  });

  it("unpacks an archive wrapped in a single folder", async () => {
    const zip = makeZip({
      "my-plugin/plugin.json": JSON.stringify(VALID_MANIFEST),
      "my-plugin/dist/plugin.js": "export default {};",
      "my-plugin/dist/plugin.css": ".demo {}",
    });
    const bundle = await bundleFromZipBytes("my-plugin.zip", zip);
    assert.equal(bundle.manifest.id, "demo-plugin");
    assert.equal(bundle.entrySource, "export default {};");
    assert.equal(bundle.styleSource, ".demo {}");
  });

  it("ignores the __MACOSX metadata folder and prefers a root plugin.json", async () => {
    const zip = makeZip({
      "__MACOSX/._plugin.json": "junk",
      "plugin.json": JSON.stringify({ ...VALID_MANIFEST, style: undefined }),
      "dist/plugin.js": "export default {};",
    });
    const bundle = await bundleFromZipBytes("demo.zip", zip);
    assert.equal(bundle.manifest.id, "demo-plugin");
    assert.equal(bundle.entrySource, "export default {};");
  });

  it("returns a null style when the manifest omits one", async () => {
    const { style: _style, ...manifest } = VALID_MANIFEST;
    const zip = makeZip({
      "plugin.json": JSON.stringify(manifest),
      "dist/plugin.js": "export default {};",
    });
    const bundle = await bundleFromZipBytes("demo.zip", zip);
    assert.equal(bundle.styleSource, null);
  });

  it("rejects an archive without any plugin.json", async () => {
    const zip = makeZip({ "dist/plugin.js": "export default {};" });
    await assert.rejects(bundleFromZipBytes("demo.zip", zip), /missing a plugin\.json/);
  });

  it("rejects an invalid manifest (entry not a .js/.mjs file)", async () => {
    const zip = makeZip({
      "plugin.json": JSON.stringify({
        ...VALID_MANIFEST,
        entry: "dist/plugin.txt",
        style: undefined,
      }),
      "dist/plugin.txt": "nope",
    });
    await assert.rejects(bundleFromZipBytes("demo.zip", zip), /manifest is invalid/);
  });

  it("accepts a boolean activeByDefault and rejects other types", async () => {
    const withFlag = (activeByDefault: unknown) =>
      makeZip({
        "plugin.json": JSON.stringify({
          ...VALID_MANIFEST,
          style: undefined,
          activeByDefault,
        }),
        "dist/plugin.js": "export default {};",
      });
    const bundle = await bundleFromZipBytes("demo.zip", withFlag(true));
    assert.equal(bundle.manifest.activeByDefault, true);
    await assert.rejects(bundleFromZipBytes("demo.zip", withFlag("true")), /manifest is invalid/);
  });

  it("rejects an entry path that escapes the archive", async () => {
    const zip = makeZip({
      "plugin.json": JSON.stringify({ ...VALID_MANIFEST, entry: "../evil.js", style: undefined }),
      "../evil.js": "export default {};",
    });
    await assert.rejects(bundleFromZipBytes("demo.zip", zip), /must be a relative safe path/);
  });

  it("rejects when the manifest entry is missing from the archive", async () => {
    const zip = makeZip({
      "plugin.json": JSON.stringify({ ...VALID_MANIFEST, style: undefined }),
    });
    await assert.rejects(
      bundleFromZipBytes("demo.zip", zip),
      /entry 'dist\/plugin\.js' is missing/,
    );
  });
});
