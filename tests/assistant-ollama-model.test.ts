import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeDesktopSettings } from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";
import {
  isInstalledOllamaModel,
  reconcileOllamaModel,
} from "../apps/geolibre-desktop/src/lib/assistant/ollama";
import {
  configForProfile,
  foldLegacyProfileModelField,
} from "../apps/geolibre-desktop/src/lib/assistant/profiles";
import {
  defaultModelFor,
  PROVIDER_MODELS,
  type AssistantProfile,
} from "../apps/geolibre-desktop/src/lib/assistant/provider";
import { PROVIDER_FIELDS } from "../apps/geolibre-desktop/src/lib/assistant/provider-fields";

// Issue #3330: an Ollama profile showed both a model selector and an
// OLLAMA_MODEL text field, and the selector's modelId always won, so a model
// typed into the field was silently ignored. The profile now has one model
// input, and a value saved in the old field is folded into modelId.

function ollamaProfile(overrides: Partial<AssistantProfile> = {}): AssistantProfile {
  return {
    id: "prof_ollama",
    name: "Local",
    provider: "ollama",
    modelId: "gemma4",
    fieldValues: { OLLAMA_BASE_URL: "http://localhost:11434" },
    ...overrides,
  };
}

describe("Ollama profile model id", () => {
  it("has no separate OLLAMA_MODEL field beside the model selector", () => {
    const envKeys: readonly string[] = PROVIDER_FIELDS.ollama.map((field) => field.envKey);
    assert.equal(envKeys.includes("OLLAMA_MODEL"), false);
  });

  it("runs the model id stored on the profile, tag included", () => {
    const config = configForProfile(ollamaProfile({ modelId: "qwen3:8b" }), {});
    assert.equal(config?.modelId, "qwen3:8b");
  });

  it("folds a saved OLLAMA_MODEL field value into modelId", () => {
    const folded = foldLegacyProfileModelField(
      ollamaProfile({
        fieldValues: { OLLAMA_BASE_URL: "http://localhost:11434", OLLAMA_MODEL: " llama3.2:3b " },
      }),
    );
    assert.equal(folded.modelId, "llama3.2:3b");
    assert.deepEqual(folded.fieldValues, { OLLAMA_BASE_URL: "http://localhost:11434" });
    assert.equal(configForProfile(folded, {})?.modelId, "llama3.2:3b");
  });

  it("keeps modelId and drops a blank legacy field", () => {
    const folded = foldLegacyProfileModelField(
      ollamaProfile({ fieldValues: { OLLAMA_MODEL: "  " } }),
    );
    assert.equal(folded.modelId, "gemma4");
    assert.deepEqual(folded.fieldValues, {});
  });

  it("leaves other providers' fields alone", () => {
    const profile: AssistantProfile = {
      id: "prof_custom",
      name: "Custom",
      provider: "custom",
      modelId: "",
      fieldValues: { OPENAI_COMPATIBLE_MODEL: "my-model" },
    };
    assert.equal(foldLegacyProfileModelField(profile), profile);
  });

  it("drops a stale OLLAMA_MODEL from a profile switched to another provider", () => {
    const profile: AssistantProfile = {
      id: "prof_switched",
      name: "Switched",
      provider: "google",
      modelId: "gemini-x",
      fieldValues: { GEMINI_API_KEY: "k", OLLAMA_MODEL: "qwen3:8b" },
    };
    const folded = foldLegacyProfileModelField(profile);
    assert.equal(folded.modelId, "gemini-x");
    assert.deepEqual(folded.fieldValues, { GEMINI_API_KEY: "k" });
  });

  it("folds the legacy field when saved settings load", () => {
    const settings = normalizeDesktopSettings({
      aiProfiles: [
        ollamaProfile({
          fieldValues: { OLLAMA_BASE_URL: "http://localhost:11434", OLLAMA_MODEL: "mistral:7b" },
        }),
      ],
    });
    const [profile] = settings.aiProfiles;
    assert.equal(profile.modelId, "mistral:7b");
    assert.equal("OLLAMA_MODEL" in profile.fieldValues, false);
  });

  it("carries a legacy aiProviderEnv OLLAMA_MODEL into the migrated profile", () => {
    const settings = normalizeDesktopSettings({
      aiProviderEnv: { OLLAMA_BASE_URL: "http://localhost:11434", OLLAMA_MODEL: "phi4:14b" },
    });
    const ollama = settings.aiProfiles.find((p) => p.provider === "ollama");
    assert.ok(ollama);
    assert.equal(ollama.modelId, "phi4:14b");
    assert.equal("OLLAMA_MODEL" in ollama.fieldValues, false);
  });

  it("does not duplicate a folded profile when legacy env is still stored", () => {
    const legacy = { OLLAMA_BASE_URL: "http://localhost:11434", OLLAMA_MODEL: "phi4:14b" };
    const settings = normalizeDesktopSettings({
      aiProfiles: [ollamaProfile({ fieldValues: { ...legacy } })],
      aiProviderEnv: legacy,
    });
    assert.equal(settings.aiProfiles.filter((p) => p.provider === "ollama").length, 1);
  });

  it("still migrates a legacy env whose model differs from the saved profile", () => {
    const settings = normalizeDesktopSettings({
      aiProfiles: [ollamaProfile({ modelId: "qwen3:8b" })],
      aiProviderEnv: { OLLAMA_BASE_URL: "http://localhost:11434", OLLAMA_MODEL: "phi4:14b" },
    });
    const models = settings.aiProfiles.filter((p) => p.provider === "ollama").map((p) => p.modelId);
    assert.deepEqual(models, ["qwen3:8b", "phi4:14b"]);
  });

  it("seeds a new profile from the OS OLLAMA_MODEL", () => {
    assert.equal(defaultModelFor("ollama", { OLLAMA_MODEL: " qwen3:8b " }), "qwen3:8b");
    assert.equal(defaultModelFor("ollama", {}), PROVIDER_MODELS.ollama[0]);
  });
});

describe("Ollama model discovery reconciliation", () => {
  const presets = PROVIDER_MODELS.ollama;

  it("treats an untagged name as its :latest tag", () => {
    assert.equal(isInstalledOllamaModel("llama3.2", ["llama3.2:latest"]), true);
    assert.equal(isInstalledOllamaModel("llama3.2:latest", ["llama3.2"]), true);
    assert.equal(isInstalledOllamaModel("llama3.2", ["llama3.2:3b"]), false);
    assert.equal(isInstalledOllamaModel("", ["llama3.2:latest"]), false);
    // A registry port is not a tag.
    const hosted = "registry.local:5000/team/model";
    assert.equal(isInstalledOllamaModel(hosted, [`${hosted}:latest`]), true);
    assert.equal(isInstalledOllamaModel(`${hosted}:q4`, [`${hosted}:latest`]), false);
  });

  it("keeps an installed model", () => {
    assert.equal(
      reconcileOllamaModel("qwen3:8b", ["gemma3:4b", "qwen3:8b"], presets, presets[0]),
      "qwen3:8b",
    );
  });

  it("swaps a preset the server lacks for an installed one", () => {
    assert.equal(reconcileOllamaModel(presets[0], ["qwen3:8b"], presets, presets[0]), "qwen3:8b");
  });

  it("keeps a blank box while the server has its fallback model", () => {
    assert.equal(reconcileOllamaModel("", ["qwen3:8b", "phi4:14b"], presets, "phi4:14b"), "");
  });

  it("fills a blank box when the server lacks its fallback model", () => {
    assert.equal(reconcileOllamaModel("", ["qwen3:8b"], presets, presets[0]), "qwen3:8b");
  });

  it("keeps a model the user typed even when discovery does not list it", () => {
    assert.equal(
      reconcileOllamaModel("my-finetune:q4", ["qwen3:8b"], presets, presets[0]),
      "my-finetune:q4",
    );
  });

  it("changes nothing when discovery found no models", () => {
    assert.equal(reconcileOllamaModel(presets[0], [], presets, presets[0]), presets[0]);
  });
});
