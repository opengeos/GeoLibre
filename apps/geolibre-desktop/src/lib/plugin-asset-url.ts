// Pure helpers for resolving plugin asset URLs. Kept free of Tauri and
// browser imports so they stay unit-testable in Node and reusable by both the
// external-plugin loader and the app API exposed to plugins.

// A loaded plugin's source is a URL (a web/desktop bundled plugin or a
// manifest-URL install) rather than a desktop filesystem path (an absolute
// path with no scheme). Only URL sources have a fetchable asset base.
export function isManagedUrlSource(source: string): boolean {
  return /^(https?|tauri):\/\//.test(source);
}

// Resolve `path` against a plugin manifest URL, rejecting anything absolute,
// scheme-qualified, or that escapes the manifest's own directory. Mirrors the
// safety checks GeoLibre applies to a manifest's `entry`/`style` paths so a
// plugin can only reach assets shipped inside its own folder.
export function resolvePluginAssetUrl(manifestUrl: string, path: string): string {
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    /^[a-z][a-z\d+.-]*:/i.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Plugin manifest paths must be relative safe paths.");
  }
  // Percent-encoded dot segments ("%2e%2e") pass the textual check above but
  // the URL parser still normalizes them, so confirm the resolved URL stays
  // under the manifest directory.
  const resolved = new URL(path, manifestUrl);
  const manifestDirectory = new URL(".", manifestUrl);
  if (!resolved.href.startsWith(manifestDirectory.href)) {
    throw new Error("Plugin manifest paths must be relative safe paths.");
  }
  return resolved.toString();
}

// Resolve a plugin asset URL from the plugin's loaded source. Returns null for
// a missing source, a desktop filesystem source (no URL base), or an unsafe
// relative path, so callers can treat null as "no bundled asset URL".
export function pluginAssetUrlFromSource(
  source: string | undefined,
  relativePath: string,
): string | null {
  if (!source || !isManagedUrlSource(source)) return null;
  try {
    return resolvePluginAssetUrl(source, relativePath);
  } catch {
    return null;
  }
}
