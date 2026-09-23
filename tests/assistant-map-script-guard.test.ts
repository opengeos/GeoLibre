import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BLOCKED_MAP_SCRIPT_METHODS,
  guardMapForScript,
} from "../apps/geolibre-desktop/src/lib/assistant/map-script-guard";

/** A stand-in map with a private field, chaining methods, and blocked methods. */
class FakeMap {
  #style = "initial";
  zoom = 3;
  calls: string[] = [];
  setStyle(style: string) {
    this.#style = style;
    return this;
  }
  remove() {
    this.calls.push("remove");
  }
  setPaintProperty(layer: string) {
    this.calls.push(`paint:${layer}`);
    return this;
  }
  getStyleName() {
    return this.#style;
  }
}

/** Run a snippet the way run_maplibre_js does: a function body with `map` in scope. */
function runSnippet(map: unknown, code: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  return new Function("map", code)(map);
}

describe("guardMapForScript (issue #2584)", () => {
  it("blocks setStyle and remove with guidance, leaving the map untouched", () => {
    const map = new FakeMap();
    const guarded = guardMapForScript(map);
    assert.throws(
      () => runSnippet(guarded, "map.setStyle('https://example.com/style.json')"),
      /set_basemap/,
    );
    assert.throws(() => runSnippet(guarded, "map.remove()"), /destroys the map/);
    assert.equal(map.getStyleName(), "initial");
    assert.deepEqual(map.calls, []);
    assert.deepEqual(Object.keys(BLOCKED_MAP_SCRIPT_METHODS).sort(), ["remove", "setStyle"]);
  });

  it("still guards a blocked call reached by chaining", () => {
    const map = new FakeMap();
    const guarded = guardMapForScript(map);
    assert.throws(
      () => runSnippet(guarded, "map.setPaintProperty('roads').setStyle('x')"),
      /set_basemap/,
    );
    assert.deepEqual(map.calls, ["paint:roads"]);
    assert.equal(map.getStyleName(), "initial");
  });

  it("passes every other method and property through to the real map", () => {
    const map = new FakeMap();
    const guarded = guardMapForScript(map);
    // Private fields only work when the method runs against the real instance.
    assert.equal(runSnippet(guarded, "return map.getStyleName()"), "initial");
    assert.equal(runSnippet(guarded, "return map.zoom"), 3);
    runSnippet(guarded, "map.zoom = 5");
    assert.equal(map.zoom, 5);
    assert.equal(runSnippet(guarded, "return map.setPaintProperty === map.setPaintProperty"), true);
    assert.ok(guarded instanceof FakeMap);
    assert.equal(guarded.constructor, FakeMap);
  });
});
