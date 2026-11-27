import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deepEqual,
  encodeBase64,
  ProjectDoc,
  splitUpdate,
  Y,
} from "../packages/collab-core/src/crdt";
import {
  chunkBytes,
  DOC_COMPACT_LOG_ENTRIES,
  joinBytes,
  RelayDoc,
  type DocStorage,
} from "../packages/collab-core/src/crdt-relay";

/** In-memory `DocStorage` that records what the relay persisted. */
function memoryStorage(): DocStorage & { base: Uint8Array | null; log: Uint8Array[] } {
  const storage = {
    base: null as Uint8Array | null,
    log: [] as Uint8Array[],
    load: () => ({ base: storage.base, log: [...storage.log] }),
    append: (update: Uint8Array) => {
      storage.log.push(update);
    },
    replace: (base: Uint8Array) => {
      storage.base = base;
      storage.log = [];
    },
  };
  return storage;
}

const editor = { canEdit: true, isHost: false, lockedLayerIds: [] as string[] };

function project(name = "Shared") {
  return {
    projectName: name,
    layers: [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ],
  };
}

/** A client document and the frames its next local write produces. */
function clientWrite(client: ProjectDoc, next: Record<string, unknown>) {
  const updates: Uint8Array[] = [];
  const listener = (update: Uint8Array) => updates.push(update);
  client.doc.on("update", listener);
  client.write(next, "local");
  client.doc.off("update", listener);
  return updates.flatMap((update) => splitUpdate(update, () => "id"));
}

describe("RelayDoc", () => {
  it("splits and joins stored bytes", () => {
    const bytes = new Uint8Array(2_500_000).map((_, i) => i & 255);
    const parts = chunkBytes(bytes);
    assert.equal(parts.length, 3);
    assert.deepEqual(joinBytes(parts), bytes);
    assert.deepEqual(chunkBytes(new Uint8Array(0)), [new Uint8Array(0)]);
  });

  it("migrates a legacy snapshot once and then loads from storage", () => {
    const storage = memoryStorage();
    let migrated = 0;
    const first = new RelayDoc({
      storage,
      legacySnapshot: () => project(),
      onMigrated: () => (migrated += 1),
    });
    assert.equal(migrated, 1);
    assert.ok(storage.base, "the migrated state is stored as the base");
    assert.ok(deepEqual(first.materialize(), project()));

    const reopened = new RelayDoc({
      storage,
      legacySnapshot: () => ({ projectName: "ignored" }),
      onMigrated: () => (migrated += 1),
    });
    assert.equal(migrated, 1);
    assert.ok(deepEqual(reopened.materialize(), project()));
  });

  it("applies, persists and announces a client update", () => {
    const storage = memoryStorage();
    const seen: string[] = [];
    const relay = new RelayDoc({ storage, onUpdate: (_u, origin) => seen.push(origin) });
    const client = new ProjectDoc();
    for (const frame of clientWrite(client, project())) {
      assert.deepEqual(relay.receive("alice", frame, editor), { status: "applied" });
    }
    assert.deepEqual(seen, ["alice"]);
    assert.equal(storage.log.length, 1);
    assert.ok(deepEqual(relay.materialize(), project()));
    assert.ok(relay.byteSize > 0);
  });

  it("answers a state vector with only the missing updates", () => {
    const relay = new RelayDoc({ storage: memoryStorage() });
    relay.writeSnapshot(project(), "host");
    const client = new ProjectDoc();
    const everything = relay.framesFor("", () => "id")!;
    for (const frame of everything) {
      Y.applyUpdate(client.doc, Buffer.from(frame.update, "base64"));
    }
    assert.ok(deepEqual(client.read(), project()));
    const vector = encodeBase64(Y.encodeStateVector(client.doc));
    const nothing = relay.framesFor(vector, () => "id")!;
    assert.equal(Buffer.from(nothing[0].update, "base64").length, 2, "an empty update");
    assert.equal(
      relay.framesFor("not base64!", () => "id"),
      null,
    );
  });

  it("refuses view-only senders, oversized documents and unreadable updates", () => {
    const relay = new RelayDoc({ storage: memoryStorage(), maxDocBytes: 1_000 });
    const client = new ProjectDoc();
    const [frame] = clientWrite(client, project());
    assert.equal(
      (relay.receive("v", frame, { ...editor, canEdit: false }) as { code: string }).code,
      "forbidden",
    );
    const big = clientWrite(client, { ...project(), projectName: "x".repeat(5_000) });
    assert.equal((relay.receive("e", big[0], editor) as { code: string }).code, "too-large");
    assert.equal(
      (
        relay.receive("e", { update: encodeBase64(new Uint8Array([9, 9, 9])) }, editor) as {
          code: string;
        }
      ).code,
      "resync",
    );
  });

  it("reverts a guest update that touches a locked layer, but not the host's", () => {
    const storage = memoryStorage();
    const relay = new RelayDoc({ storage });
    relay.writeSnapshot(project(), "host");
    const guest = new ProjectDoc();
    for (const frame of relay.framesFor("", () => "id")!) {
      Y.applyUpdate(guest.doc, Buffer.from(frame.update, "base64"));
    }
    const locked = { canEdit: true, isHost: false, lockedLayerIds: ["a"] };
    const renamed = {
      ...guest.read(),
      layers: [
        { id: "a", name: "Hijacked" },
        { id: "b", name: "B" },
      ],
    };
    const [frame] = clientWrite(guest, renamed);
    assert.deepEqual(relay.receive("guest", frame, locked), { status: "reverted", layerName: "A" });
    assert.equal((relay.materialize().layers as { name: string }[])[0].name, "A");

    const unlocked = clientWrite(guest, {
      ...guest.read(),
      layers: [
        { id: "a", name: "Hijacked" },
        { id: "b", name: "B2" },
      ],
    });
    // Only the unlocked layer changed in this update, so it goes through, and
    // the earlier refused rename stays refused.
    assert.equal(relay.receive("guest", unlocked[0], locked).status, "applied");
    assert.deepEqual(
      (relay.materialize().layers as { name: string }[]).map((l) => l.name),
      ["A", "B2"],
    );

    const host = new ProjectDoc();
    Y.applyUpdate(host.doc, Y.encodeStateAsUpdate(relay.project.doc));
    const [hostFrame] = clientWrite(host, {
      ...host.read(),
      layers: [
        { id: "a", name: "Host rename" },
        { id: "b", name: "B" },
      ],
    });
    assert.equal(relay.receive("host", hostFrame, { ...locked, isHost: true }).status, "applied");
    assert.equal((relay.materialize().layers as { name: string }[])[0].name, "Host rename");
  });

  it("drops updates whose dependencies never arrived and asks for a resync", () => {
    const relay = new RelayDoc({ storage: memoryStorage() });
    const client = new ProjectDoc();
    clientWrite(client, project());
    // Only the second edit, without the first it builds on.
    const [second] = clientWrite(client, { ...client.read(), projectName: "Later" });
    assert.equal((relay.receive("c", second, editor) as { code: string }).code, "resync");
    const store = relay.project.doc.store as unknown as { pendingStructs: unknown };
    assert.equal(store.pendingStructs, null);
    assert.equal(relay.byteSize, 0);
  });

  it("loads past a corrupt stored row instead of locking the session", () => {
    const storage = memoryStorage();
    const first = new RelayDoc({ storage });
    first.writeSnapshot(project(), "host");
    storage.log.push(new Uint8Array([255, 1, 2, 3]));
    const warn = console.warn;
    console.warn = () => {};
    try {
      const reopened = new RelayDoc({ storage });
      assert.ok(deepEqual(reopened.materialize(), project()));
    } finally {
      console.warn = warn;
    }
  });

  it("accepts comments in the seed of an empty session", () => {
    const relay = new RelayDoc({ storage: memoryStorage() });
    const client = new ProjectDoc();
    const [frame] = clientWrite(client, { ...project(), comments: [{ id: "seeded" }] });
    // A guest writing first may not plant comments...
    const guestRelay = new RelayDoc({ storage: memoryStorage() });
    guestRelay.receive("guest", frame, editor);
    assert.equal(guestRelay.project.fields.get("comments"), undefined);
    // ...but the host's seed carries them.
    relay.receive("host", frame, { ...editor, isHost: true });
    assert.deepEqual(relay.project.fields.get("comments"), [{ id: "seeded" }]);
  });

  it("undoes a client update to the relay-owned comment list", () => {
    const relay = new RelayDoc({ storage: memoryStorage() });
    relay.setField("comments", [{ id: "c1" }]);
    const client = new ProjectDoc();
    Y.applyUpdate(client.doc, Y.encodeStateAsUpdate(relay.project.doc));
    const updates: Uint8Array[] = [];
    client.doc.on("update", (u: Uint8Array) => updates.push(u));
    client.doc.transact(() => client.fields.set("comments", [{ id: "forged" }]));
    const [frame] = splitUpdate(updates[0], () => "id");
    relay.receive("c", frame, editor);
    assert.deepEqual(relay.project.fields.get("comments"), [{ id: "c1" }]);
  });

  it("compacts the log into a base state once it grows", () => {
    const storage = memoryStorage();
    const relay = new RelayDoc({ storage });
    for (let i = 0; i < DOC_COMPACT_LOG_ENTRIES + 5; i += 1) {
      relay.setField("projectName", `Rev ${i}`);
    }
    assert.ok(storage.base);
    assert.ok(storage.log.length < DOC_COMPACT_LOG_ENTRIES);
    const reopened = new RelayDoc({ storage });
    assert.equal(reopened.materialize().projectName, `Rev ${DOC_COMPACT_LOG_ENTRIES + 4}`);
  });
});
