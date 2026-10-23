/**
 * A low-latency path for the handful of map commands that are pure routing.
 *
 * "Hide the rivers" needs no reasoning, no SQL and no code — it needs an intent
 * and a layer id. Sending it through the full agent means shipping the system
 * prompt plus 21 tool schemas to an LLM and waiting for a tool call to stream
 * back; measured against this repo's own prompt that is ~3.8s on a hosted model
 * and ~0.8s on a local one. A TypeSafe System One model (Jev) answers the same
 * question as a set of typed judgments in ~230ms, because it classifies rather
 * than generates.
 *
 * So this module asks Jev one request's worth of questions and, when the answer
 * is confident enough, hands back the tool call the agent would have made. The
 * agent then runs that tool — the *same* tool, through the same store — so the
 * transcript, the undo history and the spoken reply are identical to the slow
 * path. Anything else (SQL, geoprocessing, styling, code, questions about the
 * data) comes back as `complex` and falls through untouched.
 *
 * Everything here is pure except {@link resolveFastPathAction}, which is the
 * only function that touches the network, so the routing rules can be tested
 * without a browser or an API key. The transport itself — where the questions
 * go, what a failure means — is shared with the catalog lookup in
 * {@link ./system-one}.
 */

import type { Tool } from "@strands-agents/sdk";
import {
  flattenCriterionName,
  postSystemOne,
  SYSTEM_ONE_MAX_CHOICES,
  type SystemOneAnswer,
  type SystemOneAnswers,
  type SystemOneEndpoint,
  type SystemOneFetch,
} from "./system-one";

/** The intents the fast path can satisfy, plus the fall-through. */
export const FAST_PATH_INTENTS = [
  "set_basemap",
  "add_tile_layer",
  "set_layer_visibility",
  "set_layer_opacity",
  "zoom_to",
  "remove_layer",
  "complex",
] as const;

export type FastPathIntent = (typeof FAST_PATH_INTENTS)[number];

/** A resolved tool call, ready to run through the assistant's own tool. */
export interface FastPathAction {
  /** The assistant tool to invoke, e.g. `set_layer_visibility`. */
  tool: Exclude<FastPathIntent, "complex">;
  /** Input matching that tool's schema in `tools.ts`. */
  input: Record<string, unknown>;
}

/** The parts of a layer the routing questions need. */
export interface FastPathLayer {
  id: string;
  name: string;
  type: string;
}

/** A basemap offered as a choice, from either basemap registry. */
export interface FastPathBasemap {
  id: string;
  name: string;
}

/** The live state the questions are asked against. */
export interface FastPathState {
  layers: readonly FastPathLayer[];
  /** Vector styles `set_basemap` switches between. */
  styleBasemaps: readonly FastPathBasemap[];
  /** Named XYZ raster basemaps `add_tile_layer` can add. */
  tileBasemaps: readonly FastPathBasemap[];
}

/**
 * Confidence the intent must reach before the LLM is skipped.
 *
 * Measured against this repo's tool surface, correct routings land at 0.99–1.00
 * and every non-fast-path request came back as `complex` at 1.00, so this sits
 * well clear of the observed spread. Anything below it is not a failure — it
 * just falls through to the agent, which is where the request would have gone
 * anyway.
 */
export const FAST_PATH_MIN_CONFIDENCE = 0.85;

/**
 * Confidence the *layer* choice must reach for an intent that destroys work.
 *
 * Getting `set_layer_opacity` slightly wrong is a nuisance the user can see and
 * undo; removing the wrong layer is not, so `remove_layer` is held to a higher
 * bar and otherwise defers to the agent.
 */
export const FAST_PATH_MIN_DESTRUCTIVE_CONFIDENCE = 0.95;

/**
 * How long the fast path may spend before it stops being fast.
 *
 * The entire premise is beating the agent's first token, so a slow answer is
 * worth less than no answer: past this budget the request is abandoned and the
 * agent runs as usual. Occasional multi-second responses were observed in
 * benchmarking, which is exactly the case this guards.
 */
export const FAST_PATH_TIMEOUT_MS = 1_500;

/**
 * Hard cap on options in one question.
 *
 * The layer question scales with the user's project, so a large project would
 * otherwise turn every prompt into a 400. One slot is reserved for `none`.
 */
export const FAST_PATH_MAX_CHOICES = SYSTEM_ONE_MAX_CHOICES;

/** Ordered opacity levels; the Score answer indexes into these. */
const OPACITY_LEVELS = [
  "Fully transparent — the layer should not be visible at all",
  "Mostly transparent — a faint ghost of the layer",
  "Half transparent — the layer and what is under it equally visible",
  "Mostly opaque — slightly faded",
  "Fully opaque — solid, nothing showing through",
];

/** Sentinel meaning "the request names no option from this set". */
const NONE = "none";

/**
 * Whether the fast path can run for this project at all.
 *
 * A project with more layers than the choice cap cannot be described in one
 * question, and rather than silently truncating the list — which would let Jev
 * confidently pick the wrong layer because the right one was never offered —
 * the fast path stands down and the agent handles everything.
 */
export function fastPathFitsProject(state: FastPathState): boolean {
  return state.layers.length <= FAST_PATH_MAX_CHOICES - 1;
}

/**
 * Build the questions for one request.
 *
 * Every argument is asked up front, speculatively, alongside the intent: the
 * questions are answered in parallel against the same state and cannot see each
 * other, so asking only the "relevant" ones would need a second round trip and
 * defeat the purpose. Code then reads whichever answers the chosen intent needs
 * and ignores the rest.
 *
 * @param state - Layers and basemaps currently available.
 * @returns The `questions` map for a System One request.
 */
export function buildFastPathQuestions(state: FastPathState): Record<string, unknown> {
  const layerCriteria: Record<string, string> = Object.fromEntries(
    state.layers.map((layer) => [
      layer.id,
      `The layer named "${flattenCriterionName(layer.name)}" (${flattenCriterionName(layer.type)})`,
    ]),
  );
  layerCriteria[NONE] = "The request does not refer to any layer already on the map";

  const styleCriteria: Record<string, string> = Object.fromEntries(
    state.styleBasemaps.map((basemap) => [
      basemap.id,
      `The "${flattenCriterionName(basemap.name)}" basemap style`,
    ]),
  );
  styleCriteria[NONE] = "The request names no basemap style";

  const tileCriteria: Record<string, string> = Object.fromEntries(
    state.tileBasemaps.map((basemap) => [
      basemap.id,
      `The "${flattenCriterionName(basemap.name)}" tile layer`,
    ]),
  );
  tileCriteria[NONE] = "The request names no tile basemap";

  return {
    intent: {
      type: "choice",
      instructions:
        "The user is speaking to a GIS map application. Which single action are they asking it to take right now?",
      criteria: {
        set_basemap: "Switch the underlying basemap style of the map",
        add_tile_layer:
          "Add a named XYZ raster tile basemap, such as OpenStreetMap or OpenTopoMap, as a layer",
        set_layer_visibility: "Show or hide a layer that is already on the map",
        set_layer_opacity: "Change how transparent a layer already on the map is",
        zoom_to: "Move or fit the camera to a layer already on the map",
        remove_layer: "Delete a layer from the map entirely",
        complex:
          "Anything else — querying or summarising data, writing SQL, running analysis or geoprocessing, styling by attribute value, adding data from a file or service, running code, or answering a question about what the data contains",
      },
    },
    layer: {
      type: "choice",
      instructions:
        "If the request refers to a layer that is already on the map, which one is it? Match on meaning, not exact wording.",
      criteria: layerCriteria,
    },
    styleBasemap: {
      type: "choice",
      instructions:
        "Assuming the request asks to switch the basemap style, which style does it ask for?",
      criteria: styleCriteria,
    },
    tileBasemap: {
      type: "choice",
      instructions:
        "Assuming the request asks to add a named tile basemap layer, which one does it name?",
      criteria: tileCriteria,
    },
    visible: {
      type: "noul",
      instructions:
        "Assuming the request is about whether a layer is shown, is the user asking to SHOW it?",
      criteria: {
        true: "Show, reveal, turn on, display, bring back",
        false: "Hide, turn off, conceal, take off the map temporarily",
      },
    },
    opacity: {
      type: "score",
      instructions:
        "Assuming the request is about how transparent a layer should be, what does the user want?",
      criteria: OPACITY_LEVELS,
    },
  };
}

/** One typed answer, as the System One response carries it. */
type FastPathAnswer = SystemOneAnswer;

/** The answers map from a System One response. */
export type FastPathAnswers = SystemOneAnswers;

/** Read a choice answer that must clear `minConfidence` and not be `none`. */
function resolvedChoice(answer: FastPathAnswer | undefined, minConfidence: number): string | null {
  if (!answer?.choice || answer.choice === NONE) return null;
  if ((answer.confidence ?? 0) < minConfidence) return null;
  return answer.choice;
}

/**
 * Turn a set of answers into the tool call to run, or null to use the agent.
 *
 * Returning null is always safe and always correct-by-default: it means the
 * request goes where it would have gone without this module.
 *
 * @param answers - The `answers` map from a System One response.
 * @param state - The same state the questions were built from.
 * @returns The tool call to run, or null to fall through to the agent.
 */
export function interpretFastPathAnswers(
  answers: FastPathAnswers,
  state: FastPathState,
): FastPathAction | null {
  const intent = answers.intent;
  if (!intent?.choice) return null;
  if (!FAST_PATH_INTENTS.includes(intent.choice as FastPathIntent)) return null;
  if (intent.choice === "complex") return null;
  // Deleting a layer has to clear the destructive bar on the *intent* as well
  // as on the layer: "hide the rivers" and "drop the rivers" name the same
  // layer, so a confident layer match says nothing about which of the two was
  // asked for, and only one of them is undoable by pressing the button again.
  const minIntentConfidence =
    intent.choice === "remove_layer"
      ? FAST_PATH_MIN_DESTRUCTIVE_CONFIDENCE
      : FAST_PATH_MIN_CONFIDENCE;
  if ((intent.confidence ?? 0) < minIntentConfidence) return null;

  /** The chosen layer, if it clears `minConfidence` and still exists. */
  const layerId = (minConfidence: number): string | null => {
    const chosen = resolvedChoice(answers.layer, minConfidence);
    if (!chosen) return null;
    return state.layers.some((layer) => layer.id === chosen) ? chosen : null;
  };

  switch (intent.choice as Exclude<FastPathIntent, "complex">) {
    case "set_basemap": {
      const basemap = resolvedChoice(answers.styleBasemap, FAST_PATH_MIN_CONFIDENCE);
      if (!basemap) return null;
      if (!state.styleBasemaps.some((entry) => entry.id === basemap)) return null;
      return { tool: "set_basemap", input: { basemap } };
    }
    case "add_tile_layer": {
      const basemap = resolvedChoice(answers.tileBasemap, FAST_PATH_MIN_CONFIDENCE);
      if (!basemap) return null;
      if (!state.tileBasemaps.some((entry) => entry.id === basemap)) return null;
      return { tool: "add_tile_layer", input: { basemap } };
    }
    case "set_layer_visibility": {
      const layer = layerId(FAST_PATH_MIN_CONFIDENCE);
      if (!layer) return null;
      const noul = answers.visible?.noul;
      // A Noul near 0.5 is genuine ambiguity between showing and hiding, not a
      // half-measure, and guessing wrong is the opposite of what was asked.
      if (typeof noul !== "number" || (noul > 0.25 && noul < 0.75)) return null;
      return { tool: "set_layer_visibility", input: { layer, visible: noul >= 0.75 } };
    }
    case "set_layer_opacity": {
      const layer = layerId(FAST_PATH_MIN_CONFIDENCE);
      if (!layer) return null;
      const score = answers.opacity?.score;
      if (typeof score !== "number" || !Number.isFinite(score)) return null;
      // The Score is a probability-weighted position across OPACITY_LEVELS, so
      // it is continuous: normalising by the top index maps it onto 0–1 without
      // snapping "mostly transparent" to the same value as "half".
      //
      // This is the one actionable intent with no confidence gate, which is
      // deliberate and worth stating because it reads as an omission. Score
      // confidence measures how concentrated the distribution is, and on an
      // *ordered* dimension a spread across adjacent levels is not doubt — it
      // is the answer, "between mostly transparent and half", which the
      // weighted score already expresses. Gating on it would reject precisely
      // the in-between values a Score exists to give. `visible` is banded
      // instead because show and hide are opposites rather than neighbours, so
      // a split there really is a coin toss. The residual case a gate would
      // catch is a bimodal answer (mass at both ends), whose midpoint means
      // nothing; that is left to the user, because opacity is the cheapest
      // intent to get wrong — immediately visible and undoable.
      const opacity = Math.min(1, Math.max(0, score / (OPACITY_LEVELS.length - 1)));
      return { tool: "set_layer_opacity", input: { layer, opacity } };
    }
    case "zoom_to": {
      // Without a layer the tool needs a bounding box, which is a number the
      // model cannot supply — that belongs to the agent.
      const layer = layerId(FAST_PATH_MIN_CONFIDENCE);
      if (!layer) return null;
      return { tool: "zoom_to", input: { layer } };
    }
    case "remove_layer": {
      const layer = layerId(FAST_PATH_MIN_DESTRUCTIVE_CONFIDENCE);
      if (!layer) return null;
      return { tool: "remove_layer", input: { layer } };
    }
  }
}

/**
 * Run one assistant tool outside the agent loop.
 *
 * The tool is the same instance the model would have called, so the store
 * mutation, the undo entry and any validation behave identically — the only
 * difference is who decided to call it.
 *
 * Lives here rather than beside the session so it can be tested against a real
 * SDK tool: `agent.ts` pulls in the whole app (the store, MapLibre) and cannot
 * be imported outside a browser. The `ToolContext` is built by assertion
 * because only `toolUse` is read on this path — the agent/session fields the
 * SDK also declares belong to a model-driven run, so a bump that starts
 * requiring one of them would surface as a failure here rather than a type
 * error, which is what `tests/assistant-fast-path.test.ts` pins down.
 *
 * @param tool The registered tool to invoke.
 * @param input Input matching that tool's schema.
 * @returns The failure message, or undefined when the tool succeeded.
 */
export async function runToolDirectly(
  tool: Tool,
  input: Record<string, unknown>,
): Promise<string | undefined> {
  try {
    const stream = tool.stream({
      toolUse: { name: tool.name, toolUseId: `fast-path-${Date.now()}`, input },
    } as Parameters<Tool["stream"]>[0]);
    let next = await stream.next();
    while (!next.done) next = await stream.next();
    const result = next.value;
    if (result.status !== "error") return undefined;
    return result.error?.message ?? "Tool failed";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Where the fast path sends its questions, and how it authenticates. */
export type FastPathEndpoint = SystemOneEndpoint;

/** The transport used to reach TypeSafe, injectable for tests. */
export type FastPathFetch = SystemOneFetch;

/** Options for one fast-path attempt. */
export interface ResolveFastPathOptions {
  prompt: string;
  state: FastPathState;
  endpoint: FastPathEndpoint;
  fetchImpl: FastPathFetch;
  /** Abort budget; defaults to {@link FAST_PATH_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Cancels the attempt when the surrounding run is cancelled. */
  signal?: AbortSignal;
}

/**
 * Ask TypeSafe to route one request, returning the tool call to run.
 *
 * Every failure mode — no credential, a rejected origin, a timeout, a malformed
 * response, an unconfident answer — resolves to null rather than throwing. The
 * fast path is an optimisation layered over a working assistant, so it must
 * never be able to break a request that would otherwise have succeeded.
 *
 * @returns The tool call to run, or null to fall through to the agent.
 */
export async function resolveFastPathAction(
  options: ResolveFastPathOptions,
): Promise<FastPathAction | null> {
  const { prompt, state, endpoint, fetchImpl, signal } = options;
  if (!prompt.trim() || !fastPathFitsProject(state)) return null;

  const answers = await postSystemOne({
    endpoint,
    fetchImpl,
    state: {
      request: prompt,
      layers_currently_loaded: state.layers.map((layer) => ({
        id: layer.id,
        name: flattenCriterionName(layer.name),
        type: flattenCriterionName(layer.type),
      })),
    },
    questions: buildFastPathQuestions(state),
    timeoutMs: options.timeoutMs ?? FAST_PATH_TIMEOUT_MS,
    signal,
  });
  return answers ? interpretFastPathAnswers(answers, state) : null;
}
