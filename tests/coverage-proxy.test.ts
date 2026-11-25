import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, get } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { test } from "node:test";
import {
  PROXY_MAX_BODY_BYTES,
  proxyBinaryRequestGuarded,
} from "../apps/geolibre-desktop/vite-proxy-guard";
import { MAX_COVERAGE_DOWNLOAD_BYTES } from "../apps/geolibre-desktop/src/lib/ogc-coverage-limits";

// Use the guard's workspace dependency, which may differ from the root version.
const { Agent, MockAgent } = createRequire(
  new URL("../apps/geolibre-desktop/vite-proxy-guard.ts", import.meta.url),
)("undici") as typeof import("undici");

test("coverage proxy preserves error status and its download budget while other routes keep defaults", async (t) => {
  const delegate = new Agent();
  delegate.dispatch = delegate.dispatch.bind(delegate);
  const upstream = new MockAgent({ agent: delegate });
  upstream.disableNetConnect();
  t.mock.method(
    Agent.prototype,
    "dispatch",
    (...args: Parameters<InstanceType<typeof Agent>["dispatch"]>) => upstream.dispatch(...args),
  );
  const pool = upstream.get("https://coverage.example");
  for (const status of [503, 503, 200]) {
    pool.intercept({ path: "/coverage", method: "GET" }).reply(status, "error", {
      headers: { "content-length": String(PROXY_MAX_BODY_BYTES + 1) },
    });
  }
  const largeCoverage = Buffer.alloc(PROXY_MAX_BODY_BYTES + 1, 65);
  pool.intercept({ path: "/coverage", method: "GET" }).reply(200, largeCoverage, {
    headers: { "content-length": String(largeCoverage.length) },
  });
  for (const size of [largeCoverage.length, MAX_COVERAGE_DOWNLOAD_BYTES + 1]) {
    pool.intercept({ path: "/coverage", method: "GET" }).reply(200, "", {
      headers: { "content-length": String(size) },
    });
  }
  const server = createServer((req, res) => {
    void proxyBinaryRequestGuarded(req, res, "/proxy", {
      discardErrorBody: req.headers["x-discard-errors"] === "true",
      maxBodyBytes:
        req.headers["x-coverage-limit"] === "true" ? MAX_COVERAGE_DOWNLOAD_BYTES : undefined,
    }).catch((error) => res.destroy(error));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = (server.address() as AddressInfo).port;
    const request = (discard: boolean, coverageLimit = false) =>
      new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        get(
          `http://127.0.0.1:${port}/proxy?url=${encodeURIComponent("https://coverage.example/coverage")}`,
          {
            headers: {
              "x-discard-errors": String(discard),
              "x-coverage-limit": String(coverageLimit),
            },
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => (body += chunk));
            res.on("error", reject);
            res.on("end", () => resolve({ status: res.statusCode, body }));
          },
        ).on("error", reject);
      });
    assert.deepEqual(await request(true), { status: 503, body: "" });
    assert.deepEqual(await request(false), {
      status: 502,
      body: "Upstream response exceeds size limit",
    });
    assert.deepEqual(await request(true), {
      status: 502,
      body: "Upstream response exceeds size limit",
    });
    const coverage = await request(true, true);
    assert.equal(coverage.status, 200);
    assert.equal(coverage.body.length, largeCoverage.length);
    assert.equal(coverage.body.charAt(coverage.body.length - 1), "A");
    assert.deepEqual(await request(false), {
      status: 502,
      body: "Upstream response exceeds size limit",
    });
    assert.deepEqual(await request(true, true), {
      status: 502,
      body: "Upstream response exceeds size limit",
    });
    upstream.assertNoPendingInterceptors();
  } finally {
    server.close();
    await once(server, "close");
    await upstream.close();
  }
});
