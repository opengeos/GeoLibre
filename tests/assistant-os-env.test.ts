import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ASSISTANT_ENV_VAR_NAMES,
  availableProviders,
  configForProvider,
} from "../apps/geolibre-desktop/src/lib/assistant/provider";
import { PROVIDER_FIELDS } from "../apps/geolibre-desktop/src/lib/assistant/provider-fields";

describe("ASSISTANT_ENV_VAR_NAMES", () => {
  const allowlist = new Set(ASSISTANT_ENV_VAR_NAMES);

  it("has no duplicate entries", () => {
    assert.equal(allowlist.size, ASSISTANT_ENV_VAR_NAMES.length);
  });

  it("covers every env var name backing an AI provider field", () => {
    // The OS-env read requests exactly this allowlist, so any field env key or
    // alias missing here would silently never be sourced from the environment.
    for (const fields of Object.values(PROVIDER_FIELDS)) {
      for (const field of fields) {
        assert.ok(
          allowlist.has(field.envKey),
          `missing field env key: ${field.envKey}`,
        );
        for (const alias of field.aliases ?? []) {
          assert.ok(allowlist.has(alias), `missing field alias: ${alias}`);
        }
      }
    }
  });

  it("covers the provider/model overrides and the web-search key", () => {
    for (const name of [
      "GEOLIBRE_ASSISTANT_PROVIDER",
      "GEOLIBRE_ASSISTANT_MODEL",
      "OLLAMA_HOST",
      "AWS_DEFAULT_REGION",
      "BEDROCK_MODEL",
      "TAVILY_API_KEY",
    ]) {
      assert.ok(allowlist.has(name), `missing override name: ${name}`);
    }
  });
});

describe("OS env feeds provider resolution", () => {
  // The runtime env merges the OS-provided keys under the project's own env
  // vars; these assertions pin the precedence the merge in
  // useRuntimeEnvironmentVariables relies on.
  it("configures a provider from an OS-sourced key alone", () => {
    const osEnv = { OPENAI_API_KEY: "os-key" };
    const merged = { ...osEnv };
    assert.deepEqual(availableProviders(merged), ["openai"]);
    assert.equal(
      configForProvider("openai", undefined, merged)?.apiKey,
      "os-key",
    );
  });

  it("lets a project key override the OS key on the same name", () => {
    const osEnv = { OPENAI_API_KEY: "os-key" };
    const projectEnv = { OPENAI_API_KEY: "project-key" };
    const merged = { ...osEnv, ...projectEnv };
    assert.equal(
      configForProvider("openai", undefined, merged)?.apiKey,
      "project-key",
    );
  });
});
