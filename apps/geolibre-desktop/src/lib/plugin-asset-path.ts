// Pure path-safety helpers for reading an asset out of a plugin's own bundle
// (a zip archive or plugin directory on the desktop filesystem). Mirrors the
// textual checks of resolvePluginAssetUrl (plugin-asset-url.ts) for archive
// semantics: no percent decoding, forward slashes only, and every segment must
// be non-empty and not a dot segment. Kept free of Tauri and browser imports so
// it stays unit-testable in Node and reusable by both the loader and the app
// API exposed to plugins.

/**
 * Whether `relativePath` can be safely resolved inside a plugin's own bundle.
 * Rejects empty paths, absolute paths, backslash separators (Windows paths
 * must not smuggle a directory change past the archive's forward-slash
 * namespace), scheme-qualified or drive-letter-prefixed paths, and any empty,
 * ".", or ".." segment, so the resolved key can never leave the plugin's own
 * folder in the archive or directory.
 */
export function isSafePluginAssetRelativePath(relativePath: string): boolean {
  if (relativePath === "" || relativePath.startsWith("/") || relativePath.includes("\\")) {
    return false;
  }
  // A scheme prefix ("http:", "file:") or a Windows drive letter ("C:") has no
  // business in an archive-relative path.
  if (/^[a-z][a-z\d+.-]*:/i.test(relativePath)) {
    return false;
  }
  return relativePath.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
