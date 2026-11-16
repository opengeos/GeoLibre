// Decides how a live-collaboration client reacts to its own local project edits
// when it cannot share them (#3477). Kept pure so the policy is unit-testable
// without a socket or the React hook that owns the refs.

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
