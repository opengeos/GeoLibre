import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  __resetAssistantToolRegistryForTests,
  getAssistantToolsSnapshot,
  listAssistantToolEntries,
  qualifiedAssistantToolName,
  registerAssistantTool,
  subscribeAssistantTools,
  unregisterAssistantTool,
} from "../packages/plugins/src/assistant-tool-registry";
import type { GeoLibreAssistantTool } from "../packages/plugins/src/types";

function makeTool(overrides: Partial<GeoLibreAssistantTool> = {}): GeoLibreAssistantTool {
  return {
    name: "hello_orbit",
    description: "Says hello from orbit.",
    execute: () => ({ ok: true }),
    ...overrides,
  };
}

describe("assistant tool registry", () => {
  afterEach(() => {
    __resetAssistantToolRegistryForTests();
  });

  it("registers a tool and lists it under its own name when unowned", () => {
    registerAssistantTool(makeTool());
    const entries = listAssistantToolEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].qualifiedName, "hello_orbit");
    assert.equal(entries[0].ownerPluginId, undefined);
  });

  it("prefixes and sanitizes the owner plugin id in the qualified name", () => {
    registerAssistantTool(makeTool(), "My-Plugin.v2");
    const entries = listAssistantToolEntries();
    assert.equal(entries[0].qualifiedName, "plugin_my_plugin_v2_hello_orbit");
    assert.equal(entries[0].ownerPluginId, "My-Plugin.v2");
    assert.equal(
      qualifiedAssistantToolName("hello_orbit", "My-Plugin.v2"),
      "plugin_my_plugin_v2_hello_orbit",
    );
  });

  it("rejects names that are not lowercase snake_case", () => {
    for (const name of ["", "HelloOrbit", "2fast", "hello-orbit", "hello orbit"]) {
      assert.throws(() => registerAssistantTool(makeTool({ name })), /snake_case/);
    }
  });

  it("rejects a qualified name longer than 64 characters", () => {
    assert.throws(
      () => registerAssistantTool(makeTool({ name: "a".repeat(60) }), "long-plugin-id"),
      /64 characters/,
    );
  });

  it("rejects an empty description, a missing execute, and a non-object schema", () => {
    assert.throws(() => registerAssistantTool(makeTool({ description: "  " })), /description/);
    assert.throws(
      () => registerAssistantTool(makeTool({ execute: undefined as never })),
      /execute/,
    );
    assert.throws(
      () => registerAssistantTool(makeTool({ inputSchema: [] as never })),
      /JSON Schema object/,
    );
  });

  it("replaces a re-registered name and keeps stale disposers inert", () => {
    const first = makeTool({ description: "First." });
    const disposeFirst = registerAssistantTool(first, "demo");
    const second = makeTool({ description: "Second." });
    registerAssistantTool(second, "demo");

    assert.equal(listAssistantToolEntries().length, 1);
    assert.equal(listAssistantToolEntries()[0].tool.description, "Second.");

    // The first registration's disposer must not evict the replacement.
    disposeFirst();
    assert.equal(listAssistantToolEntries().length, 1);
    assert.equal(listAssistantToolEntries()[0].tool.description, "Second.");
  });

  it("unregisters by plugin-local name with the same owner scoping", () => {
    registerAssistantTool(makeTool(), "demo");
    unregisterAssistantTool("hello_orbit", "other");
    assert.equal(listAssistantToolEntries().length, 1);
    unregisterAssistantTool("hello_orbit", "demo");
    assert.equal(listAssistantToolEntries().length, 0);
  });

  it("bumps the snapshot version and notifies subscribers on every change", () => {
    let notified = 0;
    const unsubscribe = subscribeAssistantTools(() => {
      notified += 1;
    });
    const before = getAssistantToolsSnapshot().version;

    const dispose = registerAssistantTool(makeTool());
    assert.equal(notified, 1);
    assert.equal(getAssistantToolsSnapshot().version, before + 1);
    assert.equal(getAssistantToolsSnapshot().entries.length, 1);

    dispose();
    assert.equal(notified, 2);
    assert.equal(getAssistantToolsSnapshot().entries.length, 0);

    unsubscribe();
    registerAssistantTool(makeTool({ name: "quiet_tool" }));
    assert.equal(notified, 2);
  });

  it("keeps the snapshot identity stable between mutations", () => {
    registerAssistantTool(makeTool());
    const first = getAssistantToolsSnapshot();
    assert.equal(getAssistantToolsSnapshot(), first);
    registerAssistantTool(makeTool({ name: "second_tool" }));
    assert.notEqual(getAssistantToolsSnapshot(), first);
  });

  it("runs execute with the given input (the host's call path)", async () => {
    const seen: unknown[] = [];
    registerAssistantTool(
      makeTool({
        execute: (input) => {
          seen.push(input);
          return { echoed: input };
        },
      }),
      "demo",
    );
    const entry = listAssistantToolEntries()[0];
    const result = await Promise.resolve(entry.tool.execute({ target: "LEO" }));
    assert.deepEqual(seen, [{ target: "LEO" }]);
    assert.deepEqual(result, { echoed: { target: "LEO" } });
  });
});
