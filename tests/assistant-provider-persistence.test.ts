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

// AI provider credentials are now stored as named profiles in
// `DesktopSettings.aiProfiles` (localStorage). The legacy flat `aiProviderEnv`
// map is automatically migrated to profiles on load. These tests pin the
// round-trip, the migration, and the defensiveness against malformed data.
describe("DesktopSettings.aiProfiles persistence and migration", () => {
  it("defaults to an empty array", () => {
    assert.deepEqual(normalizeDesktopSettings(undefined).aiProfiles, []);
    assert.deepEqual(normalizeDesktopSettings({}).aiProfiles, []);
  });

  it("migrates legacy aiProviderEnv into profiles", () => {
    const stored = {
      aiProviderEnv: {
        ANTHROPIC_API_KEY: "sk-ant-123",
        OPENAI_API_KEY: "sk-openai-456",
        OLLAMA_BASE_URL: "http://localhost:11434",
      },
    };
    const result = normalizeDesktopSettings(stored);
    // Should have created three profiles (one per detected provider).
    const anthropic = result.aiProfiles.find((p) => p.provider === "anthropic");
    const openai = result.aiProfiles.find((p) => p.provider === "openai");
    const ollama = result.aiProfiles.find((p) => p.provider === "ollama");
    assert.ok(anthropic);
    assert.equal(anthropic.fieldValues.ANTHROPIC_API_KEY, "sk-ant-123");
    assert.ok(openai);
    assert.equal(openai.fieldValues.OPENAI_API_KEY, "sk-openai-456");
    assert.ok(ollama);
    assert.equal(ollama.fieldValues.OLLAMA_BASE_URL, "http://localhost:11434");
    // defaultAiProfileId should be null on initial migration.
    assert.equal(result.defaultAiProfileId, null);
  });

  it("drops non-string values, blank values, and blank keys from legacy env during migration", () => {
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
    const result = normalizeDesktopSettings(stored);
    const anthropic = result.aiProfiles.find((p) => p.provider === "anthropic");
    assert.ok(anthropic);
    assert.equal(anthropic.fieldValues.ANTHROPIC_API_KEY, "sk-ant-123");
    // OPENAI_API_KEY was a number — dropped during migration (entry filtered).
    const openai = result.aiProfiles.find((p) => p.provider === "openai");
    assert.equal(openai, undefined);
    // AWS_REGION without AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY does not
    // create a bedrock profile (not enough required fields).
    const bedrock = result.aiProfiles.find((p) => p.provider === "bedrock");
    assert.equal(bedrock, undefined);
  });

  it("tolerates a non-record legacy aiProviderEnv", () => {
    for (const bad of [null, "nope", 7, ["ANTHROPIC_API_KEY"]]) {
      assert.deepEqual(normalizeDesktopSettings({ aiProviderEnv: bad }).aiProfiles, []);
    }
  });

  it("normalizes legacy settings with no aiProviderEnv field", () => {
    const legacy = {
      shareToken: "tok",
      cesiumIonToken: "cesium",
      layout: { toolbarLabels: false },
    };
    assert.deepEqual(normalizeDesktopSettings(legacy).aiProfiles, []);
  });

  it("keeps existing profiles when legacy env is also present (dedup)", () => {
    const stored = {
      aiProfiles: [
        {
          id: "prof_existing",
          name: "My Anthropic",
          provider: "anthropic",
          modelId: "claude-opus-4-8",
          fieldValues: { ANTHROPIC_API_KEY: "sk-ant-existing" },
        },
      ],
      aiProviderEnv: {
        ANTHROPIC_API_KEY: "sk-ant-existing",
        OPENAI_API_KEY: "sk-openai-new",
      },
    };
    const result = normalizeDesktopSettings(stored);
    // The existing anthropic profile should be preserved (dedup by matching
    // field values prevents a duplicate).
    assert.equal(result.aiProfiles.length, 2);
    const anthropic = result.aiProfiles.find((p) => p.provider === "anthropic");
    assert.ok(anthropic);
    assert.equal(anthropic.fieldValues.ANTHROPIC_API_KEY, "sk-ant-existing");
    // The openai key from legacy env should create a new profile.
    const openai = result.aiProfiles.find((p) => p.provider === "openai");
    assert.ok(openai);
    assert.equal(openai.fieldValues.OPENAI_API_KEY, "sk-openai-new");
  });

  it("preserves an empty fieldValues map", () => {
    const stored = {
      aiProfiles: [
        {
          id: "prof_empty",
          name: "Empty Profile",
          provider: "google",
          modelId: "gemini-3.5-flash",
          fieldValues: {},
        },
      ],
    };
    const result = normalizeDesktopSettings(stored);
    assert.equal(result.aiProfiles.length, 1);
    assert.deepEqual(result.aiProfiles[0].fieldValues, {});
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
