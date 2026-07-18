import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  OS_ENV_VAR_NAMES,
  availableProviders,
  configForProvider,
  scopeOsEnvToProject,
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
      assert.ok(fieldNames.has(name) || extras.has(name), `unrecognized OS env name: ${name}`);
    }
  });

  it("includes every strong-intent hosted AI key and override", () => {
    // The full expected set — keep this exhaustive so removing any allowlisted
    // name (not just the common ones) fails here, not only via the Rust sync test.
    for (const name of [
      "GEOLIBRE_ASSISTANT_PROVIDER",
      "GEOLIBRE_ASSISTANT_MODEL",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_GENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "OLLAMA_BASE_URL",
      "OLLAMA_MODEL",
      "OPENAI_COMPATIBLE_BASE_URL",
      "OPENAI_COMPATIBLE_API_KEY",
      "OPENAI_COMPATIBLE_MODEL",
      "TAVILY_API_KEY",
    ]) {
      assert.ok(allowlist.has(name), `missing expected name: ${name}`);
    }
  });

  it("stays in sync with the Rust ALLOWED_ENV_VARS allowlist", () => {
    // read_env_vars enforces its own copy of the allowlist server-side, so the
    // two lists must match exactly — otherwise a name added to one but not the
    // other is silently dropped (TS-only) or never requested (Rust-only). Guard
    // it here since a frontend node test can't otherwise reach lib.rs.
    const libRs = readFileSync(
      fileURLToPath(new URL("../apps/geolibre-desktop/src-tauri/src/lib.rs", import.meta.url)),
      "utf8",
    );
    const block = libRs.match(/const ALLOWED_ENV_VARS: &\[&str\] = &\[([\s\S]*?)\];/);
    assert.ok(block, "ALLOWED_ENV_VARS not found in lib.rs");
    const rustNames = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(
      [...rustNames].sort(),
      [...OS_ENV_VAR_NAMES].sort(),
      "Rust ALLOWED_ENV_VARS and OS_ENV_VAR_NAMES have drifted",
    );
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
    assert.equal(configForProvider("openai", undefined, merged)?.apiKey, "os-key");
  });

  it("lets a project key override the OS key on the same name", () => {
    const osEnv = { OPENAI_API_KEY: "os-key" };
    const projectEnv = { OPENAI_API_KEY: "project-key" };
    const merged = { ...osEnv, ...projectEnv };
    assert.equal(configForProvider("openai", undefined, merged)?.apiKey, "project-key");
  });
});

describe("scopeOsEnvToProject", () => {
  const merge = (osEnv: Record<string, string>, projectEnv: Record<string, string>) => ({
    ...scopeOsEnvToProject(osEnv, new Set(Object.keys(projectEnv))),
    ...projectEnv,
  });

  it("keeps OS values the project does not define", () => {
    assert.deepEqual(scopeOsEnvToProject({ OPENAI_API_KEY: "os" }, new Set()), {
      OPENAI_API_KEY: "os",
    });
  });

  it("drops an OS value the project overrides under a different alias", () => {
    // OS has GEMINI_API_KEY; the project overrides via the GOOGLE_API_KEY alias.
    // Without alias-group scoping, provider.ts's firstValue would still pick the
    // OS GEMINI_API_KEY (checked first), defeating "project always wins".
    const merged = merge({ GEMINI_API_KEY: "os-key" }, { GOOGLE_API_KEY: "project-key" });
    assert.equal(configForProvider("google", undefined, merged)?.apiKey, "project-key");
    assert.ok(!("GEMINI_API_KEY" in merged));
  });

  it("does not shadow across unrelated credentials", () => {
    const scoped = scopeOsEnvToProject({ GEMINI_API_KEY: "os-gem" }, new Set(["OPENAI_API_KEY"]));
    assert.deepEqual(scoped, { GEMINI_API_KEY: "os-gem" });
  });

  it("shadows the Ollama alias pair (OLLAMA_BASE_URL / OLLAMA_HOST)", () => {
    // OS supplies OLLAMA_BASE_URL; the project overrides via the OLLAMA_HOST
    // alias. The OS value must be dropped so the project's host wins.
    const merged = merge(
      { OLLAMA_BASE_URL: "http://os-host:11434" },
      { OLLAMA_HOST: "localhost:11434" },
    );
    assert.equal(
      configForProvider("ollama", undefined, merged)?.baseURL,
      "http://localhost:11434/v1",
    );
    assert.ok(!("OLLAMA_BASE_URL" in merged));
  });

  it("shadows the OS alias group even when the project row is empty", () => {
    // An enabled-but-empty project GOOGLE_API_KEY row must drop the OS
    // GEMINI_API_KEY (same alias group), so the dialog's effectiveEnv agrees
    // with the runtime: the provider is NOT configured. Presence, not value,
    // decides shadowing.
    const merged = merge({ GEMINI_API_KEY: "os-key" }, { GOOGLE_API_KEY: "" });
    assert.equal(configForProvider("google", undefined, merged), null);
  });
});
