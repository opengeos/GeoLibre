import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ASSISTANT_PROVIDER_IDS,
  availableProviders,
  type AssistantProviderId,
  type RuntimeEnv,
} from "../apps/geolibre-desktop/src/lib/assistant/provider";
import {
  PROVIDER_DOCS_URL,
  PROVIDER_FIELDS,
} from "../apps/geolibre-desktop/src/lib/assistant/provider-fields";

// Build a runtime env that fills exactly the chosen fields of a provider. A
// URL-shaped value satisfies every field the resolver inspects (API keys,
// models, regions, and the base-URL fields it actually parses), so use one
// dummy value rather than guessing which keys must look like URLs.
function envFrom(provider: AssistantProviderId, envKeys: readonly string[]): RuntimeEnv {
  const env: Record<string, string> = {};
  for (const field of PROVIDER_FIELDS[provider]) {
    if (!envKeys.includes(field.envKey)) continue;
    env[field.envKey] = "https://example.com/v1";
  }
  return env;
}

describe("PROVIDER_FIELDS", () => {
  it("defines at least one field for every provider", () => {
    for (const provider of ASSISTANT_PROVIDER_IDS) {
      assert.ok(PROVIDER_FIELDS[provider].length > 0, `${provider} has no fields`);
    }
  });

  it("uses non-empty, unique env keys within each provider", () => {
    for (const provider of ASSISTANT_PROVIDER_IDS) {
      const keys = PROVIDER_FIELDS[provider].map((field) => field.envKey);
      for (const key of keys) {
        assert.ok(key.trim().length > 0, `${provider} has a blank env key`);
      }
      assert.equal(new Set(keys).size, keys.length, `${provider} repeats an env key`);
    }
  });

  it("populates label and placeholder i18n keys for every field", () => {
    for (const provider of ASSISTANT_PROVIDER_IDS) {
      for (const field of PROVIDER_FIELDS[provider]) {
        assert.ok(
          field.labelKey.startsWith("settings.ai.field."),
          `${field.envKey} has an unexpected labelKey`,
        );
        assert.ok(
          field.placeholderKey.startsWith("settings.ai.placeholder."),
          `${field.envKey} has an unexpected placeholderKey`,
        );
      }
    }
  });

  it("marks a provider configured once all its required fields are filled", () => {
    for (const provider of ASSISTANT_PROVIDER_IDS) {
      const required = PROVIDER_FIELDS[provider]
        .filter((field) => field.required)
        .map((field) => field.envKey);
      const env = envFrom(provider, required);
      assert.ok(
        availableProviders(env).includes(provider),
        `${provider} not configured after filling required fields`,
      );
    }
  });

  it("leaves a provider unconfigured when any required field is missing", () => {
    for (const provider of ASSISTANT_PROVIDER_IDS) {
      const required = PROVIDER_FIELDS[provider]
        .filter((field) => field.required)
        .map((field) => field.envKey);
      // Drop one required field at a time; the provider must not resolve.
      for (const omitted of required) {
        const env = envFrom(
          provider,
          required.filter((key) => key !== omitted),
        );
        assert.ok(
          !availableProviders(env).includes(provider),
          `${provider} resolved without required field ${omitted}`,
        );
      }
    }
  });

  it("declares only aliases the resolver actually accepts", () => {
    for (const provider of ASSISTANT_PROVIDER_IDS) {
      for (const field of PROVIDER_FIELDS[provider]) {
        const required = PROVIDER_FIELDS[provider].filter((f) => f.required).map((f) => f.envKey);
        for (const alias of field.aliases ?? []) {
          // Fill the required fields but swap this field's canonical key for the
          // alias; the provider must still resolve, proving the alias is a real
          // synonym in provider.ts rather than dead config.
          const env: Record<string, string> = {};
          for (const key of required) {
            env[key === field.envKey ? alias : key] = "https://example.com/v1";
          }
          assert.ok(
            availableProviders(env).includes(provider),
            `${provider} did not accept alias ${alias}`,
          );
        }
      }
    }
  });

  it("only links docs URLs over https", () => {
    for (const url of Object.values(PROVIDER_DOCS_URL)) {
      assert.match(url, /^https:\/\//);
    }
  });
});
