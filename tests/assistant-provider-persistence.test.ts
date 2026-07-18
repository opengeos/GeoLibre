import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeDesktopSettings } from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";
import { mergeRuntimeEnv } from "../apps/geolibre-desktop/src/lib/assistant/provider";

const NO_SOURCES = {
  osEnv: {},
  aiEnv: {},
  geocoderEnv: {},
  cesiumEnv: {},
  projectEnv: {},
};

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
      assert.deepEqual(normalizeDesktopSettings({ aiProviderEnv: bad }).aiProviderEnv, {});
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

// The precedence order in mergeRuntimeEnv is the part most likely to regress
// silently (swapping two spreads). Pin the guarantees the app relies on:
// OS env < device AI keys < project Environment variables, with OS aliases
// dropped when a project or device credential covers the same credential group.
describe("mergeRuntimeEnv precedence", () => {
  it("lets device AI keys override the OS environment", () => {
    const merged = mergeRuntimeEnv({
      ...NO_SOURCES,
      osEnv: { ANTHROPIC_API_KEY: "from-os" },
      aiEnv: { ANTHROPIC_API_KEY: "from-device" },
    });
    assert.equal(merged.ANTHROPIC_API_KEY, "from-device");
  });

  it("lets an explicit project Environment variable override a device AI key", () => {
    const merged = mergeRuntimeEnv({
      ...NO_SOURCES,
      osEnv: { ANTHROPIC_API_KEY: "from-os" },
      aiEnv: { ANTHROPIC_API_KEY: "from-device" },
      projectEnv: { ANTHROPIC_API_KEY: "from-project" },
    });
    assert.equal(merged.ANTHROPIC_API_KEY, "from-project");
  });

  it("falls back to the OS value when nothing else provides the key", () => {
    const merged = mergeRuntimeEnv({
      ...NO_SOURCES,
      osEnv: { OPENAI_API_KEY: "from-os" },
    });
    assert.equal(merged.OPENAI_API_KEY, "from-os");
  });

  it("drops an OS alias when a device key covers the same credential group", () => {
    // Device sets the canonical GEMINI_API_KEY; the OS-provided GOOGLE_API_KEY
    // alias must not survive to shadow it via firstValue's alias ordering.
    const merged = mergeRuntimeEnv({
      ...NO_SOURCES,
      osEnv: { GOOGLE_API_KEY: "from-os-alias" },
      aiEnv: { GEMINI_API_KEY: "from-device" },
    });
    assert.equal(merged.GEMINI_API_KEY, "from-device");
    assert.equal(merged.GOOGLE_API_KEY, undefined);
  });

  it("drops an OS alias when a project key covers the same credential group", () => {
    const merged = mergeRuntimeEnv({
      ...NO_SOURCES,
      osEnv: { GEMINI_API_KEY: "from-os" },
      projectEnv: { GOOGLE_API_KEY: "from-project-alias" },
    });
    assert.equal(merged.GOOGLE_API_KEY, "from-project-alias");
    assert.equal(merged.GEMINI_API_KEY, undefined);
  });

  it("includes derived geocoder and cesium values", () => {
    const merged = mergeRuntimeEnv({
      ...NO_SOURCES,
      geocoderEnv: { VITE_GEOCODER_PROVIDER: "nominatim" },
      cesiumEnv: { VITE_CESIUM_TOKEN: "tok" },
    });
    assert.equal(merged.VITE_GEOCODER_PROVIDER, "nominatim");
    assert.equal(merged.VITE_CESIUM_TOKEN, "tok");
  });
});
