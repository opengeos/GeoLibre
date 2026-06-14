import { useAppStore } from "@geolibre/core";
import { Agent } from "@strands-agents/sdk";
import {
  configForProvider,
  createModel,
  resolveProviderConfig,
  type AssistantProviderId,
} from "./provider";
import {
  createAssistantTools,
  describeLayers,
  type AssistantToolDeps,
} from "./tools";

/** System prompt establishing the assistant's role, tools, and guardrails. */
const SYSTEM_PROMPT = `You are GeoLibre's geospatial assistant. You help the user explore and analyze the data already loaded in their map by calling the provided tools.

Guidelines:
- Always act through the tools. Never claim to have changed the map unless a tool call succeeded.
- Call list_layers to discover the current layers, their attribute fields, and the SQL table names before referencing them.
- For data questions, prefer run_sql with a single read-only DuckDB Spatial SQL statement against the SQL table names from list_layers. Show the SQL you ran. Only add the result as a layer when the user asks to map it or when geometry is clearly wanted.
- For styling requests, use apply_symbology with the layer's real field names.
- To add imagery or tile basemaps (Google Satellite, Esri imagery, OpenStreetMap, etc.), use add_tile_layer. You already know the common XYZ tile URLs, so add them directly rather than asking the user or saying you cannot.
- Use web_search when you need current information from the internet.
- Keep replies short. Report exactly what each tool did (e.g. the SQL run, the rows returned, the layer added/styled). Every change is undoable, so prefer acting over asking when the request is clear.
- Never fabricate field names, layer names, or results — read them with the tools first.`;

/** A streamed update surfaced to the chat UI. */
export type AssistantStreamEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; input: unknown; error?: string };

/**
 * A long-lived assistant session wrapping a Strands {@link Agent}. The agent is
 * built lazily on first use (so it picks up whichever provider key is
 * configured) and can be {@link reset} when settings change. Conversation
 * history persists across {@link stream} calls for multi-turn chat.
 */
export class AssistantSession {
  private agent: Agent | null = null;
  /** Explicit provider/model chosen in the UI; null means auto-resolve. */
  private selection: { provider: AssistantProviderId; model?: string } | null =
    null;

  constructor(private readonly deps: AssistantToolDeps) {}

  /** True when a provider API key is currently configured. */
  get available(): boolean {
    return resolveProviderConfig() !== null;
  }

  /**
   * Pin the provider/model (from the UI picker), or pass null to auto-resolve
   * from the configured keys. Rebuilds the agent on the next prompt.
   */
  setSelection(
    selection: { provider: AssistantProviderId; model?: string } | null,
  ): void {
    this.selection = selection;
    this.reset();
  }

  /** Drop the underlying agent so the next prompt rebuilds it (and its key). */
  reset(): void {
    this.agent?.cancel();
    this.agent = null;
  }

  /** Cancel the in-flight model/tool run, if any. */
  cancel(): void {
    this.agent?.cancel();
  }

  private async ensureAgent(): Promise<Agent> {
    if (this.agent) return this.agent;
    const config = this.selection
      ? configForProvider(this.selection.provider, this.selection.model)
      : resolveProviderConfig();
    if (!config) {
      throw new Error(
        "No LLM API key is configured. Add one (e.g. GEMINI_API_KEY) in Settings → Environment.",
      );
    }
    const model = await createModel(config);
    this.agent = new Agent({
      model,
      tools: createAssistantTools(this.deps),
      systemPrompt: SYSTEM_PROMPT,
    });
    return this.agent;
  }

  /**
   * Send a user prompt and stream back text deltas and tool-call notifications.
   * The current layer context is prepended so the model stays grounded across
   * turns without rebuilding the agent.
   *
   * @param prompt The user's natural-language request.
   * @yields {@link AssistantStreamEvent} updates as the model and tools run.
   */
  async *stream(prompt: string): AsyncGenerator<AssistantStreamEvent> {
    const agent = await this.ensureAgent();
    const context = describeLayers(useAppStore.getState().layers);
    const message = `Current layers:\n${context}\n\nUser request: ${prompt}`;

    for await (const event of agent.stream(message)) {
      // Text deltas as the model writes its reply.
      if (event.type === "modelStreamUpdateEvent") {
        const inner = event.event as {
          type?: string;
          delta?: { type?: string; text?: string };
        };
        if (
          inner?.type === "modelContentBlockDeltaEvent" &&
          inner.delta?.type === "textDelta" &&
          inner.delta.text
        ) {
          yield { type: "text", text: inner.delta.text };
        }
        continue;
      }
      // A tool finished — surface it (with any error) in the transcript.
      if (event.type === "afterToolCallEvent") {
        yield {
          type: "tool",
          name: event.toolUse.name,
          input: event.toolUse.input,
          error: event.error?.message,
        };
      }
    }
  }
}
