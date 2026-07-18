import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { PluginManager } from "../packages/plugins/src/plugin-manager";
import {
  __resetToolbarMenuRegistryForTests,
  getToolbarMenusSnapshot,
  registerToolbarMenu,
} from "../packages/plugins/src/toolbar-menu-registry";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../packages/plugins/src/types";

const app = {} as GeoLibreAppAPI;

function testPlugin(patch: Partial<GeoLibrePlugin> = {}): GeoLibrePlugin {
  return {
    id: "url-loader",
    name: "URL Loader",
    version: "0.1.0",
    activate: () => undefined,
    deactivate: () => undefined,
    ...patch,
  };
}

describe("PluginManager URL parameters", () => {
  it("runs matching active plugin URL parameter handlers once per context", async () => {
    const calls: string[] = [];
    const manager = new PluginManager();

    manager.register(
      testPlugin({
        urlParameterNames: [" data ", "", "data"],
        handleUrlParameters: (_app, params) => {
          calls.push(params.get("data") ?? "");
        },
      }),
    );
    manager.register(
      testPlugin({
        id: "unmatched-loader",
        urlParameterNames: ["missing"],
        handleUrlParameters: () => {
          calls.push("unmatched");
        },
      }),
    );
    manager.register(
      testPlugin({
        id: "undeclared-loader",
        handleUrlParameters: () => {
          calls.push("undeclared");
        },
      }),
    );
    manager.activate("url-loader", app);
    manager.activate("unmatched-loader", app);
    manager.activate("undeclared-loader", app);

    await manager.handleUrlParameters(
      new URLSearchParams("data=https%3A%2F%2Fexample.com%2Fdata.geojson"),
      app,
      "project-1",
    );
    await manager.handleUrlParameters(
      new URLSearchParams("data=https%3A%2F%2Fexample.com%2Fdata.geojson"),
      app,
      "project-1",
    );
    await manager.handleUrlParameters(new URLSearchParams("other=value"), app, "project-2");
    await manager.handleUrlParameters(
      new URLSearchParams("data=https%3A%2F%2Fexample.com%2Fnext.geojson"),
      app,
      "project-2",
    );

    assert.deepEqual(calls, [
      "https://example.com/data.geojson",
      "https://example.com/next.geojson",
    ]);
  });

  it("activates an installed-but-inactive plugin that owns a present parameter", async () => {
    const calls: string[] = [];
    const activateApps: GeoLibreAppAPI[] = [];
    const manager = new PluginManager();

    manager.register(
      testPlugin({
        id: "deep-link-loader",
        urlParameterNames: ["data"],
        activate: (a) => {
          activateApps.push(a);
        },
        handleUrlParameters: (_app, params) => {
          calls.push(params.get("data") ?? "");
        },
      }),
    );
    assert.equal(manager.isActive("deep-link-loader"), false);

    await manager.handleUrlParameters(new URLSearchParams("data=ds.zip"), app, "ctx");

    assert.equal(manager.isActive("deep-link-loader"), true);
    assert.deepEqual(calls, ["ds.zip"]);
    // Activated exactly once, with the app passed to handleUrlParameters.
    assert.deepEqual(activateApps, [app]);

    // Second dispatch for the same context: dedup means neither the handler
    // nor activation re-fires for the auto-activated plugin.
    await manager.handleUrlParameters(new URLSearchParams("data=ds.zip"), app, "ctx");
    assert.deepEqual(calls, ["ds.zip"]);
    assert.deepEqual(activateApps, [app]);
  });

  it("leaves an inactive plugin inactive when its parameter is absent", async () => {
    const manager = new PluginManager();
    let activated = false;

    manager.register(
      testPlugin({
        id: "deep-link-loader",
        urlParameterNames: ["data"],
        activate: () => {
          activated = true;
        },
        handleUrlParameters: () => undefined,
      }),
    );

    await manager.handleUrlParameters(new URLSearchParams("other=1"), app, "ctx");

    assert.equal(activated, false);
    assert.equal(manager.isActive("deep-link-loader"), false);
  });

  it("does not run a plugin whose activation is refused", async () => {
    const calls: string[] = [];
    const manager = new PluginManager();

    manager.register(
      testPlugin({
        id: "refuses-activation",
        urlParameterNames: ["data"],
        activate: () => false,
        handleUrlParameters: () => {
          calls.push("ran");
        },
      }),
    );

    await manager.handleUrlParameters(new URLSearchParams("data=ds.zip"), app, "ctx");

    assert.equal(manager.isActive("refuses-activation"), false);
    assert.deepEqual(calls, []);
  });

  it("awaits async handlers in registration order", async () => {
    const calls: string[] = [];
    const manager = new PluginManager();

    manager.register(
      testPlugin({
        id: "slow-loader",
        urlParameterNames: ["data"],
        handleUrlParameters: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          calls.push("slow");
        },
      }),
    );
    manager.register(
      testPlugin({
        id: "fast-loader",
        urlParameterNames: ["data"],
        handleUrlParameters: () => {
          calls.push("fast");
        },
      }),
    );
    manager.activate("slow-loader", app);
    manager.activate("fast-loader", app);

    await manager.handleUrlParameters(new URLSearchParams("data=value"), app, "project-1");

    assert.deepEqual(calls, ["slow", "fast"]);
  });

  it("keeps running handlers after one plugin throws", async () => {
    const calls: string[] = [];
    const manager = new PluginManager();

    manager.register(
      testPlugin({
        id: "broken-loader",
        urlParameterNames: ["data"],
        handleUrlParameters: () => {
          throw new Error("boom");
        },
      }),
    );
    manager.register(
      testPlugin({
        id: "working-loader",
        urlParameterNames: ["data"],
        handleUrlParameters: () => {
          calls.push("working");
        },
      }),
    );
    manager.activate("broken-loader", app);
    manager.activate("working-loader", app);

    await manager.handleUrlParameters(new URLSearchParams("data=value"), app, "project-1");

    assert.deepEqual(calls, ["working"]);
  });

  it("retries a plugin whose handler failed on a later dispatch", async () => {
    const calls: string[] = [];
    let shouldFail = true;
    const manager = new PluginManager();

    manager.register(
      testPlugin({
        urlParameterNames: ["data"],
        handleUrlParameters: () => {
          if (shouldFail) {
            shouldFail = false;
            throw new Error("boom");
          }
          calls.push("handled");
        },
      }),
    );
    manager.activate("url-loader", app);

    // The first dispatch fails, the second retries and succeeds, and the
    // third is deduped as handled.
    await manager.handleUrlParameters(new URLSearchParams("data=value"), app, "project-1");
    await manager.handleUrlParameters(new URLSearchParams("data=value"), app, "project-1");
    await manager.handleUrlParameters(new URLSearchParams("data=value"), app, "project-1");

    assert.deepEqual(calls, ["handled"]);
  });

  it("ignores calls without any URL parameters", async () => {
    const calls: string[] = [];
    const manager = new PluginManager();

    manager.register(
      testPlugin({
        urlParameterNames: ["data"],
        handleUrlParameters: () => {
          calls.push("handled");
        },
      }),
    );
    manager.activate("url-loader", app);

    await manager.handleUrlParameters(new URLSearchParams(""), app, "ctx");

    assert.deepEqual(calls, []);
  });

  it("evicts the oldest context once the retained context limit is exceeded", async () => {
    const calls: string[] = [];
    const manager = new PluginManager();

    manager.register(
      testPlugin({
        urlParameterNames: ["data"],
        handleUrlParameters: (_app, params) => {
          calls.push(params.get("data") ?? "");
        },
      }),
    );
    manager.activate("url-loader", app);

    // Handle the first context, then push it out of the bounded dedup map
    // with eight newer contexts (MAX_HANDLED_URL_CONTEXTS = 8).
    await manager.handleUrlParameters(new URLSearchParams("data=first"), app, "ctx-first");
    for (let i = 0; i < 8; i += 1) {
      await manager.handleUrlParameters(new URLSearchParams(`data=${i}`), app, `ctx-${i}`);
    }
    // The evicted context is treated as new again and re-runs the handler.
    await manager.handleUrlParameters(new URLSearchParams("data=first"), app, "ctx-first");

    assert.deepEqual(calls, ["first", "0", "1", "2", "3", "4", "5", "6", "7", "first"]);
  });

  it("does not evict an in-flight context from the dedup map", async () => {
    const calls: string[] = [];
    const resolvers: Array<() => void> = [];
    const manager = new PluginManager();

    manager.register(
      testPlugin({
        urlParameterNames: ["data"],
        handleUrlParameters: async (_app, params) => {
          const value = params.get("data") ?? "";
          if (value === "first") {
            await new Promise<void>((resolve) => {
              resolvers.push(resolve);
            });
          }
          calls.push(value);
        },
      }),
    );
    manager.activate("url-loader", app);

    // Suspend the first context, overflow the dedup map with eight newer
    // contexts, then settle the first dispatch and re-dispatch its context.
    // The in-flight context must survive eviction so the repeat is deduped.
    const firstCall = manager.handleUrlParameters(
      new URLSearchParams("data=first"),
      app,
      "ctx-first",
    );
    for (let i = 0; i < 8; i += 1) {
      await manager.handleUrlParameters(new URLSearchParams(`data=${i}`), app, `ctx-${i}`);
    }
    for (const resolve of resolvers) resolve();
    await firstCall;
    await manager.handleUrlParameters(new URLSearchParams("data=first"), app, "ctx-first");

    assert.deepEqual(calls, ["0", "1", "2", "3", "4", "5", "6", "7", "first"]);
  });

  it("keeps dedup state for overlapping calls with different contexts", async () => {
    const calls: string[] = [];
    const resolvers: Array<() => void> = [];
    const manager = new PluginManager();

    manager.register(
      testPlugin({
        urlParameterNames: ["data"],
        handleUrlParameters: async (_app, params) => {
          await new Promise<void>((resolve) => {
            resolvers.push(resolve);
          });
          calls.push(params.get("data") ?? "");
        },
      }),
    );
    manager.activate("url-loader", app);

    // Start two fire-and-forget calls with different context keys, then
    // re-dispatch the first context while both handlers are still suspended.
    const callA = manager.handleUrlParameters(new URLSearchParams("data=a"), app, "ctx-a");
    const callB = manager.handleUrlParameters(new URLSearchParams("data=b"), app, "ctx-b");
    const callARepeat = manager.handleUrlParameters(new URLSearchParams("data=a"), app, "ctx-a");
    for (const resolve of resolvers) resolve();
    await Promise.all([callA, callB, callARepeat]);

    assert.deepEqual(calls, ["a", "b"]);
  });

  it("does not re-run a handled context after deactivate and reactivate", async () => {
    const calls: string[] = [];
    const manager = new PluginManager();

    manager.register(
      testPlugin({
        urlParameterNames: ["data"],
        handleUrlParameters: () => {
          calls.push("handled");
        },
      }),
    );
    manager.activate("url-loader", app);

    await manager.handleUrlParameters(new URLSearchParams("data=value"), app, "project-1");
    manager.deactivate("url-loader", app);
    manager.activate("url-loader", app);
    await manager.handleUrlParameters(new URLSearchParams("data=value"), app, "project-1");

    assert.deepEqual(calls, ["handled"]);
  });
});

describe("PluginManager async activation", () => {
  it("rolls back the active state when an async mount resolves false", async () => {
    const deactivations: string[] = [];
    const manager = new PluginManager();
    let resolveMount: (value: boolean) => void = () => {};

    manager.register(
      testPlugin({
        id: "async-plugin",
        activate: () =>
          new Promise<boolean>((resolve) => {
            resolveMount = resolve;
          }),
        deactivate: () => {
          deactivations.push("async-plugin");
        },
      }),
    );

    manager.activate("async-plugin", app);
    // Optimistically active while the mount is in flight.
    assert.equal(manager.isActive("async-plugin"), true);

    resolveMount(false);
    // watchAsyncActivation wraps the plugin promise in Promise.resolve().then(),
    // so two microtask ticks are needed: one for the wrapper, one for the
    // callback. (The other async tests below flush twice for the same reason.)
    await Promise.resolve();
    await Promise.resolve();

    // A failed mount reverts the menu and tears down the partial activation.
    assert.equal(manager.isActive("async-plugin"), false);
    assert.deepEqual(deactivations, ["async-plugin"]);
  });

  it("rolls back the active state when an async mount rejects", async () => {
    const manager = new PluginManager();

    manager.register(
      testPlugin({
        id: "rejecting-plugin",
        activate: () => Promise.reject(new Error("chunk failed to load")),
      }),
    );

    manager.activate("rejecting-plugin", app);
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(manager.isActive("rejecting-plugin"), false);
  });

  it("keeps the plugin active when the async mount succeeds", async () => {
    const manager = new PluginManager();

    manager.register(
      testPlugin({
        id: "ok-plugin",
        activate: () => Promise.resolve(true),
      }),
    );

    manager.activate("ok-plugin", app);
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(manager.isActive("ok-plugin"), true);
  });

  it("rolls back a restored project's failed async activation", async () => {
    const manager = new PluginManager();
    let resolveMount: (value: boolean) => void = () => {};

    manager.register(
      testPlugin({
        id: "restored-plugin",
        activate: () =>
          new Promise<boolean>((resolve) => {
            resolveMount = resolve;
          }),
      }),
    );

    // Re-opening a saved project that had the plugin active goes through
    // restoreProjectState, not the interactive activate() path.
    manager.restoreProjectState(
      {
        manifestUrls: [],
        activePluginIds: ["restored-plugin"],
        mapControlPositions: {},
        settings: {},
      },
      app,
    );
    assert.equal(manager.isActive("restored-plugin"), true);

    resolveMount(false);
    await Promise.resolve();
    await Promise.resolve();

    // The chunk failed to mount, so the menu must not keep showing it active.
    assert.equal(manager.isActive("restored-plugin"), false);
  });

  it("does not revert when the user deactivates before the mount fails", async () => {
    const manager = new PluginManager();
    let resolveMount: (value: boolean) => void = () => {};

    manager.register(
      testPlugin({
        id: "race-plugin",
        activate: () =>
          new Promise<boolean>((resolve) => {
            resolveMount = resolve;
          }),
      }),
    );

    manager.activate("race-plugin", app);
    manager.deactivate("race-plugin", app);
    assert.equal(manager.isActive("race-plugin"), false);

    // A late failure for an already-inactive plugin must be a no-op.
    resolveMount(false);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(manager.isActive("race-plugin"), false);
  });

  it("does not let a stale failure revert a newer reactivation", async () => {
    const manager = new PluginManager();
    const resolvers: Array<(value: boolean) => void> = [];

    manager.register(
      testPlugin({
        id: "reactivated-plugin",
        activate: () =>
          new Promise<boolean>((resolve) => {
            resolvers.push(resolve);
          }),
      }),
    );

    // First activation (its mount is still pending).
    manager.activate("reactivated-plugin", app);
    // User deactivates, then reactivates before the first mount settles.
    manager.deactivate("reactivated-plugin", app);
    manager.activate("reactivated-plugin", app);
    assert.equal(manager.isActive("reactivated-plugin"), true);

    // The first (now superseded) activation fails. It must not roll back the
    // newer activation that is still mounting.
    resolvers[0](false);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(manager.isActive("reactivated-plugin"), true);

    // The newer activation then succeeds and stays active.
    resolvers[1](true);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(manager.isActive("reactivated-plugin"), true);
  });
});

describe("PluginManager toolbar menu scoping", () => {
  afterEach(() => __resetToolbarMenuRegistryForTests());

  it("tags registerToolbarMenu with the activating plugin's id", () => {
    const manager = new PluginManager();
    const seen: Array<string | undefined> = [];
    // The raw mock app handed to activate(); the manager scopes it internally
    // via scopeAppToPlugin before the plugin ever sees it.
    const mockApp = {
      registerToolbarMenu: (_menu: unknown, ownerPluginId?: string) => {
        seen.push(ownerPluginId);
        return () => undefined;
      },
    } as unknown as GeoLibreAppAPI;

    manager.register(
      testPlugin({
        id: "menu-plugin",
        // A plugin registers its menu with a single argument; the host injects
        // the owner id via the scoped app it was handed.
        activate: (api) =>
          void api.registerToolbarMenu?.({
            id: "menu-plugin-menu",
            label: "Workbench",
            items: [],
          }),
      }),
    );
    manager.activate("menu-plugin", mockApp);

    assert.deepEqual(seen, ["menu-plugin"]);
  });

  it("records the owner on the real registry when wired through activate", () => {
    // Guards the TypeScript-invisible contract between scopeAppToPlugin's cast
    // and the real registry's optional second parameter: drive the genuine
    // registerToolbarMenu (not a mock) through activate and assert the snapshot
    // carries the owner. Breaks if the registry ever drops the owner argument.
    const manager = new PluginManager();
    const realApp = { registerToolbarMenu } as unknown as GeoLibreAppAPI;

    manager.register(
      testPlugin({
        id: "real-menu-plugin",
        activate: (api) =>
          void api.registerToolbarMenu?.({
            id: "real-menu",
            label: "Workbench",
            items: [{ id: "open", label: "Open", onSelect: () => undefined }],
          }),
      }),
    );
    manager.activate("real-menu-plugin", realApp);

    const { entries } = getToolbarMenusSnapshot();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].menu.id, "real-menu");
    assert.equal(entries[0].ownerPluginId, "real-menu-plugin");
  });

  it("scopes a menu registered asynchronously after activate resolves", async () => {
    const manager = new PluginManager();
    const seen: Array<string | undefined> = [];
    const mockApp = {
      registerToolbarMenu: (_menu: unknown, ownerPluginId?: string) => {
        seen.push(ownerPluginId);
        return () => undefined;
      },
    } as unknown as GeoLibreAppAPI;

    let register: (() => void) | undefined;
    manager.register(
      testPlugin({
        id: "async-menu-plugin",
        activate: (api) => {
          // The plugin keeps the scoped app and registers its menu later, after
          // its activation has returned. The owner tag must still be applied.
          register = () =>
            api.registerToolbarMenu?.({
              id: "async-menu",
              label: "Late",
              items: [],
            });
          return Promise.resolve(true);
        },
      }),
    );
    manager.activate("async-menu-plugin", mockApp);
    await Promise.resolve();
    register?.();

    assert.deepEqual(seen, ["async-menu-plugin"]);
  });

  it("tags a menu (re)registered from applyProjectState, not just activate", () => {
    const manager = new PluginManager();
    const seen: Array<string | undefined> = [];
    const mockApp = {
      registerToolbarMenu: (_menu: unknown, ownerPluginId?: string) => {
        seen.push(ownerPluginId);
        return () => undefined;
      },
    } as unknown as GeoLibreAppAPI;

    manager.register(
      testPlugin({
        id: "settings-menu-plugin",
        // Plugins rebuild their menu as state changes; that can happen from
        // applyProjectState during a project load, not only from activate.
        applyProjectState: (api) =>
          void api.registerToolbarMenu?.({
            id: "settings-menu",
            label: "Workbench",
            items: [],
          }),
      }),
    );
    manager.restoreProjectState(
      {
        manifestUrls: [],
        activePluginIds: [],
        mapControlPositions: {},
        settings: { "settings-menu-plugin": {} },
      },
      mockApp,
    );

    assert.deepEqual(seen, ["settings-menu-plugin"]);
  });
});

describe("PluginManager panel auto-expand on restore", () => {
  // A control like the Basemaps panel: starts expanded and pops itself open
  // (with setTimeout(0), the way the real plugins do) when its plugin activates.
  function fakeControl() {
    return {
      collapsed: false,
      expand() {
        this.collapsed = false;
      },
      collapse() {
        this.collapsed = true;
      },
    };
  }

  function panelPlugin(id: string, control: ReturnType<typeof fakeControl>) {
    return testPlugin({
      id,
      activate: (api) => {
        api.addMapControl(control as never);
        setTimeout(() => control.expand(), 0);
      },
    });
  }

  // Drain several macrotask ticks: the re-collapse is double-deferred so it
  // lands after the plugin's own setTimeout(0) expand, and an async activation
  // adds another tick before its control even exists.
  async function flushTimers(times = 4) {
    for (let i = 0; i < times; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  it("keeps restored plugin panels collapsed", async () => {
    const manager = new PluginManager();
    const control = fakeControl();
    const addMapControl = () => true;
    const mockApp = { addMapControl } as unknown as GeoLibreAppAPI;
    manager.register(panelPlugin("basemaps", control));

    manager.restoreProjectState(
      {
        manifestUrls: [],
        activePluginIds: ["basemaps"],
        mapControlPositions: {},
        settings: {},
      },
      mockApp,
    );

    await flushTimers();
    assert.equal(
      control.collapsed,
      true,
      "a project restore must not leave plugin panels expanded over the map",
    );
  });

  it("collapses panels added by an async activation", async () => {
    const manager = new PluginManager();
    const control = fakeControl();
    const addMapControl = () => true;
    const mockApp = { addMapControl } as unknown as GeoLibreAppAPI;

    // A plugin mounted behind a dynamic import: it adds its control (and
    // auto-expands) only after activate()'s promise has begun resolving, so the
    // collapse must follow each control rather than fire once after the loop.
    manager.register(
      testPlugin({
        id: "async-basemaps",
        activate: (api) =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              api.addMapControl(control as never);
              setTimeout(() => control.expand(), 0);
              resolve();
            }, 0);
          }),
      }),
    );

    manager.restoreProjectState(
      {
        manifestUrls: [],
        activePluginIds: ["async-basemaps"],
        mapControlPositions: {},
        settings: {},
      },
      mockApp,
    );

    await flushTimers();
    assert.equal(
      control.collapsed,
      true,
      "a panel added by an async activation during restore must end collapsed",
    );
  });

  it("collapses a panel re-added when a restored position differs", async () => {
    const manager = new PluginManager();
    const control = fakeControl();
    let currentPosition = "top-right";
    const addMapControl = () => true;
    const mockApp = { addMapControl } as unknown as GeoLibreAppAPI;

    // A plugin whose saved position differs from the live one: restore calls
    // setMapControlPosition, which re-adds (and re-expands) the control. That
    // re-add must go through the restore collapse too, not just activate().
    manager.register(
      testPlugin({
        id: "positioned-plugin",
        activate: (api) => {
          api.addMapControl(control as never, "top-right" as never);
          setTimeout(() => control.expand(), 0);
        },
        getMapControlPosition: () => currentPosition as never,
        setMapControlPosition: (api, position) => {
          currentPosition = position;
          api.addMapControl(control as never, position);
          setTimeout(() => control.expand(), 0);
        },
      }),
    );

    manager.activate("positioned-plugin", mockApp);
    await flushTimers();

    manager.restoreProjectState(
      {
        manifestUrls: [],
        activePluginIds: ["positioned-plugin"],
        mapControlPositions: { "positioned-plugin": "bottom-left" as never },
        settings: {},
      },
      mockApp,
    );

    await flushTimers();
    assert.equal(
      control.collapsed,
      true,
      "a panel re-added by a position change during restore must stay collapsed",
    );
  });

  it("still expands the panel on a user activation", async () => {
    const manager = new PluginManager();
    const control = fakeControl();
    // Start collapsed so the assertion only passes if activate() really expands.
    control.collapsed = true;
    const addMapControl = () => true;
    const mockApp = { addMapControl } as unknown as GeoLibreAppAPI;
    manager.register(panelPlugin("basemaps", control));

    manager.activate("basemaps", mockApp);

    await flushTimers();
    assert.equal(
      control.collapsed,
      false,
      "activating a plugin from the menu should still open its panel",
    );
  });
});

describe("PluginManager markDefaultActive", () => {
  it("activates a marked plugin on restore with no saved state", () => {
    const manager = new PluginManager();
    const activated: string[] = [];
    manager.register(
      testPlugin({
        id: "bundled-drop-in",
        activate: () => {
          activated.push("bundled-drop-in");
        },
      }),
    );
    manager.markDefaultActive("bundled-drop-in");

    // Marking must NOT activate immediately: unlike built-in activeByDefault
    // plugins (whose startup side effects are applied idempotently elsewhere),
    // a drop-in needs its activate(app) called by the restore pass.
    assert.equal(manager.isActive("bundled-drop-in"), false);
    assert.deepEqual(activated, []);

    manager.restoreProjectState(null, app);
    assert.equal(manager.isActive("bundled-drop-in"), true);
    assert.deepEqual(activated, ["bundled-drop-in"]);
  });

  it("is overridden by saved state that omits the plugin", () => {
    const manager = new PluginManager();
    const activated: string[] = [];
    manager.register(
      testPlugin({
        id: "bundled-drop-in",
        activate: () => {
          activated.push("bundled-drop-in");
        },
      }),
    );
    manager.markDefaultActive("bundled-drop-in");

    manager.restoreProjectState(
      { manifestUrls: [], activePluginIds: [], mapControlPositions: {}, settings: {} },
      app,
    );
    assert.equal(manager.isActive("bundled-drop-in"), false);
    assert.deepEqual(activated, []);
  });

  it("ignores unregistered ids", () => {
    const manager = new PluginManager();
    manager.markDefaultActive("never-registered");
    manager.restoreProjectState(null, app);
    assert.equal(manager.isActive("never-registered"), false);
  });

  it("is cleared when the plugin is unregistered", () => {
    const manager = new PluginManager();
    manager.register(testPlugin({ id: "bundled-drop-in" }));
    manager.markDefaultActive("bundled-drop-in");
    manager.unregister("bundled-drop-in", app);

    manager.restoreProjectState(null, app);
    assert.equal(manager.isActive("bundled-drop-in"), false);
  });
});
