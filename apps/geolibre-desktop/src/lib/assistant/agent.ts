import {
  getAssistantToolsVersion,
  listAssistantToolEntries,
} from "@geolibre/plugins/assistant-tool-registry";
import { OPENFREEMAP_BASEMAPS, useAppStore } from "@geolibre/core";
import { Agent, type Tool } from "@strands-agents/sdk";
import i18next from "i18next";
import { configForProvider, createModel, readRuntimeEnv, resolveProviderConfig } from "./provider";
import { NAMED_TILE_BASEMAPS } from "./basemaps";
import {
  resolveFastPathAction,
  runToolDirectly,
  type FastPathAction,
  type FastPathState,
} from "./fast-path";
import { resolveSystemOneEndpoint } from "./system-one";
import { typesafeFetch } from "./typesafe-fetch";
import {
  assistantSelectionKey,
  configForProfile,
  type AssistantProviderSelection,
} from "./profiles";
import type { AssistantProfile } from "./provider";
import { describeLayers } from "./layer-summary";
import { buildSystemPrompt } from "./system-prompt";
import {
  createLoadPluginToolsTool,
  formatPluginToolCatalog,
  resolvePluginToolNames,
  scopePluginTools,
  type PluginToolLoadResult,
} from "./tool-scope";
import { createHostAssistantTools, type AssistantToolDeps } from "./tools";

/** A streamed update surfaced to the chat UI. */
export type AssistantStreamEvent =
  | { type: "text"; text: string }
  | {
      type: "tool";
      name: string;
      input: unknown;
      error?: string;
      /**
       * True when the fast path routed this call instead of the model.
       *
       * Surfaced because the feature is built to fail silently: without a mark
       * on the turn, "the fast path is off" and "the fast path is not helping"
       * look identical, which is how a misbuilt endpoint URL survived a whole
       * benchmarking round.
       */
      routed?: boolean;
    };

/**
 * The live map state the fast path routes against.
 *
 * Only the layers the user could name are offered: a layer the model cannot see
 * is one it cannot pick by mistake, and the choice list is what bounds the
 * request's size.
 */
function fastPathState(): FastPathState {
  return {
    layers: useAppStore.getState().layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      type: layer.type,
    })),
    styleBasemaps: OPENFREEMAP_BASEMAPS.map((basemap) => ({
      id: basemap.id,
      name: basemap.name,
    })),
    tileBasemaps: NAMED_TILE_BASEMAPS.map((basemap) => ({
      id: basemap.id,
      name: basemap.label,
    })),
  };
}

/**
 * A long-lived assistant session wrapping a Strands {@link Agent}. The agent is
 * built lazily on first use (so it picks up whichever provider key is
 * configured) and can be {@link reset} when settings change. Conversation
 * history persists across {@link stream} calls for multi-turn chat.
 */
export class AssistantSession {
  private agent: Agent | null = null;
  private toolsVersion = -1;
  private streaming = false;
  /** Explicit provider/model chosen in the UI; null means auto-resolve. */
  private selection: AssistantProviderSelection | null = null;
  /**
   * When set, the user chose a named profile from Settings → AI Providers.
   * The profile's own credential fieldValues are used directly rather than
   * going through the shared runtime env — this is the source of truth for
   * profile-based credential resolution and avoids cross-profile collisions.
   */
  private profile: AssistantProfile | null = null;
  /** Last layer context sent, so it is only re-sent when it actually changes. */
  private lastContext: string | null = null;
  /**
   * Value identity of the currently applied selection, so re-applying an
   * equivalent one is a no-op. Starts as the key for `null` (auto-resolve),
   * matching the initial `selection`/`profile` state above.
   */
  private selectionKey: string = assistantSelectionKey(null);
  /** Aborts an in-flight fast-path request when the user stops the run. */
  private fastPathAbort: AbortController | null = null;
  /**
   * Deferred plugin tools the model loaded with `load_plugin_tools` in this
   * conversation. Kept by name so a tool re-registered by its plugin (a version
   * bump) is re-resolved to the new instance on the next refresh; cleared with
   * the conversation in {@link reset}.
   */
  private loadedPluginTools = new Set<string>();
  /** Tool instances for direct (non-model) invocation by the fast path. */
  private cachedTools: Tool[] | null = null;
  private cachedToolsVersion = -1;

  constructor(private readonly deps: AssistantToolDeps) {}

  /** True when a provider API key is currently configured. */
  get available(): boolean {
    return resolveProviderConfig() !== null;
  }

  /**
   * Pin the provider/model (from the legacy UI picker) or pass a full
   * {@link AssistantProfile} for profile-based credential resolution.
   * Pass null to auto-resolve from the configured keys. Rebuilds the agent
   * on the next prompt, but only when the selection actually changed.
   *
   * Re-applying an equivalent selection must stay a no-op: callers re-run this
   * whenever their inputs are recomputed, and resetting there would discard the
   * conversation history this session exists to keep across {@link stream}
   * calls. Equivalence is by value, not object identity, so a profile object
   * rebuilt with the same provider, model, and credentials still matches.
   */
  setSelection(selection: AssistantProviderSelection | AssistantProfile | null): void {
    const key = assistantSelectionKey(selection);
    if (key === this.selectionKey) return;
    this.selectionKey = key;

    if (selection && "fieldValues" in selection) {
      // Profile-based: store the full profile, clear the legacy selection.
      this.profile = selection;
      this.selection = null;
    } else {
      // Legacy provider+model pair, or null for auto-resolve.
      this.selection = selection as AssistantProviderSelection | null;
      this.profile = null;
    }
    this.reset();
  }

  /** Drop the underlying agent so the next prompt rebuilds it (and its key). */
  reset(): void {
    this.agent?.cancel();
    this.agent = null;
    this.lastContext = null;
    this.loadedPluginTools.clear();
  }

  /** Cancel the in-flight model/tool run, if any. */
  cancel(): void {
    this.fastPathAbort?.abort();
    this.agent?.cancel();
  }

  /**
   * Try to answer the prompt without the model, yielding the events the agent
   * would have produced. Returns false when the request is not a fast-path one,
   * which is the common case and must cost nothing but the routing request.
   */
  private async *streamFastPath(prompt: string): AsyncGenerator<AssistantStreamEvent, boolean> {
    const endpoint = resolveSystemOneEndpoint(readRuntimeEnv());
    if (!endpoint) return false;

    const state = fastPathState();
    const abort = new AbortController();
    this.fastPathAbort = abort;
    let action: FastPathAction | null = null;
    try {
      action = await resolveFastPathAction({
        prompt,
        state,
        endpoint,
        fetchImpl: await typesafeFetch(),
        signal: abort.signal,
      });
    } finally {
      this.fastPathAbort = null;
    }
    // `resolveFastPathAction` reports a cancelled request the same way as a
    // timeout or a refusal — as "no action" — so the abort has to be read from
    // the signal. Falling through here would send the prompt to the model the
    // user just pressed Stop on, and on the first turn of a session
    // `agent?.cancel()` is a no-op because no agent exists yet. Only `cancel()`
    // touches this signal; the routing timeout aborts a controller of its own.
    if (abort.signal.aborted) return true;
    if (!action) return false;

    const tool = this.toolNamed(action.tool);
    // A tool the fast path names but the registry does not hold would be a bug,
    // not a user-visible failure: fall through rather than surface it.
    if (!tool) return false;

    const error = await runToolDirectly(tool, action.input);
    console.debug(
      `[geolibre] assistant fast path: ${action.tool} ${JSON.stringify(action.input)}` +
        (error ? ` — failed: ${error}` : ""),
    );
    yield { type: "tool", name: action.tool, input: action.input, error, routed: true };
    // The transcript already shows the call; this line is what voice mode reads
    // back, so a silent success would leave a hands-free user with no answer.
    yield {
      type: "text",
      text: error ? i18next.t("assistant.fastPath.failed") : i18next.t("assistant.fastPath.done"),
    };
    return true;
  }

  /** The host tool with this name, from a cache shared across prompts. */
  private toolNamed(name: string): Tool | null {
    const version = getAssistantToolsVersion();
    if (!this.cachedTools || this.cachedToolsVersion !== version) {
      this.cachedTools = createHostAssistantTools(this.deps);
      this.cachedToolsVersion = version;
    }
    return this.cachedTools.find((tool) => tool.name === name) ?? null;
  }

  /**
   * The tools and system prompt for the next model call. Host tools are always
   * sent; plugin tools are sent in full only while they fit under the eager
   * limit, and otherwise are listed in the prompt and loaded on demand.
   */
  private composeAgentInputs(): { tools: Tool[]; systemPrompt: string } {
    const entries = listAssistantToolEntries();
    // Forget loads whose tool has since been unregistered, so a plugin that is
    // deactivated and later reactivated starts deferred again.
    const live = new Set(entries.map((entry) => entry.tool.name));
    for (const name of this.loadedPluginTools) {
      if (!live.has(name)) this.loadedPluginTools.delete(name);
    }
    const scope = scopePluginTools(entries, this.loadedPluginTools);
    const tools = [...scope.active, ...createHostAssistantTools(this.deps)];
    if (scope.catalog.length > 0) {
      tools.push(createLoadPluginToolsTool((names) => this.loadPluginTools(names)));
    }
    return {
      tools,
      systemPrompt: buildSystemPrompt(undefined, formatPluginToolCatalog(scope.catalog)),
    };
  }

  /**
   * Make deferred plugin tools callable on the live agent. Called from inside
   * a model turn; the SDK reads the tool registry before each model call, so
   * the loaded specs reach the model on its next step.
   */
  private loadPluginTools(names: string[]): PluginToolLoadResult {
    const { tools, result } = resolvePluginToolNames(
      listAssistantToolEntries(),
      names,
      this.loadedPluginTools,
    );
    for (const loaded of tools) this.loadedPluginTools.add(loaded.name);
    if (tools.length > 0) this.agent?.toolRegistry.addOrReplace(tools);
    return result;
  }

  private async ensureAgent(): Promise<Agent> {
    if (this.agent) {
      if (this.toolsVersion !== getAssistantToolsVersion()) {
        // Refresh between prompts, retaining the agent and its conversation.
        // Plugin guidance shares the version counter, so the prompt is
        // recomposed alongside the tools.
        const { tools, systemPrompt } = this.composeAgentInputs();
        this.agent.toolRegistry.clear();
        this.agent.toolRegistry.add(tools);
        this.agent.systemPrompt = systemPrompt;
        this.toolsVersion = getAssistantToolsVersion();
      }
      return this.agent;
    }

    // Profile-based: resolve credentials directly from the profile's own
    // fieldValues, bypassing the shared runtime env. This prevents all-
    // profiles-flattened env collisions.
    const config = this.profile
      ? configForProfile(this.profile)
      : this.selection
        ? configForProvider(this.selection.provider, this.selection.model)
        : resolveProviderConfig();

    if (!config) {
      const pinned = this.selection?.provider ?? this.profile?.provider;
      throw new Error(
        pinned
          ? `No API key for the selected provider "${pinned}". Add its key in Settings → Environment Variables, or pick another provider.`
          : "No LLM API key is configured. Add GEMINI_API_KEY, GOOGLE_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY in Settings → Environment Variables.",
      );
    }
    const model = await createModel(config);
    const { tools, systemPrompt } = this.composeAgentInputs();
    this.agent = new Agent({ model, tools, systemPrompt });
    this.toolsVersion = getAssistantToolsVersion();
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
    // Guard before ensureAgent can refresh tools, including callers outside the UI.
    if (this.streaming) throw new Error("An assistant response is already in progress.");
    this.streaming = true;
    try {
      // Simple map commands are routed and executed without the model at all.
      // This runs before ensureAgent so it also works while no LLM provider is
      // configured — and, crucially, before any conversation state is touched,
      // so a fast-path turn leaves the agent's history exactly as it found it.
      if (yield* this.streamFastPath(prompt)) return;

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
    } finally {
      this.streaming = false;
    }
  }
}
