import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setMapViewUrl, setPluginUrlParameters } from "../apps/geolibre-desktop/src/lib/live-url";
import { PluginManager } from "../packages/plugins/src/plugin-manager";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../packages/plugins/src/types";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});
function address(search: string) {
  let href = `https://web.geolibre.app/${search}#keep`;
  let writes = 0;
  const state = { keep: true };
  const windowLike = {
    location: {
      get href() {
        return href;
      },
    },
    history: {
      state,
      replaceState(value: unknown, _title: string, url: string) {
        assert.equal(value, state);
        href = url;
        writes++;
      },
    },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowLike });
  return {
    windowLike,
    params: () => new URL(href).searchParams,
    href: () => href,
    writes: () => writes,
  };
}

test("camera and plugin updates merge, preserve host state and remove omitted plugin names", () => {
  const url = address("?url=project.json&plugin=example&own=old&omit=old&other=keep");
  setPluginUrlParameters(new URLSearchParams("own=a&own=b&lat=99&url=bad&other=bad"), [
    "own",
    "omit",
    "lat",
    "url",
  ]);
  setMapViewUrl({ center: [260, 37.12345678], zoom: 4.593, bearing: 0, pitch: 0 });
  assert.deepEqual(url.params().getAll("own"), ["a", "b"]);
  assert.equal(url.params().has("omit"), false);
  assert.equal(url.params().get("other"), "keep");
  assert.equal(url.params().get("url"), "project.json");
  assert.equal(url.params().get("plugin"), "example");
  assert.equal(url.params().get("lat"), "37.123457");
  assert.equal(url.params().get("lon"), "-100");
  assert.equal(url.params().get("zoom"), "4.59");
  assert.equal(new URL(url.href()).hash, "#keep");
  setMapViewUrl({ center: [260, 37.12345678], zoom: 4.593, bearing: 0, pitch: 0 });
  assert.equal(url.writes(), 2);
});

test("Desktop URL writes and unscoped plugin writes are no-ops", () => {
  const url = address("?own=old");
  setPluginUrlParameters(new URLSearchParams("own=new"));
  Object.assign(url.windowLike, { __TAURI_INTERNALS__: {} });
  setPluginUrlParameters(new URLSearchParams("own=new"), ["own"]);
  setMapViewUrl({ center: [0, 0], zoom: 0, bearing: 0, pitch: 0 });
  assert.equal(url.writes(), 0);
});

test("plugin ownership, deactivation, stale callbacks and failed activation", async () => {
  const url = address("?own=old&other=keep&url=project.json");
  const manager = new PluginManager();
  const host = { setUrlParameters: setPluginUrlParameters } as GeoLibreAppAPI;
  let scoped!: GeoLibreAppAPI;
  const plugin: GeoLibrePlugin = {
    id: "example",
    name: "Example",
    version: "1.0.0",
    urlParameterNames: ["own", "url"],
    activate(app) {
      scoped = app;
    },
    deactivate() {},
  };
  manager.register(plugin);
  await manager.activate(plugin.id, host);
  const stale = scoped;
  scoped.setUrlParameters?.(new URLSearchParams("own=new&other=bad&url=bad"));
  assert.equal(url.params().get("own"), "new");
  assert.equal(url.params().get("other"), "keep");
  assert.equal(url.params().get("url"), "project.json");
  manager.deactivate(plugin.id, host);
  stale.setUrlParameters?.(new URLSearchParams("own=stale"));
  assert.equal(url.params().has("own"), false);
  await manager.activate(plugin.id, host);
  stale.setUrlParameters?.(new URLSearchParams("own=stale"));
  assert.equal(url.params().has("own"), false);
  scoped.setUrlParameters?.(new URLSearchParams("own=live"));
  manager.unregister(plugin.id, host);
  assert.equal(url.params().has("own"), false);
  manager.register({
    ...plugin,
    async activate(app) {
      app.setUrlParameters?.(new URLSearchParams("own=failed"));
      return false;
    },
  });
  assert.equal(await manager.activate(plugin.id, host), false);
  assert.equal(url.params().has("own"), false);
});

test("plugin declarations cannot overwrite host launch and layout parameters", () => {
  // Keep these cases aligned with the launch links in data-url.ts,
  // desktop-settings-url.ts, useLayoutOptions.ts and screenshot-readiness.ts.
  const names = [
    "data",
    "stac",
    "style",
    "dataType",
    "add",
    "serviceUrl",
    "serviceStyle",
    "serviceLayer",
    "projectUrl",
    "project_url",
    "settingsUrl",
    "settingUrl",
    "tool",
    "layout",
    "panels",
    "toolbar",
    "iframe",
    "hidePanels",
    "maponly",
    "draw",
    "welcome",
    "loading",
    "locale",
    "lang",
    "collab",
  ];
  const initial = new URLSearchParams(names.map((name) => [name, "keep"]));
  const url = address(`?${initial}`);
  const patch = new URLSearchParams(names.map((name) => [name, "bad"]));
  setPluginUrlParameters(patch, [...names, "own"]);
  assert.deepEqual([...url.params()], [...initial]);
  assert.equal(url.writes(), 0);
});

test("conflicting plugin declarations cannot overwrite or clear another plugin's parameters", async () => {
  const url = address("?shared=initial");
  const manager = new PluginManager();
  const host = { setUrlParameters: setPluginUrlParameters } as GeoLibreAppAPI;
  let first!: GeoLibreAppAPI;
  let second!: GeoLibreAppAPI;
  let secondHandled = false;
  manager.register({
    id: "first",
    name: "First",
    version: "1.0.0",
    urlParameterNames: ["shared"],
    activate(app) {
      first = app;
    },
    deactivate() {},
  });
  manager.register({
    id: "second",
    name: "Second",
    version: "1.0.0",
    urlParameterNames: ["shared", "second"],
    activate(app) {
      second = app;
    },
    deactivate() {},
    handleUrlParameters() {
      secondHandled = true;
    },
  });
  await manager.activate("first", host);
  await manager.activate("second", host);
  first.setUrlParameters?.(new URLSearchParams("shared=first"));
  second.setUrlParameters?.(new URLSearchParams("shared=second&second=own"));
  assert.equal(url.params().get("shared"), "first");
  assert.equal(url.params().get("second"), "own");
  await manager.handleUrlParameters(new URLSearchParams("shared=deep-link"), host);
  assert.equal(secondHandled, true);
  manager.deactivate("second", host);
  assert.equal(url.params().get("shared"), "first");
  assert.equal(url.params().has("second"), false);
  manager.unregister("second", host);
  assert.equal(url.params().get("shared"), "first");
  manager.deactivate("first", host);
  assert.equal(url.params().has("shared"), false);
});

test("failed or declined activation preserves untouched inbound URL parameters for retry", async () => {
  for (const failure of ["decline", "throw", "reject"] as const) {
    const url = address("?inbound=keep");
    const manager = new PluginManager();
    const host = { setUrlParameters: setPluginUrlParameters } as GeoLibreAppAPI;
    const plugin: GeoLibrePlugin = {
      id: "retry",
      name: "Retry",
      version: "1.0.0",
      urlParameterNames: ["inbound"],
      activate() {
        if (failure === "decline") return false;
        if (failure === "throw") throw new Error("retry later");
        return Promise.reject(new Error("retry later"));
      },
      deactivate() {},
    };
    manager.register(plugin);
    try {
      await manager.activate(plugin.id, host);
    } catch {
      /* synchronous failure */
    }
    assert.equal(url.params().get("inbound"), "keep", failure);
    manager.register({ ...plugin, activate() {} });
    await manager.activate(plugin.id, host);
    manager.deactivate(plugin.id, host);
    assert.equal(url.params().has("inbound"), false, "explicit deactivation clears the link");
  }
});

test("replacing a plugin retains retired names until host cleanup without granting writes to them", async () => {
  for (const cleanup of ["deactivate", "unregister", "publish"] as const) {
    const url = address("?other=keep");
    const manager = new PluginManager();
    const host = { setUrlParameters: setPluginUrlParameters } as GeoLibreAppAPI;
    let scoped!: GeoLibreAppAPI;
    const plugin: GeoLibrePlugin = {
      id: "replace",
      name: "Replace",
      version: "1.0.0",
      urlParameterNames: ["old"],
      activate(app) {
        scoped = app;
      },
      deactivate() {},
    };
    manager.register(plugin);
    await manager.activate(plugin.id, host);
    scoped.setUrlParameters?.(new URLSearchParams("old=1"));
    manager.register({
      ...plugin,
      urlParameterNames: ["new"],
      handleUrlParameters(app) {
        scoped = app;
      },
    });
    assert.equal(url.params().get("old"), "1", "registration has no host for cleanup");
    if (cleanup === "publish") {
      await manager.handleUrlParameters(new URLSearchParams("new=initial"), host);
      scoped.setUrlParameters?.(new URLSearchParams("old=forbidden&new=2"));
      assert.equal(url.params().get("new"), "2");
    } else {
      manager[cleanup](plugin.id, host);
    }
    assert.equal(url.params().has("old"), false, cleanup);
    assert.equal(url.params().get("other"), "keep");
    // Cleanup released the retired claim so a different plugin can own it.
    manager.register({ ...plugin, id: "next" });
    await manager.activate("next", host);
    scoped.setUrlParameters?.(new URLSearchParams("old=next"));
    assert.equal(url.params().get("old"), "next");
  }
});

test("URL writer failures do not interrupt plugin deactivation or unregistration", async () => {
  for (const cleanup of ["deactivate", "unregister"] as const) {
    address("?other=keep");
    const manager = new PluginManager();
    let fail = false;
    let writes = 0;
    const host = {
      setUrlParameters(params: URLSearchParams, names: readonly string[] = []) {
        writes++;
        if (fail) throw new Error("history unavailable");
        setPluginUrlParameters(params, names);
      },
    } as GeoLibreAppAPI;
    let scoped!: GeoLibreAppAPI;
    manager.register({
      id: "failure",
      name: "Failure",
      version: "1.0.0",
      urlParameterNames: ["own"],
      activate(app) {
        scoped = app;
      },
      deactivate() {},
    });
    await manager.activate("failure", host);
    scoped.setUrlParameters?.(new URLSearchParams("own=1"));
    let notifications = 0;
    manager.subscribe(() => notifications++);
    fail = true;
    assert.doesNotThrow(() => manager[cleanup]("failure", host));
    assert.equal(manager.isActive("failure"), false);
    assert.equal(notifications, 1);
    assert.equal(
      manager.list().some((plugin) => plugin.id === "failure"),
      cleanup !== "unregister",
    );
    const completedWrites = writes;
    scoped.setUrlParameters?.(new URLSearchParams("own=stale"));
    assert.equal(writes, completedWrites, "callbacks retained after cleanup cannot write");
  }
});

test("a failed host write keeps retired names reserved for the next cleanup attempt", async () => {
  const url = address("");
  const manager = new PluginManager();
  let fail = false;
  const host = {
    setUrlParameters(params: URLSearchParams, names: readonly string[] = []) {
      if (fail) throw new Error("history unavailable");
      setPluginUrlParameters(params, names);
    },
  } as GeoLibreAppAPI;
  let scoped!: GeoLibreAppAPI;
  const plugin: GeoLibrePlugin = {
    id: "replace",
    name: "Replace",
    version: "1.0.0",
    urlParameterNames: ["old"],
    activate(app) {
      scoped = app;
    },
    deactivate() {},
    handleUrlParameters(app) {
      scoped = app;
    },
  };
  manager.register(plugin);
  await manager.activate(plugin.id, host);
  scoped.setUrlParameters?.(new URLSearchParams("old=1"));
  manager.register({ ...plugin, urlParameterNames: ["new"] });
  await manager.handleUrlParameters(new URLSearchParams("new=initial"), host);
  fail = true;
  assert.doesNotThrow(() => scoped.setUrlParameters?.(new URLSearchParams("new=2")));
  assert.equal(url.params().get("old"), "1");
  fail = false;
  scoped.setUrlParameters?.(new URLSearchParams("new=3"));
  assert.equal(url.params().has("old"), false);
  assert.equal(url.params().get("new"), "3");
});

test("a failed publication does not mark inbound parameters for failed-activation cleanup", async () => {
  const url = address("?own=inbound");
  const manager = new PluginManager();
  let writes = 0;
  const host = {
    setUrlParameters(params: URLSearchParams, names: readonly string[] = []) {
      if (++writes === 1) throw new Error("temporary history failure");
      setPluginUrlParameters(params, names);
    },
  } as GeoLibreAppAPI;
  manager.register({
    id: "failure",
    name: "Failure",
    version: "1.0.0",
    urlParameterNames: ["own"],
    activate(app) {
      app.setUrlParameters?.(new URLSearchParams("own=changed"));
      return false;
    },
    deactivate() {},
  });
  assert.equal(await manager.activate("failure", host), false);
  assert.equal(url.params().get("own"), "inbound");
  assert.equal(writes, 1, "failed publication does not trigger a second clearing write");
});

test("failed URL cleanup retains publication state until a later activation failure clears it", async () => {
  for (const failure of ["decline", "throw", "reject"] as const) {
    let url = address("?other=keep");
    const manager = new PluginManager();
    let failWrite = false;
    let attempts = 0;
    const host = {
      setUrlParameters(params: URLSearchParams, names: readonly string[] = []) {
        if (failWrite) throw new Error("temporary history failure");
        setPluginUrlParameters(params, names);
      },
    } as GeoLibreAppAPI;
    manager.register({
      id: "retry",
      name: "Retry",
      version: "1.0.0",
      urlParameterNames: ["own"],
      activate(app) {
        if (++attempts === 1) {
          app.setUrlParameters?.(new URLSearchParams("own=stale"));
          failWrite = true;
        }
        if (failure === "decline") return false;
        if (failure === "throw") throw new Error("activation failed");
        return Promise.reject(new Error("activation failed"));
      },
      deactivate() {},
    });
    const attempt = async () => {
      try {
        await manager.activate("retry", host);
      } catch {
        /* synchronous failure */
      }
      assert.equal(manager.isActive("retry"), false);
    };
    await attempt();
    assert.equal(url.params().get("own"), "stale");
    failWrite = false;
    await attempt();
    assert.equal(url.params().has("own"), false, failure);
    assert.equal(url.params().get("other"), "keep");
    // Once cleanup succeeds, a fresh inbound link must remain retryable.
    url = address("?own=fresh");
    await attempt();
    assert.equal(url.params().get("own"), "fresh");
  }
});
