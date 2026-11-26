// Op-level (CRDT) sync through the Node relay (#3530): two simulated clients
// converge under concurrent edits, the document persists across a restart,
// projects beyond the old 10 MB snapshot cap sync in bounded frames, and
// snapshot-protocol clients interoperate with op-level ones.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { WebSocket } from "ws";
import {
  deepEqual,
  encodeBase64,
  ProjectDoc,
  splitUpdate,
  UpdateAssembler,
  Y,
  type ProjectRecord,
} from "@geolibre/collab-core/crdt";
import { CRDT_FEATURE } from "@geolibre/collab-core";
import { createRelay } from "../src/server.js";

type Message = Record<string, unknown> & { type: string };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function start(options: Parameters<typeof createRelay>[0] = {}) {
  const relay = createRelay({ dbPath: ":memory:", ...options });
  await new Promise<void>((resolve) => relay.server.listen(0, "127.0.0.1", resolve));
  const close = relay.close;
  cleanups.push(close);
  const address = relay.server.address();
  assert(address && typeof address === "object");
  return { relay, http: `http://127.0.0.1:${address.port}`, close };
}

async function createSession(http: string, mode = "co-edit") {
  const response = await fetch(`${http}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as { sessionId: string; hostToken: string };
}

/**
 * A minimal op-level client: it mirrors the relay's document, applies every
 * inbound update, and sends every local transaction as framed updates.
 */
class CrdtClient {
  readonly project = new ProjectDoc(new Y.Doc());
  readonly messages: Message[] = [];
  private readonly assembler = new UpdateAssembler(256 * 1024 * 1024);
  private waiters: { match: (m: Message) => boolean; resolve: (m: Message) => void }[] = [];
  private chunk = 0;

  constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) => this.receive(JSON.parse(raw.toString()) as Message));
    this.project.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== "local") return;
      for (const frame of splitUpdate(update, () => `c${++this.chunk}`)) {
        socket.send(JSON.stringify({ type: "doc-update", ...frame }));
      }
    });
  }

  static async connect(http: string, sessionId: string): Promise<CrdtClient> {
    const socket = new WebSocket(`${http.replace("http", "ws")}/sessions/${sessionId}/ws`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const client = new CrdtClient(socket);
    cleanups.push(async () => socket.close());
    return client;
  }

  private receive(message: Message): void {
    if (message.type === "doc-update") {
      const result = this.assembler.push(
        String(message.origin),
        message as { update?: unknown; chunk?: unknown },
      );
      if (result.status === "complete") Y.applyUpdate(this.project.doc, result.update, "remote");
    }
    this.messages.push(message);
    for (const waiter of [...this.waiters]) {
      if (waiter.match(message)) {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        waiter.resolve(message);
      }
    }
  }

  /** Resolve with the first message (already received or future) matching. */
  next(match: (m: Message) => boolean, timeoutMs = 5000, since = 0): Promise<Message> {
    const seen = this.messages.slice(since).find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for a message")),
        timeoutMs,
      );
      this.waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  async join(hostToken?: string, features: string[] = [CRDT_FEATURE]): Promise<Message> {
    const since = this.messages.length;
    this.socket.send(
      JSON.stringify({
        type: "join",
        clientId: "ignored",
        displayName: hostToken ? "Host" : "Guest",
        color: "#123456",
        features,
        ...(hostToken ? { hostToken } : {}),
      }),
    );
    return this.next((m) => m.type === "welcome", 5000, since);
  }

  /** Pull what the relay has, then push what it lacks. */
  async sync(): Promise<void> {
    const since = this.messages.length;
    const vector = encodeBase64(Y.encodeStateVector(this.project.doc));
    this.socket.send(JSON.stringify({ type: "doc-sync", stateVector: vector }));
    const synced = await this.next((m) => m.type === "doc-synced", 10_000, since);
    const missing = Y.encodeStateAsUpdate(
      this.project.doc,
      Buffer.from(String(synced.stateVector), "base64"),
    );
    // An update with no structs and no deletions is two zero bytes.
    if (missing.length > 2) {
      for (const frame of splitUpdate(missing, () => `s${++this.chunk}`)) {
        this.socket.send(JSON.stringify({ type: "doc-update", ...frame }));
      }
    }
  }

  write(project: ProjectRecord): void {
    this.project.write(project, "local");
  }

  read(): ProjectRecord {
    return this.project.read();
  }

  /** Wait until this client's project satisfies `test`. */
  async until(test: (project: ProjectRecord) => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!test(this.read())) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for the project to converge");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function baseProject(): ProjectRecord {
  return {
    projectName: "Shared",
    layers: [
      { id: "roads", name: "Roads", style: { color: "#f00", width: 1 } },
      { id: "parcels", name: "Parcels", style: { color: "#0f0" } },
    ],
  };
}

function layer(project: ProjectRecord, id: string): Record<string, unknown> {
  return (project.layers as Record<string, unknown>[]).find((l) => l.id === id)!;
}

function editLayer(
  project: ProjectRecord,
  id: string,
  edit: (layer: Record<string, unknown>) => Record<string, unknown>,
): ProjectRecord {
  return {
    ...project,
    layers: (project.layers as Record<string, unknown>[]).map((l) => (l.id === id ? edit(l) : l)),
  };
}

describe("op-level sync through the Node relay", () => {
  it("advertises the capability and converges two clients under concurrent edits", async () => {
    const { http } = await start();
    const created = await createSession(http);
    const host = await CrdtClient.connect(http, created.sessionId);
    const welcome = await host.join(created.hostToken);
    assert.deepEqual(welcome.features, [CRDT_FEATURE]);
    assert.equal(welcome.snapshot, null);
    await host.sync();
    host.write(baseProject());

    const guest = await CrdtClient.connect(http, created.sessionId);
    await guest.join();
    await guest.sync();
    assert.ok(deepEqual(guest.read(), host.read()));

    // Both edit the same layer at once: different style properties, plus a
    // new layer each. Neither edit may be lost.
    host.write(
      editLayer(host.read(), "roads", (l) => ({
        ...l,
        style: { ...(l.style as object), color: "#00f" },
      })),
    );
    guest.write(
      editLayer(guest.read(), "roads", (l) => ({
        ...l,
        style: { ...(l.style as object), width: 5 },
      })),
    );
    host.write({ ...host.read(), layers: [...(host.read().layers as object[]), { id: "h" }] });
    guest.write({ ...guest.read(), layers: [...(guest.read().layers as object[]), { id: "g" }] });

    const converged = (p: ProjectRecord) =>
      (layer(p, "roads")?.style as Record<string, unknown>)?.color === "#00f" &&
      (layer(p, "roads")?.style as Record<string, unknown>)?.width === 5 &&
      !!layer(p, "h") &&
      !!layer(p, "g");
    await host.until(converged);
    await guest.until(converged);
    assert.ok(deepEqual(host.read(), guest.read()));
  });

  it("rejects updates from a view-only guest", async () => {
    const { http } = await start();
    const created = await createSession(http, "view-only");
    const host = await CrdtClient.connect(http, created.sessionId);
    await host.join(created.hostToken);
    await host.sync();
    host.write(baseProject());
    const guest = await CrdtClient.connect(http, created.sessionId);
    await guest.join();
    await guest.sync();
    guest.write({ ...guest.read(), projectName: "Blocked" });
    const error = await guest.next((m) => m.type === "error");
    assert.equal(error.code, "forbidden");
    assert.equal(host.read().projectName, "Shared");
  });

  it("reverts a guest's change to a locked layer for every client", async () => {
    const { http } = await start();
    const created = await createSession(http);
    const host = await CrdtClient.connect(http, created.sessionId);
    await host.join(created.hostToken);
    await host.sync();
    host.write(baseProject());
    host.socket.send(JSON.stringify({ type: "set-layer-locks", lockedLayerIds: ["roads"] }));
    const guest = await CrdtClient.connect(http, created.sessionId);
    await guest.join();
    await guest.sync();
    await guest.next((m) => m.type === "layer-locks" || m.type === "welcome");

    guest.write(editLayer(guest.read(), "roads", (l) => ({ ...l, name: "Hijacked" })));
    const error = await guest.next((m) => m.type === "error");
    assert.equal(error.code, "layer-locked");
    await guest.until((p) => layer(p, "roads").name === "Roads");
    assert.equal(layer(host.read(), "roads").name, "Roads");

    // An edit to an unlocked layer still goes through afterwards.
    guest.write(editLayer(guest.read(), "parcels", (l) => ({ ...l, name: "Parcels (guest)" })));
    await host.until((p) => layer(p, "parcels").name === "Parcels (guest)");
    assert.ok(deepEqual(host.read(), guest.read()));
  });

  it("bridges snapshot-protocol clients and op-level clients both ways", async () => {
    const { http } = await start();
    const created = await createSession(http);
    const host = await CrdtClient.connect(http, created.sessionId);
    await host.join(created.hostToken);
    await host.sync();
    host.write(baseProject());

    // A client from before op-level sync: no `features`, whole snapshots.
    const legacy = await CrdtClient.connect(http, created.sessionId);
    const welcome = await legacy.join(undefined, []);
    assert.ok(deepEqual(welcome.snapshot, host.read()));

    const edited = editLayer(welcome.snapshot as ProjectRecord, "parcels", (l) => ({
      ...l,
      name: "From legacy",
    }));
    legacy.socket.send(JSON.stringify({ type: "snapshot", project: edited, rev: 0 }));
    await host.until((p) => layer(p, "parcels").name === "From legacy");
    // Only the changed property travelled; the host's roads layer is untouched.
    assert.equal(layer(host.read(), "roads").name, "Roads");

    const before = legacy.messages.length;
    host.write(editLayer(host.read(), "roads", (l) => ({ ...l, name: "Roads v2" })));
    const snapshot = await legacy.next((m) => m.type === "snapshot", 5000, before);
    assert.equal(layer(snapshot.project as ProjectRecord, "roads").name, "Roads v2");
    assert.equal(layer(snapshot.project as ProjectRecord, "parcels").name, "From legacy");
  });

  it("refuses snapshots from a client that was never sent the project", async () => {
    const { http } = await start({ maxSnapshotBytes: 2_000 });
    const created = await createSession(http);
    const host = await CrdtClient.connect(http, created.sessionId);
    await host.join(created.hostToken);
    await host.sync();
    host.write({ ...baseProject(), notes: "x".repeat(5_000) });
    const legacy = await CrdtClient.connect(http, created.sessionId);
    await legacy.join(undefined, []);
    assert.equal((await legacy.next((m) => m.type === "error")).code, "too-large");
    const before = legacy.messages.length;
    legacy.socket.send(
      JSON.stringify({ type: "snapshot", project: { projectName: "Tiny", layers: [] }, rev: 0 }),
    );
    const refused = await legacy.next((m) => m.type === "error", 5000, before);
    assert.equal(refused.code, "too-large");
    assert.equal(layer(host.read(), "roads").name, "Roads", "the session keeps its layers");
  });

  it("migrates a session's stored snapshot into a document", async () => {
    const { http, relay } = await start();
    const created = await createSession(http);
    relay.store.saveSnapshot(created.sessionId, baseProject(), 4);
    const client = await CrdtClient.connect(http, created.sessionId);
    const welcome = await client.join(created.hostToken);
    assert.equal(welcome.rev, 4);
    await client.sync();
    assert.ok(deepEqual(client.read(), baseProject()));
    assert.equal(relay.store.get(created.sessionId)?.snapshot, null, "the old copy is dropped");
  });

  it("keeps comments written by the relay in the document", async () => {
    const { http } = await start();
    const created = await createSession(http);
    const host = await CrdtClient.connect(http, created.sessionId);
    await host.join(created.hostToken);
    await host.sync();
    host.write(baseProject());
    host.socket.send(
      JSON.stringify({
        type: "comment-mutation",
        action: {
          type: "add",
          comment: {
            id: "c1",
            body: "Check this",
            author: { name: "Host", color: "#123456" },
            anchor: { type: "point", lngLat: [1, 2] },
            createdAt: "2026-01-01T00:00:00.000Z",
            resolved: false,
            replies: [],
          },
        },
      }),
    );
    await host.until((p) => Array.isArray(p.comments) && p.comments.length === 1);
    const late = await CrdtClient.connect(http, created.sessionId);
    await late.join();
    await late.sync();
    assert.equal((late.read().comments as { id: string }[])[0].id, "c1");
  });

  it("persists the document across a restart and compacts its log", async () => {
    const directory = await mkdtemp(join(tmpdir(), "geolibre-collab-crdt-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const dbPath = join(directory, "relay.sqlite");

    const first = await start({ dbPath, idleTtlMs: 60_000 });
    const created = await createSession(first.http);
    const host = await CrdtClient.connect(first.http, created.sessionId);
    await host.join(created.hostToken);
    await host.sync();
    host.write(baseProject());
    const observer = await CrdtClient.connect(first.http, created.sessionId);
    await observer.join();
    await observer.sync();
    // Enough separate updates to cross the log-entry compaction threshold, in
    // batches that stay under the relay's per-socket frame queue.
    for (let i = 0; i < 300; i += 1) {
      host.write({ ...host.read(), projectName: `Rev ${i}` });
      if (i % 40 === 39) await observer.until((p) => p.projectName === `Rev ${i}`);
    }
    await observer.until((p) => p.projectName === "Rev 299");
    const expected = host.read();
    host.socket.close();
    observer.socket.close();
    await first.close();
    cleanups.splice(cleanups.indexOf(first.close), 1);

    const second = await start({ dbPath, idleTtlMs: 60_000 });
    const rejoined = await CrdtClient.connect(second.http, created.sessionId);
    await rejoined.join(created.hostToken);
    await rejoined.sync();
    assert.ok(deepEqual(rejoined.read(), expected));
    const rows = (
      second.relay.store as unknown as {
        db: { prepare(sql: string): { all(...args: unknown[]): unknown[] } };
      }
    ).db
      .prepare("SELECT DISTINCT kind, entry FROM collab_doc_chunks WHERE session_id = ?")
      .all(created.sessionId) as { kind: string }[];
    assert.ok(
      rows.some((row) => row.kind === "base"),
      "the log was compacted into a base",
    );
    assert.ok(rows.filter((row) => row.kind === "log").length < 256);
  });

  it("syncs and persists a project far beyond the old 10 MB snapshot cap", async () => {
    const directory = await mkdtemp(join(tmpdir(), "geolibre-collab-big-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const dbPath = join(directory, "relay.sqlite");
    const first = await start({ dbPath, idleTtlMs: 60_000, maxDocBytes: 64 * 1024 * 1024 });
    const created = await createSession(first.http);
    const host = await CrdtClient.connect(first.http, created.sessionId);
    await host.join(created.hostToken);
    await host.sync();
    const padding = "x".repeat(2_000);
    const features = Array.from({ length: 6_500 }, (_, i) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [i, i] },
      properties: { n: i, padding },
    }));
    const big: ProjectRecord = {
      projectName: "Big",
      layers: [{ id: "big", geojson: { type: "FeatureCollection", features } }],
    };
    assert.ok(JSON.stringify(big).length > 12_000_000);
    host.write(big);

    const guest = await CrdtClient.connect(first.http, created.sessionId);
    await guest.join();
    await guest.sync();
    await guest.until((p) => p.projectName === "Big", 20_000);
    assert.ok(deepEqual(guest.read(), big));
    host.socket.close();
    guest.socket.close();
    await first.close();
    cleanups.splice(cleanups.indexOf(first.close), 1);

    const second = await start({ dbPath, idleTtlMs: 60_000, maxDocBytes: 64 * 1024 * 1024 });
    const late = await CrdtClient.connect(second.http, created.sessionId);
    await late.join();
    await late.sync();
    assert.ok(deepEqual(late.read(), big));
  });

  it("refuses an update that would grow the document past its ceiling", async () => {
    const { http } = await start({ maxDocBytes: 200_000 });
    const created = await createSession(http);
    const host = await CrdtClient.connect(http, created.sessionId);
    await host.join(created.hostToken);
    await host.sync();
    host.write({ projectName: "x".repeat(300_000), layers: [] });
    const error = await host.next((m) => m.type === "error");
    assert.equal(error.code, "too-large");
  });
});
