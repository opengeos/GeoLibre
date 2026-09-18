import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { tool, type Tool, type ToolContext } from "@strands-agents/sdk";
import { z } from "zod";
import {
  registerAssistantTool,
  registerAssistantToolSpec,
  registerAssistantGuidance,
  listAssistantTools,
  listAssistantGuidance,
  unregisterAssistantToolsByOwner,
  getAssistantToolsVersion,
  MAX_ASSISTANT_GUIDANCE_LENGTH,
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

const app = {
  registerAssistantTool,
  registerAssistantToolSpec,
  registerAssistantGuidance,
} as GeoLibreAppAPI;
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

test("registration is activation-only: an inactive plugin cannot add a tool", () => {
  const manager = new PluginManager();
  const seen: Array<GeoLibreAppAPI["registerAssistantToolSpec"]> = [];
  manager.register({
    id: "test",
    name: "Test",
    version: "1.0.0",
    activate: () => {},
    deactivate: () => {},
    // Runs for inactive plugins too, on both the direct call and a project
    // restore, so the app it receives must not carry the registration methods.
    applyProjectState: (api) => {
      seen.push(api.registerAssistantToolSpec);
      api.registerAssistantToolSpec?.(spec());
    },
  });
  manager.applyPluginState("test", app, { any: "state" });
  manager.restoreProjectState(
    { activePluginIds: [], mapControlPositions: {}, settings: { test: { any: "state" } } },
    app,
  );
  assert.deepEqual(seen, [undefined, undefined]);
  assert.equal(listAssistantTools().length, 0);
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

test("guidance is versioned, trimmed, replaced in place and disposable", () => {
  const before = getAssistantToolsVersion();
  const dispose = registerAssistantGuidance("  Call get_ranking directly.  ", "test");
  assert.ok(getAssistantToolsVersion() > before);
  assert.deepEqual(listAssistantGuidance(), [
    { text: "Call get_ranking directly.", ownerPluginId: "test" },
  ]);
  // Identical text from the same owner replaces rather than duplicates, and the
  // older disposer can no longer remove the replacement.
  const replacement = registerAssistantGuidance("Call get_ranking directly.", "test");
  registerAssistantGuidance("Call get_ranking directly.", "other");
  registerAssistantGuidance("Never wrap plugin tools in SQL.", "test");
  dispose();
  assert.equal(listAssistantGuidance().length, 3);
  replacement();
  assert.deepEqual(
    listAssistantGuidance().map((entry) => entry.text),
    ["Call get_ranking directly.", "Never wrap plugin tools in SQL."],
  );
  const versionBefore = getAssistantToolsVersion();
  replacement();
  assert.equal(getAssistantToolsVersion(), versionBefore);
  unregisterAssistantToolsByOwner("test");
  assert.deepEqual(listAssistantGuidance(), [
    { text: "Call get_ranking directly.", ownerPluginId: "other" },
  ]);
  unregisterAssistantToolsByOwner("other");
  assert.deepEqual(listAssistantGuidance(), []);
});

test("guidance rejects empty, oversized and badly owned text", () => {
  assert.throws(() => registerAssistantGuidance("   ", "test"), /non-empty/);
  assert.throws(() => registerAssistantGuidance(undefined as unknown as string, "test"));
  assert.throws(
    () => registerAssistantGuidance("x".repeat(MAX_ASSISTANT_GUIDANCE_LENGTH + 1), "test"),
    /at most/,
  );
  assert.throws(() => registerAssistantGuidance("ok", "bad owner"), /plugin IDs/);
  registerAssistantGuidance("x".repeat(MAX_ASSISTANT_GUIDANCE_LENGTH), "test");
  assert.equal(listAssistantGuidance().length, 1);
});

test("manager scopes guidance to the activating plugin and removes it on teardown", () => {
  const manager = new PluginManager();
  const seen: Array<GeoLibreAppAPI["registerAssistantGuidance"]> = [];
  let stale: GeoLibreAppAPI;
  manager.register({
    id: "test",
    name: "Test",
    version: "1.0.0",
    activate: (api) => {
      stale = api;
      api.registerAssistantGuidance!("Prefer plugin_4_test_echo for rankings.", "other");
    },
    deactivate: () => {},
    applyProjectState: (api) => {
      seen.push(api.registerAssistantGuidance);
      api.registerAssistantGuidance?.("leaked");
    },
  });
  manager.activate("test", app);
  assert.deepEqual(listAssistantGuidance(), [
    { text: "Prefer plugin_4_test_echo for rankings.", ownerPluginId: "test" },
  ]);
  manager.applyPluginState("test", app, { any: "state" });
  assert.deepEqual(seen, [undefined]);
  manager.deactivate("test", app);
  assert.deepEqual(listAssistantGuidance(), []);
  // Owner "other" was ignored: the host injected "test", so its cleanup applied.
  stale!.registerAssistantGuidance!("late");
  assert.deepEqual(listAssistantGuidance(), []);
});

test("failed activation removes guidance along with tools", async () => {
  for (const outcome of ["false", "throw", "async-false", "async-throw"]) {
    const manager = new PluginManager();
    manager.register(
      plugin((api) => {
        api.registerAssistantGuidance!("guidance");
        api.registerAssistantToolSpec!(spec());
        if (outcome === "throw") throw new Error("failed");
        if (outcome === "async-throw") return Promise.reject(new Error("failed"));
        return outcome === "async-false" ? Promise.resolve(false) : false;
      }),
    );
    if (outcome === "throw") assert.throws(() => manager.activate("test", app));
    else assert.equal(await manager.activate("test", app), false);
    assert.deepEqual(listAssistantGuidance(), [], outcome);
    assert.equal(listAssistantTools().length, 0, outcome);
  }
});
