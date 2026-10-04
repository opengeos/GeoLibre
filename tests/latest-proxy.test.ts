import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLatestProxy } from "../apps/geolibre-desktop/src/lib/latest-proxy";
import {
  buildToolbarCommands,
  type ToolbarCommandContext,
} from "../apps/geolibre-desktop/src/components/layout/toolbar/toolbar-commands";

interface Shape {
  label: string;
  run: () => string;
  nested: { method: () => string; flag: boolean };
  ref: { current: { zoomIn: () => string } | null };
  ids: ReadonlySet<string>;
  list: readonly number[];
}

function version(tag: string, engine: Shape["ref"]["current"]): Shape {
  return {
    label: tag,
    run: () => `run:${tag}`,
    nested: { method: () => `nested:${tag}`, flag: tag === "b" },
    ref: { current: engine },
    ids: new Set([tag]),
    list: tag === "a" ? [1] : [1, 2],
  };
}

describe("createLatestProxy", () => {
  it("calls the newest function behind a handler captured earlier", () => {
    let latest = version("a", null);
    const view = createLatestProxy(() => latest);
    const run = view.run;
    const method = view.nested.method;
    latest = version("b", null);
    assert.equal(run(), "run:b");
    assert.equal(method(), "nested:b");
  });

  it("reads primitives at access time", () => {
    let latest = version("a", null);
    const view = createLatestProxy(() => latest);
    assert.equal(view.label, "a");
    assert.equal(view.nested.flag, false);
    latest = version("b", null);
    assert.equal(view.label, "b");
    assert.equal(view.nested.flag, true);
  });

  it("keeps optional chaining on a ref that empties or fills later", () => {
    let latest = version("a", null);
    const view = createLatestProxy(() => latest);
    const zoom = () => view.ref.current?.zoomIn();
    assert.equal(zoom(), undefined);
    latest = version("b", { zoomIn: () => "zoomed" });
    assert.equal(zoom(), "zoomed");
  });

  it("calls collection methods on the real collection", () => {
    let latest = version("a", null);
    const view = createLatestProxy(() => latest);
    assert.equal(view.ids.has("a"), true);
    assert.deepEqual(
      view.list.map((n) => n * 2),
      [2],
    );
    latest = version("b", null);
    assert.equal(view.ids.has("b"), true);
    assert.deepEqual(
      view.list.filter((n) => n > 1),
      [2],
    );
  });

  it("lets a memoized command list run the current toolbar handlers", () => {
    const calls: string[] = [];
    const contextFor = (tag: string) =>
      new Proxy(
        {
          t: ((key: string) => key) as unknown as ToolbarCommandContext["t"],
          themeMode: "light",
          collaboration: { enabled: false },
          capabilities: { nativeMapInstance: true },
          primaryRenderer: "maplibre",
          plugins: [],
          paletteExcludedPluginIds: new Set<string>(),
          isPluginEngineSupported: () => true,
          isActive: () => false,
          mapControllerRef: { current: null },
          addLayer: new Proxy({}, { get: () => () => calls.push(`addVector:${tag}`) }),
          panels: new Proxy({}, { get: () => ({ visible: false, toggle: () => {} }) }),
          setNewProjectDialogOpen: () => calls.push(`newProject:${tag}`),
        } as Record<PropertyKey, unknown>,
        { get: (target, key) => (key in target ? target[key] : () => {}) },
      ) as unknown as ToolbarCommandContext;
    let latest = contextFor("first");
    const commands = buildToolbarCommands(createLatestProxy(() => latest));
    latest = contextFor("second");
    commands.find((command) => command.id === "project.new")?.run();
    commands.find((command) => command.id === "add.vector")?.run();
    assert.deepEqual(calls, ["newProject:second", "addVector:second"]);
  });
});
