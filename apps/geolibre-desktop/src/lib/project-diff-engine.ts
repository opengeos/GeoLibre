/**
 * Parses and diffs projects for the Project History compare view, keeping the
 * parsed projects so a repeat comparison reuses them. The differ caches each
 * feature's hash by object identity, so handing it the same parsed snapshot
 * again skips re-hashing every embedded feature.
 *
 * Runs inside `project-diff.worker.ts`, and on the main thread when workers
 * are unavailable. Kept free of the store and the DOM for that reason.
 */
import {
  diffProjects,
  parseProject,
  type GeoLibreProject,
  type ProjectDiff,
} from "@geolibre/core/worker-safe";

/** One side of a comparison: a cache key and, when not cached yet, its JSON. */
export interface ProjectDiffInput {
  /** A snapshot id (its content never changes) or a per-revision current key. */
  key: string;
  /** The serialized project; may be omitted when the engine already has `key`. */
  content?: string;
}

export type ProjectDiffOutcome =
  | { ok: true; diff: ProjectDiff }
  /** `side` is the input that could not be read (`missing`: not cached and no content). */
  | { ok: false; side: "before" | "after"; reason: "parse" | "missing" };

/** Parsed projects kept for reuse, least recently used first. */
const MAX_CACHED_PROJECTS = 6;

export class ProjectDiffEngine {
  private readonly cache = new Map<string, GeoLibreProject>();

  /** Whether the engine holds `key`, so a caller can skip sending its content. */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /** Every key the engine holds. */
  keys(): string[] {
    return [...this.cache.keys()];
  }

  /**
   * Diff `before` against `after`.
   *
   * @param before - The older side.
   * @param after - The newer side.
   * @returns The diff, or which side could not be read.
   */
  compare(before: ProjectDiffInput, after: ProjectDiffInput): ProjectDiffOutcome {
    const older = this.project(before);
    if ("reason" in older) return { ok: false, side: "before", reason: older.reason };
    const newer = this.project(after);
    if ("reason" in newer) return { ok: false, side: "after", reason: newer.reason };
    return { ok: true, diff: diffProjects(older.project, newer.project) };
  }

  /** Forget cached projects whose key matches, e.g. evicted snapshots. */
  forget(predicate: (key: string) => boolean): void {
    for (const key of [...this.cache.keys()]) {
      if (predicate(key)) this.cache.delete(key);
    }
  }

  private project(
    input: ProjectDiffInput,
  ): { project: GeoLibreProject } | { reason: "parse" | "missing" } {
    const cached = this.cache.get(input.key);
    if (cached) {
      // Refresh recency so the projects in use are the last to go.
      this.cache.delete(input.key);
      this.cache.set(input.key, cached);
      return { project: cached };
    }
    if (input.content === undefined) return { reason: "missing" };
    let project: GeoLibreProject;
    try {
      project = parseProject(input.content);
    } catch {
      return { reason: "parse" };
    }
    this.cache.set(input.key, project);
    while (this.cache.size > MAX_CACHED_PROJECTS) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return { project };
  }
}
