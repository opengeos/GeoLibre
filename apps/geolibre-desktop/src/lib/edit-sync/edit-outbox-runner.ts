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
  applyConflictResolutions,
  EditSyncError,
  EditSyncOfflineError,
  EditSyncWaitingError,
  mergeChangeSet,
  retryDelayMs,
  syncOutboxEntry,
  type EditSyncAdapter,
  type EditSyncBackend,
  type ConflictResolution,
  type OutboxEntry,
  type OutboxOp,
  type SyncOutcome,
} from "./edit-outbox";
import {
  getOutboxSnapshot,
  loadOutbox,
  putOutboxEntry,
  reloadOutboxEntry,
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

/**
 * Run `fn` holding an exclusive cross-tab lock for one entry (Web Locks), so
 * two tabs never sync the same change set at once and send its inserts
 * twice. Runs without a lock where Web Locks are unavailable.
 *
 * @param id The entry id.
 * @param fn The work to run.
 * @returns What `fn` returns.
 */
function withEntryLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks?.request) return fn();
  return locks.request(`geolibre-edit-outbox:${id}`, fn) as Promise<T>;
}

/**
 * Discard a queued entry, waiting for any sync of it (in this or another tab)
 * to finish first, so a sync that is mid-write cannot bring it back.
 *
 * @param id The entry id.
 * @returns Resolves once the entry is gone.
 */
export async function discardOutboxEntry(id: string): Promise<void> {
  await inFlight.get(id)?.catch(() => null);
  await withEntryLock(id, () => removeOutboxEntry(id));
}

/** Whether an entry has a sync attempt running. */
export function isOutboxEntrySyncing(id: string): boolean {
  return inFlight.has(id);
}

/** Identifies this run of the app, for {@link editSessionToken}. */
const APP_RUN =
  typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Date.now());

/**
 * A token for one load of a layer: this app run, this project, this layer.
 * Change sets with equal tokens come from the same in-memory layer, so a
 * feature missing from the newer one was undone rather than never loaded.
 *
 * @param layerId The layer.
 * @param projectGeneration The store's project generation.
 * @returns The token.
 */
export function editSessionToken(layerId: string, projectGeneration: number): string {
  return `${APP_RUN}:${projectGeneration}:${layerId}`;
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
  /** See {@link editSessionToken}. */
  session?: string;
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
  // Read, merge and write under the entry's lock, so neither this tab's nor
  // another tab's sync can interleave with the merge.
  return withEntryLock(input.id, async (): Promise<EnqueueResult> => {
    if (inFlight.has(input.id)) return { kind: "busy" };
    const at = now();
    const queued = await reloadOutboxEntry(input.id);
    const ops =
      input.session !== undefined
        ? input.ops.map((op) => ({ ...op, session: input.session }))
        : input.ops;
    if (ops.length === 0) {
      // Nothing new to send. Queued edits recorded in this same load were
      // undone and go; edits from an earlier load (or with an unknown write
      // outcome) stay until a sync or a Discard.
      if (queued) {
        const merged = mergeChangeSet(queued, [], at, input.session);
        if (merged.ops.length === 0) await removeOutboxEntry(input.id);
        else if (merged.ops.length !== queued.ops.length) await putOutboxEntry(merged);
      }
      return { kind: "empty" };
    }
    const entry: OutboxEntry = queued
      ? {
          ...mergeChangeSet(queued, ops, at, input.session),
          session: input.session,
          target: input.target,
          targetLabel: input.targetLabel,
          layerId: input.layerId,
          layerName: input.layerName,
        }
      : {
          ...input,
          ops,
          status: "pending",
          conflicts: [],
          attempts: 0,
          createdAt: at,
          updatedAt: at,
        };
    await putOutboxEntry(entry);
    return { kind: "queued", entry };
  });
}

/**
 * Run one sync attempt for an entry and persist what remains.
 *
 * Single-flight per entry: a second call while one runs returns the same
 * promise. Returns null when the entry is gone or no backend is registered.
 *
 * @param id The entry id.
 * @param decisions Conflict decisions (op id to choice) to record first, on
 *   the stored entry under the lock, so they apply to what is stored now.
 * @param reviewed The fingerprint of the server version shown for each
 *   decided conflict, so a keep mine is bound to what the user actually saw.
 * @returns The attempt's outcome.
 */
export function syncOutboxEntryNow(
  id: string,
  decisions?: ReadonlyMap<string, ConflictResolution>,
  reviewed?: ReadonlyMap<string, string | null | undefined>,
): Promise<SyncOutcome | null> {
  const running = inFlight.get(id);
  // Decisions must not ride on an attempt that started without them.
  if (running && decisions?.size) {
    return running.then(() => syncOutboxEntryNow(id, decisions, reviewed));
  }
  if (running) return running;
  const attempt = withEntryLock(id, async (): Promise<SyncOutcome | null> => {
    // Under the lock, act on the stored entry: another tab may have synced or
    // discarded it since this tab last read the outbox.
    const stored = await reloadOutboxEntry(id);
    if (!stored) return null;
    const entry = decisions?.size ? applyConflictResolutions(stored, decisions, reviewed) : stored;
    const handler = handlers.get(entry.backend);
    if (!handler) return null;
    await putOutboxEntry({ ...entry, status: "syncing" });
    let outcome: SyncOutcome;
    try {
      const adapter = await handler.createAdapter(entry);
      outcome = await syncOutboxEntry(entry, adapter, { onDispatch: putOutboxEntry });
    } catch (error) {
      // The adapter could not be built: either it is waiting on something that
      // resolves itself (credentials still loading, its layer not open), or
      // credentials are missing and the user must act.
      const message = error instanceof Error ? error.message : String(error);
      const waiting =
        error instanceof EditSyncWaitingError || error instanceof EditSyncOfflineError;
      const at = Date.now();
      const attempts = waiting ? entry.attempts + 1 : entry.attempts;
      const failed: OutboxEntry = {
        ...entry,
        status: waiting ? "pending" : "error",
        attempts,
        lastError: message,
        lastErrorCode: error instanceof EditSyncError ? error.code : undefined,
        lastAttemptAt: at,
        nextAttemptAt: waiting ? at + retryDelayMs(attempts) : undefined,
        updatedAt: at,
      };
      await putOutboxEntry(failed);
      return {
        kind: waiting ? "offline" : "error",
        entry: failed,
        inserted: 0,
        updated: 0,
        deleted: 0,
        alreadyApplied: 0,
        keptTheirs: 0,
        insertedKeys: new Map(),
        touchedKeys: [],
        theirsKeys: [],
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
  }).finally(() => inFlight.delete(id));
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
    // Reset under each entry's lock, on the stored copy, so this tab never
    // brings back an entry another tab synced or discarded meanwhile.
    void Promise.all(
      getOutboxSnapshot().entries.map((snapshotEntry) =>
        withEntryLock(snapshotEntry.id, async () => {
          const stored = await reloadOutboxEntry(snapshotEntry.id);
          if (stored?.status === "pending" && stored.nextAttemptAt !== undefined) {
            await putOutboxEntry({ ...stored, nextAttemptAt: undefined });
          }
        }),
      ),
    ).then(tick);
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
