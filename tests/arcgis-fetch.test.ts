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

it("rejects unsupported methods, headers, and bodies instead of silently changing the request", async () => {
  const fetchImpl = createNativeArcGISFetch(async () => {
    assert.fail("Rust must not be called");
  });
  for (const init of [
    { method: "POST", body: "query" },
    { headers: { Authorization: "Bearer secret" } },
    { body: "query" },
  ]) {
    await assert.rejects(fetchImpl("https://example.com", init), /only supports GET/);
  }
  await assert.rejects(
    fetchImpl(new Request("https://example.com", { method: "POST", body: "query" })),
    /only supports GET/,
  );
});

for (const abortBeforeReady of [true, false]) {
  it(`cancels the native request when abort occurs ${abortBeforeReady ? "before" : "after"} registration`, async () => {
    const { createArcGISRequest } = await import("../apps/geolibre-desktop/src/lib/arcgis-fetch");
    const controller = new AbortController();
    const ready = { onmessage: (_: void) => {} };
    let requestId: unknown;
    let cancelled: unknown;
    let rejectFetch!: (error: unknown) => void;
    const invoke = (async (command: string, args?: Record<string, unknown>) => {
      if (command === "fetch_arcgis_response") {
        requestId = args?.requestId;
        return new Promise((_, reject) => {
          rejectFetch = reject;
        });
      }
      assert.equal(command, "cancel_arcgis_request");
      cancelled = args?.requestId;
      rejectFetch("ArcGIS request cancelled.");
    }) as Parameters<typeof createArcGISRequest>[0];
    const fetchImpl = createNativeArcGISFetch(createArcGISRequest(invoke, () => ready));
    const pending = fetchImpl("https://example.com", { signal: controller.signal });
    if (!abortBeforeReady) ready.onmessage();
    controller.abort();
    if (abortBeforeReady) {
      assert.equal(cancelled, undefined);
      ready.onmessage();
    }
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(cancelled, requestId);
    assert.equal(typeof cancelled, "string");
  });
}

it("passes form-encoded ArcGIS writes to the native transport without changing their body", async () => {
  const body = "f=json&token=secret&deletes=12";
  const fetchImpl = createNativeArcGISFetch(async (url, _signal, posted) => {
    assert.equal(url, "https://example.com/FeatureServer/0/applyEdits");
    assert.equal(posted, body);
    return { status: 200, body: '{"deleteResults":[{"success":true,"objectId":12}]}' };
  });
  const response = await fetchImpl("https://example.com/FeatureServer/0/applyEdits", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  assert.equal((await response.json()).deleteResults[0].success, true);
});

it("sends a FormData upload as multipart bytes with its boundary type", async () => {
  const fetchImpl = createNativeArcGISFetch(async (url, _signal, posted) => {
    assert.equal(url, "https://example.com/FeatureServer/0/7/addAttachment");
    assert.ok(posted && typeof posted === "object");
    assert.match(posted.contentType, /^multipart\/form-data; boundary=/);
    const decoded = Buffer.from(posted.base64, "base64");
    assert.ok(decoded.includes(Buffer.from([0x89, 0xff, 0x00])));
    assert.ok(decoded.includes(Buffer.from('filename="photo 1.png"')));
    return { status: 200, body: '{"addAttachmentResult":{"objectId":3,"success":true}}' };
  });
  const form = new FormData();
  form.set("f", "json");
  form.set("attachment", new File([new Uint8Array([0x89, 0xff, 0x00])], "photo 1.png"));
  const response = await fetchImpl("https://example.com/FeatureServer/0/7/addAttachment", {
    method: "POST",
    body: form,
  });
  assert.equal((await response.json()).addAttachmentResult.objectId, 3);
});

it("returns a binary attachment body byte for byte with its content type", async () => {
  const fetchImpl = createNativeArcGISFetch(async () => ({
    status: 200,
    body: "",
    bodyBase64: Buffer.from([0x89, 0xff, 0x00, 0x50]).toString("base64"),
    contentType: "image/png",
  }));
  const response = await fetchImpl("https://example.com/FeatureServer/0/7/attachments/1");
  assert.equal(response.headers.get("Content-Type"), "image/png");
  assert.deepEqual(
    new Uint8Array(await response.arrayBuffer()),
    new Uint8Array([0x89, 0xff, 0x00, 0x50]),
  );
});
