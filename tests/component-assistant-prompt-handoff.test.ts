import { act, fireEvent, render, screen } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createElement } from "react";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { AssistantPanel } =
  await import("../apps/geolibre-desktop/src/components/panels/AssistantPanel");
const { ASSISTANT_PROMPT_EVENT, consumePendingAssistantPrompt, requestAssistantPrompt } =
  await import("../apps/geolibre-desktop/src/lib/assistant-prompt-request");

type RuntimeEnvWindow = { __GEOLIBRE_RUNTIME_ENV__?: Record<string, string> };

/**
 * Configure a provider so the panel shows its composer rather than the setup
 * card. A local Ollama host needs no key, and nothing here sends a prompt.
 */
function configureProvider() {
  (window as unknown as RuntimeEnvWindow).__GEOLIBRE_RUNTIME_ENV__ = {
    OLLAMA_HOST: "127.0.0.1:11434",
  };
}

const renderPanel = () =>
  render(createElement(AssistantPanel, { mapControllerRef: { current: null } }));
const composer = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const text = () => document.body.textContent ?? "";

afterEach(() => {
  delete (window as unknown as RuntimeEnvWindow).__GEOLIBRE_RUNTIME_ENV__;
  consumePendingAssistantPrompt();
});

describe("assistant prompt hand-off", () => {
  it("parks one prompt, announces it, and gives it out once", () => {
    let announced = 0;
    const onRequest = () => (announced += 1);
    window.addEventListener(ASSISTANT_PROMPT_EVENT, onRequest);
    try {
      assert.equal(consumePendingAssistantPrompt(), null);
      requestAssistantPrompt("first");
      requestAssistantPrompt("second");
      assert.equal(announced, 2);
      assert.equal(consumePendingAssistantPrompt(), "second");
      assert.equal(consumePendingAssistantPrompt(), null);
    } finally {
      window.removeEventListener(ASSISTANT_PROMPT_EVENT, onRequest);
    }
  });

  it("drafts a prompt parked before the panel opened, without sending it", () => {
    configureProvider();
    requestAssistantPrompt("Explain this query.\n\nSELECT 1");
    renderPanel();
    assert.equal(composer().value, "Explain this query.\n\nSELECT 1");
    assert.equal(document.activeElement === composer(), true);
    // Still a draft: nothing in the transcript, and Send is waiting.
    assert.equal(screen.queryByRole("button", { name: "Stop" }), null);
    assert.equal(
      (screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled,
      false,
    );
    assert.equal(text().split("Explain this query.").length - 1, 1);
    assert.equal(consumePendingAssistantPrompt(), null);
  });

  it("drafts a prompt requested while open, keeping the replaced draft in history", () => {
    configureProvider();
    renderPanel();
    fireEvent.change(composer(), { target: { value: "half a thought" } });
    act(() => requestAssistantPrompt("Fix this query."));
    assert.equal(composer().value, "Fix this query.");
    assert.equal(document.activeElement === composer(), true);
    // Arrow Up at the start of the composer recalls the draft it replaced.
    composer().setSelectionRange(0, 0);
    fireEvent.keyDown(composer(), { key: "ArrowUp" });
    assert.equal(composer().value, "half a thought");
    fireEvent.keyDown(composer(), { key: "ArrowDown" });
    assert.equal(composer().value, "Fix this query.");
  });

  it("parks the typed draft and an edited recalled entry while Arrow Up is active", () => {
    configureProvider();
    renderPanel();
    fireEvent.change(composer(), { target: { value: "half a thought" } });
    act(() => requestAssistantPrompt("Fix this query."));
    // Recall "half a thought", then edit the recalled entry.
    composer().setSelectionRange(0, 0);
    fireEvent.keyDown(composer(), { key: "ArrowUp" });
    assert.equal(composer().value, "half a thought");
    fireEvent.change(composer(), { target: { value: "half a thought, edited" } });
    act(() => requestAssistantPrompt("Explain this query."));
    assert.equal(composer().value, "Explain this query.");
    composer().setSelectionRange(0, 0);
    fireEvent.keyDown(composer(), { key: "ArrowUp" });
    assert.equal(composer().value, "half a thought, edited");
    composer().setSelectionRange(0, 0);
    fireEvent.keyDown(composer(), { key: "ArrowUp" });
    assert.equal(composer().value, "Fix this query.");
  });

  it("does not jump the composer to the top on typing after a repeat request", () => {
    configureProvider();
    renderPanel();
    act(() => requestAssistantPrompt("Explain this query."));
    act(() => requestAssistantPrompt("Explain this query."));
    composer().scrollTop = 40;
    fireEvent.change(composer(), { target: { value: "Explain this query. More" } });
    assert.equal(composer().scrollTop, 40);
  });

  it("holds the draft behind the setup card until a provider is configured", async () => {
    requestAssistantPrompt("Fix this query.");
    renderPanel();
    await screen.findByText("Set up the AI assistant");
    assert.equal(screen.queryByRole("textbox"), null);
    configureProvider();
    act(() => {
      window.dispatchEvent(new CustomEvent("geolibre:runtime-env-change"));
    });
    assert.equal(composer().value, "Fix this query.");
  });
});
