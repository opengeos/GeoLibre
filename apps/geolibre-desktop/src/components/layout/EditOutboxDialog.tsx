/**
 * Pending edits dialog for the offline edit outbox (#3530): lists queued
 * change sets per source, syncs or discards them, and walks the user through
 * conflicts (keep mine, keep theirs, or decide later) before applying them.
 */

import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@geolibre/ui";
import { AlertTriangle, CloudOff, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { diffConflictVersions, formatAttributeValue } from "../../lib/edit-sync/conflict-diff";
import {
  countOps,
  type ConflictResolution,
  type OutboxConflict,
  type OutboxEntry,
} from "../../lib/edit-sync/edit-outbox";
import { discardOutboxEntry, syncOutboxEntryNow } from "../../lib/edit-sync/edit-outbox-runner";
import { describeSyncOutcome } from "../../lib/edit-sync/outbox-save";
import { notify } from "../../lib/notify";

export interface EditOutboxDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: readonly OutboxEntry[];
  online: boolean;
  durable: boolean;
  /** Set when the queue stored on this device could not be read. */
  storageError?: string;
}

export function EditOutboxDialog({
  open,
  onOpenChange,
  entries,
  online,
  durable,
  storageError,
}: EditOutboxDialogProps) {
  const { t } = useTranslation();
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const reviewing = entries.find((entry) => entry.id === reviewId) ?? null;

  const runSync = async (entry: OutboxEntry, decisions?: Map<string, ConflictResolution>) => {
    setBusyIds((current) => new Set(current).add(entry.id));
    try {
      // Decisions are recorded on the stored entry under its lock, not on this
      // dialog's copy, which another tab may have changed meanwhile.
      // Bind each keep mine to the server version this dialog showed.
      const reviewed = new Map(entry.conflicts.map((c) => [c.opId, c.theirsFingerprint]));
      const outcome = await syncOutboxEntryNow(entry.id, decisions, reviewed);
      const result = describeSyncOutcome(outcome, entry.targetLabel, t);
      notify[result.status](result.message);
    } finally {
      setBusyIds((current) => {
        const next = new Set(current);
        next.delete(entry.id);
        return next;
      });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setReviewId(null);
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="max-h-[85vh] max-w-2xl overflow-y-auto"
        data-testid="edit-outbox-dialog"
      >
        {reviewing ? (
          <ConflictReview
            entry={reviewing}
            busy={busyIds.has(reviewing.id)}
            onBack={() => setReviewId(null)}
            onApply={async (decisions) => {
              await runSync(reviewing, decisions);
              setReviewId(null);
            }}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("editOutbox.title")}</DialogTitle>
              <DialogDescription>{t("editOutbox.description")}</DialogDescription>
            </DialogHeader>
            {!online && (
              <p className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm">
                <CloudOff className="h-4 w-4 shrink-0" aria-hidden="true" />
                {t("editOutbox.offlineNotice")}
              </p>
            )}
            {storageError ? (
              <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
                {t("editOutbox.storageUnreadable", { error: storageError })}
              </p>
            ) : null}
            {!durable && !storageError && (
              <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
                {t("editOutbox.notDurable")}
              </p>
            )}
            {entries.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("editOutbox.empty")}
              </p>
            ) : (
              <ul className="divide-y rounded-md border">
                {entries.map((entry) => (
                  <OutboxEntryRow
                    key={entry.id}
                    entry={entry}
                    busy={busyIds.has(entry.id) || entry.status === "syncing"}
                    onSync={() => void runSync(entry)}
                    onReview={() => setReviewId(entry.id)}
                    onDiscard={() => void discardOutboxEntry(entry.id)}
                  />
                ))}
              </ul>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("common.close")}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function OutboxEntryRow({
  entry,
  busy,
  onSync,
  onReview,
  onDiscard,
}: {
  entry: OutboxEntry;
  busy: boolean;
  onSync: () => void;
  onReview: () => void;
  onDiscard: () => void;
}) {
  const { t } = useTranslation();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const counts = countOps(entry.ops);
  const status = busy ? "syncing" : entry.status;
  return (
    <li className="space-y-1.5 px-3 py-2.5" data-testid="edit-outbox-entry">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{entry.layerName}</p>
          <p className="truncate text-xs text-muted-foreground">
            {t(`editOutbox.backend.${entry.backend}`)} · {entry.targetLabel}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 text-xs font-medium",
            status === "conflict" && "text-amber-700 dark:text-amber-300",
            status === "error" && "text-destructive",
          )}
        >
          {t(`editOutbox.entryStatus.${status}`)}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("editOutbox.counts", {
          inserted: counts.insert,
          updated: counts.update,
          deleted: counts.delete,
        })}
        {entry.nextAttemptAt && status === "pending"
          ? ` · ${t("editOutbox.nextRetry", { time: new Date(entry.nextAttemptAt).toLocaleTimeString() })}`
          : ""}
      </p>
      {entry.lastError && (
        <p
          className={cn(
            "break-words text-xs",
            entry.status === "pending" ? "text-muted-foreground" : "text-destructive",
          )}
        >
          {t("editOutbox.lastError", { error: describeEntryError(entry, t) })}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        {entry.status === "conflict" && entry.conflicts.length > 0 && (
          <Button type="button" size="sm" disabled={busy} onClick={onReview}>
            <AlertTriangle className="me-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {t("editOutbox.review", { count: entry.conflicts.length })}
          </Button>
        )}
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onSync}>
          {busy ? (
            <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="me-1.5 h-3.5 w-3.5" aria-hidden="true" />
          )}
          {t("editOutbox.syncNow")}
        </Button>
        {confirmDiscard ? (
          <>
            <span className="text-xs">{t("editOutbox.discardConfirm")}</span>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={onDiscard}
            >
              {t("editOutbox.discard")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setConfirmDiscard(false)}
            >
              {t("common.cancel")}
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setConfirmDiscard(true)}
          >
            <Trash2 className="me-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {t("editOutbox.discard")}
          </Button>
        )}
      </div>
    </li>
  );
}

function ConflictReview({
  entry,
  busy,
  onBack,
  onApply,
}: {
  entry: OutboxEntry;
  busy: boolean;
  onBack: () => void;
  onApply: (decisions: Map<string, ConflictResolution>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const opsById = useMemo(() => new Map(entry.ops.map((op) => [op.id, op])), [entry.ops]);
  const [decisions, setDecisions] = useState<Map<string, ConflictResolution>>(
    () =>
      new Map(
        entry.conflicts.map((conflict) => [
          conflict.opId,
          opsById.get(conflict.opId)?.resolution ?? "skip",
        ]),
      ),
  );
  const setAll = (resolution: ConflictResolution) =>
    setDecisions(new Map(entry.conflicts.map((conflict) => [conflict.opId, resolution])));
  const decided = [...decisions.values()].filter((value) => value !== "skip").length;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("editOutbox.conflictsTitle", { target: entry.targetLabel })}</DialogTitle>
        <DialogDescription>{t("editOutbox.conflictsDescription")}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => setAll("mine")}>
          {t("editOutbox.allMine")}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setAll("theirs")}>
          {t("editOutbox.allTheirs")}
        </Button>
      </div>
      <ul className="space-y-3">
        {entry.conflicts.map((conflict) => (
          <ConflictItem
            key={conflict.opId}
            conflict={conflict}
            mine={opsById.get(conflict.opId)?.feature}
            mineDeleted={opsById.get(conflict.opId)?.kind === "delete"}
            value={decisions.get(conflict.opId) ?? "skip"}
            onChange={(value) =>
              setDecisions((current) => new Map(current).set(conflict.opId, value))
            }
          />
        ))}
      </ul>
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="outline" disabled={busy} onClick={onBack}>
          {t("editOutbox.back")}
        </Button>
        <Button
          type="button"
          disabled={busy || decided === 0}
          onClick={() => void onApply(decisions)}
        >
          {busy && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />}
          {t("editOutbox.apply", { count: decided })}
        </Button>
      </div>
    </>
  );
}

function ConflictItem({
  conflict,
  mine,
  mineDeleted,
  value,
  onChange,
}: {
  conflict: OutboxConflict;
  mine: import("geojson").Feature | undefined;
  mineDeleted: boolean;
  value: ConflictResolution;
  onChange: (value: ConflictResolution) => void;
}) {
  const { t } = useTranslation();
  const diff = diffConflictVersions(mineDeleted ? undefined : mine, conflict.theirs);
  const choices: ConflictResolution[] = ["mine", "theirs", "skip"];
  const label: Record<ConflictResolution, string> = {
    // For my delete, keeping mine means deleting the server's version.
    mine: mineDeleted ? t("editOutbox.keepMineDelete") : t("editOutbox.keepMine"),
    theirs: t("editOutbox.keepTheirs"),
    skip: t("editOutbox.skip"),
  };
  return (
    <li className="rounded-md border p-3" data-testid="edit-outbox-conflict">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{t("editOutbox.feature", { key: conflict.key })}</p>
        <span className="text-xs text-amber-700 dark:text-amber-300">
          {t(`editOutbox.conflictReason.${conflict.reason}`)}
        </span>
      </div>
      {mineDeleted || !conflict.theirs ? (
        <p className="mb-2 text-xs text-muted-foreground">
          {mineDeleted ? t("editOutbox.mineDeleted") : t("editOutbox.theirsDeleted")}
        </p>
      ) : null}
      {diff.attributes.length > 0 && (
        <table className="mb-2 w-full table-fixed text-xs">
          <thead>
            <tr className="text-muted-foreground">
              <th className="w-1/3 pe-2 text-start font-normal">{t("editOutbox.attribute")}</th>
              <th className="pe-2 text-start font-normal">{t("editOutbox.mine")}</th>
              <th className="text-start font-normal">{t("editOutbox.theirs")}</th>
            </tr>
          </thead>
          <tbody>
            {diff.attributes.map((attribute) => (
              <tr key={attribute.name} className="border-t align-top">
                <td className="truncate py-1 pe-2 font-mono">{attribute.name}</td>
                <td className="break-words py-1 pe-2">{formatAttributeValue(attribute.mine)}</td>
                <td className="break-words py-1">{formatAttributeValue(attribute.theirs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {diff.geometryDiffers && !mineDeleted && conflict.theirs && (
        <p className="mb-2 text-xs text-muted-foreground">{t("editOutbox.geometryDiffers")}</p>
      )}
      {/* Native radios: one tab stop, arrow keys move between the choices. */}
      <fieldset className="flex flex-wrap gap-1.5">
        <legend className="sr-only">{t("editOutbox.feature", { key: conflict.key })}</legend>
        {choices.map((choice) => (
          <label
            key={choice}
            className={cn(
              "cursor-pointer rounded-md border px-2.5 py-1 text-xs has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
              value === choice
                ? "border-primary bg-primary text-primary-foreground"
                : "hover:bg-accent hover:text-accent-foreground",
            )}
          >
            <input
              type="radio"
              className="sr-only"
              name={`conflict-${conflict.opId}`}
              value={choice}
              checked={value === choice}
              onChange={() => onChange(choice)}
            />
            {label[choice]}
          </label>
        ))}
      </fieldset>
    </li>
  );
}

/**
 * The translated message for an entry's last error when its code is known,
 * else the source's own message.
 *
 * @param entry The entry.
 * @param t Translator.
 * @returns Display text.
 */
function describeEntryError(entry: OutboxEntry, t: TFunction): string {
  switch (entry.lastErrorCode) {
    case "postgisNoConnection":
      return t("editOutbox.errors.postgisNoConnection");
    case "arcgisLayerClosed":
      return t("editOutbox.errors.arcgisLayerClosed");
    case "geolensNotConnected":
      return t("editOutbox.errors.geolensNotConnected");
    default:
      return entry.lastError ?? "";
  }
}
