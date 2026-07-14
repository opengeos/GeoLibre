import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeDesktopSettings } from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";

// AI provider credentials entered in Settings → AI Providers are stored in the
// device-local `DesktopSettings.aiProviderEnv` (localStorage) so they survive
// app restarts (issue #1249). normalizeDesktopSettings is the load-path guard
// that restores those keys from persisted storage, so these tests pin the
// round-trip and the defensiveness against malformed/legacy data.
describe("DesktopSettings.aiProviderEnv persistence", () => {
  it("defaults to an empty record", () => {
    assert.deepEqual(normalizeDesktopSettings(undefined).aiProviderEnv, {});
    assert.deepEqual(normalizeDesktopSettings({}).aiProviderEnv, {});
  });

  it("restores stored provider credentials verbatim", () => {
    const stored = {
      aiProviderEnv: {
        ANTHROPIC_API_KEY: "sk-ant-123",
        OPENAI_API_KEY: "sk-openai-456",
        OLLAMA_BASE_URL: "http://localhost:11434",
      },
    };
    assert.deepEqual(normalizeDesktopSettings(stored).aiProviderEnv, {
      ANTHROPIC_API_KEY: "sk-ant-123",
      OPENAI_API_KEY: "sk-openai-456",
      OLLAMA_BASE_URL: "http://localhost:11434",
    });
  });

  it("drops non-string values, blank values, and blank keys from tampered storage", () => {
    const stored = {
      aiProviderEnv: {
        ANTHROPIC_API_KEY: "sk-ant-123",
        OPENAI_API_KEY: 42,
        GEMINI_API_KEY: null,
        OLLAMA_MODEL: "",
        "   ": "orphan",
        "  AWS_REGION  ": "us-east-1",
      },
    };
    assert.deepEqual(normalizeDesktopSettings(stored).aiProviderEnv, {
      ANTHROPIC_API_KEY: "sk-ant-123",
      AWS_REGION: "us-east-1",
    });
  });

  it("tolerates a non-record aiProviderEnv", () => {
    for (const bad of [null, "nope", 7, ["ANTHROPIC_API_KEY"]]) {
      assert.deepEqual(
        normalizeDesktopSettings({ aiProviderEnv: bad }).aiProviderEnv,
        {},
      );
    }
  });

  it("normalizes legacy settings with no aiProviderEnv field", () => {
    const legacy = {
      shareToken: "tok",
      cesiumIonToken: "cesium",
      layout: { toolbarLabels: false },
    };
    assert.deepEqual(normalizeDesktopSettings(legacy).aiProviderEnv, {});
  });
});
