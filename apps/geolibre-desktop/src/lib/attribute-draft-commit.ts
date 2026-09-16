/**
 * Hand-off between the attribute table's unsaved cell drafts and the Layers
 * panel's write-back action (Save edits to source file / ArcGIS / PostGIS).
 *
 * Drafts live in the attribute table's component state and only reach
 * `layer.geojson` when the table's own Save runs. Write-back reads the layer
 * from the store, so without this hand-off a value that is visibly edited in the
 * table is silently left out of the save (GeoLibre#2438, #2439). The table
 * registers a committer while it holds drafts, and write-back commits them
 * first.
 */

/** Outcome of committing a layer's pending attribute drafts. */
export type PendingAttributeDraftsResult =
  /** No drafts were pending for the layer. */
  | "none"
  /** The drafts were applied to the layer in the store. */
  | "committed"
  /** Drafts are pending but cannot be applied (invalid values or no permission). */
  | "blocked";

/** Applies the table's drafts to the store, returning false when it cannot. */
export type PendingAttributeDraftsCommitter = () => boolean;

const committers = new Map<string, PendingAttributeDraftsCommitter>();

/**
 * Register the committer for a layer's unsaved attribute drafts.
 *
 * @param layerId - The layer the drafts belong to.
 * @param commit - Applies the drafts; returns false when they cannot be applied.
 * @returns An unregister function that only removes this committer, so a newer
 *   registration for the same layer is left in place.
 */
export function registerPendingAttributeDrafts(
  layerId: string,
  commit: PendingAttributeDraftsCommitter,
): () => void {
  committers.set(layerId, commit);
  return () => {
    if (committers.get(layerId) === commit) committers.delete(layerId);
  };
}

/**
 * Commit a layer's unsaved attribute drafts before its features are read.
 *
 * @param layerId - The layer about to be written back to its source.
 * @returns Whether drafts were pending, and if so whether they were applied.
 */
export function commitPendingAttributeDrafts(layerId: string): PendingAttributeDraftsResult {
  const commit = committers.get(layerId);
  if (!commit) return "none";
  if (!commit()) return "blocked";
  committers.delete(layerId);
  return "committed";
}
