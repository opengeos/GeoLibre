// Remote plugin blocklist: plugins (or single bundles of them) that the plugin
// registry's maintainers have pulled, e.g. because a version turned out to be
// malicious. Removing a plugin from the registry only stops new installs, since
// installed copies load from their saved manifest URL; the blocklist stops
// those too.
//
// The list is `blocklist.json` next to the configured registry (so a
// self-hosted registry carries its own). It is fetched once per session before
// external plugins load, cached for offline starts, and fails open: when it
// can't be fetched and nothing is cached, nothing is blocked. An entry without
// `bundleSha256` blocks every version of a plugin (checked by evaluatePlugin);
// one with a hash blocks only that bundle (checked where URL bundles are
// hashed). Bundled drop-ins are never blocked: the deployment ships them.

import { readBodyWithCap, resolveRegistryUrl } from "./plugin-registry";

export interface PluginBlocklistEntry {
  id: string;
  /** Block only the bundle with this hash; absent blocks every version. */
  bundleSha256?: string;
  /** Shown to users whose plugin is refused. */
  reason: string;
}

const CACHE_KEY = "geolibre.pluginBlocklist";
const FETCH_TIMEOUT_MS = 4_000;
const MAX_BYTES = 1024 * 1024;
const MAX_ENTRIES = 5_000;

let blockedPlugins = new Map<string, PluginBlocklistEntry>();
let blockedBundles = new Map<string, PluginBlocklistEntry>();
let loadPromise: Promise<void> | null = null;

// JSON keeps the pair unambiguous whatever characters an id contains.
const bundleKey = (id: string, hash: string): string => JSON.stringify([id, hash]);

/**
 * Normalize an untrusted blocklist document. Malformed entries are dropped
 * rather than failing the whole list, so one bad line can't unblock the rest.
 *
 * @param value - The parsed JSON.
 * @returns The valid entries.
 */
export function parsePluginBlocklist(value: unknown): PluginBlocklistEntry[] {
  if (!value || typeof value !== "object") return [];
  const blocked = (value as { blocked?: unknown }).blocked;
  if (!Array.isArray(blocked)) return [];
  const entries: PluginBlocklistEntry[] = [];
  for (const item of blocked) {
    // Cap valid entries, not raw ones, so malformed items can't push valid
    // entries past the limit.
    if (entries.length >= MAX_ENTRIES) break;
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim().slice(0, 128) : "";
    if (!id) continue;
    const reason =
      typeof record.reason === "string" && record.reason.trim()
        ? record.reason.trim().slice(0, 300)
        : "No reason given.";
    if (record.bundleSha256 === undefined) {
      entries.push({ id, reason });
    } else if (
      typeof record.bundleSha256 === "string" &&
      /^[0-9a-f]{64}$/.test(record.bundleSha256)
    ) {
      entries.push({ id, bundleSha256: record.bundleSha256, reason });
    }
  }
  return entries;
}

/**
 * Replace the active blocklist.
 *
 * @param entries - Normalized entries (see parsePluginBlocklist).
 */
export function setPluginBlocklist(entries: readonly PluginBlocklistEntry[]): void {
  blockedPlugins = new Map();
  blockedBundles = new Map();
  for (const entry of entries) {
    if (entry.bundleSha256) blockedBundles.set(bundleKey(entry.id, entry.bundleSha256), entry);
    else blockedPlugins.set(entry.id, entry);
  }
}

/** Whether any plugin or bundle is blocked at all. */
export function hasPluginBlocklistEntries(): boolean {
  return blockedPlugins.size > 0 || blockedBundles.size > 0;
}

/** The entry blocking every version of a plugin, if any. */
export function getBlocklistedPlugin(id: string): PluginBlocklistEntry | undefined {
  return blockedPlugins.get(id);
}

/** The entry blocking a plugin entirely or this exact bundle, if any. */
export function getBlocklistedBundle(id: string, hash: string): PluginBlocklistEntry | undefined {
  return blockedPlugins.get(id) ?? blockedBundles.get(bundleKey(id, hash));
}

/**
 * Where the blocklist for a registry lives: `blocklist.json` beside it.
 *
 * @param registryUrl - The registry URL.
 * @returns The blocklist URL, or null when the registry URL can't be parsed.
 */
export function pluginBlocklistUrl(registryUrl: string): string | null {
  try {
    return new URL("blocklist.json", registryUrl).href;
  } catch {
    return null;
  }
}

// The cache records which blocklist it holds, so switching registries never
// applies one registry's list to another's plugins.
function readCache(url: string): PluginBlocklistEntry[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as { url?: unknown; document?: unknown };
    return cached.url === url ? parsePluginBlocklist(cached.document) : null;
  } catch {
    return null;
  }
}

function writeCache(url: string, document: unknown): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ url, document }));
  } catch {
    // Storage may be unavailable or full; the cache is only for offline starts.
  }
}

async function fetchBlocklist(url: string): Promise<unknown> {
  const response = await fetch(url, {
    cache: "no-cache",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  // A registry without a blocklist answers 404: nothing is blocked.
  if (response.status === 404) return { blocked: [] };
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return JSON.parse(await readBodyWithCap(response, MAX_BYTES, "plugin blocklist")) as unknown;
}

/**
 * Fetch the blocklist for a registry and make it active. Never throws: on a
 * network or parse failure the last cached copy is used, and with no cache
 * nothing is blocked.
 *
 * @param registryUrl - The registry the blocklist belongs to.
 */
export async function loadPluginBlocklist(registryUrl: string): Promise<void> {
  const url = pluginBlocklistUrl(registryUrl);
  if (url === null) return;
  try {
    const document = await fetchBlocklist(url);
    // A malformed document is a failed fetch, not an empty list: replacing the
    // active (or cached) list with nothing would unblock everything.
    if (
      !document ||
      typeof document !== "object" ||
      !Array.isArray((document as { blocked?: unknown }).blocked)
    ) {
      throw new Error('blocklist has no "blocked" array');
    }
    setPluginBlocklist(parsePluginBlocklist(document));
    writeCache(url, document);
  } catch (error) {
    const cached = readCache(url);
    if (cached) setPluginBlocklist(cached);
    console.warn(
      `[GeoLibre] Could not fetch the plugin blocklist from ${url}` +
        (cached ? "; using the cached copy." : "; nothing is blocked."),
      error,
    );
  }
}

/**
 * Load the configured registry's blocklist once per session. External plugin
 * loading awaits this, so a blocked plugin is refused from the first launch.
 */
export function ensurePluginBlocklistLoaded(): Promise<void> {
  loadPromise ??= (async () => {
    // Like every other failure here, a registry URL that can't be resolved
    // (outside a Vite build, for one) means nothing is blocked.
    let registryUrl: string;
    try {
      registryUrl = resolveRegistryUrl();
    } catch (error) {
      console.warn(
        "[GeoLibre] Could not resolve the plugin registry URL for the blocklist.",
        error,
      );
      return;
    }
    await loadPluginBlocklist(registryUrl);
  })();
  return loadPromise;
}
