import "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

const { requestOgcProcess, nativeHttpSuccessRecord, nativeHttpFailureRecord } =
  await import("../apps/geolibre-desktop/src/lib/native-http");
const descriptor = Object.getOwnPropertyDescriptor(window, "__TAURI_INTERNALS__");
afterEach(() => {
  if (descriptor) Object.defineProperty(window, "__TAURI_INTERNALS__", descriptor);
  else Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

test("native process execution preserves its method, inputs, headers and asynchronous job routing", async () => {
  const body = JSON.stringify({ inputs: { name: "GeoLibre" } });
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke: async (command: string, args: Record<string, unknown>) => {
        assert.equal(command, "ogc_process_http_request");
        assert.deepEqual(args, {
          url: "https://example.org/execution",
          method: "POST",
          body,
          accept: "application/json",
          preferAsync: true,
          maxBytes: 2048,
          timeoutSecs: 120,
        });
        return {
          status: 202,
          final_url: "https://example.org/execution",
          content_type: "application/json",
          location: "/jobs/one",
          retry_after: "1",
          body: [123, 125],
        };
      },
    },
  });
  const response = await requestOgcProcess("https://example.org/execution", {
    method: "POST",
    body,
    accept: "application/json",
    preferAsync: true,
    maxBytes: 2048,
    timeoutSecs: 120,
  });
  assert.equal(response.status, 202);
  assert.equal(response.location, "/jobs/one");
  assert.equal(response.retryAfter, "1");
  assert.equal(response.url, "https://example.org/execution");
  assert.equal(new TextDecoder().decode(response.body), "{}");
});

test("process diagnostics identify writes and redact URL credentials", () => {
  const record = nativeHttpSuccessRecord(
    "ogc_process_http_request",
    "https://example.org/execution?token=secret",
    2,
    "OGC API Processes",
    "POST",
  );
  assert.equal(record.method, "POST");
  assert.match(record.message, /^POST /);
  assert.ok(!record.url?.includes("secret"));
  const failure = nativeHttpFailureRecord(
    "ogc_process_http_request",
    "https://example.org/jobs/one?token=secret",
    "request timeout",
    2,
    "OGC API Processes",
    "DELETE",
  );
  assert.equal(failure.method, "DELETE");
  assert.match(failure.message, /^DELETE /);
  assert.ok(!failure.url?.includes("secret"));
});
