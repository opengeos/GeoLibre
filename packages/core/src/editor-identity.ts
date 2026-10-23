import { EDITOR_IDENTITY_STORAGE_KEY, pickEditorIdentity } from "./editor-tracking";
import { useAppStore } from "./store";

/**
 * Runtime resolution of "who is editing", for the editor tracking stamps.
 *
 * Split from the pure `editor-tracking.ts` helpers because it reads two ambient
 * sources — the collaboration session in the store and `localStorage` — which
 * the stamping functions must stay free of so they remain unit-testable and
 * usable from Node (the MCP server authors projects without either).
 */

/**
 * The display name this browser edits under, or `""` when none is set.
 *
 * `localStorage` throws rather than returning null in a partitioned or
 * storage-blocked context (Safari private browsing, an embed in a third-party
 * iframe), so a failure here has to read as "no name set" — an editor whose
 * browser refuses storage must still be able to edit.
 */
export function readStoredAuthorName(): string {
  try {
    if (typeof localStorage === "undefined") return "";
    return localStorage.getItem(EDITOR_IDENTITY_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

/**
 * Persist the display name to edit under. A blank name clears it, so the user
 * can go back to the anonymous default rather than being stuck with a typo.
 */
export function setStoredAuthorName(name: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    const trimmed = name.trim();
    if (trimmed) {
      localStorage.setItem(EDITOR_IDENTITY_STORAGE_KEY, trimmed);
    } else {
      localStorage.removeItem(EDITOR_IDENTITY_STORAGE_KEY);
    }
  } catch {
    // Storage unavailable: the name applies to this session only.
  }
}

/**
 * The identity to stamp on edits made right now: the collaboration session's
 * name when one is active, else the locally configured name, else the anonymous
 * default.
 *
 * @returns A non-empty identity string.
 */
export function currentEditorIdentity(): string {
  const { isActive, selfName } = useAppStore.getState().collaboration;
  return pickEditorIdentity(isActive ? selfName : undefined, readStoredAuthorName());
}
