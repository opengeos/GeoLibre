import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { createNativeArcGISFetch } from "../apps/geolibre-desktop/src/lib/arcgis-fetch";

it("preserves ArcGIS HTTP errors and bodies for retry and service-error handling", async () => {
  const fetchImpl = createNativeArcGISFetch(async (url) => {
    assert.equal(url, "https://example.com/FeatureServer/0");
    return { status: 503, body: '{"error":{"message":"Busy"}}' };
  });
  const response = await fetchImpl("https://example.com/FeatureServer/0");
  assert.equal(response.ok, false);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.message, "Busy");
});

it("cancels a pending native request and ignores a later rejection", async () => {
  const controller = new AbortController();
  let rejectNative!: (error: Error) => void;
  const fetchImpl = createNativeArcGISFetch(
    () =>
      new Promise((_, reject) => {
        rejectNative = reject;
      }),
  );
  const pending = fetchImpl("https://example.com/FeatureServer/0", { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  rejectNative(new Error("Late native failure"));
});

it("does not invoke Rust for a pre-aborted request", async () => {
  const fetchImpl = createNativeArcGISFetch(async () => {
    assert.fail("Native request must not start");
  });
  await assert.rejects(fetchImpl("https://example.com", { signal: AbortSignal.abort() }), {
    name: "AbortError",
  });
});

it("normalizes IPC string errors", async () => {
  const fetchImpl = createNativeArcGISFetch(async () => {
    throw "Blocked address";
  });
  await assert.rejects(fetchImpl("https://example.com"), /Blocked address/);
});

it("keeps wildcard hosts out of the shared native HTTP capability", () => {
  const capability = JSON.parse(
    readFileSync(
      new URL("../apps/geolibre-desktop/src-tauri/capabilities/default.json", import.meta.url),
      "utf8",
    ),
  );
  for (const permission of capability.permissions) {
    if (permission.identifier === "http:default") {
      assert.ok(
        permission.allow.every(
          (entry: { url: string }) => !new URL(entry.url).hostname.includes("*"),
        ),
      );
    }
  }
});
