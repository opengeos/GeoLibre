import assert from "node:assert/strict";
import test from "node:test";

import { isGeoLibreProjectFileName } from "../apps/geolibre-desktop/src/lib/tauri-io";
import { resolveDroppedProjectIfCurrent } from "../apps/geolibre-desktop/src/lib/dropped-project";
import type { GeoLibreProject } from "@geolibre/core";

test("recognizes GeoLibre project files dropped onto the app", () => {
  assert.equal(isGeoLibreProjectFileName("map.geolibre.json"), true);
  assert.equal(isGeoLibreProjectFileName("map.geolibre"), true);
  assert.equal(isGeoLibreProjectFileName("MAP.GEOLIBRE.JSON"), true);
  assert.equal(isGeoLibreProjectFileName("/maps/map.geolibre.json"), true);
});

test("does not divert ordinary JSON datasets into the project loader", () => {
  assert.equal(isGeoLibreProjectFileName("map.json"), false);
  assert.equal(isGeoLibreProjectFileName("map.geojson"), false);
  assert.equal(isGeoLibreProjectFileName("map.geolibre.json.backup"), false);
  assert.equal(isGeoLibreProjectFileName("map.geolibre.backup"), false);
});

test("does not replace edits made while dropped project layers resolve", async () => {
  const dropped = { version: 1, name: "Dropped", layers: [] } as unknown as GeoLibreProject;
  let workspace = {
    projectGeneration: 4,
    isDirty: true,
    projectFingerprint: "before-edit",
  };
  let finishResolution: ((project: GeoLibreProject) => void) | undefined;
  let loaded = false;
  let prompted = false;

  const loading = resolveDroppedProjectIfCurrent({
    project: dropped,
    projectGeneration: 4,
    projectFingerprint: "before-edit",
    isCurrentOperation: () => true,
    getWorkspaceState: () => workspace,
    resolveProject: () =>
      new Promise((resolve) => {
        finishResolution = resolve;
      }),
    loadProject: () => {
      loaded = true;
    },
    workspaceChanged: () => {
      prompted = true;
    },
  });

  workspace = { ...workspace, projectFingerprint: "after-edit" };
  finishResolution?.(dropped);

  assert.equal(await loading, false);
  assert.equal(loaded, false);
  assert.equal(prompted, true);
});

test("does not let an older overlapping drop replace the latest one", async () => {
  const dropped = { version: 1, name: "Older", layers: [] } as unknown as GeoLibreProject;
  const workspace = { projectGeneration: 2, isDirty: false, projectFingerprint: null };
  let latest = true;
  let finishResolution: ((project: GeoLibreProject) => void) | undefined;
  let loaded = false;

  const loading = resolveDroppedProjectIfCurrent({
    project: dropped,
    projectGeneration: 2,
    projectFingerprint: null,
    isCurrentOperation: () => latest,
    getWorkspaceState: () => workspace,
    resolveProject: () =>
      new Promise((resolve) => {
        finishResolution = resolve;
      }),
    loadProject: () => {
      loaded = true;
    },
    workspaceChanged: () => undefined,
  });

  latest = false;
  finishResolution?.(dropped);

  assert.equal(await loading, false);
  assert.equal(loaded, false);
});
