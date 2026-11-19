import type { ReactNode } from "react";

export interface TouchMenuActionItem {
  kind: "action";
  id: string;
  label: string;
  description?: string;
  keywords?: string;
  badge?: string;
  active?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  icon?: ReactNode;
  onSelect: () => void;
}

export interface TouchMenuSubmenuItem {
  kind: "submenu";
  id: string;
  label: string;
  description?: string;
  badge?: string;
  disabled?: boolean;
  icon?: ReactNode;
  items: readonly TouchMenuItem[];
}

export interface TouchMenuSectionItem {
  kind: "section";
  id: string;
  label: string;
  items: readonly TouchMenuItem[];
}

export type TouchMenuItem = TouchMenuActionItem | TouchMenuSubmenuItem | TouchMenuSectionItem;

export interface ResolvedTouchMenuPage {
  /** Validated submenu id path from root to the active page. */
  path: string[];
  /** Title displayed in the header for the active page. */
  title: string;
  /** Parent page title for the Back button aria-label, or null at root. */
  parentTitle: string | null;
  /** Items displayed on the active page. */
  items: readonly TouchMenuItem[];
}

export interface TouchMenuSearchMatch {
  item: TouchMenuActionItem;
  /** Category/submenu breadcrumb trail leading to this action. */
  trail: string[];
}

/**
 * Remove empty sections and submenus recursively so profile/capability gates
 * never leave behind dead-end navigation entries.
 */
export function pruneEmptyTouchMenuItems(items: readonly TouchMenuItem[]): TouchMenuItem[] {
  const result: TouchMenuItem[] = [];
  for (const item of items) {
    if (item.kind === "action") {
      result.push(item);
      continue;
    }
    const children = pruneEmptyTouchMenuItems(item.items);
    if (children.length === 0) continue;
    result.push({ ...item, items: children });
  }
  return result;
}

function findSubmenuInItems(
  items: readonly TouchMenuItem[],
  id: string,
): TouchMenuSubmenuItem | null {
  for (const item of items) {
    if (item.kind === "submenu" && item.id === id) return item;
    if (item.kind === "section") {
      const nested = findSubmenuInItems(item.items, id);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Resolve the currently active drill-down page for `path`. Stale or hidden path
 * segments are clamped cleanly back to the deepest valid ancestor.
 */
export function resolveTouchMenuPage(
  rootTitle: string,
  rootItems: readonly TouchMenuItem[],
  path: readonly string[],
): ResolvedTouchMenuPage {
  let title = rootTitle;
  let parentTitle: string | null = null;
  let currentItems = rootItems;
  const resolvedPath: string[] = [];

  for (const segment of path) {
    const submenu = findSubmenuInItems(currentItems, segment);
    if (!submenu || submenu.disabled) break;
    parentTitle = title;
    title = submenu.label;
    currentItems = submenu.items;
    resolvedPath.push(segment);
  }

  return {
    path: resolvedPath,
    title,
    parentTitle,
    items: currentItems,
  };
}

/**
 * Search across every nested action in `items` by label, description, keywords,
 * or ancestor section/submenu trail. Multi-word queries require all tokens.
 */
export function filterTouchMenuItems(
  items: readonly TouchMenuItem[],
  rawQuery: string,
): TouchMenuSearchMatch[] {
  const tokens = rawQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const matches: TouchMenuSearchMatch[] = [];
  const visit = (nodes: readonly TouchMenuItem[], trail: readonly string[]) => {
    for (const node of nodes) {
      if (node.kind === "action") {
        const haystack = [node.label, node.description ?? "", node.keywords ?? "", ...trail]
          .join(" ")
          .toLowerCase();
        if (tokens.every((token) => haystack.includes(token))) {
          matches.push({ item: node, trail: [...trail] });
        }
      } else if (node.kind === "submenu") {
        if (node.disabled) continue;
        visit(node.items, [...trail, node.label]);
      } else {
        visit(node.items, [...trail, node.label]);
      }
    }
  };

  visit(items, []);
  return matches;
}

/** Hold duration (ms) before a touch press on a layer grip activates drag-reorder. */
export const LAYER_TOUCH_DRAG_HOLD_MS = 150;

/** Maximum finger drift (px) allowed while waiting for touch-hold drag activation. */
export const LAYER_TOUCH_DRAG_SCROLL_TOLERANCE_PX = 10;

/** Mouse pointer drag activation threshold (px). */
export const LAYER_MOUSE_DRAG_THRESHOLD_PX = 4;

/**
 * Determine whether a pending pointer drag gesture on a layer grip should
 * activate, stay pending, or cancel to yield to native vertical scrolling.
 */
export function evaluateLayerDragActivation(input: {
  pointerType: string;
  distancePx: number;
  elapsedMs: number;
}): "activate" | "pending" | "cancel" {
  if (input.pointerType === "touch") {
    if (input.elapsedMs >= LAYER_TOUCH_DRAG_HOLD_MS) return "activate";
    if (input.distancePx > LAYER_TOUCH_DRAG_SCROLL_TOLERANCE_PX) return "cancel";
    return "pending";
  }
  return input.distancePx >= LAYER_MOUSE_DRAG_THRESHOLD_PX ? "activate" : "pending";
}
