import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { afterEach, test } from "node:test";
import { handler as worker } from "../workers/ai-proxy/src/index";
import { parallelSearch } from "../workers/ai-proxy/src/parallel-search";

// Node's WebCrypto lacks this Workers API; use Node's native constant-time compare.
Object.assign(crypto.subtle, {
  timingSafeEqual: (a: ArrayBuffer, b: ArrayBuffer) =>
    timingSafeEqual(Buffer.from(a), Buffer.from(b)),
});
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const env = {
  GEOLIBRE_AI_PROXY_TOKEN: "dummy-instance",
  ALLOWED_ORIGINS: "https://app.example",
  MAX_BODY_BYTES: "1048576",
  AI_RATE_LIMITER: { limit: async () => ({ success: true }) },
} as unknown as Parameters<typeof worker.fetch>[1];
const request = (body: unknown = { query: "Landsat" }, token = "dummy-instance") =>
  new Request("https://worker.example/parallel", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://app.example",
      "X-GeoLibre-Instance-Token": token,
      Authorization: "Bearer unrelated",
    },
    body: JSON.stringify(body),
  });

test("Parallel route retains instance auth, shared limiter, CORS and query bounds", async () => {
  globalThis.fetch = async () => {
    throw new Error("Unexpected network");
  };
  assert.equal((await worker.fetch(request({}, "bad"), env)).status, 401);
  const limited = {
    ...env,
    AI_RATE_LIMITER: { limit: async () => ({ success: false }) },
  } as typeof env;
  const response = await worker.fetch(request(), limited);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://app.example");
  for (const body of [{}, { query: " " }, { query: "a".repeat(1001) }]) {
    assert.equal((await worker.fetch(request(body), env)).status, 400);
  }
  assert.equal((await worker.fetch(request({ query: "a".repeat(65537) }), env)).status, 413);
  const preflight = new Request("https://worker.example/parallel", {
    method: "OPTIONS",
    headers: { "X-GeoLibre-Instance-Token": "dummy-instance", Origin: "https://app.example" },
  });
  assert.equal((await worker.fetch(preflight, env)).status, 204);
  for (const path of ["tavily", "search"]) {
    const req = new Request(`https://worker.example/${path}`, request());
    assert.equal((await worker.fetch(req, env)).status, 503);
  }
});

function assertAnonymousRequests(requests: IncomingHttpHeaders[]) {
  assert.ok(requests.length > 0);
  for (const headers of requests) {
    assert.match(headers["user-agent"] ?? "", /^GeoLibre\//);
    assert.equal(headers.authorization, undefined);
    assert.equal(headers["x-geolibre-instance-token"], undefined);
  }
}

for (const [fail, stall] of [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
]) {
  test(`MCP SDK handles held-open ${fail ? "error" : "success"} when DELETE ${stall ? "stalls" : "fails"} and closes streams`, async () => {
    const methods: string[] = [];
    const requests: IncomingHttpHeaders[] = [];
    let streams = 0;
    let deleted = false;
    // Synthetic MCP fixture: real HTTP, each RPC flushes an event and stays open.
    const server = createServer(async (req, res) => {
      requests.push(req.headers);
      if (req.method === "DELETE") {
        deleted = true;
        if (stall) {
          streams++;
          res.on("close", () => streams--);
        } else {
          res.writeHead(500).end();
        }
        return;
      }
      if (req.method === "GET") {
        res.writeHead(405).end();
        return;
      }
      let text = "";
      for await (const chunk of req) text += chunk;
      const rpc = JSON.parse(text);
      methods.push(rpc.method);
      if (rpc.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const result =
        rpc.method === "initialize"
          ? {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "synthetic", version: "1" },
            }
          : rpc.method === "tools/list"
            ? { tools: [{ name: "web_search", inputSchema: { type: "object" } }] }
            : {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      results: [
                        {
                          title: "Synthetic",
                          url: "https://example.org/",
                          excerpts: ["Unicode\u2028separator retained"],
                        },
                      ],
                    }),
                  },
                ],
              };
      res.writeHead(200, {
        "Content-Type": "Text/Event-Stream; charset=utf-8",
        "Mcp-Session-Id": "synthetic",
      });
      streams++;
      res.on("close", () => streams--);
      res.write(
        `event: message\r\ndata: ${JSON.stringify(fail && rpc.method === "tools/call" ? { jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: "synthetic primary" } } : { jsonrpc: "2.0", id: rpc.id, result })}\r\n\r\n`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as import("node:net").AddressInfo;
    globalThis.fetch = (url, init) => {
      assert.equal(String(url), "https://mcp.parallel.ai/mcp");
      assert.equal(init?.redirect, "manual");
      return originalFetch(`http://127.0.0.1:${address.port}`, init);
    };
    try {
      const caller = AbortSignal.timeout(5_000);
      const search = parallelSearch("Landsat", caller);
      if (fail) await assert.rejects(search, /synthetic primary/);
      else assert.equal((await search)[0].content, "Unicode\u2028separator retained");
      assert.equal(deleted, true);
      assert.equal(caller.aborted, false, "teardown used the whole caller budget");
      assertAnonymousRequests(requests);
      assert.ok(methods.includes("notifications/initialized"));
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(streams, 0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

test("cancellation and upstream errors do not become fabricated results", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(parallelSearch("Landsat", controller.signal));
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  assert.equal((await worker.fetch(request(), env)).status, 502);
});

test("Worker refuses redirects without forwarding caller credentials to either local origin", async () => {
  const requests: IncomingHttpHeaders[] = [];
  let redirected = 0;
  const other = createServer((_req, res) => {
    redirected++;
    res.end();
  });
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  const otherPort = (other.address() as import("node:net").AddressInfo).port;
  const first = createServer((req, res) => {
    requests.push(req.headers);
    res.writeHead(302, { Location: `http://127.0.0.1:${otherPort}/capture` }).end();
  });
  await new Promise<void>((resolve) => first.listen(0, "127.0.0.1", resolve));
  const port = (first.address() as import("node:net").AddressInfo).port;
  globalThis.fetch = (_url, init) => originalFetch(`http://127.0.0.1:${port}`, init);
  try {
    assert.equal((await worker.fetch(request(), env)).status, 502);
    assertAnonymousRequests(requests);
    assert.equal(redirected, 0);
  } finally {
    first.closeAllConnections();
    other.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => first.close(() => resolve())),
      new Promise<void>((resolve) => other.close(() => resolve())),
    ]);
  }
});

test("Parallel failures keep the upstream response and search query out of Worker logs", async () => {
  const query = "private sample coordinates";
  const messages: string[] = [];
  let attemptedQuery: unknown;
  globalThis.fetch = async (_url, init) => {
    const rpc = JSON.parse(String(init?.body));
    if (rpc.method === "tools/call") {
      attemptedQuery = rpc.params.arguments.objective;
      return new Response(`Rejected query: ${attemptedQuery}`, { status: 422 });
    }
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    const result =
      rpc.method === "initialize"
        ? {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "synthetic", version: "1" },
          }
        : { tools: [{ name: "web_search", inputSchema: { type: "object" } }] };
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
  };
  const previous = console.error;
  console.error = (...args) => messages.push(args.join(" "));
  try {
    const response = await worker.fetch(request({ query }), env);
    assert.equal(attemptedQuery, query);
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes(query));
    assert.deepEqual(
      messages.map((message) => JSON.parse(message)),
      [{ message: "Parallel search upstream error", code: 422 }],
    );
  } finally {
    console.error = previous;
  }
});

test("an in-flight caller cancellation keeps its 504 after the SDK wraps the abort", async () => {
  const caller = new AbortController();
  globalThis.fetch = async (_url, init) => {
    caller.abort();
    init?.signal?.throwIfAborted();
    throw new Error("Worker did not propagate cancellation");
  };
  const response = await worker.fetch(new Request(request(), { signal: caller.signal }), env);
  assert.equal(response.status, 504);
  assert.match(await response.text(), /timed out or cancelled/);
});
