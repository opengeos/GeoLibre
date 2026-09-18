import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { WebSocket } from "ws";
import { signIdentityToken } from "@geolibre/collab-core";
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
    assert.deepEqual(snapshot.project, { name: "accepted" });
    assert.equal(snapshot.rev, 1);
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
    assert.deepEqual(welcome.snapshot, { persisted: true });
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
});
