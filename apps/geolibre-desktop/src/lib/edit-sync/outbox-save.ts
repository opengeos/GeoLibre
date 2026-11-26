/**
 * "Save edits to source" through the offline edit outbox (#3530): queue the
 * change set, try to sync it right away, and describe the result in the same
 * shape as a direct write-back so every save entry point reports it alike.
 */

import type { TFunction } from "i18next";
import { countOps, type SyncOutcome } from "./edit-outbox";
import {
  enqueueChangeSet,
  syncOutboxEntryNow,
  type EnqueueInput,
  type EnqueueResult,
} from "./edit-outbox-runner";

/** A save result, mirroring `SingleLayerWriteBackResult`. */
export interface OutboxSaveResult {
  status: "success" | "warning" | "error";
  message: string;
  silent?: boolean;
  /** The sync attempt behind the result, when one ran. */
  outcome?: SyncOutcome | null;
}

/** Injectable outbox calls (tests). */
export interface OutboxSaveDeps {
  enqueue?: (input: EnqueueInput) => Promise<EnqueueResult>;
  syncNow?: (id: string) => Promise<SyncOutcome | null>;
}

/**
 * Describe a sync outcome for a toast or the Save layer edits dialog.
 *
 * @param outcome The outcome (null when the entry vanished mid-sync).
 * @param target Human-readable target.
 * @param t Translator.
 * @returns The result.
 */
export function describeSyncOutcome(
  outcome: SyncOutcome | null,
  target: string,
  t: TFunction,
): OutboxSaveResult {
  if (!outcome)
    return { status: "error", message: t("editOutbox.save.failed", { target, error: "" }) };
  const counts = {
    target,
    inserted: outcome.inserted,
    updated: outcome.updated,
    deleted: outcome.deleted,
  };
  if (outcome.kind === "synced") {
    return { status: "success", message: t("editOutbox.save.synced", counts) };
  }
  if (outcome.kind === "conflict") {
    const count = outcome.entry?.conflicts.length ?? 0;
    return {
      status: "warning",
      message: `${t("editOutbox.save.synced", counts)} ${t("editOutbox.save.conflicts", { count })}`,
    };
  }
  if (outcome.kind === "offline") {
    const queued = countOps(outcome.entry?.ops ?? []);
    return {
      status: "warning",
      message: t("editOutbox.save.queued", {
        target,
        count: queued.insert + queued.update + queued.delete,
        error: outcome.error ?? "",
      }),
    };
  }
  return {
    status: "error",
    message: t("editOutbox.save.failed", { target, error: outcome.error ?? "" }),
  };
}

/**
 * Queue a layer's change set and sync it now.
 *
 * @param input The outbox entry to queue.
 * @param t Translator.
 * @param deps Injectable outbox calls (tests).
 * @returns The save result.
 */
export async function saveThroughOutbox(
  input: EnqueueInput,
  t: TFunction,
  deps: OutboxSaveDeps = {},
): Promise<OutboxSaveResult> {
  const enqueue = deps.enqueue ?? ((value: EnqueueInput) => enqueueChangeSet(value));
  const syncNow = deps.syncNow ?? syncOutboxEntryNow;
  const queued = await enqueue(input);
  if (queued.kind === "busy") {
    return { status: "error", message: t("editOutbox.save.busy", { target: input.targetLabel }) };
  }
  if (queued.kind === "empty") {
    return {
      status: "success",
      message: t("editOutbox.save.noChanges", { target: input.targetLabel }),
    };
  }
  const outcome = await syncNow(input.id);
  return { ...describeSyncOutcome(outcome, input.targetLabel, t), outcome };
}
