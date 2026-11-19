/**
 * Ask before an action drops the attribute table's unsaved drafts.
 *
 * Drafts live in the session's UI state, not in the project, so saving the
 * project does not keep them and they never mark it dirty. Closing the desktop
 * window, starting a new project, or opening, importing, restoring or
 * duplicating one replaces the session and loses them, so each of those asks
 * here first (GeoLibre#3531). The browser's leave-page prompt counts them
 * through `hasUnsavedWork` instead.
 */

import { useAppStore } from "@geolibre/core";
import i18next from "i18next";

/** The part of the store {@link pendingAttributeDraftLayerNames} reads. */
export interface AttributeDraftGuardState {
  /** Project layers, for their display names. */
  layers: readonly { id: string; name: string }[];
  /** UI state holding the per-layer draft sessions. */
  ui: { attributeTableDrafts: Record<string, unknown> };
}

/**
 * Names of the layers that hold unsaved attribute table drafts.
 *
 * Args:
 *   state: The store's layers and UI state.
 *
 * Returns:
 *   The layer names in Layers panel order; a draft whose layer is gone is
 *   skipped, since nothing is left to lose.
 */
export function pendingAttributeDraftLayerNames(state: AttributeDraftGuardState): string[] {
  const drafts = state.ui.attributeTableDrafts;
  return state.layers.filter((layer) => Object.hasOwn(drafts, layer.id)).map((layer) => layer.name);
}

/**
 * Confirm discarding unsaved attribute table drafts before they are lost.
 *
 * Call it right before the session is replaced, after any file picker has
 * returned, so the prompt never spends the user gesture a picker needs.
 *
 * Args:
 *   confirm: Shows the question and returns the answer; the browser's
 *     blocking `window.confirm` by default, as the app's drop guards use.
 *
 * Returns:
 *   True when there are no drafts or the user agrees to discard them.
 */
export function confirmDiscardAttributeDrafts(
  confirm: (message: string) => boolean = (message) => window.confirm(message),
): boolean {
  const names = pendingAttributeDraftLayerNames(useAppStore.getState());
  if (names.length === 0) return true;
  const layers = new Intl.ListFormat(i18next.language || undefined, {
    type: "conjunction",
  }).format(names);
  return confirm(i18next.t("attributeTable.discardDraftsConfirm", { count: names.length, layers }));
}
