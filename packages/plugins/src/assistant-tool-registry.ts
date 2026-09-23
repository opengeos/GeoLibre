import { Tool, tool, type JSONValue, type ToolContext } from "@strands-agents/sdk";
import type { AssistantToolSpec } from "./types";

interface Entry {
  tool: Tool;
  ownerPluginId?: string;
}
const registry = new Map<string, Entry>();
/** One registered guidance block: its text and the plugin that owns it. */
export interface AssistantGuidanceEntry {
  text: string;
  ownerPluginId?: string;
}
/** Keyed by owner + text so re-registering identical guidance replaces in place. */
const guidanceRegistry = new Map<string, AssistantGuidanceEntry>();
/** Shared by tools and guidance: the agent refreshes both when it changes. */
let version = 0;
const ownerScopes = new Map<string, { active: boolean }>();
const OWNER_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Upper bound on one guidance registration, so a plugin cannot crowd out the host prompt. */
export const MAX_ASSISTANT_GUIDANCE_LENGTH = 4000;

/** Internal lifecycle token: invalidated scopes remain stale after an owner is reused. */
export function getAssistantToolOwnerScope(owner: string): { readonly active: boolean } {
  let scope = ownerScopes.get(owner);
  if (!scope) {
    scope = { active: true };
    ownerScopes.set(owner, scope);
  }
  return scope;
}

/** Register an SDK tool in the same registry used by JSON Schema specs.
 * Names are scoped by owner, with a length prefix to avoid ambiguous joins.
 * Re-registration replaces the same name. Stale disposers are harmless.
 */
export function registerAssistantTool(original: Tool, ownerPluginId?: string): () => void {
  const owner = ownerPluginId ?? "";
  if (!OWNER_PATTERN.test(original.name) || (owner && !OWNER_PATTERN.test(owner))) {
    throw new Error(
      "Assistant tool names and plugin IDs must use letters, digits, underscores or hyphens.",
    );
  }
  const name = `plugin_${owner.length}_${owner}_${original.name}`;
  if (name.length > 64 || !original.description?.trim()) {
    throw new Error(
      "Assistant tools require a description and a scoped name of at most 64 characters.",
    );
  }
  const normalize = (value: string) => value.toLowerCase().replaceAll("_", "-");
  for (const existing of registry.keys()) {
    if (existing !== name && normalize(existing) === normalize(name)) {
      throw new Error(`Assistant tool name conflicts with ${existing}.`);
    }
  }
  // Delegate the complete SDK streaming protocol, including zod validation.
  // An old agent cannot execute a removed or replaced registration.
  class ScopedTool extends Tool {
    name = name;
    description = original.description;
    toolSpec = { ...original.toolSpec, name };
    async *stream(context: ToolContext) {
      if (registry.get(name) !== entry)
        throw new Error(`Assistant tool ${name} is no longer registered.`);
      return yield* original.stream({
        ...context,
        toolUse: { ...context.toolUse, name: original.name },
      });
    }
  }
  const entry: Entry = { tool: new ScopedTool(), ownerPluginId };
  registry.set(name, entry);
  version++;
  return () => {
    if (registry.get(name) !== entry) return;
    registry.delete(name);
    version++;
  };
}

/** Adapt a dependency-free spec using the SDK's JSON Schema overload.
 * Input is deliberately not parsed: the callback is responsible for validation.
 */
export function registerAssistantToolSpec(
  spec: AssistantToolSpec,
  ownerPluginId?: string,
): () => void {
  return registerAssistantTool(
    tool({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      callback: async (input): Promise<JSONValue> => {
        const result = await spec.callback(input);
        // The SDK wraps and copies callback results. Avoid serializing twice;
        // plugins are responsible for the documented JSON return contract.
        return (result === undefined ? null : result) as JSONValue;
      },
    }),
    ownerPluginId,
  );
}

export function listAssistantTools(): Tool[] {
  return [...registry.values()].map((entry) => entry.tool);
}

/** One registered tool with the plugin that owns it, for grouping by plugin. */
export interface AssistantToolEntry {
  tool: Tool;
  ownerPluginId?: string;
}

/** Registered tools in registration order, each with its owning plugin. */
export function listAssistantToolEntries(): AssistantToolEntry[] {
  return [...registry.values()].map(({ tool, ownerPluginId }) => ({
    tool,
    ...(ownerPluginId ? { ownerPluginId } : {}),
  }));
}

/** Append guidance to the assistant's system prompt for as long as it stays registered.
 * Tool descriptions are read only after the model has chosen a tool, so rules about
 * *when* to call a plugin's tools belong here, next to the host's own guidelines.
 * Identical text from the same owner replaces the earlier registration in place.
 * Re-registration bumps the shared version so the agent refreshes before its next prompt.
 */
export function registerAssistantGuidance(text: string, ownerPluginId?: string): () => void {
  const owner = ownerPluginId ?? "";
  if (owner && !OWNER_PATTERN.test(owner)) {
    throw new Error("Assistant plugin IDs must use letters, digits, underscores or hyphens.");
  }
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) throw new Error("Assistant guidance must be a non-empty string.");
  if (trimmed.length > MAX_ASSISTANT_GUIDANCE_LENGTH) {
    throw new Error(
      `Assistant guidance must be at most ${MAX_ASSISTANT_GUIDANCE_LENGTH} characters.`,
    );
  }
  const key = `${owner.length}_${owner}_${trimmed}`;
  const entry: AssistantGuidanceEntry = { text: trimmed, ownerPluginId };
  guidanceRegistry.set(key, entry);
  version++;
  return () => {
    if (guidanceRegistry.get(key) !== entry) return;
    guidanceRegistry.delete(key);
    version++;
  };
}

/** Registered guidance in registration order, with its owner for attribution. */
export function listAssistantGuidance(): AssistantGuidanceEntry[] {
  return [...guidanceRegistry.values()].map(({ text, ownerPluginId }) => ({
    text,
    ...(ownerPluginId ? { ownerPluginId } : {}),
  }));
}

export function getAssistantToolsVersion(): number {
  return version;
}

/** Host lifecycle cleanup, including failed activation and plugin removal.
 * Removes the owner's tools and guidance together: both live for one activation.
 */
export function unregisterAssistantToolsByOwner(ownerPluginId: string): void {
  const scope = ownerScopes.get(ownerPluginId);
  if (scope) scope.active = false;
  ownerScopes.delete(ownerPluginId);
  for (const [name, entry] of registry) {
    if (entry.ownerPluginId === ownerPluginId) {
      registry.delete(name);
      version++;
    }
  }
  for (const [key, entry] of guidanceRegistry) {
    if (entry.ownerPluginId === ownerPluginId) {
      guidanceRegistry.delete(key);
      version++;
    }
  }
}
