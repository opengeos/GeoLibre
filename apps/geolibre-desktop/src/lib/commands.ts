import type { LucideIcon } from "lucide-react";

/**
 * A keyboard shortcut definition. `mod` maps to ⌘ on macOS and Ctrl
 * elsewhere, so the same definition works cross-platform.
 */
export interface Shortcut {
  /** The `KeyboardEvent.key` to match (case-insensitive for letters). */
  key: string;
  /** Requires the platform command/control modifier (⌘ on macOS, Ctrl elsewhere). */
  mod?: boolean;
  /** Requires (true) or forbids (false) the Shift modifier. Ignored when undefined. */
  shift?: boolean;
  /** Requires (true) or forbids (false) the Alt/Option modifier. Defaults to forbidden. */
  alt?: boolean;
}

/**
 * A single invocable action. The command registry is the single source of
 * truth shared by the command palette, the global shortcut layer, and the
 * keyboard cheat sheet.
 */
export interface Command {
  /** Stable unique id (used as React key and for tests). */
  id: string;
  /** Human-readable label shown in the palette and cheat sheet. */
  title: string;
  /** Grouping label (e.g. "Project", "Add Data"). */
  group: string;
  /** Extra search terms that should match this command in the palette. */
  keywords?: string;
  /** Optional global hotkey that triggers `run` without opening the palette. */
  shortcut?: Shortcut;
  /** Optional icon shown beside the command in the palette. */
  icon?: LucideIcon;
  /** Invoked when the command is selected or its shortcut is pressed. */
  run: () => void;
}

/** The shortcut that opens the command palette. */
export const PALETTE_SHORTCUT: Shortcut = { key: "k", mod: true };

/** The shortcut that opens the keyboard shortcuts cheat sheet. */
export const SHORTCUTS_HELP_SHORTCUT: Shortcut = { key: "?" };

/**
 * Detect whether the current platform is macOS, so shortcuts can prefer ⌘
 * over Ctrl. Falls back to false in non-browser (test) environments.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  // navigator.platform is deprecated but still the most reliable signal across
  // the browsers and webviews this app targets; userAgent is the fallback.
  const platform = navigator.platform || navigator.userAgent || "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * Whether a keyboard event originated from a text-entry control, where global
 * shortcuts must not fire (so typing "s" doesn't trigger Save, etc.).
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

/**
 * Test a keyboard event against a shortcut definition for the given platform.
 * Requires the exact modifier combination so e.g. ⌘S and ⇧⌘S stay distinct,
 * and rejects the non-platform command modifier to avoid accidental matches.
 */
export function matchesShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  shortcut: Shortcut,
  isMac: boolean,
): boolean {
  if (event.key.toLowerCase() !== shortcut.key.toLowerCase()) return false;

  const modPressed = isMac ? event.metaKey : event.ctrlKey;
  const otherModPressed = isMac ? event.ctrlKey : event.metaKey;
  if (Boolean(shortcut.mod) !== modPressed) return false;
  // Never let the non-platform command key satisfy a match (e.g. Ctrl+⌘+S on
  // macOS should not fire ⌘S).
  if (otherModPressed) return false;

  // `alt` and `shift` default differently on purpose:
  //   - alt: omitted means *forbidden*. Alt is never part of an app shortcut,
  //     and on some keyboard layouts Alt+key produces a character, so a held
  //     Alt must not accidentally satisfy a match.
  //   - shift: omitted means *ignored*. Shifted symbol keys such as "?" carry
  //     Shift in the event, so requiring its absence would break them.
  // For letter shortcuts that have a distinct shifted variant (e.g. Save vs
  // Save As), set `shift` explicitly on both so they stay unambiguous.
  if (Boolean(shortcut.alt) !== event.altKey) return false;
  if (shortcut.shift !== undefined && shortcut.shift !== event.shiftKey) {
    return false;
  }
  return true;
}

/**
 * Render a shortcut as a display string, e.g. "⌘K" / "⇧⌘S" on macOS or
 * "Ctrl+K" / "Ctrl+Shift+S" elsewhere.
 */
export function formatShortcut(shortcut: Shortcut, isMac: boolean): string {
  const parts: string[] = [];
  if (isMac) {
    if (shortcut.alt) parts.push("⌥");
    if (shortcut.shift) parts.push("⇧");
    if (shortcut.mod) parts.push("⌘");
    parts.push(formatKey(shortcut.key));
    return parts.join("");
  }
  if (shortcut.mod) parts.push("Ctrl");
  if (shortcut.shift) parts.push("Shift");
  if (shortcut.alt) parts.push("Alt");
  parts.push(formatKey(shortcut.key));
  return parts.join("+");
}

function formatKey(key: string): string {
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/**
 * Filter and rank commands for a palette query. Matching is token-based: every
 * whitespace-separated token in the query must appear in the command's title,
 * group, or keywords. Title-prefix matches rank ahead of other matches, and
 * the original registry order is preserved within each rank.
 */
export function filterCommands(commands: Command[], query: string): Command[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return commands;
  const tokens = trimmed.split(/\s+/);

  const scored: Array<{ command: Command; rank: number; index: number }> = [];
  commands.forEach((command, index) => {
    const title = command.title.toLowerCase();
    const haystack = `${title} ${command.group.toLowerCase()} ${
      command.keywords?.toLowerCase() ?? ""
    }`;
    if (!tokens.every((token) => haystack.includes(token))) return;
    const rank = title.startsWith(trimmed) ? 0 : 1;
    scored.push({ command, rank, index });
  });

  scored.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return scored.map((entry) => entry.command);
}
