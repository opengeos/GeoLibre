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
        id: "inactive-loader",
        urlParameterNames: ["data"],
        handleUrlParameters: () => {
          calls.push("inactive");
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
