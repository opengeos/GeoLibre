import type { AssistantToolEntry } from "@geolibre/plugins/assistant-tool-registry";
import { tool, type JSONValue, type Tool } from "@strands-agents/sdk";
import { z } from "zod";

/**
 * Up to this many plugin tools are sent to the model in full, as they always
 * were. Past it, plugin tools are disclosed progressively: the system prompt
 * lists each one by name and a one-line summary, and its full parameter schema
 * is only sent once the model loads it with {@link LOAD_PLUGIN_TOOLS_NAME}.
 *
 * The cap is on plugin tools only. The host's own tools are the assistant's
 * core vocabulary and are always sent; it is the tool count that grows with
 * every installed plugin, and with it the ambiguity between near-identical
 * tools from different domains, that this bounds.
 */
export const EAGER_PLUGIN_TOOL_LIMIT = 12;

/** The host tool that loads deferred plugin tools into the running agent. */
export const LOAD_PLUGIN_TOOLS_NAME = "load_plugin_tools";

/** Longest one-line summary the catalog shows for a deferred tool. */
const SUMMARY_MAX_LENGTH = 160;

/**
 * A sentence end: a terminator followed by the end of the line or by a capital
 * letter, but not the period of an initial (`U.S.`) or a common abbreviation
 * (`e.g.`, `approx.`), which would otherwise cut a summary mid-thought.
 */
const SENTENCE_END = /(?<!\b(?:[A-Za-z]|e\.g|i\.e|etc|vs|approx|St|No))[.!?](?=\s+[A-Z]|\s*$)/;

/** Most names one {@link LOAD_PLUGIN_TOOLS_NAME} call may load. */
const MAX_LOAD_NAMES = 20;

/** How the registered plugin tools are split for one agent build. */
export interface PluginToolScope {
  /** Plugin tools whose full specs are sent to the model. */
  active: Tool[];
  /**
   * Every plugin tool, for the catalog, when progressive disclosure is on;
   * empty when all plugin tools fit under the limit and are sent in full.
   */
  catalog: AssistantToolEntry[];
}

/**
 * Decide which plugin tools the model sees in full.
 *
 * The decision depends only on how many plugin tools are registered, not on
 * the conversation, so the system prompt stays byte-identical from turn to turn
 * (which keeps provider prompt caching effective) until a plugin is activated
 * or removed.
 *
 * @param entries Registered plugin tools, from `listAssistantToolEntries()`.
 * @param loaded Names the model has already loaded in this conversation.
 * @param limit The largest plugin tool count that is sent without deferral.
 * @returns The active plugin tools and, when deferring, the full catalog.
 */
export function scopePluginTools(
  entries: readonly AssistantToolEntry[],
  loaded: ReadonlySet<string>,
  limit: number = EAGER_PLUGIN_TOOL_LIMIT,
): PluginToolScope {
  if (entries.length <= limit) {
    return { active: entries.map((entry) => entry.tool), catalog: [] };
  }
  return {
    active: entries.filter((entry) => loaded.has(entry.tool.name)).map((entry) => entry.tool),
    catalog: [...entries],
  };
}

/**
 * Reduce a tool description to the one line the catalog shows: its first line,
 * cut at the first sentence end, and capped so one verbose plugin cannot crowd
 * out the others.
 *
 * @param description The tool's full description.
 * @returns A single-line summary of at most {@link SUMMARY_MAX_LENGTH} characters.
 */
export function summarizeToolDescription(description: string | undefined): string {
  const firstLine = (description ?? "").trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  const sentenceEnd = firstLine.search(SENTENCE_END);
  const sentence = sentenceEnd >= 0 ? firstLine.slice(0, sentenceEnd + 1) : firstLine;
  if (sentence.length <= SUMMARY_MAX_LENGTH) return sentence;
  return `${sentence.slice(0, SUMMARY_MAX_LENGTH - 1).trimEnd()}…`;
}

/**
 * Render the deferred-tool catalog for the system prompt, grouped by plugin in
 * registration order.
 *
 * @param catalog Every plugin tool, from {@link scopePluginTools}.
 * @returns The prompt section, or an empty string when nothing is deferred.
 */
export function formatPluginToolCatalog(catalog: readonly AssistantToolEntry[]): string {
  if (catalog.length === 0) return "";
  const groups = new Map<string, string[]>();
  for (const { tool: entry, ownerPluginId } of catalog) {
    const owner = ownerPluginId ?? "";
    const lines = groups.get(owner) ?? [];
    const summary = summarizeToolDescription(entry.description);
    lines.push(summary ? `- ${entry.name}: ${summary}` : `- ${entry.name}`);
    groups.set(owner, lines);
  }
  const blocks = [...groups].map(([owner, lines]) =>
    owner ? `[plugin ${owner}]\n${lines.join("\n")}` : lines.join("\n"),
  );
  return `Plugin tools:
Active plugins provide more tools than are sent up front, so these are listed by name and summary only. Before calling one, call ${LOAD_PLUGIN_TOOLS_NAME} with the names you need (or a plugin id to load all of that plugin's tools); they become callable right away and stay loaded for the rest of the conversation. Load only the tools that fit the request, and prefer the host tools above when they already do the job.

${blocks.join("\n\n")}`;
}

/** What a {@link LOAD_PLUGIN_TOOLS_NAME} call resolved its names to. */
export interface PluginToolLoadResult {
  /** Tool names newly made callable by this call. */
  loaded: string[];
  /** Tool names that were already callable. */
  alreadyLoaded: string[];
  /** Requested names that match neither a plugin tool nor a plugin id. */
  unknown: string[];
}

/**
 * Resolve requested names against the catalog. A name matches a tool exactly,
 * or else a plugin id, which expands to every tool that plugin registered.
 *
 * @param catalog Every plugin tool currently registered.
 * @param names Tool names or plugin ids the model asked for.
 * @param loaded Names already loaded in this conversation.
 * @returns The tools to load, and the outcome to report back to the model.
 */
export function resolvePluginToolNames(
  catalog: readonly AssistantToolEntry[],
  names: readonly string[],
  loaded: ReadonlySet<string>,
): { tools: Tool[]; result: PluginToolLoadResult } {
  const tools: Tool[] = [];
  const result: PluginToolLoadResult = { loaded: [], alreadyLoaded: [], unknown: [] };
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    // An exact tool name wins over a plugin id that happens to spell the same.
    const exact = catalog.filter((entry) => entry.tool.name === name);
    const matches =
      exact.length > 0 ? exact : catalog.filter((entry) => !!name && entry.ownerPluginId === name);
    if (matches.length === 0) {
      result.unknown.push(raw);
      continue;
    }
    for (const { tool: match } of matches) {
      if (seen.has(match.name)) continue;
      seen.add(match.name);
      if (loaded.has(match.name)) {
        result.alreadyLoaded.push(match.name);
      } else {
        result.loaded.push(match.name);
        tools.push(match);
      }
    }
  }
  return { tools, result };
}

/**
 * Which plugin tools one conversation has loaded, kept across agent refreshes.
 *
 * Names are kept rather than tool instances, so a tool its plugin re-registers
 * (a version bump) resolves to the new instance on the next {@link scope}.
 */
export class ConversationPluginTools {
  private readonly loaded = new Set<string>();

  /** @param limit The largest plugin tool count that is sent without deferral. */
  constructor(private readonly limit: number = EAGER_PLUGIN_TOOL_LIMIT) {}

  /**
   * Scope the registered plugin tools for the next agent build or refresh.
   *
   * @param entries Registered plugin tools, from `listAssistantToolEntries()`.
   * @returns The active plugin tools and, when deferring, the full catalog.
   */
  scope(entries: readonly AssistantToolEntry[]): PluginToolScope {
    // Forget loads whose tool has since been unregistered, so a plugin that is
    // deactivated and later reactivated starts deferred again.
    const live = new Set(entries.map((entry) => entry.tool.name));
    for (const name of this.loaded) {
      if (!live.has(name)) this.loaded.delete(name);
    }
    const scope = scopePluginTools(entries, this.loaded, this.limit);
    // A tool sent in full already counts as loaded: if more plugins later push
    // the total past the eager limit, the tools this conversation could already
    // call stay callable instead of silently dropping behind load_plugin_tools.
    if (scope.catalog.length === 0) {
      for (const active of scope.active) this.loaded.add(active.name);
    }
    return scope;
  }

  /**
   * Mark the requested tools loaded.
   *
   * @param entries Registered plugin tools, from `listAssistantToolEntries()`.
   * @param names Tool names or plugin ids the model asked for.
   * @returns The newly loaded tools, to add to the live agent, and the outcome.
   */
  load(
    entries: readonly AssistantToolEntry[],
    names: readonly string[],
  ): { tools: Tool[]; result: PluginToolLoadResult } {
    const resolved = resolvePluginToolNames(entries, names, this.loaded);
    for (const tool of resolved.tools) this.loaded.add(tool.name);
    return resolved;
  }

  /** Forget every load, for a new conversation. */
  clear(): void {
    this.loaded.clear();
  }

  /** The loaded tool names, in load order. */
  names(): string[] {
    return [...this.loaded];
  }
}

/**
 * Build the {@link LOAD_PLUGIN_TOOLS_NAME} tool. Loading goes through `load`,
 * which the session implements by adding the tools to the live agent's
 * registry; the SDK re-reads that registry before every model call, so the
 * tools are callable on the model's very next step within the same turn.
 *
 * @param load Loads the named tools and reports what happened.
 * @returns The Strands tool to register on the agent.
 */
export function createLoadPluginToolsTool(load: (names: string[]) => PluginToolLoadResult): Tool {
  return tool({
    name: LOAD_PLUGIN_TOOLS_NAME,
    description:
      "Load plugin tools listed under 'Plugin tools' in the system prompt so they can be called. Pass their exact names, or a plugin id to load all of its tools.",
    inputSchema: z.object({
      names: z
        .array(z.string().min(1))
        .min(1)
        .max(MAX_LOAD_NAMES)
        .describe("Plugin tool names (plugin_...) or plugin ids from the catalog."),
    }),
    callback: (input): JSONValue => {
      const result = load(input.names);
      if (result.loaded.length === 0 && result.alreadyLoaded.length === 0) {
        throw new Error(
          `No plugin tool or plugin id matches ${result.unknown.join(", ")}. Use the exact names listed under 'Plugin tools'.`,
        );
      }
      return result as unknown as JSONValue;
    },
  });
}
