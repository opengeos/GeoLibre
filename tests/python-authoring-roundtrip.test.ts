import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { DEFAULT_LAYER_STYLE, parseProject, validateMapExpression } from "@geolibre/core";

// Written by the geolibre Python package's authoring functions
// (python/tests/test_authoring_parity.py pins it to what they produce). Loading
// it through the app's own parseProject proves the layer filter, labels, plugin
// state and story map the Python package and MCP server write are read back
// unchanged, rather than silently normalized away.
const fixtureText = readFileSync(
  new URL("./fixtures/python-authoring.geolibre.json", import.meta.url),
  "utf8",
);
const fixture = JSON.parse(fixtureText);

/** Drop `undefined` members the normalizers add, so shapes compare as JSON. */
function asJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("Python-authored project round trip", () => {
  const project = parseProject(fixtureText);
  const layer = project.layers.find((item) => item.id === "cities");
  const source = fixture.layers.find((item: { id: string }) => item.id === "cities");

  it("keeps the persistent layer filter", () => {
    assert.ok(layer);
    assert.deepEqual(layer.filterExpression, source.filterExpression);
    assert.ok(
      validateMapExpression(JSON.stringify(source.filterExpression), { expectedType: "boolean" })
        .ok,
    );
  });

  it("keeps every label setting, with no key the app does not know", () => {
    assert.ok(layer);
    assert.deepEqual(layer.style.labels, source.style.labels);
    assert.deepEqual(
      Object.keys(source.style.labels).sort(),
      Object.keys(DEFAULT_LAYER_STYLE.labels).sort(),
    );
    for (const key of ["sizeExpression", "visibilityExpression"] as const) {
      assert.ok(validateMapExpression(layer.style.labels[key]).ok, key);
    }
    assert.ok(
      validateMapExpression(layer.style.labels.visibilityExpression, { expectedType: "boolean" })
        .ok,
    );
  });

  it("keeps the plugin state, its corner, and the default plugins", () => {
    assert.ok(project.plugins);
    assert.deepEqual(project.plugins.settings, fixture.plugins.settings);
    assert.deepEqual(project.plugins.mapControlPositions, fixture.plugins.mapControlPositions);
    assert.deepEqual(project.plugins.activePluginIds, fixture.plugins.activePluginIds);
  });

  it("keeps the story map and its chapters exactly", () => {
    assert.deepEqual(asJson(project.storymap), fixture.storymap);
    assert.deepEqual(
      project.storymap?.chapters.map((chapter) => chapter.id),
      ["overview", "close-up"],
    );
  });
});
