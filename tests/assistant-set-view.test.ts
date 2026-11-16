import "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FunctionTool } from "@strands-agents/sdk";
import type { MapViewState } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";

const { createHostAssistantTools, resolveSetView } =
  await import("../apps/geolibre-desktop/src/lib/assistant/tools");

const START: MapViewState = {
  center: [0, 0],
  zoom: 2,
  bearing: 10,
  pitch: 20,
  bbox: [-10, -10, 10, 10],
};

describe("resolveSetView", () => {
  it("changes only the fields given", () => {
    assert.deepEqual(resolveSetView(START, { pitch: 45 }), { ...START, pitch: 45 });
  });

  it("clamps zoom and pitch to the same ranges as the MCP set_view", () => {
    const view = resolveSetView(START, { zoom: 30, pitch: 120 });
    assert.equal(view.zoom, 24);
    assert.equal(view.pitch, 85);
    assert.equal(resolveSetView(START, { zoom: -3 }).zoom, 0);
    assert.equal(resolveSetView(START, { pitch: -5 }).pitch, 0);
  });

  it("drops the stale bbox once the center or zoom moves", () => {
    assert.equal(resolveSetView(START, { center: [139.7, 35.7] }).bbox, undefined);
    assert.equal(resolveSetView(START, { zoom: 5 }).bbox, undefined);
    // Rotating or tilting does not change the framed extent.
    assert.deepEqual(resolveSetView(START, { bearing: 90 }).bbox, START.bbox);
  });
});

/** A map engine double that records the camera it was asked to show. */
function fakeEngine(): { engine: MapEngine; applied: MapViewState[] } {
  let view: MapViewState = { ...START };
  const applied: MapViewState[] = [];
  const engine = {
    readView: () => ({ ...view }),
    applyView: async (next: MapViewState) => {
      applied.push(next);
      view = { ...next };
    },
  } as unknown as MapEngine;
  return { engine, applied };
}

function setViewTool(engine: MapEngine | null): FunctionTool {
  const tool = createHostAssistantTools({ getMapController: () => engine }).find(
    (candidate) => candidate.name === "set_view",
  );
  assert.ok(tool, "set_view is registered as a host tool");
  return tool as FunctionTool;
}

describe("set_view tool", () => {
  it("moves the camera and reports the new and previous view", async () => {
    const { engine, applied } = fakeEngine();
    const result = (await setViewTool(engine).invoke({
      center: [-74, 40.7],
      zoom: 12,
    })) as unknown as { view: MapViewState; previous: MapViewState };
    assert.equal(applied.length, 1);
    assert.deepEqual(applied[0].center, [-74, 40.7]);
    assert.equal(applied[0].zoom, 12);
    // Bearing and pitch were not asked for, so they stay put.
    assert.equal(applied[0].bearing, 10);
    assert.equal(applied[0].pitch, 20);
    assert.deepEqual(result.view, { center: [-74, 40.7], zoom: 12, bearing: 10, pitch: 20 });
    assert.deepEqual(result.previous, { center: [0, 0], zoom: 2, bearing: 10, pitch: 20 });
  });

  it("needs at least one camera field", async () => {
    const { engine, applied } = fakeEngine();
    await assert.rejects(() => setViewTool(engine).invoke({}));
    assert.equal(applied.length, 0);
  });

  it("rejects an out-of-range latitude instead of moving somewhere else", async () => {
    const { engine, applied } = fakeEngine();
    await assert.rejects(() => setViewTool(engine).invoke({ center: [40.7, -740] }));
    assert.equal(applied.length, 0);
  });

  it("reports a jump the engine skipped instead of claiming success", async () => {
    // MapController.applyView returns without moving while the map is dragged.
    const engine = {
      readView: () => ({ ...START }),
      applyView: () => undefined,
    } as unknown as MapEngine;
    await assert.rejects(() => setViewTool(engine).invoke({ zoom: 9 }), /did not move/);
  });

  it("succeeds when the camera already shows the requested view", async () => {
    const { engine } = fakeEngine();
    await setViewTool(engine).invoke({ zoom: START.zoom });
  });

  it("reports when the map is not ready", async () => {
    await assert.rejects(() => setViewTool(null).invoke({ zoom: 3 }), /not ready/);
  });

  it("never asks for code confirmation", async () => {
    const { engine } = fakeEngine();
    let asked = false;
    const tool = createHostAssistantTools({
      getMapController: () => engine,
      confirmCodeExecution: async () => {
        asked = true;
        return false;
      },
    }).find((candidate) => candidate.name === "set_view") as FunctionTool;
    await tool.invoke({ zoom: 5 });
    assert.equal(asked, false);
  });
});
