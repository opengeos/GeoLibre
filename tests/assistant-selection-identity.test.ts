import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assistantSelectionKey } from "../apps/geolibre-desktop/src/lib/assistant/profiles";
import type { AssistantProfile } from "../apps/geolibre-desktop/src/lib/assistant/provider";

function profile(overrides: Partial<AssistantProfile> = {}): AssistantProfile {
  return {
    id: "prof_1",
    name: "Work Gemini",
    provider: "google",
    modelId: "gemini-3.5-flash",
    fieldValues: { GEMINI_API_KEY: "AIza-abc" },
    ...overrides,
  };
}

// AssistantSession keeps one Strands agent (and its whole message history)
// alive across stream calls, and rebuilds it whenever setSelection receives a
// *different* selection. AssistantPanel re-runs that call after every turn —
// `running` is one of its effect's dependencies and flips back to false when a
// reply finishes — so "different" has to be decided by value. Comparing object
// identity instead reset the agent on every turn and wiped the conversation.
describe("assistantSelectionKey", () => {
  it("treats auto-resolution as a single stable selection", () => {
    assert.equal(assistantSelectionKey(null), assistantSelectionKey(null));
  });

  it("matches an equal profile rebuilt as a new object", () => {
    // The regression: the panel re-derives activeProfile from the settings
    // store, so a turn ending can hand the session a fresh object holding the
    // same configuration. That must not count as a change.
    assert.equal(assistantSelectionKey(profile()), assistantSelectionKey(profile()));
  });

  it("ignores the credential insertion order", () => {
    const a = profile({ fieldValues: { OLLAMA_BASE_URL: "http://x", OLLAMA_MODEL: "llama3.2" } });
    const b = profile({ fieldValues: { OLLAMA_MODEL: "llama3.2", OLLAMA_BASE_URL: "http://x" } });
    assert.equal(assistantSelectionKey(a), assistantSelectionKey(b));
  });

  it("ignores a profile rename, which does not change how the agent is built", () => {
    assert.equal(
      assistantSelectionKey(profile()),
      assistantSelectionKey(profile({ name: "Renamed" })),
    );
  });

  it("changes when the model changes", () => {
    assert.notEqual(
      assistantSelectionKey(profile()),
      assistantSelectionKey(profile({ modelId: "gemini-3.5-pro" })),
    );
  });

  it("changes when a credential value changes", () => {
    assert.notEqual(
      assistantSelectionKey(profile()),
      assistantSelectionKey(profile({ fieldValues: { GEMINI_API_KEY: "AIza-rotated" } })),
    );
  });

  it("changes when a credential field is added or removed", () => {
    const withExtra = profile({
      fieldValues: { GEMINI_API_KEY: "AIza-abc", GOOGLE_API_KEY: "AIza-def" },
    });
    assert.notEqual(assistantSelectionKey(profile()), assistantSelectionKey(withExtra));
    assert.notEqual(
      assistantSelectionKey(profile({ fieldValues: {} })),
      assistantSelectionKey(profile()),
    );
  });

  it("separates two profiles that differ only by id", () => {
    // Duplicating a profile in Settings yields identical settings under a new
    // id; switching between them is still a real switch.
    assert.notEqual(
      assistantSelectionKey(profile()),
      assistantSelectionKey(profile({ id: "prof_2" })),
    );
  });

  it("separates a pinned profile from auto-resolution", () => {
    assert.notEqual(assistantSelectionKey(profile()), assistantSelectionKey(null));
  });

  it("compares legacy provider/model pins by value", () => {
    assert.equal(
      assistantSelectionKey({ provider: "anthropic", model: "claude-opus-5" }),
      assistantSelectionKey({ provider: "anthropic", model: "claude-opus-5" }),
    );
    assert.notEqual(
      assistantSelectionKey({ provider: "anthropic", model: "claude-opus-5" }),
      assistantSelectionKey({ provider: "anthropic", model: "claude-sonnet-5" }),
    );
    assert.notEqual(
      assistantSelectionKey({ provider: "anthropic" }),
      assistantSelectionKey({ provider: "openai" }),
    );
    assert.notEqual(assistantSelectionKey({ provider: "anthropic" }), assistantSelectionKey(null));
  });

  it("never confuses a legacy pin with a profile on the same provider", () => {
    assert.notEqual(
      assistantSelectionKey({ provider: "google", model: "gemini-3.5-flash" }),
      assistantSelectionKey(profile()),
    );
  });
});
