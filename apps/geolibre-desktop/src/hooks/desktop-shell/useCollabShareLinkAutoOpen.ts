import { useEffect } from "react";
import type { useCollaboration } from "../useCollaboration";

/**
 * Opens the Collaborate dialog when the app was opened from a `?collab=` link.
 *
 * @param collaboration - The shell's live-collaboration session.
 * @param setCollaborateDialogOpen - Store action that opens the dialog.
 */
export function useCollabShareLinkAutoOpen(
  collaboration: ReturnType<typeof useCollaboration>,
  setCollaborateDialogOpen: (open: boolean) => void,
): void {
  // When opened via a `?collab=<code>` share link, auto-open the Collaborate
  // dialog (which prefills the code) so the recipient only picks a name and
  // joins, instead of having to find the Project menu first.
  useEffect(() => {
    if (!collaboration.enabled) return;
    if (new URLSearchParams(window.location.search).get("collab")) {
      setCollaborateDialogOpen(true);
    }
  }, [collaboration.enabled, setCollaborateDialogOpen]);
}
