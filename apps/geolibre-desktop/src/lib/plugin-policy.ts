import type { TFunction } from "i18next";
import type { DeploymentPolicy } from "./deployment-policy";
import { getBlocklistedPlugin } from "./plugin-blocklist";

export type PluginSource = "registry" | "manifest-url" | "zip" | "directory" | "bundled";

export type PluginPolicyDenial =
  | { kind: "sideload-disabled"; pluginId: string }
  | { kind: "blocked"; pluginId: string }
  | { kind: "blocklisted"; pluginId: string; reason: string }
  | { kind: "not-allowed"; pluginId: string };

export type PluginDenialDecision = {
  allowed: false;
  reason: string;
  denial: PluginPolicyDenial;
};
export type PluginDecision = { allowed: true } | PluginDenialDecision;

export function pluginPolicyDenialMessage(denial: PluginPolicyDenial, t: TFunction): string {
  switch (denial.kind) {
    case "sideload-disabled":
      return t("managePlugins.policySideloadDisabled");
    case "blocked":
      return t("managePlugins.policyBlocked", { pluginId: denial.pluginId });
    case "blocklisted":
      return t("managePlugins.policyBlocklisted", {
        pluginId: denial.pluginId,
        reason: denial.reason,
      });
    case "not-allowed":
      return t("managePlugins.policyNotAllowed", { pluginId: denial.pluginId });
  }
}

function denialReason(denial: PluginPolicyDenial): string {
  switch (denial.kind) {
    case "sideload-disabled":
      return "Plugin sideloading is disabled by deployment policy.";
    case "blocked":
      return `Plugin '${denial.pluginId}' is blocked by deployment policy.`;
    case "blocklisted":
      return `Plugin '${denial.pluginId}' was blocked by the plugin registry: ${denial.reason}`;
    case "not-allowed":
      return `Plugin '${denial.pluginId}' is not allowed by deployment policy.`;
  }
}

function denied(denial: PluginPolicyDenial): PluginDecision {
  return { allowed: false, denial, reason: denialReason(denial) };
}

/** Deployment policy gates external code, not built-in plugin registration. */
export function evaluatePlugin(
  id: string,
  source: PluginSource,
  policy: DeploymentPolicy | null,
): PluginDecision {
  // The registry's blocklist (plugin-blocklist.ts) applies to every external
  // source, whatever the deployment policy says; the deployment's own bundled
  // drop-ins are exempt.
  const blocklisted = id && source !== "bundled" ? getBlocklistedPlugin(id) : undefined;
  if (blocklisted) {
    return denied({ kind: "blocklisted", pluginId: id, reason: blocklisted.reason });
  }
  const plugins = policy?.plugins;
  if (!plugins) return { allowed: true };
  if (plugins.sideload === false && source !== "registry" && source !== "bundled") {
    return denied({ kind: "sideload-disabled", pluginId: id });
  }
  if (plugins.blocked?.includes(id)) {
    return denied({ kind: "blocked", pluginId: id });
  }
  if (source !== "bundled" && plugins.allowed !== undefined && !plugins.allowed.includes(id)) {
    return denied({ kind: "not-allowed", pluginId: id });
  }
  return { allowed: true };
}
