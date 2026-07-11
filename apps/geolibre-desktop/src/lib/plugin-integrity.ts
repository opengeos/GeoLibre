// SHA-256 pinning for remotely-loaded plugin bundles.
//
// A plugin manifest URL the user installs in settings auto-loads on every app
// launch (loadPluginUrlBundles) and its entry JS is dynamically import()-ed with
// full renderer privileges (Tauri APIs on desktop). Trust is otherwise "trust
// on first use, forever": if the host is later compromised — or the author
// pushes a rogue update — the new code runs on the next launch with no re-prompt
// (a silent-update / supply-chain vector).
//
// Pinning records the bundle's SHA-256 on first trusted load. On later launches
// a bundle whose hash no longer matches the pin is NOT executed: it is held back
// and surfaced so the user can review and explicitly reload it (which re-pins).
// Local plugins (installed zips, filesystem drop-ins) are not pinned here — the
// vector is remote fetch-and-execute.

const PIN_STORAGE_KEY = "geolibre.pluginBundlePins";

export interface PluginBundleForHashing {
  entrySource: string;
  styleSource?: string | null;
}

/**
 * Compute the hex SHA-256 of a plugin bundle's executable + style sources.
 *
 * @param bundle - The fetched entry source and optional style source.
 * @returns The lowercase hex SHA-256 digest.
 */
export async function computePluginBundleHash(
  bundle: PluginBundleForHashing,
): Promise<string> {
  // Hash entry and style independently, then hash the two digests together --
  // rather than concatenating the raw sources with a delimiter. A delimiter can
  // be forged: a NUL byte is legal inside JS/CSS source, so an attacker
  // controlling what is served could shift the entry/style boundary across a
  // planted NUL and make a later, different (entry, style) pair reproduce the
  // pinned hash, defeating change detection. Fixed-length digests have no such
  // boundary ambiguity.
  const encoder = new TextEncoder();
  const [entryDigest, styleDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(bundle.entrySource)),
    crypto.subtle.digest("SHA-256", encoder.encode(bundle.styleSource ?? "")),
  ]);
  const combined = new Uint8Array([
    ...new Uint8Array(entryDigest),
    ...new Uint8Array(styleDigest),
  ]);
  const digest = await crypto.subtle.digest("SHA-256", combined);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function readPins(): Record<string, string> {
  try {
    const raw = localStorage.getItem(PIN_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // Malformed or unavailable storage: treat as no pins.
  }
  return {};
}

function writePins(pins: Record<string, string>): void {
  try {
    localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify(pins));
  } catch {
    // Storage may be unavailable or full; pinning is best-effort.
  }
}

/** The trusted hash pinned for a URL, or null if it has never been pinned. */
export function getPluginBundlePin(url: string): string | null {
  return readPins()[url] ?? null;
}

/**
 * Record (or overwrite) the trusted hash for a URL. Called on first trusted load
 * and whenever the user explicitly reloads/accepts a new version.
 *
 * @param url - The plugin manifest URL.
 * @param hash - The bundle hash to trust from now on.
 */
export function pinPluginBundle(url: string, hash: string): void {
  const pins = readPins();
  pins[url] = hash;
  writePins(pins);
}

/**
 * Forget the pin for a URL (e.g. when it is removed from settings).
 *
 * @param url - The plugin manifest URL.
 */
export function removePluginBundlePin(url: string): void {
  const pins = readPins();
  if (url in pins) {
    delete pins[url];
    writePins(pins);
  }
}

export type PluginBundleIntegrity =
  /** No prior pin; pinned now and allowed (trust on first use). */
  | { status: "pinned-first-use" }
  /** Hash matches the pin; allowed. */
  | { status: "unchanged" }
  /** Hash differs from the pin; blocked until the user reloads it. */
  | { status: "changed"; pinnedHash: string; currentHash: string };

/**
 * Verify a freshly-fetched URL bundle against its pinned hash.
 *
 * First sight of a URL pins it and allows the load (the user added the URL to
 * settings). A matching hash is allowed. A differing hash is reported as
 * `"changed"` and NOT re-pinned, so the caller can block the automatic load and
 * require an explicit reload.
 *
 * @param url - The plugin manifest URL that produced the bundle.
 * @param bundle - The fetched entry/style sources.
 * @returns The integrity verdict.
 */
export async function verifyPluginBundleIntegrity(
  url: string,
  bundle: PluginBundleForHashing,
): Promise<PluginBundleIntegrity> {
  const currentHash = await computePluginBundleHash(bundle);
  const pinnedHash = getPluginBundlePin(url);
  if (pinnedHash === null) {
    pinPluginBundle(url, currentHash);
    return { status: "pinned-first-use" };
  }
  if (pinnedHash === currentHash) {
    return { status: "unchanged" };
  }
  return { status: "changed", pinnedHash, currentHash };
}
