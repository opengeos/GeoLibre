import {
  listAssistantGuidance,
  listAssistantToolEntries,
  type AssistantToolEntry,
} from "@geolibre/plugins/assistant-tool-registry";
import { tool, type JSONValue, type Tool } from "@strands-agents/sdk";
import { z } from "zod";

/** The host tool that turns on an installed plugin so its tools can be used. */
export const ACTIVATE_PLUGIN_NAME = "activate_plugin";

/** An installed plugin that is off and declares assistant tools. */
export interface ActivatablePlugin {
  id: string;
  name: string;
  /** The plugin's `assistant.description`: what its tools do once it is on. */
  description: string;
}

/**
 * How the assistant reaches the plugin manager. The desktop shell implements it
 * with the same activation and persistence the Plugins menu uses.
 */
export interface AssistantPluginHost {
  /** Installed plugins the assistant may turn on right now. */
  listActivatable: () => ActivatablePlugin[];
  /**
   * Turn a plugin on, as the Plugins menu does.
   *
   * @returns Whether the plugin is on afterwards.
   */
  activate: (pluginId: string) => Promise<boolean>;
}

/** What an {@link ACTIVATE_PLUGIN_NAME} call reports back to the model. */
export interface PluginActivationResult {
  plugin: { id: string; name: string };
  /** The plugin's tools, now callable in this same turn. */
  tools: { name: string; description: string }[];
  /** The plugin's assistant guidance, which reaches the system prompt only on the next message. */
  guidance: string[];
}

/** How long to wait for a plugin that registers its tools after a deferred mount. */
const TOOL_REGISTRATION_TIMEOUT_MS = 3000;
const TOOL_REGISTRATION_POLL_MS = 50;

/**
 * A key that changes whenever the set of activatable plugins does, so the agent
 * recomposes its tools (and this tool's description) before the next prompt.
 *
 * @param plugins The activatable plugins.
 * @returns A stable key for the list.
 */
export function activatablePluginsKey(plugins: readonly ActivatablePlugin[]): string {
  return JSON.stringify(plugins.map(({ id, description }) => [id, description]));
}

/**
 * Wait until a just-activated plugin has registered at least one tool. A plugin
 * may register from a deferred mount, after `activate` has already resolved.
 *
 * @param pluginId The plugin that was turned on.
 * @param listEntries Reads the registered plugin tools.
 * @param timeoutMs The longest time to wait.
 * @returns The plugin's registered tools, possibly empty after the timeout.
 */
export async function waitForPluginTools(
  pluginId: string,
  listEntries: () => AssistantToolEntry[],
  timeoutMs: number = TOOL_REGISTRATION_TIMEOUT_MS,
): Promise<AssistantToolEntry[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const owned = listEntries().filter((entry) => entry.ownerPluginId === pluginId);
    if (owned.length > 0 || Date.now() >= deadline) return owned;
    await new Promise((resolve) => setTimeout(resolve, TOOL_REGISTRATION_POLL_MS));
  }
}

/**
 * Turn a plugin on from inside a model turn and hand its tools to the live
 * agent, so the model can call them in the same turn. Guidance only reaches the
 * system prompt when the agent refreshes before the next message, so it is
 * returned here as well.
 *
 * @param host The plugin manager bridge.
 * @param pluginId The plugin to turn on.
 * @param loadTools Makes the plugin's registered tools callable on the live agent.
 * @returns The plugin, its tools and its guidance, for the model.
 */
export async function activateAssistantPlugin(
  host: AssistantPluginHost,
  pluginId: string,
  loadTools: (pluginId: string) => void,
): Promise<PluginActivationResult> {
  // Read before activating: an active plugin drops out of the list.
  const name = host.listActivatable().find((plugin) => plugin.id === pluginId)?.name;
  if (!(await host.activate(pluginId))) {
    throw new Error(`Plugin ${pluginId} could not be turned on.`);
  }
  const owned = await waitForPluginTools(pluginId, listAssistantToolEntries);
  if (owned.length > 0) loadTools(pluginId);
  return {
    plugin: { id: pluginId, name: name ?? pluginId },
    tools: owned.map(({ tool }) => ({ name: tool.name, description: tool.description ?? "" })),
    guidance: listAssistantGuidance()
      .filter((entry) => entry.ownerPluginId === pluginId)
      .map((entry) => entry.text),
  };
}

/**
 * Build the {@link ACTIVATE_PLUGIN_NAME} tool. Its description lists the
 * plugins it can turn on, since the model has no other way to learn that an
 * inactive plugin could serve the request.
 *
 * @param plugins The plugins that can be turned on, at agent build time.
 * @param activate Turns one on and reports its tools and guidance.
 * @returns The Strands tool to register on the agent.
 */
export function createActivatePluginTool(
  plugins: readonly ActivatablePlugin[],
  activate: (pluginId: string) => Promise<PluginActivationResult>,
): Tool {
  const listing = plugins
    .map((plugin) => `- ${plugin.id} (${plugin.name}): ${plugin.description.trim()}`)
    .join("\n");
  return tool({
    name: ACTIVATE_PLUGIN_NAME,
    description: `Turn on an installed plugin that is currently off, when the user asks for it or the request needs what it does. Its tools become callable right away, in this same turn, and the result lists them with the plugin's guidance. Turning a plugin on may open its panel. Plugins that can be turned on:\n${listing}`,
    inputSchema: z.object({
      plugin_id: z.string().min(1).describe("The id of a plugin from the list above."),
    }),
    callback: async (input): Promise<JSONValue> => {
      const id = input.plugin_id.trim();
      if (!plugins.some((plugin) => plugin.id === id)) {
        throw new Error(
          `No installed plugin with id ${id} can be turned on. Use one of: ${plugins.map((plugin) => plugin.id).join(", ")}.`,
        );
      }
      return (await activate(id)) as unknown as JSONValue;
    },
  });
}
