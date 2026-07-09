import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OS_ENV_VAR_NAMES,
  availableProviders,
  configForProvider,
} from "../apps/geolibre-desktop/src/lib/assistant/provider";
import { PROVIDER_FIELDS } from "../apps/geolibre-desktop/src/lib/assistant/provider-fields";

describe("OS_ENV_VAR_NAMES", () => {
  const allowlist = new Set(OS_ENV_VAR_NAMES);

  // Every env var name any provider field reads or accepts as an alias.
  const fieldNames = new Set<string>();
  for (const fields of Object.values(PROVIDER_FIELDS)) {
    for (const field of fields) {
      fieldNames.add(field.envKey);
      for (const alias of field.aliases ?? []) fieldNames.add(alias);
    }
  }

  it("has no duplicate entries", () => {
    assert.equal(allowlist.size, OS_ENV_VAR_NAMES.length);
  });

  it("only lists recognized assistant env var names", () => {
    // A name is legitimate if it backs a provider field or is one of the
    // non-field extras the assistant reads (overrides + the web-search key).
    const extras = new Set([
      "GEOLIBRE_ASSISTANT_PROVIDER",
      "GEOLIBRE_ASSISTANT_MODEL",
      "TAVILY_API_KEY",
    ]);
    for (const name of allowlist) {
      assert.ok(
        fieldNames.has(name) || extras.has(name),
        `unrecognized OS env name: ${name}`,
      );
    }
  });

  it("includes the strong-intent hosted AI keys and overrides", () => {
    for (const name of [
      "GEOLIBRE_ASSISTANT_PROVIDER",
      "GEOLIBRE_ASSISTANT_MODEL",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "OPENAI_COMPATIBLE_API_KEY",
      "OLLAMA_BASE_URL",
      "TAVILY_API_KEY",
    ]) {
      assert.ok(allowlist.has(name), `missing expected name: ${name}`);
    }
  });

  it("excludes ambient credentials commonly set for unrelated work", () => {
    // AWS_* would silently auto-activate (and bill) Bedrock; OLLAMA_HOST is the
    // ambient Ollama variable. These must never be sourced from the OS env — the
    // Rust ALLOWED_ENV_VARS allowlist mirrors this exclusion.
    for (const name of [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_REGION",
      "AWS_DEFAULT_REGION",
      "BEDROCK_MODEL",
      "OLLAMA_HOST",
    ]) {
      assert.ok(!allowlist.has(name), `should be excluded: ${name}`);
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
