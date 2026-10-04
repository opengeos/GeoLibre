/**
 * The import status messages (drag-and-drop, Add Data, DuckDB materialize) on
 * the app's notification channel (issue #2858). The callers keep the setter
 * shape they had when these were React state, so each import path reads the
 * same; only where the message shows changed.
 *
 * - a status message ("Importing data…", "Added 3 layers") is one info toast
 *   that each new message replaces, until it is cleared;
 * - an import error is a warning toast: most are about the file (unparseable,
 *   no GPS tags), not a GeoLibre bug, so they carry no "Report issue";
 * - the CRS warning (a layer that loaded but sits nowhere near its data's
 *   real location) is a warning that stays until dismissed, as it did.
 */
import { dismissNotification, notify, useNotificationStore } from "./notify";

function isShowing(id: string): boolean {
  return useNotificationStore.getState().notifications.some((item) => item.id === id);
}

/** A value, or an updater from the current value (React's `SetStateAction`). */
type MessageUpdate = string | null | ((current: string | null) => string | null);

export interface DropStatusNotifier {
  /** Shows, replaces, or (with `null`) clears the status toast. */
  setDropMessage(update: MessageUpdate): void;
  /** Shows, replaces, or (with `null`) clears the import-error toast. */
  setDropError(update: MessageUpdate): void;
  /** Shows, replaces, or (with `null`) clears the CRS warning toast. */
  setCrsWarning(update: MessageUpdate): void;
  /** Clears the status toast after {@link DROP_MESSAGE_CLEAR_MS}. */
  clearDropMessageLater(): void;
  /** Cancels the pending clear. The toasts themselves stay. */
  dispose(): void;
}

/** How long a finished import's status stays up. */
export const DROP_MESSAGE_CLEAR_MS = 4000;

interface Slot {
  message: string | null;
  id: string | null;
}

/**
 * Creates the notifier. One per shell.
 *
 * @returns The setters the import hooks call.
 */
export function createDropStatusNotifier(): DropStatusNotifier {
  const status: Slot = { message: null, id: null };
  const error: Slot = { message: null, id: null };
  const crs: Slot = { message: null, id: null };
  let clearTimer: ReturnType<typeof setTimeout> | null = null;

  const update = (slot: Slot, next: MessageUpdate, show: (message: string) => string) => {
    // The user may have dismissed the toast, or it timed out: then the slot no
    // longer shows anything, and the same message must show again.
    if (slot.id && !isShowing(slot.id)) {
      slot.id = null;
      slot.message = null;
    }
    const message = typeof next === "function" ? next(slot.message) : next;
    if (message === slot.message) return;
    if (slot.id) dismissNotification(slot.id);
    slot.message = message;
    slot.id = message ? show(message) : null;
  };

  return {
    setDropMessage(next) {
      update(status, next, (message) => notify.info(message, { durationMs: null }));
    },
    setDropError(next) {
      update(error, next, (message) => {
        // The error replaces any progress message, which it supersedes.
        if (status.id) dismissNotification(status.id);
        status.id = null;
        status.message = null;
        return notify.warning(message, { dedupeKey: "drop-status:error" });
      });
    },
    setCrsWarning(next) {
      update(crs, next, (message) =>
        notify.warning(message, { durationMs: null, dedupeKey: "drop-status:crs" }),
      );
    },
    clearDropMessageLater() {
      if (clearTimer !== null) clearTimeout(clearTimer);
      clearTimer = setTimeout(() => {
        clearTimer = null;
        update(status, null, () => "");
      }, DROP_MESSAGE_CLEAR_MS);
    },
    dispose() {
      if (clearTimer !== null) clearTimeout(clearTimer);
      clearTimer = null;
    },
  };
}
