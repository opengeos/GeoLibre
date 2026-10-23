/**
 * Resolver for plugin toolbar menu labels, which may be a literal string or a
 * getter re-read on every render.
 *
 * Panel titles have accepted `string | (() => string)` since they landed, so a
 * plugin could keep its right-panel and floating-panel headers in step with the
 * app language. Toolbar menu, submenu and action labels were plain strings, so a
 * plugin's menu froze at whatever language was active when it registered
 * (GeoLibre#2021). This mirrors {@link PanelTitleResolver}'s contract for the
 * menu tree: a getter is invoked on each read, a throwing or empty getter
 * degrades to a supplied fallback, and each distinct label path warns at most
 * once so a misbehaving getter cannot flood the console — `PluginToolbarMenus`
 * re-renders the whole tree on every open and on every language change.
 *
 * Unlike the panel registries there is no per-registration `set()` step: menu
 * items are anonymous nodes in a tree, so the dedup key is the caller-supplied
 * label path (`"<menuId>.<itemId>"`). One consequence: where
 * `PanelTitleResolver` clears a panel's dedup on re-registration, a path here
 * stays warned for the session, so a plugin that fixes a broken getter and
 * re-registers its menu will not log again for that path. That is the accepted
 * trade for not tracking per-menu state; `resetToolbarLabelWarnings` clears it
 * (used by the tests).
 */

/** A label that is either literal text or a getter returning it. */
export type GeoLibreToolbarLabel = string | (() => string);

/** Label paths that have already logged a resolver failure. */
const warned = new Set<string>();

/**
 * Resolve a menu label to display text.
 *
 * `path` identifies the label for warning dedup and is the last-resort fallback
 * when a getter throws or yields nothing usable, so pass something a plugin
 * author can act on (the menu/item id path).
 */
export function resolveToolbarLabel(label: GeoLibreToolbarLabel, path: string): string {
  let resolved: unknown;
  try {
    resolved = typeof label === "function" ? label() : label;
  } catch (error) {
    if (!warned.has(path)) {
      warned.add(path);
      console.error(`Toolbar menu label "${path}" resolver threw.`, error);
    }
    return path;
  }
  // A getter wired to an i18n key can legitimately return "" before its catalog
  // loads; degrade to the path so the item stays clickable and the problem is
  // visible, and let a later re-render pick up the real value.
  if (typeof resolved !== "string" || resolved.length === 0) {
    if (!warned.has(path)) {
      warned.add(path);
      console.warn(
        `Toolbar menu label "${path}" resolver returned ${
          resolved === "" ? "an empty string" : "a non-string value"
        }; falling back to the label path.`,
      );
    }
    return path;
  }
  return resolved;
}

/**
 * Whether a value is usable as a toolbar label. Used by the registry to reject a
 * malformed registration up front; a getter's *return* value can only be checked
 * when it is read, which `resolveToolbarLabel` handles.
 */
export function isToolbarLabel(value: unknown): value is GeoLibreToolbarLabel {
  if (typeof value === "function") return true;
  return typeof value === "string" && value.length > 0;
}

/** Clear the warning dedup (test reset). */
export function resetToolbarLabelWarnings(): void {
  warned.clear();
}
