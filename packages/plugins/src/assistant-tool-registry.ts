import type { GeoLibreAssistantTool } from "./types";

/**
 * Imperative registry for plugin-contributed AI assistant tools.
 *
 * The desktop assistant builds its Strands agent from a built-in tool set; this
 * registry lets a plugin contribute additional typed tools (name, description,
 * JSON Schema input, execute callback). The assistant appends the registered
 * tools when it (re)builds its agent, and a tool that opts in via
 * `command` also appears in the command palette. Mirrors the open/subscribe
 * pattern used by the other registries in this package; hosts subscribe with
 * `useSyncExternalStore`.
 *
 * Trust model: a plugin tool is plugin-authored code running with the plugin's
 * own (already trusted) capabilities — the model only chooses its *inputs*,
 * exactly as for the built-in `run_algorithm`. It is therefore not gated behind
 * the `run_python`/`run_maplibre_js` code-execution confirmation, which exists
 * for *model-authored* code.
 */

/**
 * A registered assistant tool paired with the id of the plugin that registered
 * it (when the host scoped the registration to a plugin) and the name the
 * language model actually sees.
 */
export interface AssistantToolEntry {
  tool: GeoLibreAssistantTool;
  ownerPluginId?: string;
  /**
   * The name the agent and the command palette use. Plugin-owned tools are
   * prefixed `plugin_<ownerPluginId>_` (sanitized) so they can never collide
   * with the built-in tool names or with another plugin's tools.
   */
  qualifiedName: string;
}

/**
 * Reactive snapshot consumed by `useSyncExternalStore`. The `entries` array
 * identity is stable between mutations so React can skip re-renders; `version`
 * is bumped on every change (the assistant uses it to rebuild its agent).
 */
export interface AssistantToolsSnapshot {
  entries: AssistantToolEntry[];
  version: number;
}

/**
 * Providers commonly cap tool names at 64 characters; the qualified name must
 * fit, so long plugin ids leave less room for the tool's own name.
 */
const MAX_QUALIFIED_NAME_LENGTH = 64;

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

const registry = new Map<string, AssistantToolEntry>();
const listeners = new Set<() => void>();

let version = 0;
let snapshot: AssistantToolsSnapshot = { entries: [], version: 0 };

function emit(): void {
  version += 1;
  snapshot = { entries: [...registry.values()], version };
  for (const listener of listeners) {
    listener();
  }
}

/** Lowercase a plugin id and collapse everything else to underscores. */
function sanitizeOwnerId(ownerPluginId: string): string {
  return ownerPluginId.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
}

/** The model-facing name for a tool: owner-prefixed when a plugin owns it. */
export function qualifiedAssistantToolName(name: string, ownerPluginId?: string): string {
  return ownerPluginId ? `plugin_${sanitizeOwnerId(ownerPluginId)}_${name}` : name;
}

/**
 * Register an assistant tool. Returns an unregister function (call it from the
 * plugin's `deactivate` hook). Re-registering the same qualified name replaces
 * the tool, so a plugin can rebuild its tools as its state changes.
 *
 * `ownerPluginId` is injected by the host (the PluginManager scopes each
 * plugin's app API to its id); plugins call this with a single argument.
 *
 * @throws When the tool shape is invalid: the name must be lowercase
 * `snake_case` (`^[a-z][a-z0-9_]*$`), the description non-empty, `execute` a
 * function, `inputSchema` (when given) a plain object, and the qualified name
 * at most 64 characters.
 */
export function registerAssistantTool(
  tool: GeoLibreAssistantTool,
  ownerPluginId?: string,
): () => void {
  if (!tool || typeof tool.name !== "string" || !TOOL_NAME_PATTERN.test(tool.name)) {
    throw new Error(
      "registerAssistantTool requires a lowercase snake_case tool name (e.g. \"hello_orbit\").",
    );
  }
  if (typeof tool.description !== "string" || tool.description.trim().length === 0) {
    throw new Error(`Assistant tool "${tool.name}" must have a non-empty description.`);
  }
  if (typeof tool.execute !== "function") {
    throw new Error(`Assistant tool "${tool.name}" must have an execute function.`);
  }
  if (
    tool.inputSchema !== undefined &&
    (typeof tool.inputSchema !== "object" || tool.inputSchema === null || Array.isArray(tool.inputSchema))
  ) {
    throw new Error(`Assistant tool "${tool.name}" inputSchema must be a JSON Schema object.`);
  }
  const qualifiedName = qualifiedAssistantToolName(tool.name, ownerPluginId);
  if (qualifiedName.length > MAX_QUALIFIED_NAME_LENGTH) {
    throw new Error(
      `Assistant tool name "${qualifiedName}" exceeds ${MAX_QUALIFIED_NAME_LENGTH} characters; ` +
        "shorten the tool name (the plugin id is part of the model-facing name).",
    );
  }
  // Re-registering a qualified name replaces the tool. The returned disposer
  // only removes the tool while this exact registration is still current, so a
  // stale disposer cannot evict a newer tool that reused the name.
  const entry: AssistantToolEntry = { tool, ownerPluginId, qualifiedName };
  registry.set(qualifiedName, entry);
  emit();
  return () => {
    if (registry.get(qualifiedName) === entry) {
      registry.delete(qualifiedName);
      emit();
    }
  };
}

/**
 * Remove a previously registered assistant tool by its plugin-local name.
 * `ownerPluginId` is host-injected, matching {@link registerAssistantTool}.
 */
export function unregisterAssistantTool(name: string, ownerPluginId?: string): void {
  if (!registry.delete(qualifiedAssistantToolName(name, ownerPluginId))) return;
  emit();
}

/** All registered assistant tools, in registration order. */
export function listAssistantToolEntries(): AssistantToolEntry[] {
  return [...registry.values()];
}

/** Current reactive snapshot for `useSyncExternalStore`. */
export function getAssistantToolsSnapshot(): AssistantToolsSnapshot {
  return snapshot;
}

/** Subscribe to assistant-tool registry changes. Returns an unsubscribe. */
export function subscribeAssistantTools(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Test-only: reset the registry to its initial empty state. Not part of the
 * public plugin API.
 */
export function __resetAssistantToolRegistryForTests(): void {
  registry.clear();
  listeners.clear();
  version = 0;
  snapshot = { entries: [], version: 0 };
}
