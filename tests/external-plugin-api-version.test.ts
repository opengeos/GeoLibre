import assert from "node:assert/strict";
import test from "node:test";
import {
  assertExternalPlugin,
  loadPluginUrlBundle,
} from "../apps/geolibre-desktop/src/lib/external-plugin-validation";

const manifest = {
  apiVersion: 2,
  id: "demo-plugin",
  name: "Demo Plugin",
  version: "1.0.0",
  entry: "dist/plugin.js",
};

test("URL plugins reject an unsupported API version before their entry is fetched", async (context) => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(JSON.stringify({ ...manifest, apiVersion: 1 }));
  };
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    loadPluginUrlBundle("https://plugins.example.test/demo/plugin.json"),
    /requires Plugin API 2/,
  );
  assert.equal(requests, 1);
});

test("entry exports reject missing, v1, and unknown Plugin API versions", () => {
  for (const apiVersion of [undefined, 1, 3]) {
    assert.throws(
      () =>
        assertExternalPlugin({
          apiVersion,
          id: "demo-plugin",
          name: "Demo Plugin",
          version: "1.0.0",
          activate: () => undefined,
          deactivate: () => undefined,
        }),
      /requires Plugin API 2/,
    );
  }
});
