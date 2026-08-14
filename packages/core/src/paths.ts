// Matches a `..` directory-traversal segment (bounded by separators or the
// string ends), without rejecting a `..` inside a filename like `v1..2.gpkg`.
const PATH_TRAVERSAL = /(?:^|[/\\])\.\.(?:[/\\]|$)/;

/**
 * Whether a path contains a `..` directory-traversal segment. Used to reject a
 * (possibly hand-edited) project's `sourcePath` before re-reading it off disk.
 *
 * @param path - The path to check.
 * @returns True when the path contains a traversal segment.
 */
export function hasPathTraversal(path: string): boolean {
  return PATH_TRAVERSAL.test(path);
}

/**
 * Whether a path is an absolute local filesystem path a host could read.
 *
 * Matches the raw path (not a trimmed copy): a whitespace-padded value would
 * pass a trimmed check but reach the file read unchanged and fail there, so it
 * is rejected up front. Accepts POSIX paths and Windows drive-letter paths only.
 * UNC paths (`\\server\share`) are deliberately rejected: reading one can make
 * Windows auto-authenticate against a remote host (NTLM hash capture), and a
 * remote share is not a supported local data source.
 *
 * Lives in core so validation of a persisted path is available wherever a
 * record is normalized — the desktop app's `isAbsoluteLocalPath` re-exports the
 * same rule for its Tauri call sites.
 *
 * @param path - The path to check.
 * @returns True when the path is an absolute POSIX or Windows path.
 */
export function isAbsoluteFilesystemPath(path: string): boolean {
  return path.startsWith("/") || /^[a-z]:[\\/]/i.test(path);
}
