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
  #listeners = new Map<string, Array<(event: unknown) => void>>();
  on(type: string, listener: (event: unknown) => void) {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
    return this;
  }
  off(type: string, listener: (event: unknown) => void) {
    this.#listeners.set(
      type,
      (this.#listeners.get(type) ?? []).filter((entry) => entry !== listener),
    );
    return this;
  }
  once(type: string, listener?: (event: unknown) => void): this | Promise<unknown> {
    if (!listener) {
      return new Promise((resolve) => {
        const handler = (event: unknown) => {
          this.off(type, handler);
          resolve(event);
        };
        this.on(type, handler);
      });
    }
    const handler = (event: unknown) => {
      this.off(type, handler);
      listener.call(this, event);
    };
    return this.on(type, handler);
  }
  /** Fire like MapLibre's Evented: `this` and `event.target` are the real map. */
  fire(type: string) {
    const event = { type, target: this, preventDefault() {} };
    for (const listener of this.#listeners.get(type) ?? []) listener.call(this, event);
  }
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

  it("hands event listeners the guarded map as this and event.target", async () => {
    const map = new FakeMap();
    const guarded = guardMapForScript(map);
    runSnippet(
      guarded,
      `map.on('idle', function (e) {
        try { this.setStyle('x'); } catch (error) { window_errors.push('this:' + error.message); }
        try { e.target.setStyle('x'); } catch (error) { window_errors.push('target:' + error.message); }
        e.preventDefault();
      });`.replaceAll("window_errors", "globalThis.__guardErrors"),
    );
    (globalThis as { __guardErrors?: string[] }).__guardErrors = [];
    const pending = (guarded as unknown as { once: (type: string) => Promise<unknown> }).once(
      "idle",
    );
    map.fire("idle");
    const errors = (globalThis as { __guardErrors?: string[] }).__guardErrors ?? [];
    assert.equal(errors.length, 2);
    assert.match(errors[0], /^this:.*set_basemap/);
    assert.match(errors[1], /^target:.*set_basemap/);
    const event = (await pending) as { target: { setStyle: (style: string) => void } };
    assert.throws(() => event.target.setStyle("x"), /set_basemap/);
    assert.equal(map.getStyleName(), "initial");
    delete (globalThis as { __guardErrors?: string[] }).__guardErrors;
  });

  it("removes a listener through off with the function passed to on", () => {
    const map = new FakeMap();
    const guarded = guardMapForScript(map);
    let calls = 0;
    const listener = () => {
      calls += 1;
    };
    guarded.on("move", listener);
    guarded.off("move", listener);
    map.fire("move");
    assert.equal(calls, 0);
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
