/// <reference lib="webworker" />
/**
 * Parses and diffs projects for Project History's compare view off the main
 * thread (GeoLibre#2869). A snapshot is parsed once and kept, so comparing it
 * again (another target, a live edit) only re-parses the side that changed.
 *
 * Imports only the store-free engine (`@geolibre/core/worker-safe`); the
 * package root would bundle the Zustand store into the worker.
 */
import {
  ProjectDiffEngine,
  type ProjectDiffInput,
  type ProjectDiffOutcome,
} from "../lib/project-diff-engine";

/** A request from the client, tagged so the reply can be matched to it. */
export type ProjectDiffWorkerRequest =
  | { type: "compare"; id: number; before: ProjectDiffInput; after: ProjectDiffInput }
  /** Drop cached projects whose keys are not in `keep` (evicted snapshots). */
  | { type: "retain"; keep: string[] };

export interface ProjectDiffWorkerResponse {
  id: number;
  outcome: ProjectDiffOutcome;
  /** Keys the worker now holds, so the client can skip resending them. */
  cached: string[];
}

const engine = new ProjectDiffEngine();
const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<ProjectDiffWorkerRequest>) => {
  const request = event.data;
  if (request.type === "retain") {
    const keep = new Set(request.keep);
    engine.forget((key) => !keep.has(key));
    return;
  }
  let outcome: ProjectDiffOutcome;
  try {
    outcome = engine.compare(request.before, request.after);
  } catch (error) {
    // The differ itself failed; report it against the newer side, which is
    // the one that changes between requests.
    console.error("[geolibre] Project diff failed in the worker.", error);
    outcome = { ok: false, side: "after", reason: "parse" };
  }
  const reply: ProjectDiffWorkerResponse = { id: request.id, outcome, cached: engine.keys() };
  scope.postMessage(reply);
};
