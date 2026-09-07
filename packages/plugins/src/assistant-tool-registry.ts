import { Tool, tool, type JSONValue, type ToolContext } from "@strands-agents/sdk";
import type { AssistantToolSpec } from "./types";

interface Entry {
  tool: Tool;
  ownerPluginId?: string;
}
const registry = new Map<string, Entry>();
let version = 0;
const ownerGenerations = new Map<string, number>();

/** Internal lifecycle token: stale async plugin callbacks cannot resurrect tools. */
export function getAssistantToolOwnerGeneration(owner: string): number {
  return ownerGenerations.get(owner) ?? 0;
}

/** Register an SDK tool in the same registry used by JSON Schema specs.
 * Names are scoped by owner, with a length prefix to avoid ambiguous joins.
 * Re-registration replaces the same name. Stale disposers are harmless.
 */
export function registerAssistantTool(original: Tool, ownerPluginId?: string): () => void {
  const owner = ownerPluginId ?? "";
  if (!/^[a-zA-Z0-9_-]+$/.test(original.name) || (owner && !/^[a-zA-Z0-9_-]+$/.test(owner))) {
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
        // Normalize to the SDK's JSON return contract, including void callbacks.
        return result === undefined ? null : JSON.parse(JSON.stringify(result));
      },
    }),
    ownerPluginId,
  );
}

export function listAssistantTools(): Tool[] {
  return [...registry.values()].map((entry) => entry.tool);
}

export function getAssistantToolsVersion(): number {
  return version;
}

/** Host lifecycle cleanup, including failed activation and plugin removal. */
export function unregisterAssistantToolsByOwner(ownerPluginId: string): void {
  ownerGenerations.set(ownerPluginId, getAssistantToolOwnerGeneration(ownerPluginId) + 1);
  for (const [name, entry] of registry) {
    if (entry.ownerPluginId === ownerPluginId) {
      registry.delete(name);
      version++;
    }
  }
}
