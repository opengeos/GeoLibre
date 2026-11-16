// Decides how a live-collaboration client reacts to its own local project edits
// when it cannot share them (#3477). Kept pure so the policy is unit-testable
// without a socket or the React hook that owns the refs.

import i18n from "../i18n";
import { notify } from "./notify";

export interface LocalChangeContext {
  /** A session is live (the welcome has arrived). */
  active: boolean;
  /** The change came from a peer's snapshot being applied, not from this user. */
  applyingRemote: boolean;
  /** This participant may currently send snapshots. */
  canEdit: boolean;
  /** The view-only notice was already shown for the current view-only stretch. */
  noticeShown: boolean;
}

/**
 * What to do about a local project change while a session is live:
 * `"notify"` tells a view-only participant once that the change stays on their
 * screen, `"reset"` re-arms that notice after they regain edit rights, and
 * `"none"` leaves everything as is.
 */
export function viewOnlyLocalChangeAction(
  context: LocalChangeContext,
): "notify" | "reset" | "none" {
  if (!context.active || context.applyingRemote) return "none";
  if (context.canEdit) return context.noticeShown ? "reset" : "none";
  return context.noticeShown ? "none" : "notify";
}

/**
 * Tracks the one-time view-only notice across a session's local changes.
 *
 * @param show Shows the notice; defaults to an info toast.
 * @returns `onLocalChange`, called for every local project change, and
 *   `reset`, called when a new session starts.
 */
export function createViewOnlyNotice(
  show: () => void = () =>
    notify.info(i18n.t("collaborate.viewOnlyLocalChange"), {
      dedupeKey: "collab-view-only-local-change",
    }),
): {
  onLocalChange: (context: Omit<LocalChangeContext, "noticeShown">) => void;
  reset: () => void;
} {
  let shown = false;
  return {
    onLocalChange(context) {
      const action = viewOnlyLocalChangeAction({ ...context, noticeShown: shown });
      if (action === "reset") shown = false;
      if (action === "notify") {
        shown = true;
        show();
      }
    },
    reset() {
      shown = false;
    },
  };
}

/**
 * Report a snapshot the relay refused for touching a host-locked layer. It is
 * transient, not a session error: the relay follows the refusal with the
 * session's project, which undoes the change, so it is a toast rather than an
 * error left in the Collaborate dialog.
 *
 * @param detail The relay's message, naming the locked layer.
 */
export function notifyLayerLockedRejection(detail: string): void {
  notify.warning(i18n.t("collaborate.layerLockedRejected"), {
    description: detail,
    dedupeKey: "collab-layer-locked",
  });
}
