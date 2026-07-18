import { redo, undo, useAppStore } from "@geolibre/core";
import { useEffect } from "react";

/** True when focus is in a text-editing surface (let the browser handle undo). */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  // SELECT is intentionally omitted: a <select> has no native text undo, so we
  // let the app's undo/redo run even when one is focused.
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

/**
 * Global Ctrl/Cmd+Z (undo) and Ctrl/Cmd+Shift+Z / Ctrl+Y (redo) shortcuts for
 * layer + style history. Ignored while editing text. Mount once at the app root.
 */
export function useUndoRedoShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (isEditableTarget(e.target)) return;
      const key = e.key.toLowerCase();
      // Ctrl/Cmd+Shift+Z, or the Windows-style Ctrl+Y (Ctrl only, not Cmd+Y).
      const isRedo = (key === "z" && e.shiftKey) || (key === "y" && e.ctrlKey && !e.shiftKey);
      const isUndo = key === "z" && !e.shiftKey;
      if (!isUndo && !isRedo) return;
      // Only consume the event when there is actually something to do, so an
      // empty stack doesn't swallow the browser/OS shortcut (e.g. Cmd+Y).
      const temporal = useAppStore.temporal.getState();
      if (isRedo && temporal.futureStates.length > 0) {
        e.preventDefault();
        redo();
      } else if (isUndo && temporal.pastStates.length > 0) {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
