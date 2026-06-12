import { redo, undo, useAppStore } from "@geolibre/core";
import { useEffect } from "react";

/** True when focus is in a text-editing surface (let the browser handle undo). */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
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
      const isRedo =
        (key === "z" && e.shiftKey) || (key === "y" && !e.shiftKey);
      const isUndo = key === "z" && !e.shiftKey;
      if (!isUndo && !isRedo) return;
      e.preventDefault();
      if (isRedo) {
        if (useAppStore.temporal.getState().futureStates.length > 0) redo();
      } else if (useAppStore.temporal.getState().pastStates.length > 0) {
        undo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
