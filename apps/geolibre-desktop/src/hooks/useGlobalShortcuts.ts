import { useEffect, useMemo, useRef } from "react";
import {
  type Command,
  PALETTE_SHORTCUT,
  SHORTCUTS_HELP_SHORTCUT,
  isEditableTarget,
  isMacPlatform,
  matchesShortcut,
} from "../lib/commands";

interface UseGlobalShortcutsOptions {
  /** The current command registry; commands with a `shortcut` are bound. */
  commands: Command[];
  /** Opens the command palette (Cmd/Ctrl-K). */
  onOpenPalette: () => void;
  /** Opens the keyboard shortcuts cheat sheet (?). */
  onOpenShortcuts: () => void;
  /** When false, no listener is attached. */
  enabled?: boolean;
}

/**
 * Centralized global hotkey layer. Attaches a single window keydown listener
 * that opens the command palette, opens the cheat sheet, and runs any command
 * whose `shortcut` matches. Shortcuts are ignored while the user is typing in a
 * text field. Bare-letter shortcuts (e.g. "N"/"R" for the camera resets) only
 * use keys MapLibre does not bind, so its own arrow/zoom key handling on the
 * focused canvas is left untouched.
 */
export function useGlobalShortcuts({
  commands,
  onOpenPalette,
  onOpenShortcuts,
  enabled = true,
}: UseGlobalShortcutsOptions): void {
  const isMac = useMemo(() => isMacPlatform(), []);
  // Keep the latest values in refs so the listener can stay attached without
  // re-binding on every render (the command array is rebuilt frequently).
  const commandsRef = useRef(commands);
  const onOpenPaletteRef = useRef(onOpenPalette);
  const onOpenShortcutsRef = useRef(onOpenShortcuts);
  commandsRef.current = commands;
  onOpenPaletteRef.current = onOpenPalette;
  onOpenShortcutsRef.current = onOpenShortcuts;

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      // Respect anything that already handled the event (e.g. an open dialog's
      // own key handling) and skip while typing in inputs.
      if (event.defaultPrevented) return;
      if (event.repeat) return;
      if (isEditableTarget(event.target)) return;

      if (matchesShortcut(event, PALETTE_SHORTCUT, isMac)) {
        event.preventDefault();
        onOpenPaletteRef.current();
        return;
      }
      if (matchesShortcut(event, SHORTCUTS_HELP_SHORTCUT, isMac)) {
        event.preventDefault();
        onOpenShortcutsRef.current();
        return;
      }
      for (const command of commandsRef.current) {
        if (command.shortcut && matchesShortcut(event, command.shortcut, isMac)) {
          event.preventDefault();
          command.run();
          return;
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, isMac]);
}
