import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createEmptyProject, redactCredentials } from "@geolibre/core";
import {
  applyTerrainLook,
  type TerrainLookEngine,
} from "../apps/geolibre-desktop/src/lib/terrain-look.ts";

const DEFAULT_TERRAIN_EXAGGERATION = 1;

// `preferences.map.terrainEnabled` is project state, but it used to be applied
// from an effect inside TopToolbar. `?maponly` embeds (share.geolibre.app builds
// thumbnails with them) hide the toolbar, so it never mounted and a saved 3D
// project rendered flat — no DEM tiles were ever requested. The restore now
// lives in DesktopShell via useTerrainRestore, which mounts regardless of
// chrome. Nothing in the type system stops a future edit from moving it back
// into chrome-gated code, so pin the arrangement here.
function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
}

const DESKTOP_SHELL = "apps/geolibre-desktop/src/components/layout/DesktopShell.tsx";
const TOP_TOOLBAR = "apps/geolibre-desktop/src/components/layout/TopToolbar.tsx";
const TOOLBAR_HOOKS_DIR = "apps/geolibre-desktop/src/hooks/toolbar";
const TOOLBAR_HOOKS = readdirSync(
  fileURLToPath(new URL(`../${TOOLBAR_HOOKS_DIR}`, import.meta.url)),
).map((name) => `${TOOLBAR_HOOKS_DIR}/${name}`);

describe("terrain restore is independent of toolbar visibility", () => {
  it("DesktopShell applies the preference itself", () => {
    const shell = source(DESKTOP_SHELL);
    assert.match(
      shell,
      /useTerrainRestore\(mapControllerRef, mapReadyGeneration, projectGeneration\)/,
      `${DESKTOP_SHELL} must call useTerrainRestore so terrain survives ?maponly`,
    );
  });

  it("DesktopShell calls it outside the toolbarVisible branch", () => {
    const shell = source(DESKTOP_SHELL);
    const restore = shell.indexOf("useTerrainRestore(");
    const gate = shell.indexOf("layoutOptions.toolbarVisible");
    assert.notEqual(restore, -1, "useTerrainRestore call is missing");
    assert.notEqual(gate, -1, "toolbar render gate is missing");
    assert.ok(restore < gate, "useTerrainRestore must run before/outside the toolbar render gate");
  });

  it("TopToolbar no longer owns the terrain restore", () => {
    // The toolbar's state lives in hooks/toolbar/ (#2858); those hooks mount
    // with it, so they are chrome-gated too.
    for (const path of [TOP_TOOLBAR, ...TOOLBAR_HOOKS]) {
      assert.doesNotMatch(
        source(path),
        /setBuiltInControlVisible\(\s*"terrain"/,
        `${path} is unmounted by ?maponly and must not apply terrain`,
      );
    }
  });
});

describe("applyTerrainLook", () => {
  const DEM = "https://example.com/dem.tif";

  function fakeEngine(
    options: { terrainSource?: boolean; cogSource?: string | null; custom?: boolean } = {},
  ) {
    const calls: { exaggeration: number[]; sources: (string | null)[] } = {
      exaggeration: [],
      sources: [],
    };
    let cogSource = options.cogSource ?? null;
    let custom = options.custom ?? cogSource !== null;
    const engine: TerrainLookEngine = {
      capabilities: {
        terrainSource: options.terrainSource ?? true,
      } as TerrainLookEngine["capabilities"],
      setTerrainExaggeration: (value) => {
        calls.exaggeration.push(value);
      },
      getTerrainCogSource: () => cogSource,
      hasCustomTerrainSource: () => custom,
      setTerrainCogSource: async (source) => {
        calls.sources.push(source as string | null);
        cogSource = typeof source === "string" ? source : null;
        custom = source !== null;
        return true;
      },
    };
    return { engine, calls };
  }

  it("applies a saved exaggeration and COG source", () => {
    const { engine, calls } = fakeEngine();
    applyTerrainLook(
      engine,
      { terrainExaggeration: 2, terrainSource: DEM },
      { reset: true, defaultExaggeration: DEFAULT_TERRAIN_EXAGGERATION },
    );
    assert.deepEqual(calls, { exaggeration: [2], sources: [DEM] });
  });

  it("does not reload a source the engine already draws", () => {
    const { engine, calls } = fakeEngine({ cogSource: DEM });
    applyTerrainLook(
      engine,
      { terrainExaggeration: 2, terrainSource: DEM },
      { reset: false, defaultExaggeration: DEFAULT_TERRAIN_EXAGGERATION },
    );
    assert.deepEqual(calls.sources, []);
  });

  it("puts a project without a saved look back to the defaults", () => {
    const { engine, calls } = fakeEngine({ cogSource: DEM });
    applyTerrainLook(
      engine,
      {},
      { reset: true, defaultExaggeration: DEFAULT_TERRAIN_EXAGGERATION },
    );
    assert.deepEqual(calls, { exaggeration: [DEFAULT_TERRAIN_EXAGGERATION], sources: [null] });
  });

  it("keeps a local-file DEM on a new engine for the same project", () => {
    const { engine, calls } = fakeEngine({ cogSource: null, custom: true });
    applyTerrainLook(
      engine,
      {},
      { reset: false, defaultExaggeration: DEFAULT_TERRAIN_EXAGGERATION },
    );
    assert.deepEqual(calls, { exaggeration: [], sources: [] });
  });

  it("only sets the exaggeration where the engine takes no DEM", () => {
    const { engine, calls } = fakeEngine({ terrainSource: false });
    applyTerrainLook(
      engine,
      { terrainExaggeration: 3, terrainSource: DEM },
      { reset: true, defaultExaggeration: DEFAULT_TERRAIN_EXAGGERATION },
    );
    assert.deepEqual(calls, { exaggeration: [3], sources: [] });
  });
});

describe("terrain source redaction", () => {
  it("strips credentials from a saved terrain DEM URL", () => {
    const base = createEmptyProject("Signed DEM");
    const project = {
      ...base,
      preferences: {
        ...base.preferences,
        map: {
          ...base.preferences.map,
          terrainSource: "https://example.com/dem.tif?api_key=secret",
        },
      },
    };
    const redacted = redactCredentials(project);
    assert.doesNotMatch(redacted.preferences.map.terrainSource ?? "", /secret/);
  });
});
