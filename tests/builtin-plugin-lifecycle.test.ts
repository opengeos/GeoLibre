import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createLazyPlugin,
  type LazyPluginRegistration,
} from "../packages/plugins/src/builtin-plugin-lifecycle";
import { PluginManager } from "../packages/plugins/src/plugin-manager";
import { createBuiltInPluginModules } from "../packages/plugins/src/builtin-plugin-loader";
import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
} from "../packages/plugins/src/types";

const app = {} as GeoLibreAppAPI;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}

function harness() {
  const pending = deferred<GeoLibrePlugin>();
  const environment = { generation: 0, registered: true, imports: 0, changes: 0 };
  const errors: unknown[] = [];
  const calls: string[] = [];
  let loaded: GeoLibrePlugin | undefined;
  let saved: unknown;
  let position: GeoLibreMapControlPosition = "top-right";
  const implementation: GeoLibrePlugin = {
    id: "lazy",
    name: "Lazy",
    version: "1",
    activate: () => {
      calls.push("activate");
    },
    deactivate: () => {
      calls.push("deactivate");
    },
    getProjectState: () => saved,
    applyProjectState: (_app, state) => {
      saved = state;
      calls.push(`state:${JSON.stringify(state)}`);
    },
    getMapControlPosition: () => position,
    setMapControlPosition: (_app, value) => {
      position = value;
      calls.push(`position:${value}`);
    },
    handleUrlParameters: () => {
      calls.push("url");
    },
  };
  const registration: LazyPluginRegistration = {
    metadata: {
      id: "lazy",
      name: "Lazy",
      version: "1",
      category: "tools",
      defaultMapControlPosition: "top-right",
      hooks: [
        "getProjectState",
        "applyProjectState",
        "getMapControlPosition",
        "setMapControlPosition",
        "handleUrlParameters",
      ],
    },
    load: () => {
      environment.imports++;
      return pending.promise.then((value) => {
        loaded = value;
        return value;
      });
    },
    peek: () => loaded,
    deactivatePendingState: (state) =>
      state && typeof state === "object" ? { ...state, open: false, playing: false } : state,
  };
  const adapter = createLazyPlugin(registration, {
    restoreGeneration: () => environment.generation,
    isRegistered: () => environment.registered,
    changed: () => {
      environment.changes++;
    },
    reportError: (error) => {
      errors.push(error);
    },
  });
  return {
    adapter,
    registration,
    pending,
    environment,
    implementation,
    calls,
    errors,
    setLoaded: (value: GeoLibrePlugin) => {
      loaded = value;
    },
  };
}

describe("lazy plugin lifecycle", () => {
  it("retains live settings and teardown after a later configuration failure evicts the module", async () => {
    const test = harness();
    let imports = 0;
    let failSetup = false;
    const modules = createBuiltInPluginModules({
      native: async () => {
        imports++;
        return { plugin: test.implementation };
      },
    });
    const setup = () => {
      if (failSetup) throw new Error("labels failed");
    };
    modules.configure("native", { labels: setup });
    const lazy = createLazyPlugin(
      {
        ...test.registration,
        load: async () => (await modules.loadModule("native")).plugin,
        peek: () => modules.peekModule("native")?.plugin,
      },
      {
        restoreGeneration: () => 0,
        isRegistered: () => true,
        changed: () => {},
        reportError: (error) => {
          throw error;
        },
      },
    );
    await lazy.plugin.activate(app);
    test.implementation.applyProjectState?.(app, { value: 42 });
    failSetup = true;
    assert.throws(() => modules.configure("native", { labels: setup }), /labels failed/);
    assert.equal(modules.peekModule("native"), undefined);
    assert.deepEqual(lazy.plugin.getProjectState?.(), { value: 42 });
    lazy.plugin.deactivate(app);
    assert.equal(test.calls.at(-1), "deactivate");
    failSetup = false;
    await lazy.prepare(app);
    assert.equal(imports, 2);
  });

  it("does not activate an implementation loaded for an obsolete renderer", async () => {
    const test = harness();
    let renderer: "mapbox" | "cesium" = "mapbox";
    const host = { getMapRenderer: () => renderer } as unknown as GeoLibreAppAPI;
    const activation = test.adapter.plugin.activate(host);
    renderer = "cesium";
    test.pending.resolve(test.implementation);
    assert.equal(await activation, false);
    assert.deepEqual(test.calls, []);
  });

  it("cancels pending helper and state writes as soon as the renderer changes", async () => {
    const test = harness();
    const manager = new PluginManager();
    let renderer: "mapbox" | "cesium" = "mapbox";
    const host = { getMapRenderer: () => renderer } as unknown as GeoLibreAppAPI;
    manager.registerLazy({
      ...test.registration,
      metadata: { ...test.registration.metadata, engines: ["mapbox", "cesium"] },
    });
    manager.restoreProjectState(
      {
        manifestUrls: [],
        activePluginIds: [],
        mapControlPositions: {},
        settings: { lazy: { value: 42 } },
      },
      host,
    );
    let called = false;
    const helper = manager.runPluginHelper("lazy", host, () => {
      called = true;
    });
    renderer = "cesium";
    test.pending.resolve(test.implementation);
    await assert.rejects(helper, /superseded/);
    assert.equal(called, false);
    assert.deepEqual(test.calls, []);
    assert.deepEqual(manager.getProjectState().settings.lazy, { value: 42 });
    manager.restoreProjectState(null, host);
    await tick();
    assert.deepEqual(test.calls, ['state:{"value":42}']);
  });

  it("allows a supported host control helper without activating an unsupported plugin panel", async () => {
    const test = harness();
    const manager = new PluginManager();
    let mounts = 0;
    let renderer: "mapbox" | "cesium" = "mapbox";
    const host = {
      getMapRenderer: () => renderer,
      addMapControl: () => {
        mounts++;
        return true;
      },
    } as unknown as GeoLibreAppAPI;
    manager.registerLazy({
      ...test.registration,
      metadata: { ...test.registration.metadata, engines: ["maplibre"] },
    });
    assert.equal(manager.activate("lazy", host), false);
    let retained: GeoLibreAppAPI | undefined;
    const helper = manager.runPluginHelper("lazy", host, (_implementation, scoped) => {
      retained = scoped;
      return scoped.addMapControl({ onAdd: () => ({}) as HTMLElement, onRemove() {} });
    });
    test.pending.resolve(test.implementation);
    assert.equal(await helper, true);
    assert.equal(mounts, 1);
    assert.equal(manager.isActive("lazy"), false);
    renderer = "cesium";
    retained!.addMapControl({ onAdd: () => ({}) as HTMLElement, onRemove() {} });
    assert.equal(mounts, 1);
  });

  it("prepares state before a host helper and fences its retained app scope", async () => {
    const test = harness();
    const manager = new PluginManager();
    let mounts = 0;
    const host = {
      addMapControl: () => {
        mounts++;
        return true;
      },
    } as unknown as GeoLibreAppAPI;
    manager.registerLazy(test.registration);
    manager.restoreProjectState(
      {
        manifestUrls: [],
        activePluginIds: [],
        mapControlPositions: {},
        settings: { lazy: { value: 42 } },
      },
      host,
    );
    let retained: GeoLibreAppAPI | undefined;
    const helper = manager.runPluginHelper("lazy", host, (implementation, scopedApp) => {
      assert.deepEqual(implementation.getProjectState?.(), { value: 42 });
      retained = scopedApp;
      scopedApp.addMapControl({ onAdd: () => ({}) as HTMLElement, onRemove() {} });
      return "ready";
    });
    test.pending.resolve(test.implementation);
    assert.equal(await helper, "ready");
    assert.equal(mounts, 1);
    manager.restoreProjectState(null, host);
    retained!.addMapControl({ onAdd: () => ({}) as HTMLElement, onRemove() {} });
    assert.equal(mounts, 1);
  });

  it("does not run a helper superseded while its implementation loads", async () => {
    const test = harness();
    const manager = new PluginManager();
    manager.registerLazy(test.registration);
    let calls = 0;
    const helper = manager.runPluginHelper("lazy", app, () => {
      calls++;
    });
    manager.restoreProjectState(null, app);
    test.pending.resolve(test.implementation);
    await assert.rejects(helper, /superseded/);
    assert.equal(calls, 0);
  });

  it("loads default-active entries through the manager instead of marking them initialized", async () => {
    const test = harness();
    const manager = new PluginManager();
    manager.registerLazy({
      ...test.registration,
      metadata: { ...test.registration.metadata, activeByDefault: true },
    });
    assert.equal(test.environment.imports, 0);
    assert.equal(manager.isActive("lazy"), false);
    manager.restoreProjectState(null, app);
    const active = manager.activate("lazy", app);
    test.pending.resolve(test.implementation);
    assert.equal(await active, true);
    assert.deepEqual(test.calls, ["activate"]);
  });

  it("preserves inactive manager snapshots and discards a superseded restore", async () => {
    const test = harness();
    const manager = new PluginManager();
    manager.registerLazy(test.registration);
    const state = (value: string) => ({
      manifestUrls: [],
      activePluginIds: [],
      mapControlPositions: {},
      settings: { lazy: { value } },
    });
    manager.restoreProjectState(state("old"), app);
    assert.deepEqual(manager.getProjectState().settings.lazy, { value: "old" });
    manager.restoreProjectState(state("new"), app);
    test.pending.resolve(test.implementation);
    await tick();
    assert.deepEqual(test.calls, ['state:{"value":"new"}']);
    assert.equal(manager.isActive("lazy"), false);
    assert.equal(await manager.preparePlugin("lazy", app), test.implementation);

    const removed = harness();
    const other = new PluginManager();
    other.registerLazy(removed.registration);
    other.restoreProjectState(state("removed"), app);
    other.unregister("lazy", app);
    removed.pending.resolve(removed.implementation);
    await tick();
    assert.deepEqual(removed.calls, []);
  });

  it("retargets a pending session activation when the renderer changes", async () => {
    const test = harness();
    const manager = new PluginManager();
    let renderer: "maplibre" | "cesium" = "maplibre";
    let mounts = 0;
    const scopedApp = {
      getMapRenderer: () => renderer,
      addMapControl: () => {
        mounts++;
      },
    } as unknown as GeoLibreAppAPI;
    test.implementation.activate = (current) => {
      current.addMapControl({ onAdd: () => ({}) as HTMLElement, onRemove() {} });
    };
    manager.registerLazy({
      ...test.registration,
      metadata: {
        ...test.registration.metadata,
        sessionScoped: true,
        engines: ["maplibre", "cesium"],
      },
    });
    manager.restoreProjectState(null, scopedApp);
    const old = manager.activate("lazy", scopedApp);
    renderer = "cesium";
    manager.restoreProjectState(null, scopedApp, { mapReplaced: true });
    test.pending.resolve(test.implementation);
    await old;
    await tick();
    assert.equal(manager.isActive("lazy"), true);
    assert.equal(mounts, 1);
    assert.deepEqual(manager.getProjectState().activePluginIds, []);
  });

  it("keeps pending snapshots and restores positions before settings", async () => {
    const test = harness();
    test.adapter.plugin.applyProjectState!(app, undefined);
    test.adapter.plugin.setMapControlPosition!(app, "bottom-left");
    assert.equal(test.environment.imports, 0);
    const state = { value: 42 };
    test.adapter.plugin.applyProjectState!(app, state);
    assert.deepEqual(test.adapter.plugin.getProjectState!(), state);
    assert.equal(test.adapter.plugin.getMapControlPosition!(), "bottom-left");
    test.pending.resolve(test.implementation);
    await tick();
    assert.deepEqual(test.calls, ["position:bottom-left", 'state:{"value":42}']);
    assert.deepEqual(test.adapter.plugin.getProjectState!(), state);
    assert.equal(test.environment.changes, 1);
  });

  it("cancels late activation and keeps the closed saved state", async () => {
    const test = harness();
    test.adapter.plugin.applyProjectState!(app, { open: true, playing: true, value: 42 });
    const activation = test.adapter.plugin.activate(app);
    test.adapter.plugin.deactivate(app);
    assert.deepEqual(test.adapter.plugin.getProjectState!(), {
      open: false,
      playing: false,
      value: 42,
    });
    test.pending.resolve(test.implementation);
    assert.equal(await activation, false);
    await tick();
    assert.deepEqual(test.calls, []);
    await test.adapter.prepare(app);
    assert.deepEqual(test.adapter.plugin.getProjectState!(), {
      open: false,
      playing: false,
      value: 42,
    });
    assert.equal(
      test.calls.some((call) => call === "activate"),
      false,
    );
  });

  it("applies only the latest project and prevents writes after unregister", async () => {
    const test = harness();
    test.adapter.plugin.applyProjectState!(app, { project: "old" });
    test.environment.generation++;
    test.adapter.retargetRestore(app);
    test.adapter.plugin.applyProjectState!(app, { project: "new" });
    test.pending.resolve(test.implementation);
    await tick();
    assert.deepEqual(test.calls, ['state:{"project":"new"}']);
    test.adapter.plugin.applyProjectState!(app, undefined);
    assert.equal(test.adapter.plugin.getProjectState!(), undefined);

    const removed = harness();
    removed.adapter.plugin.applyProjectState!(app, { project: "removed" });
    removed.environment.registered = false;
    removed.pending.resolve(removed.implementation);
    await tick();
    assert.deepEqual(removed.calls, []);
  });

  it("rejects superseded helper preparation before applying pending settings", async () => {
    const test = harness();
    const preparing = test.adapter.prepare(app);
    test.environment.generation++;
    test.pending.resolve(test.implementation);
    await assert.rejects(preparing, /superseded/);
    assert.deepEqual(test.calls, []);
  });

  it("waits for native activation before URL dispatch and handles cancellation", async () => {
    const test = harness();
    const mounted = deferred<void>();
    test.implementation.activate = () => {
      test.calls.push("activate");
      return mounted.promise;
    };
    const activation = test.adapter.plugin.activate(app);
    const url = Promise.resolve(
      test.adapter.plugin.handleUrlParameters!(app, new URLSearchParams("data=1")),
    );
    test.pending.resolve(test.implementation);
    await tick();
    assert.deepEqual(test.calls, ["activate"]);
    test.adapter.plugin.deactivate(app);
    mounted.resolve();
    assert.equal(await activation, false);
    await assert.rejects(url, /activate|superseded/);
    assert.equal(test.calls.includes("url"), false);
  });

  it("retains settings when an import fails and reads implementations loaded by helpers", async () => {
    const test = harness();
    test.adapter.plugin.applyProjectState!(app, { value: "preserved" });
    test.pending.reject(new Error("Unavailable"));
    await tick();
    assert.equal(test.errors.length, 1);
    assert.deepEqual(test.adapter.plugin.getProjectState!(), { value: "preserved" });
    const external = harness();
    external.implementation.getProjectState = () => ({ value: "helper" });
    external.setLoaded(external.implementation);
    assert.deepEqual(external.adapter.plugin.getProjectState!(), { value: "helper" });
  });
});
