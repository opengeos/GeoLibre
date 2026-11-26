import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { proxyOgcProcessRequest } from "../apps/geolibre-desktop/vite-ogc-process-proxy";
import { MAX_PROCESS_INPUT_BYTES } from "../apps/geolibre-desktop/src/lib/ogc-process-limits";

const { Agent, MockAgent } = createRequire(
  new URL("../apps/geolibre-desktop/vite-proxy-guard.ts", import.meta.url),
)("undici") as typeof import("undici");

test("process proxy preserves execution/job controls, redirect methods and response limits", async (t) => {
  const delegate = new Agent();
  delegate.dispatch = delegate.dispatch.bind(delegate);
  const upstream = new MockAgent({ agent: delegate });
  upstream.disableNetConnect();
  let dispatches = 0;
  t.mock.method(
    Agent.prototype,
    "dispatch",
    (...args: Parameters<InstanceType<typeof Agent>["dispatch"]>) => {
      dispatches++;
      const [options, handler] = args;
      // Fetch streams its POST body to the dispatcher. Buffer that test-only
      // stream so MockAgent can assert the actual JSON bytes, not its generator.
      if (
        options.body &&
        typeof options.body === "object" &&
        Symbol.asyncIterator in options.body
      ) {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of options.body as AsyncIterable<Uint8Array>)
            chunks.push(Buffer.from(chunk));
          upstream.dispatch({ ...options, body: Buffer.concat(chunks).toString("utf8") }, handler);
        })().catch((error: Error) => handler.onError?.(error));
        return true;
      }
      return upstream.dispatch(...args);
    },
  );
  const pool = upstream.get("https://process.example");
  const body = JSON.stringify({ inputs: { name: "GeoLibre" }, response: "document" });
  pool
    .intercept({
      path: "/execution",
      method: "POST",
      body,
      headers: { "content-type": "application/json", prefer: "respond-async" },
    })
    .reply(201, JSON.stringify({ jobID: "one", status: "accepted" }), {
      headers: {
        "Content-Type": "application/json",
        Location: "/jobs/one",
        "Retry-After": "2",
        Link: '</jobs/one>; rel="monitor"',
      },
    });
  pool.intercept({ path: "/jobs/one", method: "DELETE" }).reply(204, "");
  pool
    .intercept({ path: "/accepted-large", method: "POST", body })
    .reply(202, "12345678", { headers: { Location: "/jobs/retained" } });
  pool.intercept({ path: "/large", method: "GET" }).reply(200, "123456789");
  pool.intercept({ path: "/failure", method: "GET" }).reply(503, "123456789");
  pool.intercept({ path: "/html", method: "GET" }).reply(200, "<script>unsafe()</script>", {
    headers: { "Content-Type": "text/html" },
  });
  pool
    .intercept({ path: "/redirect", method: "POST", body })
    .reply(303, "", { headers: { Location: "/results" } });
  pool
    .intercept({ path: "/preserve", method: "POST", body })
    .reply(307, "", { headers: { Location: "https://other.example/preserved" } });
  pool
    .intercept({ path: "/delete-redirect", method: "DELETE" })
    .reply(308, "", { headers: { Location: "https://other.example/job" } });
  pool
    .intercept({ path: "/read-redirect", method: "GET" })
    .reply(302, "", { headers: { Location: "/read-result" } });
  pool.intercept({ path: "/read-result", method: "GET" }).reply(200, "read result");
  pool.intercept({ path: "/private", method: "GET" }).reply(302, "", {
    headers: { Location: "http://169.254.169.254/latest/meta-data/" },
  });
  const server = createServer((req, res) => {
    void proxyOgcProcessRequest(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const send = (
    method: string,
    path: string,
    data?: string | Buffer,
    headers: Record<string, string> = {},
    chunked = false,
  ) =>
    new Promise<{ status: number | undefined; headers: IncomingHttpHeaders; body: string }>(
      (resolve, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port,
            method,
            path: `/proxy?url=${encodeURIComponent(`https://process.example${path}`)}`,
            headers: { "content-type": "application/json", ...headers },
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
              body += chunk;
            });
            res.on("error", reject);
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
          },
        );
        req.on("error", reject);
        if (chunked && data) {
          const bytes = typeof data === "string" ? Buffer.from(data) : data;
          req.write(bytes.subarray(0, bytes.length / 2));
          req.end(bytes.subarray(bytes.length / 2));
        } else req.end(data);
      },
    );
  try {
    const accepted = await send("POST", "/execution", body, { prefer: "respond-async" });
    assert.equal(accepted.status, 201);
    assert.equal(accepted.headers.location, "/jobs/one");
    assert.equal(accepted.headers["retry-after"], "2");
    assert.equal(accepted.headers.link, '</jobs/one>; rel="monitor"');
    assert.equal(accepted.headers["x-geolibre-final-url"], "https://process.example/execution");
    assert.equal(accepted.headers["cache-control"], "no-store");
    const retained = await send("POST", "/accepted-large", body, { "x-geolibre-max-bytes": "4" });
    assert.equal(retained.status, 202);
    assert.equal(retained.headers.location, "/jobs/retained");
    assert.equal(retained.body, "");
    assert.match(String(accepted.headers["content-security-policy"]), /sandbox/);
    assert.equal(accepted.headers["x-content-type-options"], "nosniff");
    const html = await send("GET", "/html");
    assert.equal(html.headers["content-type"], "text/html");
    assert.equal(html.body, "<script>unsafe()</script>");
    assert.match(String(html.headers["content-security-policy"]), /default-src 'none'/);
    assert.equal((await send("DELETE", "/jobs/one")).status, 204);
    assert.equal(
      (await send("GET", "/large", undefined, { "x-geolibre-max-bytes": "4" })).status,
      502,
    );
    const failure = await send("GET", "/failure", undefined, { "x-geolibre-max-bytes": "4" });
    assert.equal(failure.status, 503);
    assert.equal(failure.body, "");
    for (const [method, path] of [
      ["POST", "/redirect"],
      ["POST", "/preserve"],
      ["DELETE", "/delete-redirect"],
    ]) {
      const before = dispatches;
      assert.equal((await send(method, path, method === "POST" ? body : undefined)).status, 502);
      assert.equal(dispatches, before + 1, "mutating redirects never forward a second request");
    }
    assert.equal((await send("GET", "/read-redirect")).body, "read result");
    assert.equal((await send("GET", "/private")).status, 502);
    upstream.assertNoPendingInterceptors();
    const before = dispatches;
    for (const [method, payload, headers, expected, chunked] of [
      ["PUT", undefined, {}, 405, false],
      ["POST", "{}", { "content-type": "text/plain" }, 415, false],
      ["POST", "[]", {}, 400, false],
      ["POST", "broken", {}, 400, false],
      ["POST", Buffer.from([255]), {}, 400, false],
      ["POST", "{}", { origin: "https://attacker.example" }, 403, false],
      ["POST", "{}", { origin: "null" }, 403, false],
      ["POST", "x".repeat(MAX_PROCESS_INPUT_BYTES + 1), {}, 413, true],
      ["GET", undefined, { "x-geolibre-max-bytes": "99999999999" }, 400, false],
    ] as const) {
      assert.equal((await send(method, "/not-sent", payload, headers, chunked)).status, expected);
    }
    assert.equal(dispatches, before);
  } finally {
    server.close();
    await once(server, "close");
    await upstream.close();
  }
});
