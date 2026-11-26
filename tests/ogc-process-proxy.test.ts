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

for (const status of [202, 401])
  test(`received HTTP ${status} headers precede a stalled body and completed bodies remain intact`, async (t) => {
    const payload = JSON.stringify({ status: status === 202 ? "accepted" : "unauthorized" });
    let writes = 0;
    let release: (() => void) | undefined;
    const upstream = createServer((req, res) => {
      writes++;
      req.resume();
      res.writeHead(status, {
        Location: "/jobs/retained",
        "Retry-After": "2",
        "Content-Type": "application/json",
        Connection: "close",
      });
      res.flushHeaders();
      const finish = () => {
        if (!res.destroyed) res.end(payload);
      };
      if (new URL(req.url ?? "/", "http://localhost").pathname === "/pending") release = finish;
      else finish();
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const delegate = new Agent();
    delegate.dispatch = delegate.dispatch.bind(delegate);
    const origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    t.mock.method(
      Agent.prototype,
      "dispatch",
      (...[options, handler]: Parameters<InstanceType<typeof Agent>["dispatch"]>) =>
        // Some Node versions share this dispatcher with global fetch. Redirect
        // only the upstream request, keeping the real local proxy in the path.
        delegate.dispatch(
          String(options.origin) === "https://process.example" ? { ...options, origin } : options,
          handler,
        ),
    );
    const proxy = createServer((req, res) => {
      void proxyOgcProcessRequest(req, res);
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const url = (path: string) =>
      `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/proxy?url=${encodeURIComponent(`https://process.example${path}`)}`;
    try {
      const abort = new AbortController();
      const acknowledged = await fetch(url("/pending"), {
        method: status === 202 ? "POST" : "GET",
        body: status === 202 ? "{}" : undefined,
        headers: { "Content-Type": "application/json", Connection: "close" },
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
      });
      assert.equal(acknowledged.status, status);
      assert.equal(acknowledged.headers.get("location"), "/jobs/retained");
      assert.equal(acknowledged.headers.get("retry-after"), "2");
      assert.ok(release);
      abort.abort();
      await assert.rejects(acknowledged.arrayBuffer());
      release();
      const complete = await fetch(url("/complete"), {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json", Connection: "close" },
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(complete.status, status);
      assert.equal(await complete.text(), payload);
      assert.equal(writes, 2, "one dispatch per submission, with no retry");
    } finally {
      release?.();
      await delegate.close();
      proxy.close();
      upstream.close();
      await Promise.all([once(proxy, "close"), once(upstream, "close")]);
    }
  });

test("a body-limit failure preserves acknowledgement headers queued in a real socket", async (t) => {
  let writes = 0;
  const upstream = createServer((req, res) => {
    writes++;
    req.resume();
    res.writeHead(202, { Location: "/jobs/queued", "Content-Length": "9" });
    res.end("123456789");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const delegate = new Agent();
  delegate.dispatch = delegate.dispatch.bind(delegate);
  const origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  t.mock.method(
    Agent.prototype,
    "dispatch",
    (...[options, handler]: Parameters<InstanceType<typeof Agent>["dispatch"]>) =>
      delegate.dispatch(
        String(options.origin) === "https://process.example" ? { ...options, origin } : options,
        handler,
      ),
  );
  const done: { resolve?: () => void; release?: () => void } = {};
  const handled = new Promise<void>((resolve) => {
    done.resolve = resolve;
  });
  const proxy = createServer((req, res) => {
    const flush = res.flushHeaders.bind(res);
    res.flushHeaders = () => {
      const socket = res.socket!;
      socket.cork();
      done.release = () => socket.uncork();
      flush();
      assert.ok(socket.writableLength > 0, "headers must still be queued before body rejection");
    };
    void proxyOgcProcessRequest(req, res).finally(() => done.resolve?.());
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  try {
    const received = fetch(
      `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/proxy?url=${encodeURIComponent("https://process.example/execution")}`,
      {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json", "x-geolibre-max-bytes": "1" },
        signal: AbortSignal.timeout(5000),
      },
    ).then(
      (response) => ({ response, error: undefined }),
      (error) => ({ response: undefined, error }),
    );
    await handled;
    done.release?.();
    const result = await received;
    assert.ok(result.response, String(result.error));
    assert.equal(result.response.status, 202);
    assert.equal(result.response.headers.get("location"), "/jobs/queued");
    await assert.rejects(result.response.arrayBuffer());
    assert.equal(writes, 1);
  } finally {
    done.release?.();
    await delegate.close();
    proxy.closeAllConnections();
    proxy.close();
    upstream.close();
    await Promise.all([once(proxy, "close"), once(upstream, "close")]);
  }
});

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
  pool.intercept({ path: "/delete-large", method: "DELETE" }).reply(200, "12345678");
  pool
    .intercept({ path: "/accepted-large", method: "POST", body })
    .reply(202, "12345678", { headers: { Location: "/jobs/retained" } });
  pool.intercept({ path: "/large", method: "GET" }).reply(200, "123456789");
  pool.intercept({ path: "/sync-large", method: "POST", body }).reply(200, "12345678", {
    headers: { Link: '</jobs/sync>; rel="monitor"' },
  });
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
    new Promise<{
      status: number | undefined;
      headers: IncomingHttpHeaders;
      body: string;
      bodyReadFailed?: boolean;
    }>((resolve, reject) => {
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
          res.on("aborted", () =>
            resolve({ status: res.statusCode, headers: res.headers, body, bodyReadFailed: true }),
          );
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
        },
      );
      req.on("error", reject);
      if (chunked && data) {
        const bytes = typeof data === "string" ? Buffer.from(data) : data;
        req.write(bytes.subarray(0, bytes.length / 2));
        req.end(bytes.subarray(bytes.length / 2));
      } else req.end(data);
    });
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
    assert.equal(retained.bodyReadFailed, true);
    const synchronous = await send("POST", "/sync-large", body, { "x-geolibre-max-bytes": "4" });
    assert.equal(synchronous.status, 200);
    assert.equal(synchronous.headers.link, '</jobs/sync>; rel="monitor"');
    assert.equal(synchronous.bodyReadFailed, true);
    assert.equal(synchronous.body, "");
    const dismissed = await send("DELETE", "/delete-large", undefined, {
      "x-geolibre-max-bytes": "4",
    });
    assert.equal(dismissed.status, 200);
    assert.equal(dismissed.body, "");
    assert.equal(dismissed.bodyReadFailed, true);
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
    assert.equal(failure.bodyReadFailed, true);
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
      ["POST", '{"inputs":{"name":"\\ud800"}}', {}, 400, false],
      ["POST", '{"inputs":{"\\ud800":1}}', {}, 400, false],
      [
        "POST",
        '{"inputs":{"payload":' + "[".repeat(126) + "0" + "]".repeat(126) + "}}",
        {},
        400,
        false,
      ],
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
