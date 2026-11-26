import { waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

const { requestOgcProcess, nativeHttpSuccessRecord, nativeHttpFailureRecord } =
  await import("../apps/geolibre-desktop/src/lib/native-http");
const descriptor = Object.getOwnPropertyDescriptor(window, "__TAURI_INTERNALS__");
afterEach(() => {
  if (descriptor) Object.defineProperty(window, "__TAURI_INTERNALS__", descriptor);
  else Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

test("native protocol-owned errors use localized codes while unknown failures retain their detail", async () => {
  const { processHttp } = await import("../apps/geolibre-desktop/src/lib/ogc-process-http");
  for (const [message, code] of [
    ["OGC process request timed out", "requestTimeout"],
    ["Too many OGC process redirects", "redirectLimit"],
    ["OGC process inputs must be valid JSON", "inputsJsonSyntax"],
  ]) {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        invoke: async () => {
          throw message;
        },
      },
    });
    await assert.rejects(
      processHttp("https://example.org/jobs/one", new AbortController().signal),
      { code },
    );
  }
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke: async () => {
        throw "Custom connection failure";
      },
    },
  });
  await assert.rejects(processHttp("https://example.org/jobs/one", new AbortController().signal), {
    message: "Custom connection failure",
  });
});

test("a dispatched native submission retains a late accepted job after observation aborts", async () => {
  const pending: { resolve?: (value: unknown) => void } = {};
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke: () =>
        new Promise((resolve) => {
          pending.resolve = resolve;
        }),
    },
  });
  const { processHttp } = await import("../apps/geolibre-desktop/src/lib/ogc-process-http");
  const abort = new AbortController();
  const result = processHttp("https://example.org/execution", abort.signal, {
    method: "POST",
    body: "{}",
  });
  await waitFor(() => assert.ok(pending.resolve));
  abort.abort();
  pending.resolve?.({
    status: 202,
    final_url: "https://example.org/execution",
    content_type: "application/json",
    location: "/jobs/late",
    retry_after: null,
    link: null,
    body_base64: "",
  });
  const response = await result;
  assert.equal(response.status, 202);
  assert.equal(response.location, "/jobs/late");
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
          link: '</jobs/one>; rel="monitor"',
          body_base64: "e30=",
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
  assert.equal(response.link, '</jobs/one>; rel="monitor"');
  assert.equal(response.url, "https://example.org/execution");
  assert.equal(new TextDecoder().decode(response.body), "{}");
});

for (const compatibility of [false, true]) {
  test(`compact native result transport retains all byte values (${compatibility ? "compatibility decoder" : "host decoder"})`, async () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        invoke: async () => ({
          status: 200,
          final_url: "https://example.org/result",
          content_type: "image/tiff",
          location: null,
          retry_after: null,
          body_base64: btoa(String.fromCharCode(...bytes)),
        }),
      },
    });
    const descriptor = Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64");
    try {
      if (compatibility)
        Object.defineProperty(Uint8Array, "fromBase64", { configurable: true, value: undefined });
      const result = await requestOgcProcess("https://example.org/result", { method: "GET" });
      assert.deepEqual(result.body, bytes);
    } finally {
      if (descriptor) Object.defineProperty(Uint8Array, "fromBase64", descriptor);
      else Reflect.deleteProperty(Uint8Array, "fromBase64");
    }
  });
}

test("a failing diagnostic observer cannot discard an accepted native job", async () => {
  const { subscribeDiagnostics, setCaptureNetworkInfo, getDiagnosticsSnapshot, clearDiagnostics } =
    await import("../apps/geolibre-desktop/src/lib/diagnostics");
  const previous = getDiagnosticsSnapshot().captureNetworkInfo;
  setCaptureNetworkInfo(true);
  clearDiagnostics();
  let notifications = 0;
  let invocations = 0;
  const unsubscribeFailure = subscribeDiagnostics(() => {
    throw new Error("observer failed");
  });
  const unsubscribeHealthy = subscribeDiagnostics(() => {
    notifications++;
  });
  let renewals = 0;
  let unsubscribeRenewing = () => {};
  const renewing = () => {
    renewals++;
    // Bound the fixture so a live-Set regression fails instead of hanging.
    if (renewals < 3) {
      unsubscribeRenewing();
      unsubscribeRenewing = subscribeDiagnostics(renewing);
    }
  };
  unsubscribeRenewing = subscribeDiagnostics(renewing);
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke: async () => {
        invocations++;
        return {
          status: 202,
          final_url: "https://example.org/execution",
          content_type: "application/json",
          location: "/jobs/accepted",
          retry_after: null,
          link: null,
          body_base64: "",
        };
      },
    },
  });
  try {
    const response = await requestOgcProcess("https://example.org/execution", {
      method: "POST",
      body: "{}",
    });
    assert.equal(response.status, 202);
    assert.equal(response.location, "/jobs/accepted");
    assert.equal(invocations, 1);
    assert.equal(notifications, 1);
    assert.equal(renewals, 1);
    assert.equal(getDiagnosticsSnapshot().networkCount, 1);
  } finally {
    unsubscribeFailure();
    unsubscribeHealthy();
    unsubscribeRenewing();
    setCaptureNetworkInfo(previous);
    clearDiagnostics();
  }
});

test("native error metadata survives the local deadline while explicit cancellation still wins", async (t) => {
  let deadline = new AbortController();
  let caller = new AbortController();
  let status = 401;
  let cancel = false;
  t.mock.method(AbortSignal, "timeout", () => deadline.signal);
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke: async () => {
        if (cancel) caller.abort(new DOMException("cancelled", "AbortError"));
        else deadline.abort(new DOMException("deadline", "TimeoutError"));
        return {
          status,
          final_url: "https://example.org/jobs/one",
          content_type: "application/json",
          location: null,
          retry_after: null,
          link: null,
          body_base64: status === 200 ? "e30=" : "",
          body_read_failed: status !== 200,
        };
      },
    },
  });
  const { processHttp } = await import("../apps/geolibre-desktop/src/lib/ogc-process-http");
  const rejected = await processHttp("https://example.org/jobs/one", caller.signal);
  assert.equal(rejected.status, 401);
  assert.equal(rejected.bodyReadFailed, true);
  deadline = new AbortController();
  status = 200;
  const completed = await processHttp("https://example.org/jobs/one", caller.signal);
  assert.equal(completed.status, 200);
  assert.equal(new TextDecoder().decode(completed.body), "{}");
  deadline = new AbortController();
  caller = new AbortController();
  status = 401;
  cancel = true;
  await assert.rejects(processHttp("https://example.org/jobs/one", caller.signal), {
    name: "AbortError",
  });
});

test("a frontend deadline does not relabel a native connection failure", async (t) => {
  const deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => deadline.signal);
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke: async () => {
        deadline.abort(new DOMException("deadline", "TimeoutError"));
        throw "Connection refused by service";
      },
    },
  });
  const { processHttp } = await import("../apps/geolibre-desktop/src/lib/ogc-process-http");
  await assert.rejects(processHttp("https://example.org/jobs/one", new AbortController().signal), {
    message: "Connection refused by service",
  });
});

test("invalid Unicode is rejected before native dispatch and valid surrogate pairs survive", async () => {
  let calls = 0;
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke: async () => {
        calls++;
        return {
          status: 200,
          final_url: "https://example.org/execution",
          content_type: "application/json",
          location: null,
          retry_after: null,
          link: null,
          body_base64: "e30=",
        };
      },
    },
  });
  const { processHttp } = await import("../apps/geolibre-desktop/src/lib/ogc-process-http");
  const signal = new AbortController().signal;
  for (const inputs of [{ name: "\ud800" }, { "\udfff": 1 }]) {
    await assert.rejects(
      processHttp("https://example.org/execution", signal, {
        method: "POST",
        body: JSON.stringify({ inputs }),
      }),
      { code: "inputUnicode" },
    );
  }
  assert.equal(calls, 0);
  assert.equal(
    (
      await processHttp("https://example.org/execution", signal, {
        method: "POST",
        body: JSON.stringify({ inputs: { name: "\ud83d\ude00" } }),
      })
    ).status,
    200,
  );
  assert.equal(calls, 1);
});

test("native synchronous write acknowledgement retains routing and body failure separately", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke: async () => ({
        status: 200,
        final_url: "https://example.org/execution",
        content_type: "application/json",
        location: null,
        retry_after: null,
        link: '</jobs/sync>; rel="monitor"',
        body_base64: "",
        body_read_failed: true,
      }),
    },
  });
  const { processHttp } = await import("../apps/geolibre-desktop/src/lib/ogc-process-http");
  const response = await processHttp(
    "https://example.org/execution",
    new AbortController().signal,
    { method: "POST", body: "{}" },
  );
  assert.equal(response.status, 200);
  assert.equal(response.link, '</jobs/sync>; rel="monitor"');
  assert.equal(response.bodyReadFailed, true);
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
