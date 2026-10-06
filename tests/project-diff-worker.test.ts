import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEmptyProject, DEFAULT_LAYER_STYLE, serializeProject } from "@geolibre/core";
import { ProjectDiffEngine } from "../apps/geolibre-desktop/src/lib/project-diff-engine";
import { createProjectDiffClient } from "../apps/geolibre-desktop/src/lib/project-diff-client";
import type {
  ProjectDiffWorkerRequest,
  ProjectDiffWorkerResponse,
} from "../apps/geolibre-desktop/src/workers/project-diff.worker";

function projectJson(layerIds: string[]): string {
  return serializeProject({
    ...createEmptyProject("Diff"),
    layers: layerIds.map((id) => ({
      id,
      name: id,
      type: "geojson" as const,
      source: { type: "geojson" },
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {},
    })),
  });
}

describe("ProjectDiffEngine", () => {
  it("diffs two projects and reuses a cached side without its content", () => {
    const engine = new ProjectDiffEngine();
    const first = engine.compare(
      { key: "s1", content: projectJson(["a"]) },
      { key: "s2", content: projectJson(["a", "b"]) },
    );
    assert.ok(first.ok);
    assert.deepEqual(
      first.diff.layers.added.map((layer) => layer.id),
      ["b"],
    );
    // Both sides are cached now; a repeat needs only the keys.
    const again = engine.compare({ key: "s1" }, { key: "s2" });
    assert.ok(again.ok);
    assert.equal(again.diff.changeCount, first.diff.changeCount);
  });

  it("reports which side could not be read", () => {
    const engine = new ProjectDiffEngine();
    assert.deepEqual(engine.compare({ key: "x", content: "{not json" }, { key: "y" }), {
      ok: false,
      side: "before",
      reason: "parse",
    });
    assert.deepEqual(engine.compare({ key: "a", content: projectJson([]) }, { key: "missing" }), {
      ok: false,
      side: "after",
      reason: "missing",
    });
  });

  it("keeps a bounded set of parsed projects, dropping the least recently used", () => {
    const engine = new ProjectDiffEngine();
    for (let i = 0; i < 8; i++) {
      engine.compare(
        { key: "keep", content: projectJson([]) },
        { key: `s${i}`, content: projectJson([]) },
      );
    }
    // "keep" is used on every call, so it survives; the oldest others go.
    assert.ok(engine.has("keep"));
    assert.equal(engine.has("s0"), false);
    assert.ok(engine.has("s7"));
    assert.ok(engine.keys().length <= 6);
  });

  it("forgets keys on request", () => {
    const engine = new ProjectDiffEngine();
    engine.compare(
      { key: "s1", content: projectJson([]) },
      { key: "s2", content: projectJson([]) },
    );
    engine.forget((key) => key === "s1");
    assert.deepEqual(engine.keys(), ["s2"]);
  });
});

/** A stand-in Worker that runs the real worker protocol in-process. */
class FakeWorker {
  onmessage: ((event: MessageEvent<ProjectDiffWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly requests: ProjectDiffWorkerRequest[] = [];
  terminated = false;
  private readonly engine = new ProjectDiffEngine();

  constructor(private readonly crash = false) {}

  postMessage(request: ProjectDiffWorkerRequest): void {
    this.requests.push(request);
    queueMicrotask(() => {
      if (this.crash) {
        this.onerror?.({ preventDefault() {} } as ErrorEvent);
        return;
      }
      if (request.type === "retain") {
        const keep = new Set(request.keep);
        this.engine.forget((key) => !keep.has(key));
        return;
      }
      const outcome = this.engine.compare(request.before, request.after);
      this.onmessage?.({
        data: { id: request.id, outcome, cached: this.engine.keys() },
      } as MessageEvent<ProjectDiffWorkerResponse>);
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Drop a cached project, as the worker's own LRU eviction would. */
  forget(key: string): void {
    this.engine.forget((cachedKey) => cachedKey === key);
  }
}

describe("createProjectDiffClient", () => {
  const source = (key: string, layers: string[], reads: string[] = []) => ({
    key,
    content: () => {
      reads.push(key);
      return projectJson(layers);
    },
  });

  it("diffs on the main thread when no worker is available", async () => {
    const client = createProjectDiffClient(() => null);
    const outcome = await client.compare(source("a", ["x"]), source("b", ["x", "y"]));
    assert.ok(outcome.ok);
    assert.equal(outcome.diff.layers.added.length, 1);
  });

  it("sends a project's content only until the worker holds it", async () => {
    const worker = new FakeWorker();
    const client = createProjectDiffClient(() => worker as unknown as Worker);
    const reads: string[] = [];
    await client.compare(source("snap", ["x"], reads), source("current:0", ["x"], reads));
    await client.compare(source("snap", ["x"], reads), source("current:1", ["x", "y"], reads));
    // The snapshot is serialized and sent once; each live revision once.
    assert.deepEqual(reads, ["snap", "current:0", "current:1"]);
    const second = worker.requests[1];
    assert.ok(second.type === "compare" && second.before.content === undefined);
    client.dispose();
    assert.ok(worker.terminated);
  });

  it("propagates a failure to read a side's content", () => {
    const client = createProjectDiffClient(() => null);
    assert.throws(
      () =>
        client.compare(source("a", []), {
          key: "current:0",
          content: () => {
            throw new RangeError("Invalid string length");
          },
        }),
      RangeError,
    );
  });

  it("re-sends a project in full when the worker no longer holds it", async () => {
    const worker = new FakeWorker();
    const client = createProjectDiffClient(() => worker as unknown as Worker);
    await client.compare(source("snap", ["x"]), source("current:0", ["x"]));
    // The worker drops "snap" behind the client's back (its own eviction).
    worker.forget("snap");
    const outcome = await client.compare(source("snap", ["x"]), source("current:1", ["x", "y"]));
    assert.ok(outcome.ok, "answered after one full re-send");
    assert.equal(outcome.diff.layers.added.length, 1);
  });

  it("answers every pending request when the worker fails, even one whose content throws", async () => {
    const worker = new FakeWorker(true);
    const client = createProjectDiffClient(() => worker as unknown as Worker);
    let reads = 0;
    // Readable once (for the worker request), then too large (for the fallback).
    const flaky = {
      key: "current:0",
      content: () => {
        reads += 1;
        if (reads > 1) throw new RangeError("Invalid string length");
        return projectJson([]);
      },
    };
    const [failed, ok] = await Promise.all([
      client.compare(source("a", []), flaky),
      client.compare(source("a", []), source("b", ["y"])),
    ]);
    assert.equal(failed.ok, false);
    assert.ok(ok.ok, "the next pending request still resolves");
  });

  it("falls back to the main thread when the worker fails", async () => {
    const worker = new FakeWorker(true);
    const client = createProjectDiffClient(() => worker as unknown as Worker);
    const outcome = await client.compare(source("a", []), source("b", ["y"]));
    assert.ok(outcome.ok, "the pending request is answered in-thread");
    assert.ok(worker.terminated);
    const next = await client.compare(source("a", []), source("b", ["y"]));
    assert.ok(next.ok);
  });
});
