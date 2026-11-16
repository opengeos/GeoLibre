import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { ORT_VERSION } from "../packages/processing/src/object-detection";

describe("object-detection ORT version", () => {
  it("matches the onnxruntime-web pin in package.json", () => {
    // The WASM CDN URL is built from ORT_VERSION; it must equal the installed
    // (and pinned) onnxruntime-web version, or the runtime would fetch a
    // mismatched .wasm and fail at first inference. This guards a dependency
    // bump that forgets to update the constant.
    const pkg = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../packages/processing/package.json", import.meta.url)),
        "utf8",
      ),
    ) as { dependencies: Record<string, string> };
    assert.equal(pkg.dependencies["onnxruntime-web"], ORT_VERSION);
  });
});

describe("built-in detection model URLs", () => {
  it("are commit-pinned raw.githubusercontent.com URLs, not jsDelivr /gh/", async () => {
    const { BUILTIN_DETECTION_MODELS } =
      await import("../apps/geolibre-desktop/src/lib/detection-models");
    assert.ok(BUILTIN_DETECTION_MODELS.length > 0);
    for (const model of BUILTIN_DETECTION_MODELS) {
      // jsDelivr's /gh/ mirror stopped serving these files (503 without a CORS
      // header, issue #3472); GitHub's raw host serves them with ACAO: *.
      assert.doesNotMatch(model.url, /cdn\.jsdelivr\.net\/gh\//, model.id);
      assert.match(
        model.url,
        /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\/.+\.onnx$/,
        model.id,
      );
    }
  });
});
