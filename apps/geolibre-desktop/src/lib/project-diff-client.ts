/**
 * Runs Project History comparisons in `project-diff.worker.ts`, so parsing and
 * diffing a large project never blocks the UI (GeoLibre#2869). Falls back to
 * the same engine on the main thread where workers are unavailable (tests, a
 * worker that failed to start or crashed).
 */
import type {
  ProjectDiffWorkerRequest,
  ProjectDiffWorkerResponse,
} from "../workers/project-diff.worker";
import {
  ProjectDiffEngine,
  type ProjectDiffInput,
  type ProjectDiffOutcome,
} from "./project-diff-engine";

/** One side of a comparison: a stable cache key and a way to get its JSON. */
export interface ProjectDiffSource {
  key: string;
  /** Called only when the engine does not hold `key` yet; may throw. */
  content: () => string;
}

export interface ProjectDiffClient {
  /**
   * Compare two projects. A later call does not cancel an earlier one; the
   * caller drops stale replies. Throws (synchronously) when reading a side's
   * content throws.
   */
  compare(before: ProjectDiffSource, after: ProjectDiffSource): Promise<ProjectDiffOutcome>;
  /** Let the engine drop every cached project not named in `keys`. */
  retain(keys: string[]): void;
  /** Stop the worker. */
  dispose(): void;
}

/**
 * Create a client. One per open compare view: the worker holds the parsed
 * projects for as long as the view is open, and is terminated with it.
 *
 * @param createWorker - Builds the worker; injectable for tests. Returning
 *   `null` (or throwing) selects the in-thread engine.
 * @returns The client.
 */
export function createProjectDiffClient(
  createWorker: () => Worker | null = defaultWorker,
): ProjectDiffClient {
  let worker: Worker | null = null;
  try {
    worker = createWorker();
  } catch (error) {
    console.warn("[geolibre] Project diff worker unavailable; diffing on the main thread.", error);
  }
  if (!worker) return inThreadClient();

  let nextId = 0;
  // Keys the worker reported holding after its last reply.
  let cached = new Set<string>();
  interface Pending {
    before: ProjectDiffSource;
    after: ProjectDiffSource;
    resolve: (outcome: ProjectDiffOutcome) => void;
    /** Already re-sent in full once after a "missing" reply. */
    retried?: boolean;
  }
  const pending = new Map<number, Pending>();
  let fallback: ProjectDiffClient | null = null;

  worker.onmessage = (event: MessageEvent<ProjectDiffWorkerResponse>) => {
    const { id, outcome } = event.data;
    cached = new Set(event.data.cached);
    const request = pending.get(id);
    pending.delete(id);
    if (!request) return;
    if (!outcome.ok && outcome.reason === "missing" && worker && !request.retried) {
      // The worker dropped a project the client thought it still held (a
      // retain or its own eviction raced the request): send both in full.
      let retry: ProjectDiffWorkerRequest;
      try {
        retry = {
          type: "compare",
          id: nextId++,
          before: { key: request.before.key, content: request.before.content() },
          after: { key: request.after.key, content: request.after.content() },
        };
      } catch {
        request.resolve({ ok: false, side: "after", reason: "parse" });
        return;
      }
      pending.set(retry.id, { ...request, retried: true });
      worker.postMessage(retry);
      return;
    }
    request.resolve(outcome);
  };
  // A worker that fails to load or crashes would leave its callers waiting:
  // switch to the in-thread engine and answer them from it.
  worker.onerror = (event) => {
    event.preventDefault();
    console.warn("[geolibre] Project diff worker failed; diffing on the main thread.", event);
    worker?.terminate();
    worker = null;
    fallback ??= inThreadClient();
    const engine = fallback;
    for (const [id, request] of pending) {
      pending.delete(id);
      // compare() throws synchronously when reading a side's content fails
      // (a live project too large to serialize); answer that request with a
      // failure rather than abandoning the rest of the queue.
      Promise.resolve()
        .then(() => engine.compare(request.before, request.after))
        .then(request.resolve, () =>
          request.resolve({ ok: false, side: "after", reason: "parse" }),
        );
    }
  };

  const toInput = (source: ProjectDiffSource): ProjectDiffInput =>
    cached.has(source.key) ? { key: source.key } : { key: source.key, content: source.content() };

  return {
    compare(before, after) {
      if (!worker) {
        fallback ??= inThreadClient();
        return fallback.compare(before, after);
      }
      const request: ProjectDiffWorkerRequest = {
        type: "compare",
        id: nextId++,
        before: toInput(before),
        after: toInput(after),
      };
      const active = worker;
      return new Promise<ProjectDiffOutcome>((resolve) => {
        pending.set(request.id, { before, after, resolve });
        active.postMessage(request);
      });
    },
    retain(keys) {
      const keep = new Set(keys);
      cached = new Set([...cached].filter((key) => keep.has(key)));
      const request: ProjectDiffWorkerRequest = { type: "retain", keep: keys };
      worker?.postMessage(request);
      fallback?.retain(keys);
    },
    dispose() {
      worker?.terminate();
      worker = null;
      pending.clear();
    },
  };
}

function defaultWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  return new Worker(new URL("../workers/project-diff.worker.ts", import.meta.url), {
    type: "module",
    name: "geolibre-project-diff",
  });
}

function inThreadClient(): ProjectDiffClient {
  const engine = new ProjectDiffEngine();
  return {
    compare(before, after) {
      const toInput = (source: ProjectDiffSource): ProjectDiffInput =>
        engine.has(source.key)
          ? { key: source.key }
          : { key: source.key, content: source.content() };
      // Reading a side's content can throw (a live project too large to
      // serialize); let that reach the caller, as the worker path does.
      const inputs = [toInput(before), toInput(after)] as const;
      try {
        return Promise.resolve(engine.compare(inputs[0], inputs[1]));
      } catch (error) {
        console.error("[geolibre] Project diff failed.", error);
        return Promise.resolve({ ok: false, side: "after", reason: "parse" });
      }
    },
    retain(keys) {
      const keep = new Set(keys);
      engine.forget((key) => !keep.has(key));
    },
    dispose() {},
  };
}
