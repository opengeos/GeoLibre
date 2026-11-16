import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  applyChatGptStatus,
  chatGptFetch,
  chatGptRoute,
  discoverChatGptModels,
  isChatGptReady,
  parseChatGptCatalog,
  resetChatGptStatusForTests,
} from "../apps/geolibre-desktop/src/lib/assistant/chatgpt";
import {
  availableProviders,
  configForProvider,
  createModel,
  hasProviderKey,
  resolveProviderConfig,
} from "../apps/geolibre-desktop/src/lib/assistant/provider";

const READY = { signedIn: true, planAllowed: true, email: "someone@example.com" };

describe("chatGptRoute", () => {
  it("reaches only the Responses API and the model list", () => {
    assert.equal(chatGptRoute("https://api.openai.com/v1/responses"), "responses");
    assert.equal(chatGptRoute("https://api.openai.com/v1/models"), "models");
    assert.equal(chatGptRoute("https://api.openai.com/v1/files"), null);
    assert.equal(chatGptRoute("https://api.openai.com/v1/responses/resp_1"), null);
    assert.equal(chatGptRoute("https://evil.example/v1/responses"), null);
    assert.equal(chatGptRoute("http://api.openai.com/v1/responses"), null);
    assert.equal(chatGptRoute("not a url"), null);
  });
});

describe("parseChatGptCatalog", () => {
  it("keeps the listed models in the catalog's order", () => {
    const models = parseChatGptCatalog({
      models: [
        { slug: "gpt-b", visibility: "list", display_name: "GPT B" },
        { slug: "gpt-hidden", visibility: "hide" },
        { slug: "gpt-a", visibility: "list" },
        { slug: "gpt-b", visibility: "list" },
        { slug: "bad\u0007id", visibility: "list" },
        { visibility: "list" },
      ],
    });
    assert.deepEqual(models, [
      { id: "gpt-b", name: "GPT B" },
      { id: "gpt-a", name: "gpt-a" },
    ]);
  });

  it("reads a plain OpenAI model list too", () => {
    assert.deepEqual(parseChatGptCatalog({ data: [{ id: "gpt-x" }] }), [
      { id: "gpt-x", name: "gpt-x" },
    ]);
    assert.deepEqual(parseChatGptCatalog(null), []);
  });
});

describe("the chatgpt provider", () => {
  beforeEach(() => resetChatGptStatusForTests());
  afterEach(() => resetChatGptStatusForTests());

  it("is configured only while signed in with the plan allowed", () => {
    assert.equal(configForProvider("chatgpt", undefined, {}), null);
    resetChatGptStatusForTests({ signedIn: true, planAllowed: false });
    assert.equal(configForProvider("chatgpt", undefined, {}), null);
    resetChatGptStatusForTests(READY);
    assert.deepEqual(configForProvider("chatgpt", "gpt-x", {}), {
      provider: "chatgpt",
      modelId: "gpt-x",
    });
  });

  it("is never auto-selected, only chosen", () => {
    resetChatGptStatusForTests(READY);
    assert.equal(resolveProviderConfig({}), null);
    assert.equal(
      resolveProviderConfig({ OPENAI_API_KEY: "sk-test" })?.provider,
      "openai",
      "a key-based provider still wins auto-selection",
    );
    assert.equal(
      resolveProviderConfig({ GEOLIBRE_ASSISTANT_PROVIDER: "chatgpt" })?.provider,
      "chatgpt",
    );
  });

  it("counts as a configured provider once signed in", () => {
    assert.equal(hasProviderKey({}), false);
    resetChatGptStatusForTests(READY);
    assert.equal(hasProviderKey({}), true);
    assert.deepEqual(availableProviders({}), ["chatgpt"]);
  });

  it("is not offered outside the desktop app", async () => {
    const { isChatGptSignInAvailable } =
      await import("../apps/geolibre-desktop/src/lib/assistant/chatgpt");
    assert.equal(isChatGptSignInAvailable(), false);
  });

  it("reports readiness changes", () => {
    applyChatGptStatus({
      ...READY,
      registered: true,
      remembered: true,
      signingIn: false,
    });
    assert.equal(isChatGptReady(), true);
  });
});

// ── chatGptFetch over a mocked Tauri IPC ──

type Invoke = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;

interface FakeChannel {
  id: number;
}

/**
 * Install a fake `__TAURI_INTERNALS__` whose `chatgpt_request` answers with
 * `reply` (streamed in `chunkSize`-byte chunks), recording each request.
 */
function installTauri(reply: { status: number; contentType: string; body: string }) {
  const callbacks = new Map<number, (message: unknown) => void>();
  let nextId = 1;
  const requests: { path: unknown; body: unknown }[] = [];
  const invoke: Invoke = async (cmd, args) => {
    if (cmd === "chatgpt_request_cancel") return null;
    assert.equal(cmd, "chatgpt_request");
    requests.push({ path: args.path, body: args.body });
    const channel = callbacks.get((args.events as FakeChannel).id)!;
    const bytes = Buffer.from(reply.body);
    const messages: unknown[] = [
      { event: "head", status: reply.status, contentType: reply.contentType },
    ];
    for (let i = 0; i < bytes.length; i += 7) {
      messages.push({ event: "chunk", data: bytes.subarray(i, i + 7).toString("base64") });
    }
    messages.push({ event: "end" });
    messages.forEach((message, index) => channel({ index, message }));
    return null;
  };
  (globalThis as unknown as { window: unknown }).window = {
    __TAURI_INTERNALS__: {
      transformCallback: (callback: (message: unknown) => void) => {
        const id = nextId++;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke,
    },
    dispatchEvent: () => true,
  };
  return { requests };
}

function sse(events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

describe("chatGptFetch", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    resetChatGptStatusForTests();
  });

  it("streams the backend's reply as a Response", async () => {
    installTauri({ status: 200, contentType: "application/json", body: '{"ok":"héllo"}' });
    const response = await chatGptFetch("https://api.openai.com/v1/models");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.deepEqual(await response.json(), { ok: "héllo" });
  });

  it("refuses any other endpoint before reaching the backend", async () => {
    const { requests } = installTauri({ status: 200, contentType: "", body: "" });
    await assert.rejects(chatGptFetch("https://api.openai.com/v1/files"), TypeError);
    assert.equal(requests.length, 0);
  });

  it("takes the body and signal of a Request input", async () => {
    const { requests } = installTauri({ status: 200, contentType: "", body: "" });
    const response = await chatGptFetch(
      new Request("https://api.openai.com/v1/responses", { method: "POST", body: '{"a":1}' }),
    );
    await response.text();
    assert.equal(requests[0].body, '{"a":1}');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      chatGptFetch(
        new Request("https://api.openai.com/v1/responses", {
          method: "POST",
          body: "{}",
          signal: controller.signal,
        }),
      ),
      { name: "AbortError" },
    );
    assert.equal(requests.length, 1);
  });

  it("ignores events that arrive after the reader cancels", async () => {
    installTauri({ status: 200, contentType: "text/plain", body: "x".repeat(64) });
    const response = await chatGptFetch("https://api.openai.com/v1/models");
    // The fake backend delivers every event synchronously; cancelling the
    // already-filled body must not throw on a closed stream.
    await response.body!.cancel();
  });

  it("loads the plan's model catalog", async () => {
    installTauri({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ models: [{ slug: "gpt-plan", visibility: "list" }] }),
    });
    assert.deepEqual(await discoverChatGptModels(), [{ id: "gpt-plan", name: "gpt-plan" }]);
  });

  it("runs a Strands agent turn through the Responses API, stateless", async () => {
    const { requests } = installTauri({
      status: 200,
      contentType: "text/event-stream",
      body: sse([
        {
          type: "response.created",
          response: { id: "resp_1", status: "in_progress", output: [] },
        },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { id: "msg_1", type: "message", role: "assistant", content: [] },
        },
        {
          type: "response.output_text.delta",
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          delta: "Zooming to Tokyo.",
        },
        {
          type: "response.completed",
          response: {
            id: "resp_1",
            status: "completed",
            output: [
              {
                id: "msg_1",
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Zooming to Tokyo." }],
              },
            ],
            usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
          },
        },
      ]),
    });
    resetChatGptStatusForTests(READY);
    const config = configForProvider("chatgpt", "gpt-plan", {});
    assert.ok(config);
    const model = await createModel(config);
    const { Agent } = await import("@strands-agents/sdk");
    const agent = new Agent({ model, tools: [], systemPrompt: "You are GeoLibre." });
    const result = await agent.invoke("Zoom to Tokyo");
    assert.match(String(result), /Zooming to Tokyo\./);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, "responses");
    const body = JSON.parse(String(requests[0].body));
    assert.equal(body.model, "gpt-plan");
    assert.equal(body.stream, true);
    // A plan's requests keep nothing server-side.
    assert.equal(body.store, false);
    assert.equal(body.previous_response_id, undefined);
    // The plan limits reply length itself and refuses the field.
    assert.equal(body.max_output_tokens, undefined);
    assert.equal(body.instructions, "You are GeoLibre.");
  });
});
