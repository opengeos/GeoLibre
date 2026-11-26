/**
 * Status bar indicator for the offline edit outbox (#3530): shows how many
 * edits are waiting (and whether any need review), and opens the Pending
 * edits dialog. Hidden while the outbox is empty and the app is online. The
 * background sync itself runs from `useEditOutboxRunner`.
 */

import { cn } from "@geolibre/ui";
import { AlertTriangle, CloudOff, CloudUpload } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { countOps } from "../../lib/edit-sync/edit-outbox";
import { isNavigatorOnline } from "../../lib/edit-sync/edit-outbox-runner";
import { getOutboxSnapshot, subscribeOutbox } from "../../lib/edit-sync/edit-outbox-store";
import { EditOutboxDialog } from "./EditOutboxDialog";

function subscribeOnline(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

export function EditOutboxStatus({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const snapshot = useSyncExternalStore(subscribeOutbox, getOutboxSnapshot, getOutboxSnapshot);
  const online = useSyncExternalStore(subscribeOnline, isNavigatorOnline, () => true);

  const pending = snapshot.entries.reduce((sum, entry) => {
    const counts = countOps(entry.ops);
    return sum + counts.insert + counts.update + counts.delete;
  }, 0);
  const needsReview = snapshot.entries.some(
    (entry) => entry.status === "conflict" || entry.status === "error",
  );

  const unreadable = Boolean(snapshot.storageError);
  const hidden = pending === 0 && online && !unreadable;
  if (hidden && !open) return null;

  const label =
    pending === 0
      ? unreadable
        ? t("editOutbox.statusUnreadable")
        : t("editOutbox.statusOffline")
      : needsReview
        ? t("editOutbox.statusReview", { count: pending })
        : t("editOutbox.status", { count: pending });
  const Icon = needsReview || unreadable ? AlertTriangle : online ? CloudUpload : CloudOff;

  // One tree whether or not the button shows, so an open dialog (and a
  // conflict review in it) survives the last edit syncing or a network change.
  return (
    <>
      {hidden ? null : (
        <button
          type="button"
          data-testid="edit-outbox-status"
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent hover:text-accent-foreground",
            (needsReview || unreadable) && "text-amber-700 dark:text-amber-300",
          )}
          title={t("editOutbox.title")}
          onClick={() => setOpen(true)}
        >
          <Icon className="h-3 w-3" aria-hidden="true" />
          {compact ? pending : label}
        </button>
      )}
      <EditOutboxDialog
        open={open}
        onOpenChange={setOpen}
        entries={snapshot.entries}
        online={online}
        durable={snapshot.durable}
        storageError={snapshot.storageError}
      />
    </>
  );
}
