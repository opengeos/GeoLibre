import { mockFetch } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Message,
  ReasoningBlock,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  CachePointBlock,
} from "@strands-agents/sdk";
import type { AssistantProfile } from "../apps/geolibre-desktop/src/lib/assistant/provider";

/** Run a stream to completion, discarding its events. */
async function drain(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    // Only the side effects (the requests sent) matter here.
  }
}

const { MAX_CARRIED_TOOL_RESULT_CHARS, portableHistory } =
  await import("../apps/geolibre-desktop/src/lib/assistant/conversation-history");
const { AssistantSession } = await import("../apps/geolibre-desktop/src/lib/assistant/agent");

describe("portableHistory", () => {
  it("cuts an oversized tool result so a smaller model can take the history", () => {
    const big = "x".repeat(MAX_CARRIED_TOOL_RESULT_CHARS * 3);
    const history = portableHistory([
      new Message({
        role: "user",
        content: [
          new ToolResultBlock({
            toolUseId: "t1",
            status: "success",
            content: [new TextBlock(big), new TextBlock("short")],
          }),
        ],
      }),
    ]);
    const block = history[0].content[0];
    assert.ok("toolResult" in block);
    const [first, second] = block.toolResult.content;
    assert.ok("text" in first && "text" in second);
    assert.ok(first.text.length < MAX_CARRIED_TOOL_RESULT_CHARS + 100);
    assert.match(first.text, /truncated/);
    assert.equal(second.text, "short");
  });

  it("keeps text, tool calls and tool results", () => {
    const history = portableHistory([
      new Message({ role: "user", content: [new TextBlock("Where is Tokyo?")] }),
      new Message({
        role: "assistant",
        content: [new ToolUseBlock({ name: "zoom_to", toolUseId: "t1", input: { layer: "x" } })],
      }),
      new Message({
        role: "user",
        content: [
          new ToolResultBlock({
            toolUseId: "t1",
            status: "success",
            content: [new TextBlock("ok")],
          }),
        ],
      }),
    ]);
    assert.equal(history.length, 3);
    assert.deepEqual(history[0].content, [{ text: "Where is Tokyo?" }]);
    assert.equal((history[1].content[0] as { toolUse: { name: string } }).toolUse.name, "zoom_to");
    assert.ok("toolResult" in history[2].content[0]);
  });

  it("drops provider-signed reasoning, cache points and emptied messages", () => {
    const history = portableHistory([
      new Message({
        role: "assistant",
        content: [new ReasoningBlock({ text: "thinking", signature: "sig-from-provider-a" })],
      }),
      new Message({
        role: "assistant",
        content: [
          new ReasoningBlock({ text: "more thinking", signature: "sig" }),
          new TextBlock("Tokyo is in Japan."),
          new CachePointBlock({ cacheType: "default" }),
        ],
      }),
      new Message({
        role: "assistant",
        content: [
          new ToolUseBlock({
            name: "set_view",
            toolUseId: "t2",
            input: { zoom: 3 },
            reasoningSignature: "gemini-thought-signature",
          }),
        ],
      }),
    ]);
    // The reasoning-only message disappears instead of becoming an empty turn.
    assert.equal(history.length, 2);
    assert.deepEqual(history[0].content, [{ text: "Tokyo is in Japan." }]);
    const block = history[1].content[0];
    assert.ok("toolUse" in block);
    const toolUse = block.toolUse;
    assert.equal(toolUse.name, "set_view");
    assert.equal("reasoningSignature" in toolUse, false);
  });
});

/** An OpenAI-compatible profile served at its own base URL. */
function customProfile(id: string, baseUrl: string): AssistantProfile {
  return {
    id,
    name: id,
    provider: "custom",
    modelId: `model-${id}`,
    fieldValues: { OPENAI_COMPATIBLE_BASE_URL: baseUrl, OPENAI_COMPATIBLE_API_KEY: "k" },
  };
}

/** A streamed Chat Completions reply that says `text` and stops. */
function chatReply(text: string): Response {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({
      id: "c1",
      object: "chat.completion.chunk",
      created: 0,
      model: "m",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  const body = chunk({ role: "assistant", content: text }) + chunk({}, "stop") + "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("AssistantSession profile switch", () => {
  it("carries the conversation to the newly selected profile", async () => {
    const requests: { url: string; body: { messages: { role: string; content: unknown }[] } }[] =
      [];
    mockFetch(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push({ url, body: JSON.parse(String(init?.body)) });
      return chatReply(requests.length === 1 ? "The capital is Canberra." : "I said Canberra.");
    });

    const session = new AssistantSession({ getMapController: () => null });
    session.setSelection(customProfile("a", "https://a.example/v1"));
    await drain(session.stream("What is the capital of Australia?"));

    session.setSelection(customProfile("b", "https://b.example/v1"));
    await drain(session.stream("What did you just tell me?"));

    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /^https:\/\/a\.example\/v1\//);
    assert.match(requests[1].url, /^https:\/\/b\.example\/v1\//);
    const sent = JSON.stringify(requests[1].body.messages);
    // The second profile sees the first exchange, not just the new prompt.
    assert.match(sent, /capital of Australia/);
    assert.match(sent, /The capital is Canberra\./);
    assert.match(sent, /What did you just tell me\?/);
  });

  it("starts fresh after reset", async () => {
    const requests: { messages: unknown[] }[] = [];
    mockFetch(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return chatReply("ok");
    });

    const session = new AssistantSession({ getMapController: () => null });
    session.setSelection(customProfile("a", "https://a.example/v1"));
    await drain(session.stream("first question"));
    session.reset();
    await drain(session.stream("second question"));

    const sent = JSON.stringify(requests[1].messages);
    assert.doesNotMatch(sent, /first question/);
    assert.match(sent, /second question/);
  });
});
