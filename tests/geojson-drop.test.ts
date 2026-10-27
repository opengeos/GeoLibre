import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, it } from "node:test";

// shpjs reads the browser `self` global when tauri-io is imported.
(globalThis as { self?: unknown }).self ??= globalThis;

let loadDroppedVectorFiles: typeof import("../apps/geolibre-desktop/src/lib/tauri-io").loadDroppedVectorFiles;

before(async () => {
  ({ loadDroppedVectorFiles } = await import("../apps/geolibre-desktop/src/lib/tauri-io"));
});

it("rejects truncated GeoJSON with its syntax error before initializing DuckDB", async () => {
  const text = readFileSync(new URL("../e2e/fixtures/malformed.geojson", import.meta.url), "utf8");
  await assert.rejects(
    loadDroppedVectorFiles([new File([text], "malformed.geojson")]),
    SyntaxError,
  );

  const valid = readFileSync(new URL("../e2e/fixtures/smoke.geojson", import.meta.url), "utf8");
  const layers = await loadDroppedVectorFiles([new File([valid], "recovered.geojson")]);
  assert.equal(layers.length, 1);
  assert.equal(layers[0].path, "recovered.geojson");
});
