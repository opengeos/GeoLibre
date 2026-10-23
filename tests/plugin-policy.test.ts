import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluatePlugin,
  pluginPolicyDenialMessage,
  type PluginSource,
} from "../apps/geolibre-desktop/src/lib/plugin-policy";
import type { DeploymentPolicy } from "../apps/geolibre-desktop/src/lib/deployment-policy";

const sources: PluginSource[] = ["registry", "manifest-url", "zip", "directory", "bundled"];
for (const source of sources) {
  test(`${source}: policy precedence truth table`, () => {
    const cases: [DeploymentPolicy | null, boolean, string?][] = [
      [null, true],
      [{ version: 1 }, true],
      [{ version: 1, plugins: {} }, true],
      [{ version: 1, plugins: { allowed: ["demo"] } }, true],
      [{ version: 1, plugins: { blocked: ["other"] } }, true],
      [{ version: 1, plugins: { allowed: [] } }, source === "bundled", "not-allowed"],
      [{ version: 1, plugins: { blocked: ["demo"], allowed: ["demo"] } }, false, "blocked"],
      [
        { version: 1, plugins: { sideload: false } },
        source === "registry" || source === "bundled",
        "sideload-disabled",
      ],
      [
        { version: 1, plugins: { sideload: false, blocked: ["demo"], allowed: [] } },
        false,
        source === "registry" || source === "bundled" ? "blocked" : "sideload-disabled",
      ],
    ];
    for (const [policy, allowed, denialKind] of cases) {
      const result = evaluatePlugin("demo", source, policy);
      assert.equal(result.allowed, allowed, JSON.stringify(policy));
      if (!result.allowed) {
        assert.equal(result.denial.kind, denialKind);
        assert.equal(result.denial.pluginId, "demo");
        assert.match(result.reason, /deployment policy/);
      }
    }
  });
}
test("translated denials interpolate IDs and diagnostic messages stay separate", () => {
  const denied = evaluatePlugin("custom-id", "registry", {
    version: 1,
    plugins: { allowed: [] },
  });
  assert.equal(denied.allowed, false);
  if (!denied.allowed) {
    assert.deepEqual(denied.denial, { kind: "not-allowed", pluginId: "custom-id" });
    assert.match(denied.reason, /custom-id/);
  }
  const translate = ((key: string, options?: { pluginId: string }) =>
    `${key}:${options?.pluginId ?? ""}`) as never;
  for (const [kind, key] of [
    ["sideload-disabled", "managePlugins.policySideloadDisabled:"],
    ["blocked", "managePlugins.policyBlocked:custom-id"],
    ["not-allowed", "managePlugins.policyNotAllowed:custom-id"],
  ] as const) {
    assert.equal(pluginPolicyDenialMessage({ kind, pluginId: "custom-id" }, translate), key);
  }
});
