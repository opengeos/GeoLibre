import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import WebSocket from "ws";
import { getParticipantKey, type SessionParticipant } from "../packages/collab-core/src/index.ts";
import { createRelay } from "../workers/collab-node/src/server.ts";
import { parallelSearch } from "../workers/ai-proxy/src/parallel-search.ts";
import { handler as aiProxyWorker } from "../workers/ai-proxy/src/index.ts";
import tilesWorkerModule from "../workers/tiles/src/index.ts";
import {
  fetchAllowlistedUpstream,
  ODP_TILE_UPSTREAM,
} from "../workers/tiles/src/allowlisted-fetch.ts";
import {
  clearEarthdataPresignedCache,
  handleEarthdataDownload,
} from "../workers/tiles/src/earthdata.ts";

Object.assign(crypto.subtle, {
  timingSafeEqual: (a: ArrayBuffer, b: ArrayBuffer) =>
    timingSafeEqual(Buffer.from(a), Buffer.from(b)),
});

const tilesWorker =
  "fetch" in tilesWorkerModule
    ? tilesWorkerModule
    : (tilesWorkerModule as unknown as { default: typeof tilesWorkerModule }).default;

describe("Section 3a worker reliability fixes", () => {
  it("isolates participant keys for shared multi-use invites while keeping single-use durable", () => {
    const singleUse: SessionParticipant = {
      clientId: "c-1",
      displayName: "A",
      color: "#111111",
      role: "guest",
      inviteToken: "tok-single",
    };
    const sharedA: SessionParticipant = {
      clientId: "c-2",
      displayName: "B",
      color: "#222222",
      role: "guest",
      inviteToken: "tok-shared",
      inviteShared: true,
    };
    const sharedB: SessionParticipant = {
      clientId: "c-3",
      displayName: "C",
      color: "#333333",
      role: "guest",
      inviteToken: "tok-shared",
      inviteShared: true,
    };

    assert.equal(getParticipantKey(singleUse), "invite:tok-single");
    assert.equal(getParticipantKey(sharedA), "anon:c-2");
    assert.equal(getParticipantKey(sharedB), "anon:c-3");
    assert.notEqual(getParticipantKey(sharedA), getParticipantKey(sharedB));
  });

  it("schedules empty-session cleanup alarm on Durable Object /init", () => {
    const source = readFileSync(
      new URL("../workers/collab/src/session.ts", import.meta.url),
      "utf8",
    );
    const initStart = source.indexOf('url.pathname === "/init"');
    const wsStart = source.indexOf('url.pathname === "/ws"', initStart);
    assert.ok(initStart !== -1 && wsStart > initStart);
    const initBlock = source.slice(initStart, wsStart);
    assert.match(
      initBlock,
      /this\.ctx\.storage\.setAlarm\(Date\.now\(\) \+ EMPTY_SESSION_TTL_MS\)/,
    );
  });

  it("blocking one guest on a multi-use invite does not block another guest on the same invite", async () => {
    const relay = createRelay({ dbPath: ":memory:" });
    await new Promise<void>((resolve) => relay.server.listen(0, "127.0.0.1", resolve));
    const addr = relay.server.address();
    assert.ok(addr && typeof addr === "object");
    const baseHttp = `http://127.0.0.1:${addr.port}`;
    const baseWs = `ws://127.0.0.1:${addr.port}`;

    try {
      const created = (await (
        await fetch(`${baseHttp}/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "view-only" }),
        })
      ).json()) as { sessionId: string; hostToken: string };

      const connect = () =>
        new Promise<WebSocket>((resolve, reject) => {
          const ws = new WebSocket(`${baseWs}/sessions/${created.sessionId}/ws`);
          ws.once("open", () => resolve(ws));
          ws.once("error", reject);
        });
      const nextMessage = (ws: WebSocket, predicate: (m: Record<string, unknown>) => boolean) =>
        new Promise<Record<string, unknown>>((resolve) => {
          const onMsg = (raw: WebSocket.RawData) => {
            const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
            if (predicate(parsed)) {
              ws.off("message", onMsg);
              resolve(parsed);
            }
          };
          ws.on("message", onMsg);
        });

      const host = await connect();
      const hostWelcome = nextMessage(host, (m) => m.type === "welcome");
      host.send(
        JSON.stringify({
          type: "join",
          clientId: "h1",
          displayName: "Host",
          color: "#000000",
          hostToken: created.hostToken,
        }),
      );
      await hostWelcome;

      const inviteMsg = nextMessage(host, (m) => m.type === "invite-created");
      host.send(JSON.stringify({ type: "mint-invite", role: "co-edit", maxUses: 5 }));
      const inviteToken = ((await inviteMsg).invite as { token: string }).token;

      const guest1 = await connect();
      const g1WelcomeP = nextMessage(guest1, (m) => m.type === "welcome");
      guest1.send(
        JSON.stringify({
          type: "join",
          clientId: "g1",
          displayName: "Guest 1",
          color: "#111111",
          inviteToken,
        }),
      );
      const g1Welcome = await g1WelcomeP;
      const g1ClientId = g1Welcome.clientId as string;

      const kickedP = nextMessage(guest1, (m) => m.type === "kicked");
      host.send(JSON.stringify({ type: "block-participant", clientId: g1ClientId }));
      await kickedP;

      // Second guest with the same multi-use invite should still be welcomed.
      const guest2 = await connect();
      const g2MsgP = nextMessage(guest2, (m) => m.type === "welcome" || m.type === "error");
      guest2.send(
        JSON.stringify({
          type: "join",
          clientId: "g2",
          displayName: "Guest 2",
          color: "#222222",
          inviteToken,
        }),
      );
      const g2Msg = await g2MsgP;
      assert.equal(g2Msg.type, "welcome");

      host.close();
      guest1.close();
      guest2.close();
    } finally {
      await relay.close();
    }
  });

  it("ai-proxy parallelSearch sends DELETE with fresh timeout even after caller abort", async () => {
    const originalFetch = globalThis.fetch;
    let deleteSignalAborted: boolean | null = null;
    let sawDelete = false;
    const caller = new AbortController();

    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        sawDelete = true;
        deleteSignalAborted = init.signal?.aborted ?? false;
        return new Response(null, { status: 204 });
      }
      const rawBody = typeof init?.body === "string" ? init.body : "";
      const parsed = rawBody ? (JSON.parse(rawBody) as { id?: number; method?: string }) : {};
      if (parsed.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              serverInfo: { name: "mock", version: "1.0" },
            },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "mcp-session-id": "sess-abort-test",
            },
          },
        );
      }
      if (parsed.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      // Abort caller during listTools so finally calls terminateSession() after abort.
      caller.abort();
      throw new DOMException("Aborted", "AbortError");
    }) as typeof fetch;

    try {
      await assert.rejects(() => parallelSearch("flood", caller.signal));
      assert.equal(sawDelete, true);
      assert.equal(deleteSignalAborted, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("ai-proxy handles missing ALLOWED_ORIGINS and ALLOWED_MODELS without crashing", async () => {
    const env = {
      DEFAULT_MODEL: "openai/gpt-5",
      GEOLIBRE_AI_PROXY_TOKEN: "tok-123",
      CLOUDFLARE_ACCOUNT_ID: "acc",
      CLOUDFLARE_API_TOKEN: "cf-tok",
      MAX_BODY_BYTES: "1048576",
      MAX_OUTPUT_TOKENS: "1024",
      AI_RATE_LIMITER: { limit: async () => ({ success: true }) },
    } as unknown as Parameters<typeof aiProxyWorker.fetch>[1];

    const res = await aiProxyWorker.fetch(
      new Request("https://ai.example.test/v1/chat/completions", {
        method: "POST",
        headers: {
          Origin: "https://geolibre.app",
          "X-GeoLibre-Instance-Token": "tok-123",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
      env,
    );
    assert.equal(res.status, 400);
  });

  it("tiles worker rejects zoom > 24 and tolerates missing global caches", async () => {
    const res = await tilesWorker.fetch(
      new Request("https://tiles.example.test/mars-viking/25/0/0.png"),
      {} as Parameters<typeof tilesWorker.fetch>[1],
      { waitUntil() {}, passThroughOnException() {} } as unknown as Parameters<
        typeof tilesWorker.fetch
      >[2],
    );
    assert.equal(res.status, 404);
  });

  it("allowlisted-fetch cancels redirect response bodies", async () => {
    let cancelled = false;
    let calls = 0;
    const response = await fetchAllowlistedUpstream(
      `${ODP_TILE_UPSTREAM}0/0/0.pbf`,
      {},
      async () => {
        calls += 1;
        if (calls === 1) {
          const stream = new ReadableStream({
            cancel() {
              cancelled = true;
            },
          });
          return new Response(stream, {
            status: 302,
            headers: {
              location: `${ODP_TILE_UPSTREAM}0/0/1.pbf`,
            },
          });
        }
        return new Response("ok", { status: 200 });
      },
    );
    assert.equal(response.status, 200);
    assert.equal(cancelled, true);
  });

  it("earthdata cancels redirect/error bodies and caches presigned URL across 2-hop redirects", async () => {
    clearEarthdataPresignedCache();
    let cancelledHop1 = false;
    let cancelledHop2 = false;
    let cachedUrl: string | null = null;
    const originalCaches = (globalThis as { caches?: unknown }).caches;
    (globalThis as { caches?: unknown }).caches = {
      default: {
        match: async () => undefined,
        put: async (_req: unknown, resp: Response) => {
          cachedUrl = await resp.text();
        },
        delete: async () => false,
      },
    };
    try {
      let step = 0;
      const req = new Request(
        "https://tiles.example.test/earthdata/download?url=" +
          encodeURIComponent("https://data.nsidc.earthdatacloud.nasa.gov/test/file.h5"),
        { headers: { Authorization: "Bearer test-token" } },
      );
      const res = await handleEarthdataDownload(req, async () => {
        step += 1;
        if (step === 1) {
          return new Response(
            new ReadableStream({
              cancel() {
                cancelledHop1 = true;
              },
            }),
            {
              status: 302,
              headers: {
                location: "https://data.nsidc.earthdatacloud.nasa.gov/redirect-step/file.h5",
              },
            },
          );
        }
        if (step === 2) {
          return new Response(
            new ReadableStream({
              cancel() {
                cancelledHop2 = true;
              },
            }),
            {
              status: 302,
              headers: {
                location:
                  "https://nsidc-cumulus-prod-protected.s3.us-west-2.amazonaws.com/file.h5?X-Amz-Signature=abc",
              },
            },
          );
        }
        return new Response("hdf5-bytes", { status: 200 });
      });
      assert.equal(res.status, 200);
      assert.equal(cancelledHop1, true);
      assert.equal(cancelledHop2, true);
      assert.equal(
        cachedUrl,
        "https://nsidc-cumulus-prod-protected.s3.us-west-2.amazonaws.com/file.h5?X-Amz-Signature=abc",
      );
    } finally {
      (globalThis as { caches?: unknown }).caches = originalCaches;
    }
  });
});
