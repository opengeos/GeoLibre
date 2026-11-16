import type {
  ContentBlockData,
  Message,
  MessageData,
  ToolResultBlockData,
} from "@strands-agents/sdk";

/**
 * Longest tool result, in characters, carried into a rebuilt agent. Results
 * such as fetched GeoJSON or Python output can be large, and a switch to a
 * model with a smaller context window must not fail on the first turn because
 * of output the user has already seen.
 */
export const MAX_CARRIED_TOOL_RESULT_CHARS = 8000;

const TRUNCATION_NOTE = "\n[truncated when the conversation moved to another model]";

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

/**
 * Copy a conversation so a freshly built agent, possibly on another provider
 * or model, can continue it.
 *
 * Switching AI profiles (or rotating a key) rebuilds the Strands agent, and a
 * new agent starts with an empty history unless it is seeded. The transcript
 * stays on screen across the switch, so dropping the history made the model
 * deny context the user can plainly see.
 *
 * Text, tool calls and tool results carry over verbatim. Reasoning blocks and
 * the reasoning signature on a tool call do not: they are signed by the
 * provider that produced them, and another provider (or the same one under a
 * different model) rejects a signature it did not issue. Providers only require
 * them inside an unfinished tool-use loop, and a rebuild happens between
 * turns, so dropping them loses nothing the next model needs. Cache points are
 * dropped too, being a hint for the provider that placed them. A message left
 * empty by the filtering is dropped rather than sent as an empty turn, and an
 * oversized tool result is cut to {@link MAX_CARRIED_TOOL_RESULT_CHARS}.
 *
 * @param messages The outgoing agent's conversation history.
 * @returns Serialized messages to seed the next agent with.
 */
export function portableHistory(messages: readonly Message[]): MessageData[] {
  const out: MessageData[] = [];
  for (const message of messages) {
    const data = message.toJSON();
    const content = data.content.flatMap((block): ContentBlockData[] => {
      if ("reasoning" in block || "cachePoint" in block) return [];
      if ("toolUse" in block && block.toolUse.reasoningSignature !== undefined) {
        const { reasoningSignature: _signature, ...toolUse } = block.toolUse;
        return [{ toolUse }];
      }
      if ("toolResult" in block) return [{ toolResult: capToolResult(block.toolResult) }];
      return [block];
    });
    if (content.length === 0) continue;
    out.push({ ...data, content });
  }
  return out;
}
