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
