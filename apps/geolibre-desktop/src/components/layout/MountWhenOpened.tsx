import { useAppStore, type AppState } from "@geolibre/core";
import { useState, type ReactNode } from "react";

/**
 * Defers rendering a code-split dialog or panel until it is first opened.
 *
 * `React.lazy` fetches a chunk the first time its component renders, even when
 * that component immediately returns `null` because it is closed. Rendering the
 * lazy tool dialogs unconditionally therefore downloaded all of them right
 * after startup. This wrapper holds the children back until `isOpen` first
 * returns true, then keeps them mounted so a job that is still running, or
 * state the user left behind, survives closing the dialog.
 *
 * The open flag is read here rather than in the shell so opening a dialog
 * re-renders only this wrapper. `isOpen` selects a value from the UI slice
 * that is truthy while the child is open.
 */
export function MountWhenOpened({
  isOpen,
  children,
}: {
  isOpen: (ui: AppState["ui"]) => unknown;
  children: ReactNode;
}) {
  const open = useAppStore((s) => Boolean(isOpen(s.ui)));
  const [opened, setOpened] = useState(open);
  // Updating state during render is React's documented way to derive state
  // from a changing value without an extra committed render.
  if (open && !opened) setOpened(true);
  return opened || open ? children : null;
}
