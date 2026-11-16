import type { ContentBlockData, Message, MessageData } from "@strands-agents/sdk";

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
 * empty by the filtering is dropped rather than sent as an empty turn.
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
      return [block];
    });
    if (content.length === 0) continue;
    out.push({ ...data, content });
  }
  return out;
}
