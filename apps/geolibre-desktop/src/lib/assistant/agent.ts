import { useAppStore } from "@geolibre/core";
import { Agent } from "@strands-agents/sdk";
import {
  configForProvider,
  createModel,
  resolveProviderConfig,
  type AssistantProviderId,
} from "./provider";
import { createAssistantTools, describeLayers, type AssistantToolDeps } from "./tools";

/** System prompt establishing the assistant's role, tools, and guardrails. */
const SYSTEM_PROMPT = `You are GeoLibre's geospatial assistant. You help the user explore and analyze the data already loaded in their map by calling the provided tools.

Guidelines:
- Always act through the tools. Never claim to have changed the map unless a tool call succeeded.
- Call list_layers to discover the current layers, their attribute fields, and the SQL table names before referencing them.
- For data questions, prefer run_sql with a single read-only DuckDB Spatial SQL statement against the SQL table names from list_layers. Show the SQL you ran. Only add the result as a layer when the user asks to map it or when geometry is clearly wanted.
- For styling requests, use apply_symbology with the layer's real field names.
- For geoprocessing (buffer, clip, dissolve, intersection, difference, union, spatial join, simplify, centroids, H3 grids, …), call list_algorithms to discover ids and typed parameters, then run_algorithm with the algorithm id and parameters. A 'layer' parameter takes a layer id. Build a multi-step pipeline by feeding one run's returned result layer id into the next.
- To add satellite/aerial imagery or other earth-observation data, use search_stac and add_stac_layer against the Planetary Computer (collections such as sentinel-2-l2a, landsat-c2-l2, naip, cop-dem-glo-30); the bounding box defaults to the current view.
- To add tile basemaps (OpenStreetMap, OpenTopoMap, CARTO Dark Matter, etc.), use add_tile_layer with a known name or an XYZ url, rather than asking the user or saying you cannot.
- Use web_search when you need current information from the internet.
- When no dedicated tool fits the request (e.g. changing the map projection to globe, enabling terrain or sky, setting a custom paint/layout property), do not say you can't — use run_maplibre_js to accomplish it with a small JavaScript snippet against the live \`map\` object.
- For data processing or computation (numpy/pandas/geopandas, custom analysis), use run_python; a \`geolibre\` object is available there to drive the map.
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
  private selection: { provider: AssistantProviderId; model?: string } | null = null;
  /** Last layer context sent, so it is only re-sent when it actually changes. */
  private lastContext: string | null = null;

  constructor(private readonly deps: AssistantToolDeps) {}

  /** True when a provider API key is currently configured. */
  get available(): boolean {
    return resolveProviderConfig() !== null;
  }

  /**
   * Pin the provider/model (from the UI picker), or pass null to auto-resolve
   * from the configured keys. Rebuilds the agent on the next prompt.
   */
  setSelection(selection: { provider: AssistantProviderId; model?: string } | null): void {
    this.selection = selection;
    this.reset();
  }

  /** Drop the underlying agent so the next prompt rebuilds it (and its key). */
  reset(): void {
    this.agent?.cancel();
    this.agent = null;
    this.lastContext = null;
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
      const pinned = this.selection?.provider;
      throw new Error(
        pinned
          ? `No API key for the selected provider "${pinned}". Add its key in Settings → Environment Variables, or pick another provider.`
          : "No LLM API key is configured. Add GEMINI_API_KEY, GOOGLE_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY in Settings → Environment Variables.",
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
    // Only prepend the layer context when it changed since the last message, so
    // long conversations don't re-send the full layer list on every turn.
    const context = describeLayers(useAppStore.getState().layers);
    const message =
      context === this.lastContext
        ? prompt
        : `Current layers:\n${context}\n\nUser request: ${prompt}`;
    this.lastContext = context;

    for await (const event of agent.stream(message)) {
      // Text deltas as the model writes its reply. `event.event` is the SDK's
      // normalized ModelStreamEvent (provider-agnostic), so we narrow on its
      // public discriminants rather than casting to an ad-hoc shape.
      if (event.type === "modelStreamUpdateEvent") {
        const inner = event.event;
        if (
          inner.type === "modelContentBlockDeltaEvent" &&
          inner.delta.type === "textDelta" &&
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
