import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPluginHttpSend,
  createPluginNativeFetch,
  type PluginHttpPayload,
  type PluginHttpResult,
} from "../apps/geolibre-desktop/src/lib/plugin-native-fetch";
import type { DiagnosticInput } from "../apps/geolibre-desktop/src/lib/diagnostics";

const encode = (text: string) => Buffer.from(text).toString("base64");
const decode = (base64: string) => Buffer.from(base64, "base64").toString();

function result(patch: Partial<PluginHttpResult> = {}): PluginHttpResult {
  return {
    status: 200,
    statusText: "OK",
    url: "https://d2s.example/api/v1/users/current",
    headers: [["content-type", "application/json"]],
    body: encode('{"email":"user@example.com"}'),
    ...patch,
  };
}

describe("createPluginNativeFetch", () => {
  it("sends a form login the way the webview would encode it", async () => {
    const sent: PluginHttpPayload[] = [];
    const fetchImpl = createPluginNativeFetch(async (request) => {
      sent.push(request);
      return result({ body: encode("200") });
    });
    const response = await fetchImpl("https://d2s.example/api/v1/auth/access-token", {
      method: "POST",
      credentials: "include",
      body: new URLSearchParams({ username: "user@example.com", password: "p&ss" }),
    });
    assert.equal(response.status, 200);
    assert.equal(sent[0].method, "POST");
    assert.equal(sent[0].url, "https://d2s.example/api/v1/auth/access-token");
    assert.equal(decode(sent[0].body!), "username=user%40example.com&password=p%26ss");
    assert.ok(
      sent[0].headers.some(
        ([name, value]) =>
          name === "content-type" && value.startsWith("application/x-www-form-urlencoded"),
      ),
    );
  });

  it("returns status, headers, final URL and body as a Response", async () => {
    const fetchImpl = createPluginNativeFetch(async (request) => {
      assert.equal(request.body, undefined, "a GET carries no body");
      return result({ status: 401, statusText: "Unauthorized", body: encode('{"detail":"x"}') });
    });
    const response = await fetchImpl(new URL("https://d2s.example/api/v1/users/current"));
    assert.equal(response.ok, false);
    assert.equal(response.status, 401);
    assert.equal(response.statusText, "Unauthorized");
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(response.url, "https://d2s.example/api/v1/users/current");
    assert.deepEqual(await response.json(), { detail: "x" });
  });

  it("round-trips binary bodies", async () => {
    const bytes = Uint8Array.from({ length: 70000 }, (_, index) => index % 256);
    const fetchImpl = createPluginNativeFetch(async (request) => {
      assert.deepEqual(new Uint8Array(Buffer.from(request.body!, "base64")), bytes);
      return result({ body: Buffer.from(bytes).toString("base64") });
    });
    const response = await fetchImpl("https://d2s.example/upload", { method: "PUT", body: bytes });
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  });

  it("gives null-body statuses an empty body", async () => {
    const fetchImpl = createPluginNativeFetch(async () => result({ status: 204, body: "" }));
    const response = await fetchImpl("https://d2s.example/api/v1/auth/remove-access-token", {
      method: "DELETE",
    });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
  });

  it("rejects network failures as a TypeError and records a redacted diagnostic", async () => {
    const records: DiagnosticInput[] = [];
    const fetchImpl = createPluginNativeFetch(
      async () => {
        throw "Request failed: connection refused";
      },
      (record) => records.push(record),
    );
    await assert.rejects(fetchImpl("https://d2s.example/data?token=secret"), {
      name: "TypeError",
      message: /connection refused/,
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].level, "error");
    assert.equal(records[0].method, "GET");
    assert.ok(!records[0].url?.includes("secret"), "the token is redacted");
  });

  it("records an HTTP error status as an error diagnostic", async () => {
    const records: DiagnosticInput[] = [];
    const fetchImpl = createPluginNativeFetch(
      async () => result({ status: 401 }),
      (record) => records.push(record),
    );
    await fetchImpl("https://d2s.example/api/v1/users/current");
    assert.equal(records[0].level, "error");
    assert.equal(records[0].status, 401);
  });

  it("records an expected status as info, without sending the marker", async () => {
    const records: DiagnosticInput[] = [];
    const sent: PluginHttpPayload[] = [];
    const fetchImpl = createPluginNativeFetch(
      async (request) => {
        sent.push(request);
        return result({ status: 400, body: encode('{"error":"authorization_pending"}') });
      },
      (record) => records.push(record),
    );
    // An OAuth device-code poll: 400 means "not approved yet" (RFC 8628).
    const response = await fetchImpl("https://d2s.example/o/token/", {
      method: "POST",
      headers: { "x-geolibre-expected-status": "400, 428" },
      body: new URLSearchParams({ grant_type: "device_code" }),
    });
    assert.equal(response.status, 400);
    assert.equal(records[0].level, "info");
    assert.equal(records[0].status, 400);
    assert.ok(
      !sent[0].headers.some(([name]) => name === "x-geolibre-expected-status"),
      "the marker stays on the client",
    );
  });

  it("still records a status that wasn't listed as expected as an error", async () => {
    const records: DiagnosticInput[] = [];
    const fetchImpl = createPluginNativeFetch(
      async () => result({ status: 500 }),
      (record) => records.push(record),
    );
    await fetchImpl("https://d2s.example/o/token/", {
      headers: { "x-geolibre-expected-status": "400" },
    });
    assert.equal(records[0].level, "error");
  });

  it("records any failure of an optional request as info", async () => {
    const records: DiagnosticInput[] = [];
    const sent: PluginHttpPayload[] = [];
    const fetchImpl = createPluginNativeFetch(
      async (request) => {
        sent.push(request);
        if (sent.length === 1) return result({ status: 404 });
        throw "Request failed: connection refused";
      },
      (record) => records.push(record),
    );
    const optional = { headers: { "x-geolibre-optional-resource": "1" } };
    await fetchImpl("https://d2s.example/api/v1/optional", optional);
    await assert.rejects(fetchImpl("https://d2s.example/api/v1/optional", optional), {
      name: "TypeError",
    });
    assert.deepEqual(
      records.map((record) => record.level),
      ["info", "info"],
    );
    assert.ok(
      sent.every((request) =>
        request.headers.every(([name]) => name !== "x-geolibre-optional-resource"),
      ),
      "the marker stays on the client",
    );
  });

  it("aborts without waiting for the native request", async () => {
    const controller = new AbortController();
    const fetchImpl = createPluginNativeFetch(() => new Promise(() => {}));
    const pending = fetchImpl("https://d2s.example/slow", { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
  });

  it("does not start a pre-aborted request", async () => {
    const fetchImpl = createPluginNativeFetch(async () => assert.fail("must not send"));
    await assert.rejects(fetchImpl("https://d2s.example", { signal: AbortSignal.abort() }), {
      name: "AbortError",
    });
  });
});

describe("createPluginHttpSend", () => {
  it("cancels the native request once Rust has registered it", async () => {
    const calls: Array<[string, unknown]> = [];
    let ready!: { onmessage: (() => void) | null };
    let finish!: (value: PluginHttpResult) => void;
    const invoke = ((command: string, args: unknown) => {
      calls.push([command, args]);
      if (command === "plugin_http_request") {
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      return Promise.resolve();
    }) as never;
    const send = createPluginHttpSend(invoke, () => {
      ready = { onmessage: null };
      return ready as never;
    });
    const controller = new AbortController();
    const pending = send(
      { url: "https://d2s.example", method: "GET", headers: [] },
      controller.signal,
    );
    // An abort before Rust registered the request has nothing to cancel yet;
    // the ready message then sends the cancellation.
    controller.abort();
    assert.equal(calls.length, 1);
    ready.onmessage?.();
    assert.equal(calls[1][0], "cancel_plugin_http_request");
    assert.deepEqual(calls[1][1], {
      requestId: (calls[0][1] as { requestId: string }).requestId,
    });
    finish(result());
    await pending;
  });
});
