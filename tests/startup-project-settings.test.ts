import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeDesktopSettings } from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";

describe("startup project settings", () => {
  it("defaults to the normal untitled workspace", () => {
    assert.deepEqual(normalizeDesktopSettings({}).startup, {
      mode: "default",
      projectPath: null,
      projectName: null,
    });
  });

  it("normalizes a selected startup project", () => {
    assert.deepEqual(
      normalizeDesktopSettings({
        startup: {
          mode: "specific",
          projectPath: " /tmp/field.geolibre.json ",
          projectName: " Field ",
        },
      }).startup,
      {
        mode: "specific",
        projectPath: "/tmp/field.geolibre.json",
        projectName: "Field",
      },
    );
  });

  it("rejects a specific mode without a path and unknown modes", () => {
    assert.equal(
      normalizeDesktopSettings({ startup: { mode: "specific" } }).startup.mode,
      "default",
    );
    assert.equal(
      normalizeDesktopSettings({ startup: { mode: "tampered" } }).startup.mode,
      "default",
    );
  });
});
