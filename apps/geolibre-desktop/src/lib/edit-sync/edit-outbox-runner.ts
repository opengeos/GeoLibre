/**
 * Drives the offline edit outbox (#3530): enqueue change sets, sync them now
 * or when the connection returns, back off between failed attempts, and hand
 * each synced result to the backend so it can refresh the open layer.
 *
 * Backends register an adapter factory per {@link EditSyncBackend}. The
 * factory runs at sync time, so it can resolve credentials from the app's own
 * stores rather than from the persisted entry.
 */

import {
  EditSyncError,
  mergeChangeSet,
  syncOutboxEntry,
  type EditSyncAdapter,
  type EditSyncBackend,
  type OutboxEntry,
  type OutboxOp,
  type SyncOutcome,
} from "./edit-outbox";
import {
  getOutboxEntry,
  getOutboxSnapshot,
  loadOutbox,
  putOutboxEntry,
  removeOutboxEntry,
} from "./edit-outbox-store";

/** A backend's sync hooks. */
export interface EditSyncBackendHandler {
  /** Build the adapter for an entry, or throw if its credentials are missing. */
  createAdapter(entry: OutboxEntry): EditSyncAdapter | Promise<EditSyncAdapter>;
  /** Called after an attempt that applied or resolved anything. */
  afterSync?(entry: OutboxEntry, outcome: SyncOutcome): void | Promise<void>;
}

const handlers = new Map<EditSyncBackend, EditSyncBackendHandler>();
const inFlight = new Map<string, Promise<SyncOutcome | null>>();

/**
 * Register (or replace) a backend's sync handler.
 *
 * @param backend The backend.
 * @param handler Its hooks.
 */
export function registerEditSyncBackend(
  backend: EditSyncBackend,
  handler: EditSyncBackendHandler,
): void {
  handlers.set(backend, handler);
}

/** Remove every registered backend (tests). */
export function resetEditSyncBackends(): void {
  handlers.clear();
  inFlight.clear();
}

/** Whether the browser believes it has a network connection. */
export function isNavigatorOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/** Whether an entry has a sync attempt running. */
export function isOutboxEntrySyncing(id: string): boolean {
  return inFlight.has(id);
}

/** Input for {@link enqueueChangeSet}. */
export interface EnqueueInput {
  id: string;
  backend: EditSyncBackend;
  target: Record<string, unknown>;
  targetLabel: string;
  layerId: string;
  layerName: string;
  ops: OutboxOp[];
}

/** Result of {@link enqueueChangeSet}. */
export type EnqueueResult =
  | { kind: "queued"; entry: OutboxEntry }
  | { kind: "empty" }
  | { kind: "busy" };

/**
 * Record a layer's change set in the outbox, replacing any older change set
 * for the same target (both were diffed against the same base).
 *
 * @param input The target and its operations.
 * @param now Clock (injectable for tests).
 * @returns The queued entry, `empty` when there is nothing to send and nothing
 *   queued, or `busy` while a sync for the target is running.
 */
export async function enqueueChangeSet(
  input: EnqueueInput,
  now: () => number = Date.now,
): Promise<EnqueueResult> {
  await loadOutbox();
  if (inFlight.has(input.id)) return { kind: "busy" };
  const at = now();
  const queued = getOutboxEntry(input.id);
  if (input.ops.length === 0) {
    // Nothing new to send. A queued entry is kept: its edits never reached
    // the source, and the layer may simply have been reloaded without them.
    // Only a successful sync or an explicit Discard removes it.
    return { kind: "empty" };
  }
  const entry: OutboxEntry = queued
    ? {
        ...mergeChangeSet(queued, input.ops, at),
        target: input.target,
        targetLabel: input.targetLabel,
        layerId: input.layerId,
        layerName: input.layerName,
      }
    : {
        ...input,
        status: "pending",
        conflicts: [],
        attempts: 0,
        createdAt: at,
        updatedAt: at,
      };
  await putOutboxEntry(entry);
  return { kind: "queued", entry };
}

/**
 * Run one sync attempt for an entry and persist what remains.
 *
 * Single-flight per entry: a second call while one runs returns the same
 * promise. Returns null when the entry is gone or no backend is registered.
 *
 * @param id The entry id.
 * @returns The attempt's outcome.
 */
export function syncOutboxEntryNow(id: string): Promise<SyncOutcome | null> {
  const running = inFlight.get(id);
  if (running) return running;
  const attempt = (async (): Promise<SyncOutcome | null> => {
    await loadOutbox();
    const entry = getOutboxEntry(id);
    if (!entry) return null;
    const handler = handlers.get(entry.backend);
    if (!handler) return null;
    await putOutboxEntry({ ...entry, status: "syncing" });
    let outcome: SyncOutcome;
    try {
      const adapter = await handler.createAdapter(entry);
      outcome = await syncOutboxEntry(entry, adapter);
    } catch (error) {
      // The adapter could not be built (credentials missing): the user must act.
      const message = error instanceof Error ? error.message : String(error);
      const failed: OutboxEntry = {
        ...entry,
        status: "error",
        lastError: message,
        lastErrorCode: error instanceof EditSyncError ? error.code : undefined,
        lastAttemptAt: Date.now(),
        nextAttemptAt: undefined,
        updatedAt: Date.now(),
      };
      await putOutboxEntry(failed);
      return {
        kind: "error",
        entry: failed,
        inserted: 0,
        updated: 0,
        deleted: 0,
        alreadyApplied: 0,
        keptTheirs: 0,
        insertedKeys: new Map(),
        touchedKeys: [],
        error: message,
      };
    }
    if (outcome.entry) await putOutboxEntry(outcome.entry);
    else await removeOutboxEntry(id);
    const changed =
      outcome.inserted +
      outcome.updated +
      outcome.deleted +
      outcome.alreadyApplied +
      outcome.keptTheirs;
    if (changed > 0 || outcome.kind === "synced") {
      try {
        await handler.afterSync?.(entry, outcome);
      } catch {
        // Refreshing the open layer is best effort; the source is already in sync.
      }
    }
    return outcome;
  })().finally(() => inFlight.delete(id));
  inFlight.set(id, attempt);
  return attempt;
}

/**
 * Sync every entry whose retry time has come (pending, online, not running).
 * Conflicted and failed entries wait for the user.
 *
 * @param now Clock.
 * @returns The outcomes of the attempts made.
 */
export async function flushDueOutboxEntries(
  now: () => number = Date.now,
): Promise<Array<SyncOutcome | null>> {
  await loadOutbox();
  if (!isNavigatorOnline()) return [];
  const due = getOutboxSnapshot().entries.filter(
    (entry) =>
      entry.status === "pending" &&
      !inFlight.has(entry.id) &&
      handlers.has(entry.backend) &&
      (entry.nextAttemptAt === undefined || entry.nextAttemptAt <= now()),
  );
  const outcomes: Array<SyncOutcome | null> = [];
  // Sequential: a flaky link should not see a burst of parallel writes.
  for (const entry of due) outcomes.push(await syncOutboxEntryNow(entry.id));
  return outcomes;
}

let stopRunner: (() => void) | null = null;

/**
 * Start the background runner once per app: load the outbox, retry due
 * entries on an interval, and immediately when the browser comes back online.
 *
 * @param intervalMs How often to check for due entries.
 * @returns A function that stops the runner.
 */
export function startEditOutboxRunner(intervalMs = 15_000): () => void {
  if (stopRunner) return stopRunner;
  const tick = () => {
    void flushDueOutboxEntries();
  };
  const onOnline = () => {
    // Coming back online makes every pending entry due now.
    for (const entry of getOutboxSnapshot().entries) {
      if (entry.status === "pending" && entry.nextAttemptAt !== undefined) {
        void putOutboxEntry({ ...entry, nextAttemptAt: undefined });
      }
    }
    tick();
  };
  void loadOutbox().then(tick);
  const timer = setInterval(tick, intervalMs);
  if (typeof window !== "undefined") window.addEventListener("online", onOnline);
  stopRunner = () => {
    clearInterval(timer);
    if (typeof window !== "undefined") window.removeEventListener("online", onOnline);
    stopRunner = null;
  };
  return stopRunner;
}
