import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { WebSocket } from "ws";
import {
  MAX_SESSION_LOG_STORAGE_BYTES,
  RELAY_SNAPSHOT_ORIGIN,
  SESSION_LOG_LIMIT,
  signIdentityToken,
} from "@geolibre/collab-core";
import { createRelay } from "../src/server.js";

/** Issuer secret for the identity tests; a relay without one rejects all tokens. */
const IDENTITY_SECRET = "test-identity-secret";

type Message = Record<string, unknown> & { type: string };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function start(options: Parameters<typeof createRelay>[0] = {}) {
  const relay = createRelay({ dbPath: ":memory:", ...options });
  await new Promise<void>((resolve) => relay.server.listen(0, "127.0.0.1", resolve));
  cleanups.push(relay.close);
  const address = relay.server.address();
  assert(address && typeof address === "object");
  return { relay, http: `http://127.0.0.1:${address.port}` };
}

async function createSession(http: string, mode = "co-edit") {
  const response = await fetch(`${http}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as {
    sessionId: string;
    hostToken: string;
    mode: string;
  };
}

async function connect(http: string, sessionId: string): Promise<WebSocket> {
  const socket = new WebSocket(`${http.replace("http", "ws")}/sessions/${sessionId}/ws`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function next(socket: WebSocket, type?: string): Promise<Message> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 2000);
    const receive = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as Message;
      if (type && message.type !== type) {
        socket.once("message", receive);
        return;
      }
      clearTimeout(timer);
      resolve(message);
    };
    socket.once("message", receive);
  });
}

async function joinSession(
  socket: WebSocket,
  hostToken?: string,
  displayName = "Participant",
): Promise<Message> {
  socket.send(
    JSON.stringify({
      type: "join",
      clientId: "ignored-client-id",
      displayName,
      color: "#123456",
      ...(hostToken ? { hostToken } : {}),
    }),
  );
  return next(socket, "welcome");
}

describe("Node collaboration relay", () => {
  it("serves health, creates sessions, and rejects unknown websocket routes", async () => {
    const { http } = await start();
    const health = await fetch(`${http}/health`);
    assert.deepEqual(await health.json(), {
      ok: true,
      service: "geolibre-collab",
      identitySupported: false,
    });

    const created = await createSession(http, "view-only");
    assert.match(created.sessionId, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
    assert.match(created.hostToken, /^[0-9a-f]{48}$/);
    assert.equal(created.mode, "view-only");

    await assert.rejects(connect(http, "NOTFOUND"), /Unexpected server response: 404/);
  });

  it("allows the hosted GeoLibre web origins to create sessions", async () => {
    const { http } = await start();

    for (const origin of [
      "https://geolibre.app",
      "https://web.geolibre.app",
      "https://viewer.geolibre.app",
      "https://studio.geolibre.app",
      "https://50e58010.geolibre-preview.pages.dev",
    ]) {
      const response = await fetch(`${http}/sessions`, {
        method: "POST",
        headers: { origin },
      });
      assert.equal(response.status, 200, `${origin} should be allowed`);
    }

    const rejected = await fetch(`${http}/sessions`, {
      method: "POST",
      headers: { origin: "https://web.geolibre.app.example.com" },
    });
    assert.equal(rejected.status, 403);

    const rejectedPreviewLookalike = await fetch(`${http}/sessions`, {
      method: "POST",
      headers: { origin: "https://preview.geolibre-preview.pages.dev.example.com" },
    });
    assert.equal(rejectedPreviewLookalike.status, 403);

    for (const origin of [
      "https://opengeos.org",
      "https://a.b.geolibre-preview.pages.dev",
      "https://preview.geolibre-preview.pages.dev:8443",
    ]) {
      const response = await fetch(`${http}/sessions`, {
        method: "POST",
        headers: { origin },
      });
      assert.equal(response.status, 403, `${origin} should be rejected`);
    }
  });

  it("makes a configured origin allowlist authoritative", async () => {
    const { http } = await start();
    const previous = process.env.ALLOWED_ORIGINS;
    process.env.ALLOWED_ORIGINS = "https://allowed.example";
    try {
      const allowed = await fetch(`${http}/sessions`, {
        method: "POST",
        headers: { origin: "https://allowed.example" },
      });
      assert.equal(allowed.status, 200);

      for (const origin of ["http://localhost:5173", "https://pr-1.geolibre-preview.pages.dev"]) {
        const response = await fetch(`${http}/sessions`, {
          method: "POST",
          headers: { origin },
        });
        assert.equal(response.status, 403, `${origin} should require explicit configuration`);
      }
    } finally {
      if (previous === undefined) delete process.env.ALLOWED_ORIGINS;
      else process.env.ALLOWED_ORIGINS = previous;
    }
  });

  it("rejects an oversized session-create body by declared length and by count", async () => {
    const { http } = await start();

    // Declared length: answered before any body handler runs. Written over a raw
    // socket on purpose -- fetch refuses to send fewer bytes than it declared,
    // and sending only two of a claimed million is exactly the case that must
    // not be allowed to hold the connection open.
    const { port } = new URL(http);
    const declared = await new Promise<string>((resolve, reject) => {
      const socket = connectTcp({ port: Number(port), host: "127.0.0.1" }, () => {
        socket.write(
          "POST /sessions HTTP/1.1\r\nHost: localhost\r\n" +
            "Content-Type: application/json\r\nContent-Length: 999999\r\n\r\n{}",
        );
      });
      let received = "";
      socket.on("data", (chunk) => {
        received += chunk.toString();
        if (received.includes("Request body too large")) {
          socket.destroy();
          resolve(received);
        }
      });
      socket.on("error", reject);
      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(new Error(`no response before the declared body arrived: ${received}`));
      });
    });
    assert.match(declared, /^HTTP\/1\.1 413 /);

    // No declared length to trust: the running byte count still stops it.
    const counted = await fetch(`${http}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"mode":"${"x".repeat(20_000)}"}`,
    });
    assert.equal(counted.status, 413);

    // A normal body is unaffected.
    assert.equal((await fetch(`${http}/sessions`, { method: "POST" })).status, 200);
  });

  it("enforces view-only mode and lets only the host change it", async () => {
    const { http } = await start();
    const created = await createSession(http, "view-only");
    const host = await connect(http, created.sessionId);
    const guest = await connect(http, created.sessionId);
    await joinSession(host, created.hostToken, "Host");
    await joinSession(guest, undefined, "Guest");

    guest.send(JSON.stringify({ type: "snapshot", project: { name: "blocked" }, rev: 0 }));
    const forbidden = await next(guest, "error");
    assert.equal(forbidden.code, "forbidden");

    guest.send(JSON.stringify({ type: "set-mode", mode: "co-edit" }));
    assert.equal((await next(guest, "error")).code, "forbidden");

    host.send(JSON.stringify({ type: "set-mode", mode: "co-edit" }));
    assert.equal((await next(guest, "mode")).mode, "co-edit");

    guest.send(JSON.stringify({ type: "snapshot", project: { name: "accepted" }, rev: 999 }));
    const snapshot = await next(host, "snapshot");
    // The relay keeps the project in a document, which always has a layer list.
    assert.deepEqual(snapshot.project, { name: "accepted", layers: [] });
    assert.equal(snapshot.rev, 1);
    host.close();
    guest.close();
  });

  it("resyncs a guest whose snapshot touched a locked layer so later edits sync (#3477)", async () => {
    const { http } = await start();
    const created = await createSession(http);
    const host = await connect(http, created.sessionId);
    const guest = await connect(http, created.sessionId);
    await joinSession(host, created.hostToken, "Host");
    await joinSession(guest, undefined, "Guest");

    const stored = {
      name: "Knoxville",
      layers: [
        { id: "historic", name: "Historic sites", opacity: 1 },
        { id: "worship", name: "Places of worship", opacity: 1 },
      ],
    };
    host.send(JSON.stringify({ type: "snapshot", project: stored, rev: 1 }));
    await next(guest, "snapshot");
    host.send(JSON.stringify({ type: "set-layer-locks", lockedLayerIds: ["historic"] }));
    await next(guest, "layer-locks");

    // The guest's opacity change to the locked layer is refused, and the relay
    // hands the stored project back so the guest drops the refused change.
    const touchesLocked = structuredClone(stored);
    touchesLocked.layers[0].opacity = 0;
    const resync = next(guest, "snapshot");
    guest.send(JSON.stringify({ type: "snapshot", project: touchesLocked, rev: 1 }));
    assert.equal((await next(guest, "error")).code, "layer-locked");
    const restored = await resync;
    assert.equal(restored.origin, RELAY_SNAPSHOT_ORIGIN);
    assert.deepEqual(restored.project, stored);
    assert.equal(restored.rev, 1);

    // Built on the restored project, an edit to an unlocked layer now syncs.
    const unlockedEdit = structuredClone(stored);
    unlockedEdit.layers[1].opacity = 0.5;
    guest.send(JSON.stringify({ type: "snapshot", project: unlockedEdit, rev: 2 }));
    const accepted = await next(host, "snapshot");
    assert.deepEqual(accepted.project, unlockedEdit);
    assert.equal(accepted.rev, 2);

    // A view-only refusal is not answered with the project: the guest keeps its
    // local change on screen, and a tiny frame cannot pull megabytes back.
    host.send(JSON.stringify({ type: "set-mode", mode: "view-only" }));
    await next(guest, "mode");
    const frames: string[] = [];
    guest.on("message", (raw) => frames.push((JSON.parse(raw.toString()) as Message).type));
    guest.send(JSON.stringify({ type: "snapshot", project: {}, rev: 3 }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(frames, ["error"]);
    host.close();
    guest.close();
  });

  it("applies participant overrides and the configured snapshot cap", async () => {
    const { http } = await start({ maxSnapshotBytes: 300 });
    const created = await createSession(http);
    const host = await connect(http, created.sessionId);
    const guest = await connect(http, created.sessionId);
    await joinSession(host, created.hostToken);
    const welcome = await joinSession(guest);
    const guestId = welcome.clientId as string;

    host.send(
      JSON.stringify({
        type: "set-participant-mode",
        clientId: guestId,
        canEdit: false,
      }),
    );
    await next(guest, "participants");
    guest.send(JSON.stringify({ type: "snapshot", project: {}, rev: 0 }));
    assert.equal((await next(guest, "error")).code, "forbidden");

    host.send(
      JSON.stringify({
        type: "set-participant-mode",
        clientId: guestId,
        canEdit: true,
      }),
    );
    await next(guest, "participants");
    guest.send(JSON.stringify({ type: "snapshot", project: { data: "x".repeat(400) }, rev: 0 }));
    assert.equal((await next(guest, "error")).code, "too-large");
    host.close();
    guest.close();
  });

  it("validates comment mutations before permissions and bounds the stored project", async () => {
    // Both behaviours are Worker parity requirements: a malformed frame must
    // answer bad-message even from a view-only guest, and a comment must not be
    // able to push the persisted project past the snapshot ceiling.
    const { http } = await start({ maxSnapshotBytes: 400 });
    const created = await createSession(http);
    const host = await connect(http, created.sessionId);
    const guest = await connect(http, created.sessionId);
    await joinSession(host, created.hostToken);
    await joinSession(guest);

    host.send(JSON.stringify({ type: "set-mode", mode: "view-only" }));
    await next(guest, "mode");

    // Shape is checked first, so this is bad-message rather than forbidden.
    guest.send(JSON.stringify({ type: "comment-mutation", action: { type: "nonsense" } }));
    assert.equal((await next(guest, "error")).code, "bad-message");

    // A well-formed frame from the same view-only guest is the forbidden case.
    guest.send(
      JSON.stringify({
        type: "comment-mutation",
        action: { type: "delete", commentId: "abc" },
      }),
    );
    assert.equal((await next(guest, "error")).code, "forbidden");

    // The host may comment, but not past the configured ceiling.
    host.send(
      JSON.stringify({
        type: "comment-mutation",
        action: {
          type: "add",
          comment: {
            id: "c1",
            body: "x".repeat(500),
            author: "Host",
            authorColor: "#123456",
            createdAt: Date.now(),
            anchor: { type: "point", lng: 1, lat: 2 },
          },
        },
      }),
    );
    assert.equal((await next(host, "error")).code, "bad-message");
    host.close();
    guest.close();
  });

  it("keeps commenting working after a snapshot plants a null into comments", async () => {
    // Snapshot content is opaque and unvalidated, so a client can seed
    // project.comments with a non-object. Every `.id` read in the mutation path
    // would then throw, leaving commenting permanently broken for the session
    // even though the process survives.
    const { http } = await start();
    const created = await createSession(http);
    const host = await connect(http, created.sessionId);
    await joinSession(host, created.hostToken);
    // The mutation is broadcast to everyone except its sender, so observe from a
    // second peer.
    const observer = await connect(http, created.sessionId);
    await joinSession(observer);

    host.send(JSON.stringify({ type: "snapshot", project: { comments: [null, 7, "x"] } }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    host.send(
      JSON.stringify({
        type: "comment-mutation",
        action: {
          type: "add",
          comment: {
            id: "c1",
            body: "still works",
            author: { name: "Host", color: "#123456" },
            createdAt: new Date().toISOString(),
            anchor: { type: "point", lngLat: [1, 2] },
          },
        },
      }),
    );
    const echoed = await next(observer, "comment-mutation");
    assert.equal((echoed.action as { type: string }).type, "add");
    observer.close();
    host.close();
  });

  it("restores the latest snapshot and revision from SQLite after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "geolibre-collab-"));
    const dbPath = join(directory, "relay.sqlite");
    cleanups.push(() => rm(directory, { recursive: true, force: true }));

    const first = await start({ dbPath, idleTtlMs: 60_000 });
    const created = await createSession(first.http);
    const host = await connect(first.http, created.sessionId);
    await joinSession(host, created.hostToken);
    // A second peer observes the broadcast, which the relay only emits after the
    // snapshot is written. Waiting on that beats a fixed sleep, which turns into
    // a flake the moment CI is slower than the guess.
    const observer = await connect(first.http, created.sessionId);
    await joinSession(observer);
    host.send(JSON.stringify({ type: "snapshot", project: { persisted: true }, rev: 0 }));
    await next(observer, "snapshot");
    observer.close();
    host.close();
    await cleanups.pop()?.();

    const second = await start({ dbPath, idleTtlMs: 60_000 });
    const rejoined = await connect(second.http, created.sessionId);
    const welcome = await joinSession(rejoined, created.hostToken);
    assert.deepEqual(welcome.snapshot, { persisted: true, layers: [] });
    assert.equal(welcome.rev, 1);
    rejoined.close();
  });

  it("only honors X-Forwarded-For when trustProxy is enabled", async () => {
    const untrusted = await start({ trustProxy: false });
    for (let i = 1; i <= 10; i++) {
      const res = await fetch(`${untrusted.http}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${i}` },
        body: JSON.stringify({ mode: "co-edit" }),
      });
      assert.equal(res.status, 200);
    }
    const res11Untrusted = await fetch(`${untrusted.http}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.11" },
      body: JSON.stringify({ mode: "co-edit" }),
    });
    assert.equal(res11Untrusted.status, 429);

    const trusted = await start({ trustProxy: true });
    for (let i = 1; i <= 11; i++) {
      const res = await fetch(`${trusted.http}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `10.0.1.${i}` },
        body: JSON.stringify({ mode: "co-edit" }),
      });
      assert.equal(res.status, 200);
    }
  });

  it("defers invite consumption until after authorization checks succeed", async () => {
    const { http } = await start({ identitySecret: IDENTITY_SECRET });
    const createdRes = await fetch(`${http}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "view-only", requireIdentity: true }),
    });
    const created = (await createdRes.json()) as { sessionId: string; hostToken: string };

    const host = await connect(http, created.sessionId);
    await joinSession(host, created.hostToken);

    // Host join with hostToken AND inviteToken should not consume the invite.
    host.send(
      JSON.stringify({
        type: "mint-invite",
        role: "co-edit",
        maxUses: 1,
      }),
    );
    const inviteMsg = await next(host, "invite-created");
    const inviteToken = (inviteMsg.invite as { token: string }).token;

    // 1. Host reconnects supplying hostToken AND inviteToken; should join as host without burning invite.
    const hostReconnect = await connect(http, created.sessionId);
    hostReconnect.send(
      JSON.stringify({
        type: "join",
        clientId: "host2",
        displayName: "HostReconnect",
        color: "#000000",
        hostToken: created.hostToken,
        inviteToken,
      }),
    );
    const hostWelcome = await next(hostReconnect, "welcome");
    assert.equal(hostWelcome.role, "host");
    hostReconnect.close();

    // 2. Unauthenticated guest attempts to join with inviteToken (fails identity check).
    const unauthGuest = await connect(http, created.sessionId);
    unauthGuest.send(
      JSON.stringify({
        type: "join",
        clientId: "client1",
        displayName: "Guest",
        color: "#ffffff",
        inviteToken,
      }),
    );
    const err = await next(unauthGuest, "error");
    assert.equal(err.code, "identity-required");
    unauthGuest.close();

    // 3. First authenticated guest joins with inviteToken; succeeds and claims the 1-use co-edit invite.
    const authGuest = await connect(http, created.sessionId);
    authGuest.send(
      JSON.stringify({
        type: "join",
        clientId: "client2",
        displayName: "Alice",
        color: "#00ff00",
        inviteToken,
        identityToken: await signIdentityToken(
          { provider: "geolibre", userId: "user1", username: "Alice" },
          IDENTITY_SECRET,
        ),
      }),
    );
    const welcome = await next(authGuest, "welcome");
    assert.equal(welcome.type, "welcome");
    authGuest.close();

    // 4. Second authenticated guest attempts to join using the same maxUses: 1 inviteToken.
    // The invite was consumed by Alice, so authGuest2 does NOT get co-edit override.
    const authGuest2 = await connect(http, created.sessionId);
    authGuest2.send(
      JSON.stringify({
        type: "join",
        clientId: "client3",
        displayName: "Bob",
        color: "#ff0000",
        inviteToken,
        identityToken: await signIdentityToken(
          { provider: "geolibre", userId: "user2", username: "Bob" },
          IDENTITY_SECRET,
        ),
      }),
    );
    const welcome2 = await next(authGuest2, "welcome");
    assert.equal(welcome2.type, "welcome");

    // Since the co-edit invite was maxed out, Bob is a view-only guest in this view-only session.
    authGuest2.send(JSON.stringify({ type: "snapshot", project: { name: "bob" }, rev: 0 }));
    const editErr = await next(authGuest2, "error");
    assert.equal(editErr.code, "forbidden");

    authGuest2.close();
    host.close();
  });

  it("rejects a self-asserted identity token and refuses requireIdentity without an issuer", async () => {
    // No identitySecret: this relay has no issuer configured.
    const { http } = await start();

    // A host cannot arm a gate nobody could pass.
    const refused = await fetch(`${http}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "co-edit", requireIdentity: true }),
    });
    assert.equal(refused.status, 400);

    const created = await createSession(http);
    const guest = await connect(http, created.sessionId);
    guest.send(
      JSON.stringify({
        type: "join",
        clientId: "client1",
        displayName: "Mallory",
        color: "#ffffff",
        // Raw JSON, the shape the relay used to trust verbatim.
        identityToken: JSON.stringify({ provider: "geolibre", userId: "admin", username: "Admin" }),
      }),
    );
    const welcome = await next(guest, "welcome");
    assert.equal(welcome.identitySupported, false);
    const self = (welcome.participants as { clientId: string; identity: unknown }[]).find(
      (p) => p.clientId === welcome.clientId,
    );
    // Unverified claims must not reach the roster, or the "verified" badge lies.
    assert.equal(self?.identity, null);
    guest.close();
  });

  it("rejects an identity token signed with the wrong secret", async () => {
    const { http } = await start({ identitySecret: IDENTITY_SECRET });
    const created = await createSession(http);
    const guest = await connect(http, created.sessionId);
    guest.send(
      JSON.stringify({
        type: "join",
        clientId: "client1",
        displayName: "Mallory",
        color: "#ffffff",
        identityToken: await signIdentityToken(
          { provider: "geolibre", userId: "admin", username: "Admin" },
          "not-the-relay-secret",
        ),
      }),
    );
    const welcome = await next(guest, "welcome");
    assert.equal(welcome.identitySupported, true);
    const self = (welcome.participants as { clientId: string; identity: unknown }[]).find(
      (p) => p.clientId === welcome.clientId,
    );
    assert.equal(self?.identity, null);
    guest.close();
  });

  it("uses rightmost trusted X-Forwarded-For hop for rate limiting when trustProxy is enabled", async () => {
    const { http } = await start({
      trustProxy: true,
      trustProxyHops: 1,
    });
    // Spoofed left-most IPs change on every request, while the rightmost proxy-appended client IP stays constant.
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${http}/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": `198.51.100.${i + 1}, 203.0.113.9`,
        },
        body: JSON.stringify({ mode: "co-edit" }),
      });
      assert.equal(res.status, 200);
    }
    const eleventh = await fetch(`${http}/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.99, 203.0.113.9",
      },
      body: JSON.stringify({ mode: "co-edit" }),
    });
    assert.equal(eleventh.status, 429);
  });

  it("falls back to remoteAddress when X-Forwarded-For has fewer entries than trustProxyHops", async () => {
    const { http } = await start({
      trustProxy: true,
      trustProxyHops: 2,
    });
    // Single-entry X-Forwarded-For is shorter than trustProxyHops=2, so spoofed
    // values must not create distinct rate-limit buckets; all share 127.0.0.1.
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${http}/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": `198.51.100.${i + 1}`,
        },
        body: JSON.stringify({ mode: "co-edit" }),
      });
      assert.equal(res.status, 200);
    }
    const eleventh = await fetch(`${http}/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.99",
      },
      body: JSON.stringify({ mode: "co-edit" }),
    });
    assert.equal(eleventh.status, 429);
  });

  it("serves the host-only session log and lets the host clear it", async () => {
    const { http } = await start();
    const created = await createSession(http, "view-only");
    const logUrl = `${http}/sessions/${created.sessionId}/log`;
    const asHost = { authorization: `Bearer ${created.hostToken}` };

    const host = await connect(http, created.sessionId);
    const guest = await connect(http, created.sessionId);
    const hostWelcome = await joinSession(host, created.hostToken, "Host");
    const guestWelcome = await joinSession(guest, undefined, "Guest");
    const hostId = hostWelcome.clientId as string;
    const guestId = guestWelcome.clientId as string;

    host.send(JSON.stringify({ type: "set-mode", mode: "co-edit" }));
    await next(guest, "mode");
    host.send(JSON.stringify({ type: "set-participant-mode", clientId: guestId, canEdit: false }));
    await next(guest, "participants");
    host.send(JSON.stringify({ type: "snapshot", project: { name: "logged" }, rev: 0 }));
    await next(guest, "snapshot");
    guest.close();

    // The leave is logged from the socket's close handler, so poll for it.
    let log: Message[] = [];
    for (let attempt = 0; attempt < 50; attempt++) {
      const response = await fetch(logUrl, { headers: asHost });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      log = (await response.json()) as Message[];
      if (log.some((entry) => entry.type === "leave")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(
      log.map(({ ts, ...rest }) => {
        assert.equal(typeof ts, "number");
        return rest;
      }),
      [
        { type: "join", clientId: hostId, identity: null },
        { type: "join", clientId: guestId, identity: null },
        { type: "set-mode", mode: "co-edit" },
        { type: "set-participant-mode", clientId: guestId, canEdit: false },
        { type: "snapshot", rev: 1, origin: hostId },
        { type: "leave", clientId: guestId },
      ],
    );

    // Anything but the exact host token is refused, including the token in the
    // query string, a guest without one, and an unknown session code.
    for (const [url, headers] of [
      [logUrl, {}],
      [logUrl, { authorization: "Bearer wrong-token" }],
      [logUrl, { authorization: created.hostToken }],
      [`${logUrl}?hostToken=${created.hostToken}`, {}],
      [`${http}/sessions/NOTFOUND/log`, asHost],
    ] as const) {
      assert.equal((await fetch(url, { headers })).status, 403);
      assert.equal((await fetch(url, { method: "DELETE", headers })).status, 403);
    }

    const cleared = await fetch(logUrl, { method: "DELETE", headers: asHost });
    assert.equal(cleared.status, 204);
    assert.equal(cleared.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(await (await fetch(logUrl, { headers: asHost })).json(), []);

    // Clearing the log leaves the session and its snapshot intact.
    const rejoin = await connect(http, created.sessionId);
    const welcome = await joinSession(rejoin, created.hostToken, "Host");
    assert.deepEqual(welcome.snapshot, { name: "logged", layers: [] });
    host.close();
    rejoin.close();
  });

  it("authorizes log requests without loading the session snapshot", async (t) => {
    const { relay, http } = await start();
    const created = await createSession(http);
    relay.store.saveSnapshot(created.sessionId, { data: "x".repeat(2_000_000) }, 1);
    const fullReads = t.mock.method(relay.store, "get");
    const logUrl = `${http}/sessions/${created.sessionId}/log`;
    const asHost = { authorization: `Bearer ${created.hostToken}` };
    assert.equal((await fetch(logUrl, { headers: asHost })).status, 200);
    assert.equal((await fetch(logUrl, { method: "DELETE", headers: asHost })).status, 204);
    const unauthorized = { authorization: "Bearer wrong-token" };
    assert.equal((await fetch(logUrl, { headers: unauthorized })).status, 403);
    assert.equal((await fetch(logUrl, { method: "DELETE", headers: unauthorized })).status, 403);
    assert.equal(fullReads.mock.callCount(), 0);
  });

  it("allows DELETE and the Authorization header in CORS preflight", async () => {
    const { http } = await start();
    const preflight = await fetch(`${http}/sessions/ABCDEFGH/log`, { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /\bDELETE\b/);
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /\bAuthorization\b/);
  });

  it("bounds the session log by entry count and bytes and persists it across restarts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "geolibre-collab-log-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const dbPath = join(dir, "collab.sqlite");
    const first = await start({ dbPath });
    const created = await createSession(first.http);

    // Enough entries to pass the byte budget well before the count limit.
    const appended = 2500;
    for (let rev = 1; rev <= appended; rev++) {
      first.relay.store.appendSessionLog(created.sessionId, {
        type: "snapshot",
        ts: rev,
        rev,
        origin: "o",
      });
    }
    const counted = first.relay.store.getSessionLog(created.sessionId);
    assert.ok(counted.length > 0 && counted.length < appended);
    assert.ok(counted.length <= SESSION_LOG_LIMIT);
    assert.ok(
      new TextEncoder().encode(JSON.stringify(counted)).length <= MAX_SESSION_LOG_STORAGE_BYTES,
    );
    // The oldest entries are the ones dropped.
    assert.equal(counted.at(-1)?.ts, appended);
    assert.equal(counted[0]?.ts, appended - counted.length + 1);

    // An entry bigger than the whole budget is still kept, alone, rather than
    // the log being dropped.
    const big = {
      type: "join" as const,
      ts: 0,
      clientId: "big",
      identity: { provider: "test", userId: "x".repeat(120_000), username: "big" },
    };
    first.relay.store.appendSessionLog(created.sessionId, big);
    assert.deepEqual(first.relay.store.getSessionLog(created.sessionId), [big]);
    await cleanups.pop()?.();

    const second = await start({ dbPath });
    const response = await fetch(`${second.http}/sessions/${created.sessionId}/log`, {
      headers: { authorization: `Bearer ${created.hostToken}` },
    });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as Message[]).length, 1);
  });
});
