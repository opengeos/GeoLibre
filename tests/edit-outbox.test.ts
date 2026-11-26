import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature } from "geojson";
import {
  applyConflictResolutions,
  buildChangeSet,
  countOps,
  EditSyncConflictRaceError,
  EditSyncOfflineError,
  EditSyncRejectedError,
  EditSyncUncertainError,
  mergeChangeSet,
  retryDelayMs,
  syncOutboxEntry,
  type ApplyPlan,
  type EditSyncAdapter,
  type OutboxEntry,
  type OutboxOp,
} from "../apps/geolibre-desktop/src/lib/edit-sync/edit-outbox";
import {
  canonicalJson,
  captureFingerprintBaseline,
  featureFingerprint,
  featureIdKey,
  readFingerprintBaseline,
} from "../apps/geolibre-desktop/src/lib/edit-sync/feature-fingerprint";

function point(id: string | number | undefined, x: number, props: Record<string, unknown> = {}) {
  return {
    type: "Feature",
    ...(id === undefined ? {} : { id }),
    geometry: { type: "Point", coordinates: [x, 0] },
    properties: props,
  } as Feature;
}

/**
 * An in-memory feature server keyed by string id, standing in for a remote
 * source. Applies plans the way a real backend would and records every call.
 */
class FakeServer implements EditSyncAdapter {
  rows = new Map<string, Feature>();
  nextKey = 100;
  calls: string[] = [];
  failFetch: Error | null = null;
  failApply: Error[] = [];
  rejectOps = new Map<string, string>();
  /** Mutate the server between the read and the write (simulates a race). */
  beforeApply: (() => void) | null = null;

  fetchRemote = async (_entry: OutboxEntry, keys: string[], maybeApplied: OutboxOp[]) => {
    this.calls.push(`fetch:${keys.join(",")}`);
    if (this.failFetch) throw this.failFetch;
    const byKey = new Map<string, Feature | null>();
    for (const key of keys) byKey.set(key, this.rows.get(key) ?? null);
    const insertMatches = new Map<string, string>();
    for (const op of maybeApplied) {
      for (const [key, row] of this.rows) {
        if (featureFingerprint(row) === op.mineFingerprint) insertMatches.set(op.id, key);
      }
    }
    return { byKey, insertMatches };
  };

  apply = async (_entry: OutboxEntry, plan: ApplyPlan) => {
    this.calls.push(`apply:i${plan.inserts.length}u${plan.updates.length}d${plan.deletes.length}`);
    this.beforeApply?.();
    this.beforeApply = null;
    const next = this.failApply.shift();
    if (next) throw next;
    // Optimistic check: every touched row must still be what the plan read.
    for (const op of [...plan.updates, ...plan.deletes]) {
      const read = plan.remote.byKey.get(op.key!) ?? null;
      const now = this.rows.get(op.key!) ?? null;
      if (canonicalJson(read) !== canonicalJson(now)) throw new EditSyncConflictRaceError("race");
    }
    const applied: string[] = [];
    const failed: Array<{ opId: string; message: string }> = [];
    const insertedKeys = new Map<string, string>();
    for (const op of [...plan.inserts, ...plan.updates, ...plan.deletes]) {
      const rejection = this.rejectOps.get(op.id);
      if (rejection) {
        failed.push({ opId: op.id, message: rejection });
        continue;
      }
      if (op.kind === "insert") {
        const key = op.key ?? String(this.nextKey++);
        this.rows.set(key, { ...op.feature!, id: key });
        insertedKeys.set(op.id, key);
      } else if (op.kind === "update") {
        this.rows.set(op.key!, { ...op.feature!, id: op.key! });
      } else {
        this.rows.delete(op.key!);
      }
      applied.push(op.id);
    }
    return { applied, failed, insertedKeys };
  };
}

let idCounter = 0;
const newId = () => `op${idCounter++}`;

function entryFor(ops: OutboxOp[], overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id: "postgis:t",
    backend: "postgis",
    target: {},
    targetLabel: "public.t",
    layerId: "layer-1",
    layerName: "T",
    ops,
    status: "pending",
    conflicts: [],
    attempts: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** Load features into the server and return their base fingerprints. */
function seed(server: FakeServer, features: Feature[]): Map<string, string> {
  for (const f of features) server.rows.set(String(f.id), structuredClone(f));
  return readFingerprintBaseline(captureFingerprintBaseline(features))!;
}

describe("feature fingerprints", () => {
  it("ignores key order, null attributes, editor-internal keys, and the id", () => {
    const a = point(1, 5, { b: 2, a: 1, empty: null });
    const b = point(2, 5, { a: 1, b: 2, __gm_shape: "x", __geolibre_fid: "f1" });
    assert.equal(featureFingerprint(a), featureFingerprint(b));
    assert.notEqual(featureFingerprint(a), featureFingerprint(point(1, 6, { a: 1, b: 2 })));
    assert.notEqual(featureFingerprint(a), featureFingerprint(point(1, 5, { a: 1, b: 3 })));
  });

  it("can leave a key column out so an insert matches its stored row", () => {
    const local = point(undefined, 1, { name: "x" });
    const stored = point(7, 1, { name: "x", gid: 7 });
    assert.equal(
      featureFingerprint(local, { omitProperties: ["gid"] }),
      featureFingerprint(stored, { omitProperties: ["gid"] }),
    );
  });

  it("keeps prototype-like keys as data", () => {
    const baseline = captureFingerprintBaseline([point("__proto__", 1), point("constructor", 2)]);
    const map = readFingerprintBaseline(JSON.parse(JSON.stringify(baseline)))!;
    assert.deepEqual([...map.keys()].sort(), ["__proto__", "constructor"]);
    assert.equal(readFingerprintBaseline([]), undefined);
    assert.equal(featureIdKey({ id: "" }), null);
    assert.equal(featureIdKey({ id: Number.NaN }), null);
  });
});

describe("buildChangeSet", () => {
  it("diffs edits, inserts, duplicates, and deletes against the base", () => {
    const loaded = [point(1, 1, { n: "a" }), point(2, 2, { n: "b" }), point(3, 3, { n: "c" })];
    const baseline = readFingerprintBaseline(captureFingerprintBaseline(loaded))!;
    const current = [
      point(1, 1, { n: "a" }), // unchanged
      point(2, 9, { n: "b" }), // moved
      point(2, 9, { n: "b" }), // copied: becomes a keyless insert
      point(undefined, 4, { n: "new" }), // drawn
    ];
    const ops = buildChangeSet({ baseline, features: current, keyOf: featureIdKey, newId });
    assert.deepEqual(
      ops.map((op) => [op.kind, op.key]),
      [
        ["update", "2"],
        ["insert", null],
        ["insert", null],
        ["delete", "3"],
      ],
    );
    assert.equal(ops[1].feature!.id, undefined);
    assert.equal(ops[0].rawKey, 2);
    assert.deepEqual(countOps(ops), { insert: 2, update: 1, delete: 1 });
  });

  it("returns nothing for an unedited layer", () => {
    const loaded = [point(1, 1), point(2, 2)];
    const baseline = readFingerprintBaseline(captureFingerprintBaseline(loaded))!;
    assert.deepEqual(buildChangeSet({ baseline, features: loaded, keyOf: featureIdKey }), []);
  });
});

describe("syncOutboxEntry", () => {
  it("applies non-conflicting edits and drops the entry", async () => {
    const server = new FakeServer();
    const baseline = seed(server, [point(1, 1), point(2, 2), point(3, 3)]);
    const ops = buildChangeSet({
      baseline,
      features: [point(1, 10), point(2, 2), point(undefined, 4)],
      keyOf: featureIdKey,
      newId,
    });
    const outcome = await syncOutboxEntry(entryFor(ops), server);
    assert.equal(outcome.kind, "synced");
    assert.equal(outcome.entry, null);
    assert.deepEqual([outcome.inserted, outcome.updated, outcome.deleted], [1, 1, 1]);
    assert.deepEqual([...server.rows.keys()].sort(), ["1", "100", "2"]);
    assert.equal((server.rows.get("1")!.geometry as { coordinates: number[] }).coordinates[0], 10);
    assert.deepEqual(outcome.touchedKeys.sort(), ["1", "100", "3"]);
  });

  it("is idempotent: a retry after the edits already landed writes nothing", async () => {
    const server = new FakeServer();
    const baseline = seed(server, [point(1, 1), point(2, 2)]);
    const ops = buildChangeSet({
      baseline,
      features: [point(1, 10)],
      keyOf: featureIdKey,
      newId,
    });
    server.rows.set("1", point(1, 10));
    server.rows.delete("2");
    const outcome = await syncOutboxEntry(entryFor(ops), server);
    assert.equal(outcome.kind, "synced");
    assert.equal(outcome.alreadyApplied, 2);
    assert.ok(server.calls.every((call) => !call.startsWith("apply")));
  });

  it("holds both-sides edits as conflicts while applying the rest", async () => {
    const server = new FakeServer();
    const baseline = seed(server, [point(1, 1), point(2, 2), point(3, 3)]);
    const ops = buildChangeSet({
      baseline,
      features: [point(1, 10), point(2, 20)],
      keyOf: featureIdKey,
      newId,
    });
    server.rows.set("1", point(1, 99, { by: "them" })); // edited remotely
    server.rows.set("3", point(3, 33)); // edited remotely, deleted locally
    const outcome = await syncOutboxEntry(entryFor(ops), server);
    assert.equal(outcome.kind, "conflict");
    assert.equal(outcome.updated, 1); // feature 2 still went through
    const entry = outcome.entry!;
    assert.equal(entry.status, "conflict");
    assert.deepEqual(entry.conflicts.map((c) => [c.key, c.reason]).sort(), [
      ["1", "remoteChanged"],
      ["3", "remoteChanged"],
    ]);
    assert.equal(entry.conflicts.find((c) => c.key === "1")!.theirs!.properties!.by, "them");
    assert.equal(entry.ops.length, 2);
  });

  it("reports a feature deleted on the server as a conflict, and re-creates it on keep mine", async () => {
    const server = new FakeServer();
    const baseline = seed(server, [point(1, 1)]);
    const ops = buildChangeSet({ baseline, features: [point(1, 5)], keyOf: featureIdKey, newId });
    server.rows.delete("1");
    const first = await syncOutboxEntry(entryFor(ops), server);
    assert.equal(first.entry!.conflicts[0].reason, "remoteDeleted");
    assert.equal(first.entry!.conflicts[0].theirs, null);
    const resolved = applyConflictResolutions(
      first.entry!,
      new Map([[first.entry!.ops[0].id, "mine" as const]]),
    );
    const second = await syncOutboxEntry(resolved, server);
    assert.equal(second.kind, "synced");
    assert.equal(second.inserted, 1);
    assert.equal(server.rows.size, 1);
  });

  it("honours keep mine, keep theirs, and skip", async () => {
    const server = new FakeServer();
    const baseline = seed(server, [point(1, 1), point(2, 2), point(3, 3)]);
    const ops = buildChangeSet({
      baseline,
      features: [point(1, 10), point(2, 20), point(3, 30)],
      keyOf: featureIdKey,
      newId,
    });
    for (const key of ["1", "2", "3"]) server.rows.set(key, point(Number(key), 77));
    const conflicted = (await syncOutboxEntry(entryFor(ops), server)).entry!;
    const byKey = new Map(conflicted.ops.map((op) => [op.key, op.id]));
    const resolved = applyConflictResolutions(
      conflicted,
      new Map([
        [byKey.get("1")!, "mine" as const],
        [byKey.get("2")!, "theirs" as const],
        [byKey.get("3")!, "skip" as const],
      ]),
    );
    const outcome = await syncOutboxEntry(resolved, server);
    assert.equal(outcome.kind, "conflict");
    assert.equal(outcome.updated, 1);
    assert.equal(outcome.keptTheirs, 1);
    assert.equal((server.rows.get("1")!.geometry as { coordinates: number[] }).coordinates[0], 10);
    assert.equal((server.rows.get("2")!.geometry as { coordinates: number[] }).coordinates[0], 77);
    // The skipped op stays queued with its earlier conflict snapshot.
    assert.deepEqual(
      outcome.entry!.ops.map((op) => [op.key, op.resolution]),
      [["3", "skip"]],
    );
    assert.deepEqual(
      outcome.entry!.conflicts.map((c) => c.key),
      ["3"],
    );
    // A pass with only deferred ops reads nothing.
    server.calls = [];
    const idle = await syncOutboxEntry(outcome.entry!, server);
    assert.equal(idle.kind, "conflict");
    assert.deepEqual(server.calls, []);
  });

  it("re-reads after a read/write race instead of overwriting", async () => {
    const server = new FakeServer();
    const baseline = seed(server, [point(1, 1)]);
    const ops = buildChangeSet({ baseline, features: [point(1, 5)], keyOf: featureIdKey, newId });
    server.beforeApply = () => server.rows.set("1", point(1, 66));
    const outcome = await syncOutboxEntry(entryFor(ops), server);
    assert.equal(outcome.kind, "conflict");
    assert.deepEqual(server.calls, ["fetch:1", "apply:i0u1d0", "fetch:1"]);
    assert.equal((server.rows.get("1")!.geometry as { coordinates: number[] }).coordinates[0], 66);
  });

  it("keeps the entry with backoff when the source is offline", async () => {
    const server = new FakeServer();
    const baseline = seed(server, [point(1, 1)]);
    const ops = buildChangeSet({ baseline, features: [point(1, 5)], keyOf: featureIdKey, newId });
    server.failFetch = new EditSyncOfflineError("no route to host");
    const outcome = await syncOutboxEntry(entryFor(ops, { attempts: 2 }), server, {
      now: () => 1_000,
    });
    assert.equal(outcome.kind, "offline");
    assert.equal(outcome.entry!.status, "pending");
    assert.equal(outcome.entry!.attempts, 3);
    assert.equal(outcome.entry!.nextAttemptAt, 1_000 + retryDelayMs(3));
    assert.equal(outcome.entry!.lastError, "no route to host");
  });

  it("deduplicates an insert whose earlier response was lost", async () => {
    const server = new FakeServer();
    const baseline = seed(server, []);
    const ops = buildChangeSet({
      baseline,
      features: [point(undefined, 4, { n: "new" })],
      keyOf: featureIdKey,
      newId,
    });
    // The write lands, but the client never hears back.
    server.beforeApply = () => server.rows.set("500", point(500, 4, { n: "new" }));
    server.failApply.push(new EditSyncUncertainError("connection reset"));
    const lost = await syncOutboxEntry(entryFor(ops), server);
    assert.equal(lost.kind, "offline");
    assert.equal(lost.entry!.ops[0].maybeApplied, true);
    const retry = await syncOutboxEntry(lost.entry!, server);
    assert.equal(retry.kind, "synced");
    assert.equal(retry.alreadyApplied, 1);
    assert.equal(server.rows.size, 1);
  });

  it("records per-feature rejections and a hard rejection as errors", async () => {
    const server = new FakeServer();
    const baseline = seed(server, [point(1, 1), point(2, 2)]);
    const ops = buildChangeSet({
      baseline,
      features: [point(1, 5), point(2, 6)],
      keyOf: featureIdKey,
      newId,
    });
    server.rejectOps.set(ops[1].id, "value out of range");
    const partial = await syncOutboxEntry(entryFor(ops), server);
    assert.equal(partial.kind, "error");
    assert.equal(partial.updated, 1);
    assert.equal(partial.entry!.ops.length, 1);
    assert.equal(partial.entry!.ops[0].error, "value out of range");
    assert.equal(partial.entry!.status, "error");

    server.failApply.push(new EditSyncRejectedError("permission denied"));
    server.rejectOps.clear();
    const hard = await syncOutboxEntry(partial.entry!, server);
    assert.equal(hard.kind, "error");
    assert.equal(hard.entry!.lastError, "permission denied");
  });

  it("treats a client-keyed insert colliding with someone else's row as a conflict", async () => {
    const server = new FakeServer();
    seed(server, []);
    const ops: OutboxOp[] = [
      {
        id: "i1",
        kind: "insert",
        key: "k1",
        feature: point("k1", 1),
        mineFingerprint: featureFingerprint(point("k1", 1)),
      },
    ];
    server.rows.set("k1", point("k1", 2));
    const outcome = await syncOutboxEntry(entryFor(ops), server);
    assert.equal(outcome.kind, "conflict");
  });
});

describe("mergeChangeSet", () => {
  it("replaces queued ops but keeps the dedupe flag of an uncertain insert", () => {
    const insert = point(undefined, 4, { n: "new" });
    const queued = entryFor(
      [
        {
          id: "old-insert",
          kind: "insert",
          key: null,
          feature: insert,
          mineFingerprint: featureFingerprint(insert),
          maybeApplied: true,
        },
      ],
      { status: "error", attempts: 4, lastError: "x" },
    );
    const merged = mergeChangeSet(
      queued,
      [
        {
          id: "new-insert",
          kind: "insert",
          key: null,
          feature: insert,
          mineFingerprint: featureFingerprint(insert),
        },
      ],
      9,
    );
    assert.equal(merged.ops[0].id, "old-insert");
    assert.equal(merged.ops[0].maybeApplied, true);
    assert.equal(merged.status, "pending");
    assert.equal(merged.attempts, 0);
    assert.equal(merged.updatedAt, 9);
  });
});

describe("retryDelayMs", () => {
  it("doubles from five seconds and caps at five minutes", () => {
    assert.equal(retryDelayMs(1), 5_000);
    assert.equal(retryDelayMs(2), 10_000);
    assert.equal(retryDelayMs(50), 300_000);
  });
});
