import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { MapCameraTransitionOptions, MapEngineClient } from "../packages/map/src/engine/types";
import { STORY_CAMERA_TAG, flyToCamera } from "../apps/geolibre-desktop/src/lib/map-engine-camera";
import { unsupportedScriptingCommandMessage } from "../apps/geolibre-desktop/src/lib/scripting/errors";
import { createTestMapEngine } from "./engine-test-fakes";

const root = path.resolve(import.meta.dirname, "..");

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), "utf8");
}

test("partial camera moves preserve neutral view fields and tag the transition", () => {
  const engine = createTestMapEngine({
    center: [8.55, 47.37],
    zoom: 9,
    bearing: 12,
    pitch: 25,
    bbox: [8, 47, 9, 48],
  });
  let applied:
    | {
        view: ReturnType<MapEngineClient["camera"]["readView"]>;
        options?: MapCameraTransitionOptions;
      }
    | undefined;
  const client: MapEngineClient = {
    ...engine,
    camera: {
      ...engine.camera,
      applyView: (view, options) => {
        applied = { view, options };
      },
    },
  };

  flyToCamera(client, {
    center: [7.45, 46.95],
    zoom: 14,
    durationMs: 600,
    tag: STORY_CAMERA_TAG,
  });

  assert.deepEqual(applied, {
    view: {
      center: [7.45, 46.95],
      zoom: 14,
      bearing: 12,
      pitch: 25,
    },
    options: { mode: "fly", durationMs: 600, tag: STORY_CAMERA_TAG },
  });
});

test("viewport history uses tagged engine events instead of native map listeners", async () => {
  const history = await source("apps/geolibre-desktop/src/hooks/useViewportHistory.ts");

  assert.match(history, /client\.on\("moveend"/);
  assert.match(history, /VIEWPORT_HISTORY_RESTORE_TAG/);
  assert.match(history, /STORY_CAMERA_TAG/);
  assert.doesNotMatch(history, /getMap\(|MapController|\.easeToView\(/);
});

test("camera, control, snapshot, and collaboration consumers use engine ports", async () => {
  const [toolbar, terrain, snapshot, collaboration, story] = await Promise.all([
    source("apps/geolibre-desktop/src/components/layout/TopToolbar.tsx"),
    source("apps/geolibre-desktop/src/components/layout/TerrainSettingsDialog.tsx"),
    source("apps/geolibre-desktop/src/lib/build-project-snapshot.ts"),
    source("apps/geolibre-desktop/src/hooks/useCollaboration.ts"),
    source("apps/geolibre-desktop/src/components/storymap/StoryMapPresenter.tsx"),
  ]);

  assert.match(toolbar, /\.controls\.setBuiltInState\(/);
  assert.match(toolbar, /\.camera\.resetNorthPitch\(/);
  assert.match(terrain, /\.controls\.setTerrainExaggeration\(/);
  assert.match(snapshot, /\.camera\.readView\(\) \?\? state\.mapView/);
  assert.match(collaboration, /\.camera\.applyView\(message\.view\)/);
  assert.match(collaboration, /client\.on\("pointermove"/);
  assert.match(story, /\.camera\.playStoryChapter\(/);
});

test("native renderer scripting is absent and old callers get an actionable error", async () => {
  const [tools, prompt] = await Promise.all([
    source("apps/geolibre-desktop/src/lib/assistant/tools.ts"),
    source("apps/geolibre-desktop/src/lib/assistant/agent.ts"),
  ]);

  assert.doesNotMatch(tools, /name:\s*["']run_maplibre_js["']/);
  assert.doesNotMatch(tools, /new Function\(/);
  assert.doesNotMatch(prompt, /use run_maplibre_js/);
  assert.match(unsupportedScriptingCommandMessage("run_maplibre_js"), /Unsupported command/);
  assert.match(unsupportedScriptingCommandMessage("run_maplibre_js"), /engine-neutral/);
});
