import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveProviderConfig,
  type RuntimeEnv,
} from "../apps/geolibre-desktop/src/lib/assistant/provider";

describe("resolveProviderConfig", () => {
  it("returns null when no provider key is configured", () => {
    assert.equal(resolveProviderConfig({}), null);
    assert.equal(resolveProviderConfig({ UNRELATED: "x" } as RuntimeEnv), null);
  });

  it("selects Google from GEMINI_API_KEY with its default model", () => {
    const config = resolveProviderConfig({ GEMINI_API_KEY: "g-key" });
    assert.deepEqual(config, {
      provider: "google",
      apiKey: "g-key",
      modelId: "gemini-2.5-flash",
    });
  });

  it("accepts GOOGLE_API_KEY as a Google alias", () => {
    const config = resolveProviderConfig({ GOOGLE_API_KEY: "g2" });
    assert.equal(config?.provider, "google");
    assert.equal(config?.apiKey, "g2");
  });

  it("selects Anthropic when only its key is present", () => {
    const config = resolveProviderConfig({ ANTHROPIC_API_KEY: "a-key" });
    assert.equal(config?.provider, "anthropic");
    assert.equal(config?.modelId, "claude-opus-4-8");
  });

  it("prefers Google over others when several keys exist", () => {
    const config = resolveProviderConfig({
      OPENAI_API_KEY: "o",
      ANTHROPIC_API_KEY: "a",
      GEMINI_API_KEY: "g",
    });
    assert.equal(config?.provider, "google");
  });

  it("honors an explicit provider override", () => {
    const config = resolveProviderConfig({
      GEOLIBRE_ASSISTANT_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "a",
      GEMINI_API_KEY: "g",
    });
    assert.equal(config?.provider, "anthropic");
  });

  it("returns null when the overridden provider has no key", () => {
    const config = resolveProviderConfig({
      GEOLIBRE_ASSISTANT_PROVIDER: "openai",
      GEMINI_API_KEY: "g",
    });
    assert.equal(config, null);
  });

  it("applies a model override", () => {
    const config = resolveProviderConfig({
      GEMINI_API_KEY: "g",
      GEOLIBRE_ASSISTANT_MODEL: "gemini-2.5-pro",
    });
    assert.equal(config?.modelId, "gemini-2.5-pro");
  });

  it("ignores blank key values", () => {
    assert.equal(resolveProviderConfig({ GEMINI_API_KEY: "   " }), null);
  });
});
