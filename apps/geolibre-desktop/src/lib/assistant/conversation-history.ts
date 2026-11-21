import type {
  ContentBlockData,
  Message,
  MessageData,
  ToolResultBlockData,
} from "@strands-agents/sdk";

/**
 * Longest single tool result part, in characters, carried into a rebuilt
 * agent. Results such as fetched GeoJSON or Python output can be large, and a
 * switch to a model with a smaller context window must not fail because of
 * output the user has already seen.
 */
export const MAX_CARRIED_TOOL_RESULT_CHARS = 8000;

/**
 * Budget, in characters, for all carried tool results together. Once it is
 * exceeded the oldest results are replaced by a short note, so a long session
 * cannot overflow a smaller model on any later turn either.
 */
export const MAX_CARRIED_TOOL_RESULTS_TOTAL_CHARS = 40000;

const TRUNCATION_NOTE = "\n[truncated when the conversation moved to another model]";
const OMITTED_NOTE = "[older tool output omitted when the conversation moved to another model]";

/** Cap one tool result's text and JSON parts at {@link MAX_CARRIED_TOOL_RESULT_CHARS}. */
function capToolResult(result: ToolResultBlockData): ToolResultBlockData {
  const content = result.content.map((part) => {
    let text: string | null = null;
    if ("text" in part) text = part.text;
    else if ("json" in part) text = JSON.stringify(part.json) ?? "";
    if (text === null || text.length <= MAX_CARRIED_TOOL_RESULT_CHARS) return part;
    return { text: text.slice(0, MAX_CARRIED_TOOL_RESULT_CHARS) + TRUNCATION_NOTE };
  });
  return { ...result, content };
}

/** Characters a tool result's text and JSON parts take up. */
function toolResultSize(result: ToolResultBlockData): number {
  let size = 0;
  for (const part of result.content) {
    if ("text" in part) size += part.text.length;
    else if ("json" in part) size += (JSON.stringify(part.json) ?? "").length;
  }
  return size;
}

/**
 * Copy a conversation so a freshly built agent, possibly on another provider
 * or model, can continue it.
 *
 * Switching AI profiles (or rotating a key) rebuilds the Strands agent, and a
 * new agent starts with an empty history unless it is seeded. The transcript
 * stays on screen across the switch, so dropping the history made the model
 * deny context the user can plainly see.
 *
 * Text, tool calls and tool results carry over. Reasoning blocks and the
 * reasoning signature on a tool call do not: they are signed by the provider
 * that produced them, and another provider (or the same one under a different
 * model) rejects a signature it did not issue. Providers only require them
 * inside an unfinished tool-use loop, and a rebuild happens between turns, so
 * dropping them loses nothing the next model needs. Cache points are dropped
 * too, being a hint for the provider that placed them. A tool call without a
 * result (a run stopped mid-call) is dropped, since chat APIs reject an
 * unanswered call. Tool output is capped per part and in total, oldest first.
 * A message left empty by the filtering is dropped rather than sent as an
 * empty turn.
 *
 * @param messages The outgoing agent's conversation history.
 * @returns Serialized messages to seed the next agent with.
 */
export function portableHistory(messages: readonly Message[]): MessageData[] {
  const data = messages.map((message) => message.toJSON());
  const answered = new Set<string>();
  for (const message of data) {
    for (const block of message.content) {
      if ("toolResult" in block) answered.add(block.toolResult.toolUseId);
    }
  }

  const filtered = data.map((message) => ({
    ...message,
    content: message.content.flatMap((block): ContentBlockData[] => {
      if ("reasoning" in block || "cachePoint" in block) return [];
      if ("toolUse" in block) {
        if (!answered.has(block.toolUse.toolUseId)) return [];
        const { reasoningSignature: _signature, ...toolUse } = block.toolUse;
        return [{ toolUse }];
      }
      if ("toolResult" in block) return [{ toolResult: capToolResult(block.toolResult) }];
      return [block];
    }),
  }));

  // Enforce the total budget by blanking the oldest results first; the newest
  // output is the most likely to be asked about next.
  let total = 0;
  for (const message of filtered) {
    for (const block of message.content) {
      if ("toolResult" in block) total += toolResultSize(block.toolResult);
    }
  }
  for (const message of filtered) {
    if (total <= MAX_CARRIED_TOOL_RESULTS_TOTAL_CHARS) break;
    message.content = message.content.map((block) => {
      if (!("toolResult" in block) || total <= MAX_CARRIED_TOOL_RESULTS_TOTAL_CHARS) return block;
      total += OMITTED_NOTE.length - toolResultSize(block.toolResult);
      return { toolResult: { ...block.toolResult, content: [{ text: OMITTED_NOTE }] } };
    });
  }

  return filtered.filter((message) => message.content.length > 0);
}
