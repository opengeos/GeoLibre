import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldUseTauriFsForRecentProject } from "../apps/geolibre-desktop/src/lib/project-file-routing";

describe("recent project file routing", () => {
  it("routes Android content URIs through the Tauri filesystem plugin", () => {
    assert.equal(shouldUseTauriFsForRecentProject("content://documents/project", true), true);
  });

  it("keeps Android filesystem paths on the guarded Rust command", () => {
    assert.equal(shouldUseTauriFsForRecentProject("/storage/project.geolibre.json", true), false);
  });

  it("does not apply Android content URI routing on desktop", () => {
    assert.equal(shouldUseTauriFsForRecentProject("content://documents/project", false), false);
  });
});
