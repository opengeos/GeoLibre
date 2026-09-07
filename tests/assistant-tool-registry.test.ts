import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { tool, type Tool, type ToolContext } from "@strands-agents/sdk";
import { z } from "zod";
import {
  registerAssistantTool,
  registerAssistantToolSpec,
  listAssistantTools,
  unregisterAssistantToolsByOwner,
  getAssistantToolsVersion,
} from "../packages/plugins/src/assistant-tool-registry";
import { PluginManager } from "../packages/plugins/src/plugin-manager";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../packages/plugins/src/types";

const owners = ["test", "other", "a_b", "a"];
afterEach(() => owners.forEach(unregisterAssistantToolsByOwner));
const spec = (callback = (input: unknown): unknown => input) => ({
  name: "echo",
  description: "Echo input",
  callback,
  inputSchema: { type: "object" as const, properties: { value: { type: "string" as const } } },
});
async function run(registered: Tool, input: unknown) {
  const stream = registered.stream({
    toolUse: { name: registered.name, toolUseId: "test-use", input },
  } as ToolContext);
  let result = await stream.next();
  while (!result.done) result = await stream.next();
  return result.value;
}

test("JSON Schema and SDK tools share a registry and preserve SDK validation", async () => {
  registerAssistantToolSpec(spec(), "test");
  registerAssistantTool(
    tool({
      name: "typed",
      description: "Typed input",
      inputSchema: z.object({ value: z.string() }),
      callback: (input) => input,
    }),
    "test",
  );
  const [plain, typed] = listAssistantTools();
  assert.equal(plain.toolSpec.name, plain.name);
  assert.equal((await run(plain, { value: 4 })).status, "success");
  assert.equal((await run(typed, { value: 4 })).status, "error");
  assert.equal((await run(typed, { value: "ok" })).status, "success");
});

test("callback failures become SDK error results and async/void results work", async () => {
  registerAssistantToolSpec(
    spec(() => {
      throw new Error("invalid input");
    }),
    "test",
  );
  assert.equal((await run(listAssistantTools()[0], {})).status, "error");
  registerAssistantToolSpec(
    spec(async () => ({ count: 3 })),
    "test",
  );
  const result = await run(listAssistantTools()[0], {});
  assert.equal(result.status, "success");
  assert.match(JSON.stringify(result), /count/);
  registerAssistantToolSpec(
    { name: "echo", description: "No input", callback: () => undefined },
    "test",
  );
  assert.equal((await run(listAssistantTools()[0], {})).status, "success");
});

test("replacement, stale disposers, ownership and stale execution", async () => {
  const before = getAssistantToolsVersion();
  const dispose = registerAssistantToolSpec(spec(), "test");
  const old = listAssistantTools()[0];
  registerAssistantToolSpec(spec(), "test");
  registerAssistantToolSpec(spec(), "other");
  dispose();
  assert.equal(listAssistantTools().length, 2);
  await assert.rejects(() => run(old, {}), /no longer registered/);
  unregisterAssistantToolsByOwner("test");
  assert.equal(listAssistantTools().length, 1);
  assert.ok(getAssistantToolsVersion() > before);
});

test("scoped names cannot collide across ambiguous owner/name joins", () => {
  registerAssistantToolSpec({ ...spec(), name: "c" }, "a_b");
  registerAssistantToolSpec({ ...spec(), name: "b_c" }, "a");
  assert.equal(new Set(listAssistantTools().map((t) => t.name)).size, 2);
  assert.throws(() => registerAssistantToolSpec({ ...spec(), name: "bad name" }, "test"));
  assert.throws(() => registerAssistantToolSpec({ ...spec(), name: "x".repeat(64) }, "test"));
  registerAssistantToolSpec(spec(), "test");
  assert.throws(() => registerAssistantToolSpec({ ...spec(), name: "ECHO" }, "test"), /conflicts/);
});

const app = { registerAssistantTool, registerAssistantToolSpec } as GeoLibreAppAPI;
function plugin(activate: GeoLibrePlugin["activate"], deactivate = () => {}): GeoLibrePlugin {
  return { id: "test", name: "Test", version: "1.0.0", activate, deactivate };
}

test("manager injects owner and cleans up even when deactivation throws", () => {
  const manager = new PluginManager();
  manager.register(
    plugin(
      (api) => {
        api.registerAssistantToolSpec!(spec(), "other");
      },
      () => {
        throw new Error("teardown");
      },
    ),
  );
  manager.activate("test", app);
  assert.match(listAssistantTools()[0].name, /^plugin_4_test_/);
  assert.throws(() => manager.deactivate("test", app), /teardown/);
  assert.equal(listAssistantTools().length, 0);
});

test("sync and async activation failures remove tools", async () => {
  for (const outcome of ["false", "throw", "async-false", "async-throw"]) {
    const manager = new PluginManager();
    manager.register(
      plugin((api) => {
        api.registerAssistantToolSpec!(spec());
        if (outcome === "throw") throw new Error("failed");
        if (outcome === "async-throw") return Promise.reject(new Error("failed"));
        return outcome === "async-false" ? Promise.resolve(false) : false;
      }),
    );
    if (outcome === "throw") assert.throws(() => manager.activate("test", app));
    else assert.equal(await manager.activate("test", app), false);
    assert.equal(listAssistantTools().length, 0, outcome);
  }
});

test("late async registration cannot survive deactivation or replace a new activation", async () => {
  const manager = new PluginManager();
  let stale: GeoLibreAppAPI;
  manager.register(
    plugin((api) => {
      stale = api;
      api.registerAssistantToolSpec!(spec());
    }),
  );
  manager.activate("test", app);
  const first = stale!;
  manager.deactivate("test", app);
  first.registerAssistantToolSpec!(spec());
  assert.equal(listAssistantTools().length, 0);
  manager.activate("test", app);
  first.registerAssistantToolSpec!({ ...spec(), name: "late" });
  assert.equal(listAssistantTools().length, 1);
  manager.unregister("test", app);
  assert.equal(listAssistantTools().length, 0);
});
