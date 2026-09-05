import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

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
    assert.doesNotMatch(
      source(TOP_TOOLBAR),
      /setBuiltInControlVisible\(\s*"terrain"/,
      `${TOP_TOOLBAR} is unmounted by ?maponly and must not apply terrain`,
    );
  });
});
