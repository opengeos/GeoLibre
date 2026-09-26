/**
 * Query parameter that deep-links to one or more built-in plugins, e.g.
 * `…/?plugin=maplibre-gl-swipe` or `…/?plugin=swipe,graticule`. Opening the app
 * with it activates those plugins as if picked from the Plugins menu.
 */
export const PLUGIN_DEEP_LINK_PARAM = "plugin";

/**
 * Id prefixes a short plugin name may omit, longest first so
 * `maplibre-gl-swipe` shortens to `swipe` rather than `gl-swipe`.
 */
const SHORT_NAME_PREFIXES = ["maplibre-gl-", "maplibre-", "geolibre-"] as const;

/**
 * The short name for a plugin id: the id with its first matching
 * {@link SHORT_NAME_PREFIXES} entry removed, or `null` when none matches.
 *
 * @param id - A plugin id.
 * @returns The short name, or `null`.
 */
function shortName(id: string): string | null {
  for (const prefix of SHORT_NAME_PREFIXES) {
    if (id.startsWith(prefix) && id.length > prefix.length) return id.slice(prefix.length);
  }
  return null;
}

/**
 * Maps each lowercased short name to the plugin id it resolves to, or to
 * `null` when more than one plugin shares it.
 *
 * @param ids - The plugin ids a deep link may activate.
 * @returns The short-name index.
 */
function shortNameIndex(ids: Iterable<string>): Map<string, string | null> {
  const byShortName = new Map<string, string | null>();
  for (const id of ids) {
    const short = shortName(id)?.toLowerCase();
    if (!short) continue;
    byShortName.set(short, byShortName.has(short) ? null : id);
  }
  return byShortName;
}

/**
 * The name to write in a `?plugin=` link for each allowed plugin: its short
 * name when that resolves to it alone, otherwise its full id. Sorted, so the
 * list reads the same wherever it is shown.
 *
 * @param allowedIds - The plugin ids a deep link may activate.
 * @returns One link name per plugin.
 */
export function pluginDeepLinkNames(allowedIds: Iterable<string>): string[] {
  const ids = [...new Set(allowedIds)];
  const byShortName = shortNameIndex(ids);
  return ids
    .map((id) => {
      const short = shortName(id)?.toLowerCase();
      return short && byShortName.get(short) === id ? short : id;
    })
    .sort();
}

/** The result of parsing a `?plugin=` deep link. */
export interface PluginDeepLinkTargets {
  /** Resolved plugin ids to activate, deduplicated, in link order. */
  pluginIds: string[];
  /** Requested names that matched no allowed plugin, as written in the link. */
  unknown: string[];
}

/**
 * Parses a `?plugin=` deep link from a raw query string.
 *
 * Each value may list several plugins separated by commas, and the parameter
 * may repeat. A name matches a plugin by its full id (`maplibre-gl-swipe`) or by
 * its short name, the id without a `maplibre-gl-`, `maplibre-`, or `geolibre-`
 * prefix (`swipe`). Short names are case-insensitive; a short name two plugins
 * share resolves to neither, so a link never activates an arbitrary one.
 *
 * @param search - A `window.location.search`-style query string (leading `?`
 *   optional).
 * @param allowedIds - The plugin ids a deep link may activate.
 * @returns The targets, or `null` when the parameter is absent or names
 *   nothing.
 */
export function pluginDeepLinkFromSearch(
  search: string,
  allowedIds: Iterable<string>,
): PluginDeepLinkTargets | null {
  const requested = new URLSearchParams(search)
    .getAll(PLUGIN_DEEP_LINK_PARAM)
    .flatMap((value) => value.split(","))
    .map((name) => name.trim())
    .filter(Boolean);
  if (requested.length === 0) return null;

  const ids = new Set(allowedIds);
  const byShortName = shortNameIndex(ids);

  const pluginIds: string[] = [];
  const unknown: string[] = [];
  for (const name of requested) {
    const id = ids.has(name) ? name : byShortName.get(name.toLowerCase());
    if (!id) {
      unknown.push(name);
      continue;
    }
    if (!pluginIds.includes(id)) pluginIds.push(id);
  }
  return { pluginIds, unknown };
}
