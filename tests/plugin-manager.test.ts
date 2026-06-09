import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PluginManager } from "../packages/plugins/src/plugin-manager";
import type {
  GeoLibreAppAPI,
  GeoLibrePlugin,
} from "../packages/plugins/src/types";

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
    await manager.handleUrlParameters(
      new URLSearchParams("other=value"),
      app,
      "project-2",
    );
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

    await manager.handleUrlParameters(
      new URLSearchParams("data=ds.zip"),
      app,
      "ctx",
    );

    assert.equal(manager.isActive("deep-link-loader"), true);
    assert.deepEqual(calls, ["ds.zip"]);
    // Activated exactly once, with the app passed to handleUrlParameters.
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

    await manager.handleUrlParameters(
      new URLSearchParams("other=1"),
      app,
      "ctx",
    );

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

    await manager.handleUrlParameters(
      new URLSearchParams("data=ds.zip"),
      app,
      "ctx",
    );

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

    await manager.handleUrlParameters(
      new URLSearchParams("data=value"),
      app,
      "project-1",
    );

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

    await manager.handleUrlParameters(
      new URLSearchParams("data=value"),
      app,
      "project-1",
    );

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
    await manager.handleUrlParameters(
      new URLSearchParams("data=value"),
      app,
      "project-1",
    );
    await manager.handleUrlParameters(
      new URLSearchParams("data=value"),
      app,
      "project-1",
    );
    await manager.handleUrlParameters(
      new URLSearchParams("data=value"),
      app,
      "project-1",
    );

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
    await manager.handleUrlParameters(
      new URLSearchParams("data=first"),
      app,
      "ctx-first",
    );
    for (let i = 0; i < 8; i += 1) {
      await manager.handleUrlParameters(
        new URLSearchParams(`data=${i}`),
        app,
        `ctx-${i}`,
      );
    }
    // The evicted context is treated as new again and re-runs the handler.
    await manager.handleUrlParameters(
      new URLSearchParams("data=first"),
      app,
      "ctx-first",
    );

    assert.deepEqual(calls, [
      "first",
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "first",
    ]);
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
      await manager.handleUrlParameters(
        new URLSearchParams(`data=${i}`),
        app,
        `ctx-${i}`,
      );
    }
    for (const resolve of resolvers) resolve();
    await firstCall;
    await manager.handleUrlParameters(
      new URLSearchParams("data=first"),
      app,
      "ctx-first",
    );

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
    const callA = manager.handleUrlParameters(
      new URLSearchParams("data=a"),
      app,
      "ctx-a",
    );
    const callB = manager.handleUrlParameters(
      new URLSearchParams("data=b"),
      app,
      "ctx-b",
    );
    const callARepeat = manager.handleUrlParameters(
      new URLSearchParams("data=a"),
      app,
      "ctx-a",
    );
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

    await manager.handleUrlParameters(
      new URLSearchParams("data=value"),
      app,
      "project-1",
    );
    manager.deactivate("url-loader", app);
    manager.activate("url-loader", app);
    await manager.handleUrlParameters(
      new URLSearchParams("data=value"),
      app,
      "project-1",
    );

    assert.deepEqual(calls, ["handled"]);
  });
});
