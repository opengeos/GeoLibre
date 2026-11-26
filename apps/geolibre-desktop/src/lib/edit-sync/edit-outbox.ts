/**
 * Offline edit outbox: change sets, conflict detection, and sync (#3530).
 *
 * When the user saves edits to a remote source (PostGIS, an ArcGIS feature
 * service, GeoLens, a GeoPackage), the save is recorded here first as a change
 * set: one operation per inserted, updated, or deleted feature, each carrying
 * the fingerprint of the feature as it was loaded (the base). The change set
 * is persisted, so it survives a reload or restart, and syncing it is retried
 * until the source is reachable.
 *
 * Syncing is a three-way comparison per feature, on fingerprints:
 *
 * - the server row still matches the base: nobody else touched it, so apply;
 * - the server row already matches my version: an earlier attempt landed (or
 *   someone made the same change), so the operation is done, which is what
 *   makes a retried sync idempotent;
 * - otherwise the row changed on both sides: a conflict, which waits for the
 *   user to keep mine, keep theirs, or skip it for now. Operations without a
 *   conflict apply without waiting for that review.
 *
 * Backends plug in through {@link EditSyncAdapter}. This module is pure (no
 * DOM, no store, no I/O of its own) so it can be unit tested with fakes.
 */

import type { Feature } from "geojson";
import { featureFingerprint } from "./feature-fingerprint";

/** The remote sources an outbox entry can sync to. */
export type EditSyncBackend = "postgis" | "arcgis" | "geolens" | "geopackage";

/** What one queued operation does to the source. */
export type OutboxOpKind = "insert" | "update" | "delete";

/** How the user resolved a conflict. */
export type ConflictResolution = "mine" | "theirs" | "skip";

/** One queued feature change. */
export interface OutboxOp {
  /** Stable id, unique within the entry. */
  id: string;
  kind: OutboxOpKind;
  /** The source key as a string, or null for an insert of a feature without one. */
  key: string | null;
  /** The source key with its original type (a numeric primary key stays a number). */
  rawKey?: string | number;
  /** My version of the feature, for inserts and updates. */
  feature?: Feature;
  /** Fingerprint of the feature as loaded, for updates and deletes. */
  baseFingerprint?: string;
  /** Fingerprint of my version, for inserts and updates. */
  mineFingerprint?: string;
  /**
   * Set when a write carrying this insert was sent but its outcome is unknown
   * (the response was lost). A retry first asks the adapter whether the row
   * already exists, instead of inserting it twice.
   */
  maybeApplied?: boolean;
  /** The user's decision for a conflicted operation. */
  resolution?: ConflictResolution;
  /** The last per-feature error the source reported for this operation. */
  error?: string;
}

/** Why an operation conflicts with the server. */
export type ConflictReason = "remoteChanged" | "remoteDeleted";

/** A conflicted operation, with the server's current version for review. */
export interface OutboxConflict {
  opId: string;
  key: string;
  reason: ConflictReason;
  /** The server's version, or null when the server deleted the feature. */
  theirs: Feature | null;
}

/** Lifecycle of an outbox entry. */
export type OutboxEntryStatus = "pending" | "syncing" | "conflict" | "error";

/** Every queued change for one layer's source. */
export interface OutboxEntry {
  /** Identity of the source target; one entry per target. */
  id: string;
  backend: EditSyncBackend;
  /**
   * Backend-specific description of the target (table, service URL, dataset,
   * file). JSON-safe and **free of credentials**: the adapter resolves those
   * at sync time from the app's own credential stores.
   */
  target: Record<string, unknown>;
  /** Human-readable target for the review dialog. */
  targetLabel: string;
  /** The layer the edits were made on, if it is still open. */
  layerId: string;
  layerName: string;
  ops: OutboxOp[];
  status: OutboxEntryStatus;
  conflicts: OutboxConflict[];
  /** Consecutive failed attempts, for backoff. */
  attempts: number;
  lastError?: string;
  lastAttemptAt?: number;
  nextAttemptAt?: number;
  createdAt: number;
  updatedAt: number;
}

/** The server's current state of the features an entry touches. */
export interface RemoteState {
  /** Every requested key: the server's feature, or null when it is gone. */
  byKey: Map<string, Feature | null>;
  /**
   * For inserts flagged `maybeApplied`: op id to the key of the server row
   * that already holds that insert. Unmatched inserts are sent again.
   */
  insertMatches?: Map<string, string>;
}

/** The writes one sync attempt sends. */
export interface ApplyPlan {
  inserts: OutboxOp[];
  updates: OutboxOp[];
  deletes: OutboxOp[];
  /** The state the plan was computed against, for optimistic checks. */
  remote: RemoteState;
}

/** What the source reports after applying a plan. */
export interface ApplyResult {
  /** Op ids the source applied. */
  applied: string[];
  /** Op ids the source rejected, with its message. The rest still applied. */
  failed: Array<{ opId: string; message: string }>;
  /** Server keys assigned to applied inserts, by op id. */
  insertedKeys?: Map<string, string>;
}

/** A backend's sync implementation. */
export interface EditSyncAdapter {
  /**
   * Read the server's current version of `keys`, and resolve any
   * `maybeApplied` inserts. Throws {@link EditSyncOfflineError} when the
   * source cannot be reached.
   */
  fetchRemote(entry: OutboxEntry, keys: string[], maybeApplied: OutboxOp[]): Promise<RemoteState>;
  /**
   * Apply a plan. Throws {@link EditSyncConflictRaceError} when the server
   * changed between the read and the write (nothing applied), or
   * {@link EditSyncOfflineError} / {@link EditSyncUncertainError} /
   * {@link EditSyncRejectedError} as appropriate.
   */
  apply(entry: OutboxEntry, plan: ApplyPlan): Promise<ApplyResult>;
  /** Fingerprint a server feature the same way the base was fingerprinted. */
  fingerprint?(feature: Feature): string;
}

/** The source could not be reached; nothing was written. Retry later. */
export class EditSyncOfflineError extends Error {
  override readonly name = "EditSyncOfflineError";
}

/** A write was sent but its outcome is unknown. Inserts must be deduplicated on retry. */
export class EditSyncUncertainError extends Error {
  override readonly name = "EditSyncUncertainError";
}

/** The server changed between the read and the write; nothing was written. */
export class EditSyncConflictRaceError extends Error {
  override readonly name = "EditSyncConflictRaceError";
}

/** The source refused the write for a reason a retry will not fix. */
export class EditSyncRejectedError extends Error {
  override readonly name = "EditSyncRejectedError";
}

/** How a sync attempt ended. */
export type SyncOutcomeKind = "synced" | "conflict" | "offline" | "error";

/** Result of {@link syncOutboxEntry}. */
export interface SyncOutcome {
  kind: SyncOutcomeKind;
  /** The entry after the attempt, or null when every operation is done. */
  entry: OutboxEntry | null;
  inserted: number;
  updated: number;
  deleted: number;
  /** Operations found already applied on the server (idempotent retries). */
  alreadyApplied: number;
  /** Conflicted operations the user resolved with keep theirs. */
  keptTheirs: number;
  /** Server keys assigned to applied inserts, by op id. */
  insertedKeys: Map<string, string>;
  /** Keys of the features that changed on the server through this sync. */
  touchedKeys: string[];
  error?: string;
}

/** Backoff before retry number `attempts` (1-based): 5 s doubling, capped at 5 min. */
export function retryDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 10));
  return Math.min(5_000 * 2 ** exponent, 300_000);
}

/** Inputs for {@link buildChangeSet}. */
export interface ChangeSetInput {
  /** Base fingerprints, keyed by source key, from load time. */
  baseline: ReadonlyMap<string, string>;
  /** The layer's current features. */
  features: readonly Feature[];
  /** How to read a feature's source key. */
  keyOf: (feature: Feature) => string | null;
  /** How to read a feature's typed key (defaults to `feature.id`). */
  rawKeyOf?: (feature: Feature) => string | number | undefined;
  /** How to fingerprint a feature (defaults to {@link featureFingerprint}). */
  fingerprint?: (feature: Feature) => string;
  /** The typed key of a base entry, for deletes (defaults to the string key). */
  rawKeyOfBase?: (key: string) => string | number;
  /** Turn a duplicate of a keyed feature into a keyless insert. */
  stripKey?: (feature: Feature) => Feature;
  /** Op id generator (injectable for tests). */
  newId?: () => string;
}

function defaultStripKey(feature: Feature): Feature {
  const { id: _id, ...rest } = feature;
  return rest as Feature;
}

/**
 * Diff a layer's features against its base fingerprints into queued operations.
 *
 * A keyed feature whose fingerprint moved is an update; a feature with no key,
 * or a key the base never held, is an insert; a base key no feature claims is
 * a delete. A key claimed twice updates once (first occurrence) and inserts
 * the rest without their key, which is what a copied feature should become.
 *
 * @param input The base, the current features, and how to key them.
 * @returns The operations, in feature order with deletes last.
 */
export function buildChangeSet(input: ChangeSetInput): OutboxOp[] {
  const fingerprint = input.fingerprint ?? ((feature: Feature) => featureFingerprint(feature));
  const stripKey = input.stripKey ?? defaultStripKey;
  const rawKeyOf =
    input.rawKeyOf ??
    ((feature: Feature) =>
      typeof feature.id === "string" || typeof feature.id === "number" ? feature.id : undefined);
  let counter = 0;
  const newId = input.newId ?? (() => `op-${Date.now().toString(36)}-${(counter++).toString(36)}`);
  const ops: OutboxOp[] = [];
  const seen = new Set<string>();
  for (const feature of input.features) {
    const key = input.keyOf(feature);
    const base = key !== null && !seen.has(key) ? input.baseline.get(key) : undefined;
    if (key !== null && base !== undefined) {
      seen.add(key);
      const mine = fingerprint(feature);
      if (mine === base) continue;
      ops.push({
        id: newId(),
        kind: "update",
        key,
        rawKey: rawKeyOf(feature) ?? key,
        feature: structuredClone(feature),
        baseFingerprint: base,
        mineFingerprint: mine,
      });
      continue;
    }
    const insertFeature = key !== null && seen.has(key) ? stripKey(feature) : feature;
    const insertKey = key !== null && !seen.has(key) ? key : null;
    if (insertKey !== null) seen.add(insertKey);
    ops.push({
      id: newId(),
      kind: "insert",
      key: insertKey,
      ...(insertKey !== null ? { rawKey: rawKeyOf(feature) ?? insertKey } : {}),
      feature: structuredClone(insertFeature),
      mineFingerprint: fingerprint(insertFeature),
    });
  }
  for (const [key, base] of input.baseline) {
    if (seen.has(key)) continue;
    ops.push({
      id: newId(),
      kind: "delete",
      key,
      rawKey: input.rawKeyOfBase?.(key) ?? key,
      baseFingerprint: base,
    });
  }
  return ops;
}

/** Count of operations by kind, for status readouts. */
export function countOps(ops: readonly OutboxOp[]): Record<OutboxOpKind, number> {
  const counts: Record<OutboxOpKind, number> = { insert: 0, update: 0, delete: 0 };
  for (const op of ops) counts[op.kind] += 1;
  return counts;
}

/** The classification of one operation against the server. */
type OpVerdict =
  | { kind: "apply"; op: OutboxOp }
  | { kind: "done"; op: OutboxOp }
  | { kind: "theirs"; op: OutboxOp }
  | { kind: "conflict"; op: OutboxOp; conflict: OutboxConflict }
  | { kind: "skip"; op: OutboxOp };

/**
 * Classify one operation by comparing base, mine, and theirs.
 *
 * @param op The queued operation.
 * @param remote The server's current state.
 * @param fingerprint How to fingerprint a server feature.
 * @returns What the sync should do with it.
 */
export function classifyOp(
  op: OutboxOp,
  remote: RemoteState,
  fingerprint: (feature: Feature) => string,
): OpVerdict {
  if (op.kind === "insert") {
    if (op.maybeApplied && remote.insertMatches?.has(op.id)) return { kind: "done", op };
    if (op.key === null) return { kind: "apply", op };
    // A client-keyed insert: a server row under that key is either this insert
    // landing earlier, or someone else's row, which is a conflict.
    const existing = remote.byKey.get(op.key) ?? null;
    if (!existing) return { kind: "apply", op };
    if (fingerprint(existing) === op.mineFingerprint) return { kind: "done", op };
    return resolveConflict(op, {
      opId: op.id,
      key: op.key,
      reason: "remoteChanged",
      theirs: existing,
    });
  }
  const key = op.key as string;
  const theirs = remote.byKey.has(key) ? (remote.byKey.get(key) ?? null) : null;
  if (op.kind === "delete") {
    if (!theirs) return { kind: "done", op };
    if (fingerprint(theirs) === op.baseFingerprint) return { kind: "apply", op };
    return resolveConflict(op, { opId: op.id, key, reason: "remoteChanged", theirs });
  }
  if (!theirs) {
    return resolveConflict(op, { opId: op.id, key, reason: "remoteDeleted", theirs: null });
  }
  const theirsFingerprint = fingerprint(theirs);
  if (theirsFingerprint === op.mineFingerprint) return { kind: "done", op };
  if (theirsFingerprint === op.baseFingerprint) return { kind: "apply", op };
  return resolveConflict(op, { opId: op.id, key, reason: "remoteChanged", theirs });
}

function resolveConflict(op: OutboxOp, conflict: OutboxConflict): OpVerdict {
  if (op.resolution === "theirs") return { kind: "theirs", op };
  if (op.resolution === "mine") {
    // Keeping my update of a feature the server deleted re-creates it.
    if (op.kind === "update" && conflict.reason === "remoteDeleted") {
      return { kind: "apply", op: { ...op, kind: "insert" } };
    }
    return { kind: "apply", op };
  }
  return { kind: "conflict", op, conflict };
}

/** Options for {@link syncOutboxEntry}. */
export interface SyncOptions {
  /** Clock (injectable for tests). */
  now?: () => number;
  /** How many times to re-read after a read/write race before giving up. */
  maxRaceRetries?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run one sync attempt for an entry.
 *
 * Reads the server's state of every touched feature, classifies each
 * operation, applies the non-conflicting ones, and returns the entry with
 * what remains (failed operations, unresolved conflicts) or null when it is
 * fully synced. Never throws: every failure is folded into the outcome so the
 * caller can persist it.
 *
 * @param entry The entry to sync. Not mutated.
 * @param adapter The backend.
 * @param options Clock and retry settings.
 * @returns The outcome, including the updated entry.
 */
export async function syncOutboxEntry(
  entry: OutboxEntry,
  adapter: EditSyncAdapter,
  options: SyncOptions = {},
): Promise<SyncOutcome> {
  const now = options.now ?? Date.now;
  const fingerprint = adapter.fingerprint ?? ((feature: Feature) => featureFingerprint(feature));
  const maxRaceRetries = options.maxRaceRetries ?? 2;
  const outcome: SyncOutcome = {
    kind: "synced",
    entry: null,
    inserted: 0,
    updated: 0,
    deleted: 0,
    alreadyApplied: 0,
    keptTheirs: 0,
    insertedKeys: new Map(),
    touchedKeys: [],
  };
  const startedAt = now();
  const failRetryable = (error: unknown, ops: OutboxOp[]): SyncOutcome => {
    const attempts = entry.attempts + 1;
    return {
      ...outcome,
      kind: "offline",
      error: errorMessage(error),
      entry: {
        ...entry,
        ops,
        status: "pending",
        attempts,
        lastError: errorMessage(error),
        lastAttemptAt: startedAt,
        nextAttemptAt: startedAt + retryDelayMs(attempts),
        updatedAt: startedAt,
      },
    };
  };

  let ops = entry.ops.map((op) => ({ ...op }));
  for (let round = 0; ; round++) {
    // Deferred conflicts stay queued untouched until the user decides.
    const active = ops.filter((op) => op.resolution !== "skip");
    const keys = [
      ...new Set(active.map((op) => op.key).filter((key): key is string => key !== null)),
    ];
    const maybeApplied = active.filter((op) => op.kind === "insert" && op.maybeApplied);

    let remote: RemoteState = { byKey: new Map() };
    try {
      // Only deferred conflicts left: nothing to read or write this round.
      if (active.length > 0) remote = await adapter.fetchRemote(entry, keys, maybeApplied);
    } catch (error) {
      if (error instanceof EditSyncRejectedError) {
        return failHard(entry, ops, outcome, error, startedAt);
      }
      return failRetryable(error, ops);
    }

    const verdicts = active.map((op) => classifyOp(op, remote, fingerprint));
    const toApply = verdicts.filter((v) => v.kind === "apply").map((v) => v.op);
    const conflicts = verdicts.flatMap((v) => (v.kind === "conflict" ? [v.conflict] : []));
    const doneIds = new Set(
      verdicts.filter((v) => v.kind === "done" || v.kind === "theirs").map((v) => v.op.id),
    );

    let result: ApplyResult = { applied: [], failed: [] };
    if (toApply.length > 0) {
      const plan: ApplyPlan = {
        inserts: toApply.filter((op) => op.kind === "insert"),
        updates: toApply.filter((op) => op.kind === "update"),
        deletes: toApply.filter((op) => op.kind === "delete"),
        remote,
      };
      try {
        result = await adapter.apply(entry, plan);
      } catch (error) {
        if (error instanceof EditSyncConflictRaceError && round < maxRaceRetries) continue;
        if (error instanceof EditSyncRejectedError) {
          return failHard(entry, ops, outcome, error, startedAt);
        }
        if (error instanceof EditSyncUncertainError) {
          const pending = new Set(plan.inserts.map((op) => op.id));
          ops = ops.map((op) => (pending.has(op.id) ? { ...op, maybeApplied: true } : op));
        }
        return failRetryable(error, ops);
      }
    }

    const appliedIds = new Set(result.applied);
    const failedById = new Map(result.failed.map((f) => [f.opId, f.message]));
    for (const verdict of verdicts) {
      const { op } = verdict;
      if (verdict.kind === "done") outcome.alreadyApplied += 1;
      if (verdict.kind === "theirs") outcome.keptTheirs += 1;
      if (verdict.kind === "apply" && appliedIds.has(op.id)) {
        if (op.kind === "insert") outcome.inserted += 1;
        else if (op.kind === "update") outcome.updated += 1;
        else outcome.deleted += 1;
        if (op.key !== null) outcome.touchedKeys.push(op.key);
      }
    }
    for (const [opId, key] of result.insertedKeys ?? []) {
      outcome.insertedKeys.set(opId, key);
      outcome.touchedKeys.push(key);
    }

    const conflictIds = new Set(conflicts.map((c) => c.opId));
    const remaining = ops
      .filter((op) => !doneIds.has(op.id) && !appliedIds.has(op.id))
      .map((op) => {
        const message = failedById.get(op.id);
        const next: OutboxOp = { ...op, maybeApplied: op.maybeApplied && !appliedIds.has(op.id) };
        if (!next.maybeApplied) delete next.maybeApplied;
        if (message !== undefined) next.error = message;
        else delete next.error;
        // A conflict is re-reviewed against the server's latest version.
        if (conflictIds.has(op.id)) delete next.resolution;
        return next;
      });
    if (remaining.length === 0) return outcome;
    const failed = remaining.some((op) => failedById.has(op.id));
    const hasConflicts = conflicts.length > 0 || remaining.some((op) => op.resolution === "skip");
    const status: OutboxEntryStatus = failed ? "error" : hasConflicts ? "conflict" : "pending";
    const keptConflicts = [
      ...conflicts,
      // Deferred ops keep the conflict snapshot they were reviewed with.
      ...entry.conflicts.filter((c) =>
        remaining.some((op) => op.id === c.opId && op.resolution === "skip"),
      ),
    ];
    return {
      ...outcome,
      kind: failed ? "error" : hasConflicts ? "conflict" : "synced",
      error: failed ? [...failedById.values()].join("; ") : undefined,
      entry: {
        ...entry,
        ops: remaining,
        status,
        conflicts: keptConflicts,
        attempts: 0,
        lastError: failed ? [...failedById.values()].join("; ") : undefined,
        lastAttemptAt: startedAt,
        nextAttemptAt: undefined,
        updatedAt: startedAt,
      },
    };
  }
}

function failHard(
  entry: OutboxEntry,
  ops: OutboxOp[],
  outcome: SyncOutcome,
  error: unknown,
  at: number,
): SyncOutcome {
  return {
    ...outcome,
    kind: "error",
    error: errorMessage(error),
    entry: {
      ...entry,
      ops,
      status: "error",
      lastError: errorMessage(error),
      lastAttemptAt: at,
      nextAttemptAt: undefined,
      updatedAt: at,
    },
  };
}

/**
 * Record the user's conflict decisions on an entry, ready for the next sync.
 *
 * @param entry The entry under review.
 * @param decisions Op id to decision; ops not listed keep their state.
 * @returns The updated entry (not persisted).
 */
export function applyConflictResolutions(
  entry: OutboxEntry,
  decisions: ReadonlyMap<string, ConflictResolution>,
): OutboxEntry {
  return {
    ...entry,
    ops: entry.ops.map((op) => {
      const decision = decisions.get(op.id);
      return decision ? { ...op, resolution: decision } : op;
    }),
  };
}

/**
 * Merge a newer change set for the same target into a queued entry.
 *
 * The newer change set is the whole truth for what I want each feature to
 * be. Two things carry over from the queued one: a feature's **older** base
 * fingerprint (the layer may have been re-based onto the server's version
 * after a partial sync, and comparing against that would hide a conflict
 * still under review), and the dedupe flag of an insert already sent with an
 * unknown outcome.
 *
 * @param queued The entry already in the outbox.
 * @param ops The newer change set.
 * @param at Timestamp of the merge.
 * @returns The merged entry, reset to pending.
 */
export function mergeChangeSet(queued: OutboxEntry, ops: OutboxOp[], at: number): OutboxEntry {
  const uncertain = queued.ops.filter((op) => op.kind === "insert" && op.maybeApplied);
  const olderBase = new Map<string, string>();
  for (const op of queued.ops) {
    if (op.key !== null && op.baseFingerprint !== undefined)
      olderBase.set(op.key, op.baseFingerprint);
  }
  const merged = ops.map((op) => {
    const base = op.key !== null ? olderBase.get(op.key) : undefined;
    return base !== undefined && op.kind !== "insert" ? { ...op, baseFingerprint: base } : op;
  });
  for (const op of uncertain) {
    const twin = merged.findIndex(
      (candidate) =>
        candidate.kind === "insert" && candidate.mineFingerprint === op.mineFingerprint,
    );
    if (twin >= 0) merged[twin] = { ...merged[twin], id: op.id, maybeApplied: true };
  }
  return {
    ...queued,
    ops: merged,
    status: "pending",
    conflicts: [],
    attempts: 0,
    lastError: undefined,
    nextAttemptAt: undefined,
    updatedAt: at,
  };
}
