import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Feature } from "geojson";
import type { TFunction } from "i18next";
import {
  diffConflictVersions,
  formatAttributeValue,
} from "../apps/geolibre-desktop/src/lib/edit-sync/conflict-diff";
import {
  EditSyncOfflineError,
  EditSyncRejectedError,
  type EditSyncAdapter,
  type OutboxEntry,
  type OutboxOp,
  type SyncOutcome,
} from "../apps/geolibre-desktop/src/lib/edit-sync/edit-outbox";
import {
  editSessionToken,
  discardOutboxEntry,
  enqueueChangeSet,
  flushDueOutboxEntries,
  isOutboxEntrySyncing,
  registerEditSyncBackend,
  resetEditSyncBackends,
  startEditOutboxRunner,
  syncOutboxEntryNow,
  type EnqueueInput,
} from "../apps/geolibre-desktop/src/lib/edit-sync/edit-outbox-runner";
import {
  getOutboxEntry,
  getOutboxSnapshot,
  indexedDbOutboxPersistence,
  isOutboxEntry,
  loadOutbox,
  memoryOutboxPersistence,
  putOutboxEntry,
  reloadOutboxEntry,
  setOutboxPersistence,
  subscribeOutbox,
  type OutboxPersistence,
} from "../apps/geolibre-desktop/src/lib/edit-sync/edit-outbox-store";
import {
  describeSyncOutcome,
  saveThroughOutbox,
} from "../apps/geolibre-desktop/src/lib/edit-sync/outbox-save";

const t = ((key: string, values?: Record<string, unknown>) =>
  values ? `${key} ${JSON.stringify(values)}` : key) as unknown as TFunction;

function feature(x: number, props: Record<string, unknown> = {}): Feature {
  return { type: "Feature", geometry: { type: "Point", coordinates: [x, 0] }, properties: props };
}

function updateOp(id: string, key: string): OutboxOp {
  return {
    id,
    kind: "update",
    key,
    feature: feature(1),
    baseFingerprint: "base",
    mineFingerprint: "mine",
  };
}

function input(ops: OutboxOp[], id = "postgis:t"): EnqueueInput {
  return {
    id,
    backend: "postgis",
    target: { table: "t" },
    targetLabel: "public.t",
    layerId: "layer-1",
    layerName: "T",
    ops,
  };
}

/** A persistence that records operations, to prove entries reach storage. */
function recordingPersistence(initial: OutboxEntry[] = []) {
  const inner = memoryOutboxPersistence(initial);
  const log: string[] = [];
  const persistence: OutboxPersistence = {
    load: () => inner.load(),
    put: async (entry) => {
      log.push(`put:${entry.id}:${entry.status}`);
      await inner.put(entry);
    },
    remove: async (id) => {
      log.push(`remove:${id}`);
      await inner.remove(id);
    },
  };
  return { persistence, inner, log };
}

describe("edit outbox store", () => {
  afterEach(() => setOutboxPersistence(null));

  it("loads persisted entries once and resets a crashed sync to pending", async () => {
    const stored = { ...(await enqueueShape()), status: "syncing" as const };
    setOutboxPersistence(memoryOutboxPersistence([stored]));
    let notified = 0;
    const unsubscribe = subscribeOutbox(() => (notified += 1));
    await loadOutbox();
    await loadOutbox();
    unsubscribe();
    assert.equal(getOutboxSnapshot().loaded, true);
    assert.equal(getOutboxEntry(stored.id)!.status, "pending");
    assert.equal(notified, 1);
  });

  it("trusts memory after a failed write and clears the warning once storage recovers", async () => {
    let failWrites = true;
    const inner = memoryOutboxPersistence();
    setOutboxPersistence({
      load: () => inner.load(),
      get: () => inner.get!("x"),
      put: async (entry) => {
        if (failWrites) throw new Error("QuotaExceededError");
        await inner.put(entry);
      },
      remove: (id) => inner.remove(id),
    });
    await loadOutbox();
    const entry = await enqueueShape();
    await putOutboxEntry(entry);
    assert.equal(getOutboxSnapshot().writeError, "QuotaExceededError");
    // Storage lacks the entry, but the sync must still see it.
    assert.equal((await reloadOutboxEntry(entry.id))!.id, entry.id);
    failWrites = false;
    await putOutboxEntry({ ...entry, attempts: 1 });
    assert.equal(getOutboxSnapshot().writeError, undefined);
    assert.equal(getOutboxSnapshot().durable, true);
  });

  it("falls back to memory and reports it when storage refuses", async () => {
    setOutboxPersistence({
      load: async () => {
        throw new Error("QuotaExceededError");
      },
      put: async () => {},
      remove: async () => {},
    });
    await loadOutbox();
    const snapshot = getOutboxSnapshot();
    assert.equal(snapshot.durable, false);
    assert.equal(snapshot.storageError, "QuotaExceededError");
    await putOutboxEntry(await enqueueShape());
    assert.equal(getOutboxSnapshot().entries.length, 1);
  });

  it("re-reads an entry another tab synced or changed", async () => {
    const shared = memoryOutboxPersistence();
    setOutboxPersistence(shared);
    const entry = await enqueueShape();
    await putOutboxEntry(entry);
    // Another tab updates, then removes, the stored entry.
    await shared.put({ ...entry, attempts: 7 });
    assert.equal((await reloadOutboxEntry(entry.id))!.attempts, 7);
    assert.equal(getOutboxEntry(entry.id)!.attempts, 7);
    await shared.remove(entry.id);
    assert.equal(await reloadOutboxEntry(entry.id), undefined);
    assert.equal(getOutboxEntry(entry.id), undefined);
  });

  it("validates rows read back from storage", () => {
    assert.equal(isOutboxEntry(null), false);
    assert.equal(isOutboxEntry({ id: "x", backend: "postgis", layerId: "l", ops: [] }), false);
    assert.equal(
      isOutboxEntry({ id: "x", backend: "postgis", layerId: "l", ops: [], target: {} }),
      true,
    );
  });
});

async function enqueueShape(): Promise<OutboxEntry> {
  return {
    ...input([updateOp("a", "1")]),
    status: "pending",
    conflicts: [],
    attempts: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("indexedDbOutboxPersistence", () => {
  it("round-trips entries through an IndexedDB object store", async () => {
    const persistence = indexedDbOutboxPersistence(fakeIndexedDb());
    const entry = await enqueueShape();
    await persistence.put(entry);
    await persistence.put({ ...entry, id: "other" });
    assert.deepEqual((await persistence.load()).map((e) => e.id).sort(), ["other", "postgis:t"]);
    await persistence.remove("other");
    assert.deepEqual(
      (await persistence.load()).map((e) => e.id),
      ["postgis:t"],
    );
  });
});

describe("edit outbox runner", () => {
  let rec: ReturnType<typeof recordingPersistence>;
  beforeEach(() => {
    rec = recordingPersistence();
    setOutboxPersistence(rec.persistence);
    resetEditSyncBackends();
  });
  afterEach(() => {
    setOutboxPersistence(null);
    resetEditSyncBackends();
  });

  it("queues, merges a newer change set, and keeps the queue on an empty one", async () => {
    const first = await enqueueChangeSet(input([updateOp("a", "1")]), () => 10);
    assert.equal(first.kind, "queued");
    const second = await enqueueChangeSet(input([updateOp("b", "2")]), () => 20);
    assert.equal(second.kind, "queued");
    const entry = getOutboxEntry("postgis:t")!;
    // The newer change set adds feature 2; the queued edit to feature 1 is kept.
    assert.deepEqual(
      entry.ops.map((op) => op.key),
      ["2", "1"],
    );
    assert.equal(entry.createdAt, 10);
    assert.equal(entry.updatedAt, 20);
    // An empty diff (say, the layer was reloaded without the queued edits)
    // must not discard edits that never reached the source.
    assert.equal((await enqueueChangeSet(input([]))).kind, "empty");
    assert.deepEqual(
      getOutboxEntry("postgis:t")!.ops.map((op) => op.key),
      ["2", "1"],
    );
    assert.ok(!rec.log.includes("remove:postgis:t"));
  });

  it("drops edits undone in the same layer load, keeps them across loads", async () => {
    const session = editSessionToken("layer-1", 3);
    await enqueueChangeSet({ ...input([updateOp("a", "1"), updateOp("b", "2")]), session });
    // Same load: feature 1 was reverted, so only feature 2 is still edited.
    await enqueueChangeSet({ ...input([updateOp("c", "2")]), session });
    assert.deepEqual(
      getOutboxEntry("postgis:t")!.ops.map((op) => op.key),
      ["2"],
    );
    // Same load, everything undone: the entry goes.
    await enqueueChangeSet({ ...input([]), session });
    assert.equal(getOutboxEntry("postgis:t"), undefined);

    await enqueueChangeSet({ ...input([updateOp("d", "1")]), session });
    // A later load (new project generation) lacks the queued edit to feature 1.
    const later = editSessionToken("layer-1", 4);
    assert.notEqual(later, session);
    await enqueueChangeSet({ ...input([updateOp("e", "2")]), session: later });
    assert.deepEqual(
      getOutboxEntry("postgis:t")!.ops.map((op) => op.key),
      ["2", "1"],
    );
  });

  it("syncs through the registered backend, persists progress, and runs afterSync", async () => {
    const synced: SyncOutcome[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const adapter: EditSyncAdapter = {
      fetchRemote: async (_e, keys) => {
        await gate;
        return { byKey: new Map(keys.map((k) => [k, feature(0)])) };
      },
      apply: async (_e, plan) => ({
        applied: [...plan.updates].map((op) => op.id),
        failed: [],
      }),
      fingerprint: () => "base",
    };
    registerEditSyncBackend("postgis", {
      createAdapter: () => adapter,
      afterSync: (_entry, outcome) => {
        synced.push(outcome);
      },
    });
    await enqueueChangeSet(input([updateOp("a", "1")]));
    const running = syncOutboxEntryNow("postgis:t");
    // Single flight: a second request joins the first, and enqueue is refused.
    assert.equal(syncOutboxEntryNow("postgis:t"), running);
    assert.ok(isOutboxEntrySyncing("postgis:t"));
    assert.equal((await enqueueChangeSet(input([updateOp("c", "3")]))).kind, "busy");
    release();
    const outcome = await running;
    assert.equal(outcome!.kind, "synced");
    assert.equal(outcome!.updated, 1);
    assert.equal(getOutboxEntry("postgis:t"), undefined);
    assert.equal(synced.length, 1);
    assert.ok(rec.log.includes("put:postgis:t:syncing"));
    assert.equal(rec.log.at(-1), "remove:postgis:t");
  });

  it("records a missing credential as an error the user must act on", async () => {
    registerEditSyncBackend("postgis", {
      createAdapter: () => {
        throw new EditSyncRejectedError("No PostgreSQL connection", "postgisNoConnection");
      },
    });
    await enqueueChangeSet(input([updateOp("a", "1")]));
    const outcome = await syncOutboxEntryNow("postgis:t");
    assert.equal(outcome!.kind, "error");
    assert.equal(getOutboxEntry("postgis:t")!.status, "error");
    assert.equal(getOutboxEntry("postgis:t")!.lastErrorCode, "postgisNoConnection");
    assert.equal(await syncOutboxEntryNow("missing"), null);
  });

  it("flushes only due, pending entries while online", async () => {
    const attempts: string[] = [];
    registerEditSyncBackend("postgis", {
      createAdapter: (entry) => ({
        fetchRemote: async () => {
          attempts.push(entry.id);
          throw new EditSyncOfflineError("down");
        },
        apply: async () => ({ applied: [], failed: [] }),
      }),
    });
    await enqueueChangeSet(input([updateOp("a", "1")], "due"));
    await enqueueChangeSet(input([updateOp("b", "1")], "later"));
    await putOutboxEntry({ ...getOutboxEntry("later")!, nextAttemptAt: 10_000 });
    await enqueueChangeSet(input([updateOp("c", "1")], "review"));
    await putOutboxEntry({ ...getOutboxEntry("review")!, status: "conflict" });

    await flushDueOutboxEntries(() => 5_000);
    assert.deepEqual(attempts, ["due"]);
    const due = getOutboxEntry("due")!;
    assert.equal(due.attempts, 1);
    assert.ok(due.nextAttemptAt! > Date.now() - 1);

    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: false },
      configurable: true,
    });
    try {
      assert.deepEqual(await flushDueOutboxEntries(() => 1e12), []);
    } finally {
      if (original) Object.defineProperty(globalThis, "navigator", original);
      else delete (globalThis as { navigator?: unknown }).navigator;
    }
  });

  it("records conflict decisions on the stored entry and discards after a sync", async () => {
    const seen: OutboxEntry[] = [];
    registerEditSyncBackend("postgis", {
      createAdapter: (entry) => {
        seen.push(entry);
        return {
          fetchRemote: async () => {
            throw new EditSyncOfflineError("down");
          },
          apply: async () => ({ applied: [], failed: [] }),
        };
      },
    });
    await enqueueChangeSet(input([updateOp("a", "1")]));
    await syncOutboxEntryNow("postgis:t", new Map([["a", "skip" as const]]));
    assert.equal(seen[0].ops[0].resolution, "skip");
    await discardOutboxEntry("postgis:t");
    assert.equal(getOutboxEntry("postgis:t"), undefined);
  });

  it("starts once and stops cleanly", () => {
    const stop = startEditOutboxRunner(60_000);
    assert.equal(startEditOutboxRunner(60_000), stop);
    stop();
  });
});

describe("saveThroughOutbox", () => {
  it("maps each outcome to a save result", async () => {
    const base = {
      entry: null,
      inserted: 1,
      updated: 2,
      deleted: 3,
      alreadyApplied: 0,
      keptTheirs: 0,
      insertedKeys: new Map(),
      touchedKeys: [],
    };
    const queued = (kind: SyncOutcome["kind"], extra: Partial<SyncOutcome> = {}) =>
      saveThroughOutbox(input([updateOp("a", "1")]), t, {
        enqueue: async () => ({ kind: "queued", entry: {} as OutboxEntry }),
        syncNow: async () => ({ ...base, kind, ...extra }),
      });
    assert.equal((await queued("synced")).status, "success");
    const conflict = await queued("conflict", {
      entry: { conflicts: [{}, {}] } as unknown as OutboxEntry,
    });
    assert.equal(conflict.status, "warning");
    assert.match(conflict.message, /editOutbox.save.conflicts \{"count":2\}/);
    const offline = await queued("offline", {
      entry: { ops: [updateOp("a", "1")] } as unknown as OutboxEntry,
      error: "down",
    });
    assert.equal(offline.status, "warning");
    assert.match(offline.message, /"count":1/);
    assert.equal((await queued("error", { error: "nope" })).status, "error");

    const busy = await saveThroughOutbox(input([]), t, {
      enqueue: async () => ({ kind: "busy" }),
    });
    assert.equal(busy.status, "error");
    const empty = await saveThroughOutbox(input([]), t, {
      enqueue: async () => ({ kind: "empty" }),
    });
    assert.equal(empty.status, "success");
    assert.equal(describeSyncOutcome(null, "x", t).status, "error");
  });
});

describe("conflict diff", () => {
  it("lists differing attributes and geometry, treating null as absent", () => {
    const diff = diffConflictVersions(
      feature(1, { a: 1, b: null, c: "same", __gm_x: 1 }),
      feature(2, { a: 2, c: "same", d: [1] }),
    );
    assert.equal(diff.geometryDiffers, true);
    assert.deepEqual(
      diff.attributes.map((a) => a.name),
      ["a", "d"],
    );
    assert.deepEqual(diffConflictVersions(undefined, null), {
      geometryDiffers: false,
      attributes: [],
    });
    assert.equal(formatAttributeValue(null), "");
    assert.equal(formatAttributeValue("x"), "x");
    assert.equal(formatAttributeValue({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.equal(formatAttributeValue({ k: "z".repeat(200) }).length, 120);
  });
});

/** Minimal in-memory IndexedDB: one database, object stores keyed by keyPath. */
function fakeIndexedDb(): IDBFactory {
  const stores = new Map<string, Map<string, unknown>>();
  const later = (fn: () => void) => setTimeout(fn, 0);
  const db = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string) => {
      stores.set(name, new Map());
    },
    close: () => {},
    transaction: (name: string) => {
      const store = stores.get(name)!;
      const tx: Record<string, unknown> = {};
      const request = (result: () => unknown) => {
        const req: Record<string, unknown> = {};
        later(() => {
          req.result = result();
          (req.onsuccess as (() => void) | undefined)?.();
          later(() => (tx.oncomplete as () => void)());
        });
        return req;
      };
      tx.objectStore = () => ({
        getAll: () => request(() => [...store.values()].map((v) => structuredClone(v))),
        put: (value: { id: string }) => request(() => store.set(value.id, structuredClone(value))),
        delete: (id: string) => request(() => store.delete(id)),
      });
      return tx;
    },
  };
  let upgraded = false;
  return {
    open: () => {
      const req: Record<string, unknown> = { result: db };
      later(() => {
        if (!upgraded) {
          upgraded = true;
          (req.onupgradeneeded as () => void)();
        }
        (req.onsuccess as () => void)();
      });
      return req;
    },
  } as unknown as IDBFactory;
}
