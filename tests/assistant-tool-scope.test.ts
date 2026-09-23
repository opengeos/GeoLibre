import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { tool, type Tool, type ToolContext } from "@strands-agents/sdk";
import { z } from "zod";
import {
  listAssistantToolEntries,
  registerAssistantToolSpec,
  unregisterAssistantToolsByOwner,
  type AssistantToolEntry,
} from "../packages/plugins/src/assistant-tool-registry";
import {
  EAGER_PLUGIN_TOOL_LIMIT,
  LOAD_PLUGIN_TOOLS_NAME,
  createLoadPluginToolsTool,
  formatPluginToolCatalog,
  resolvePluginToolNames,
  scopePluginTools,
  summarizeToolDescription,
} from "../apps/geolibre-desktop/src/lib/assistant/tool-scope";
import {
  SYSTEM_PROMPT,
  buildSystemPrompt,
} from "../apps/geolibre-desktop/src/lib/assistant/system-prompt";

afterEach(() => ["alpha", "beta"].forEach(unregisterAssistantToolsByOwner));

function entry(name: string, ownerPluginId?: string, description = `Does ${name}.`) {
  return {
    tool: tool({ name, description, inputSchema: z.object({}), callback: () => null }),
    ...(ownerPluginId ? { ownerPluginId } : {}),
  } satisfies AssistantToolEntry;
}

function entries(count: number, owner = "alpha"): AssistantToolEntry[] {
  return Array.from({ length: count }, (_, i) => entry(`tool_${i}`, owner));
}

async function run(registered: Tool, input: unknown) {
  const stream = registered.stream({
    toolUse: { name: registered.name, toolUseId: "test-use", input },
  } as ToolContext);
  let result = await stream.next();
  while (!result.done) result = await stream.next();
  return result.value;
}

test("plugin tools under the limit are all sent in full, with no catalog", () => {
  const all = entries(EAGER_PLUGIN_TOOL_LIMIT);
  const scope = scopePluginTools(all, new Set());
  assert.deepEqual(
    scope.active.map((t) => t.name),
    all.map((e) => e.tool.name),
  );
  assert.deepEqual(scope.catalog, []);
  assert.equal(formatPluginToolCatalog(scope.catalog), "");
});

test("past the limit only loaded plugin tools are sent, and all are catalogued", () => {
  const all = entries(EAGER_PLUGIN_TOOL_LIMIT + 1);
  const none = scopePluginTools(all, new Set());
  assert.deepEqual(none.active, []);
  assert.equal(none.catalog.length, all.length);

  const some = scopePluginTools(all, new Set(["tool_3", "tool_7"]));
  assert.deepEqual(
    some.active.map((t) => t.name),
    ["tool_3", "tool_7"],
  );
  // The catalog does not shrink as tools are loaded, so the prompt stays stable.
  assert.equal(some.catalog.length, all.length);
});

test("summaries keep the first sentence of the first line and cap the length", () => {
  assert.equal(
    summarizeToolDescription("Query PM2.5 rows. Returns JSON.\nMore."),
    "Query PM2.5 rows.",
  );
  assert.equal(summarizeToolDescription("  List fires\nsecond line"), "List fires");
  // Initials and abbreviations do not end the sentence.
  assert.equal(
    summarizeToolDescription("Query wildfire risk for a U.S. county. Returns rows."),
    "Query wildfire risk for a U.S. county.",
  );
  assert.equal(
    summarizeToolDescription("Rank sensors, e.g. by PM2.5, approx. hourly. More."),
    "Rank sensors, e.g. by PM2.5, approx. hourly.",
  );
  assert.equal(summarizeToolDescription(undefined), "");
  const long = summarizeToolDescription("x".repeat(500));
  assert.equal(long.length, 160);
  assert.ok(long.endsWith("…"));
});

test("the catalog groups tools by plugin and explains how to load them", () => {
  const text = formatPluginToolCatalog([
    entry("plugin_5_alpha_a", "alpha"),
    entry("plugin_4_beta_b", "beta", "Beta tool.\nDetails."),
    entry("plugin_5_alpha_c", "alpha"),
  ]);
  assert.match(text, new RegExp(`call ${LOAD_PLUGIN_TOOLS_NAME}`));
  assert.ok(
    text.includes(
      "[plugin alpha]\n- plugin_5_alpha_a: Does plugin_5_alpha_a.\n- plugin_5_alpha_c: Does plugin_5_alpha_c.",
    ),
  );
  assert.ok(text.includes("[plugin beta]\n- plugin_4_beta_b: Beta tool."));
  assert.doesNotMatch(text, /Details/);
});

test("the catalog is appended after the host prompt and plugin guidance", () => {
  const catalog = formatPluginToolCatalog([entry("plugin_5_alpha_a", "alpha")]);
  const prompt = buildSystemPrompt([{ text: "Use a.", ownerPluginId: "alpha" }], catalog);
  assert.ok(prompt.startsWith(SYSTEM_PROMPT));
  assert.ok(prompt.indexOf("Plugin guidance:") < prompt.indexOf("Plugin tools:"));
  assert.ok(prompt.endsWith(catalog));
  assert.equal(buildSystemPrompt([], ""), SYSTEM_PROMPT);
});

test("names resolve to exact tools or expand a plugin id, reporting the rest", () => {
  const catalog = [
    entry("plugin_5_alpha_a", "alpha"),
    entry("plugin_5_alpha_b", "alpha"),
    entry("plugin_4_beta_c", "beta"),
  ];
  const { tools, result } = resolvePluginToolNames(
    catalog,
    ["alpha", "plugin_5_alpha_a", "plugin_4_beta_c", "nope", ""],
    new Set(["plugin_4_beta_c"]),
  );
  assert.deepEqual(
    tools.map((t) => t.name),
    ["plugin_5_alpha_a", "plugin_5_alpha_b"],
  );
  assert.deepEqual(result, {
    loaded: ["plugin_5_alpha_a", "plugin_5_alpha_b"],
    alreadyLoaded: ["plugin_4_beta_c"],
    unknown: ["nope", ""],
  });
});

test("load_plugin_tools reports loads and errors when nothing matches", async () => {
  const calls: string[][] = [];
  const loader = createLoadPluginToolsTool((names) => {
    calls.push(names);
    return names[0] === "known"
      ? { loaded: ["plugin_5_alpha_a"], alreadyLoaded: [], unknown: [] }
      : { loaded: [], alreadyLoaded: [], unknown: names };
  });
  assert.equal(loader.name, LOAD_PLUGIN_TOOLS_NAME);

  const ok = await run(loader, { names: ["known"] });
  assert.equal(ok.status, "success");
  assert.match(JSON.stringify(ok.content), /plugin_5_alpha_a/);

  const miss = await run(loader, { names: ["missing"] });
  assert.equal(miss.status, "error");
  assert.match(JSON.stringify(miss.content), /No plugin tool or plugin id matches missing/);

  // Schema validation rejects an empty request before the loader runs.
  assert.equal((await run(loader, { names: [] })).status, "error");
  assert.deepEqual(calls, [["known"], ["missing"]]);
});

test("registry entries carry the owning plugin for grouping", () => {
  const spec = { name: "echo", description: "Echo.", callback: () => null };
  registerAssistantToolSpec(spec, "alpha");
  registerAssistantToolSpec(spec, "beta");
  assert.deepEqual(
    listAssistantToolEntries().map((e) => [e.tool.name, e.ownerPluginId]),
    [
      ["plugin_5_alpha_echo", "alpha"],
      ["plugin_4_beta_echo", "beta"],
    ],
  );
});
