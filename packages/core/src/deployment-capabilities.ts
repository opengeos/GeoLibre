// The deployment capability model (issue #1673).
//
// A *deployment* — a hosted container, a kiosk terminal, a classroom instance,
// an embed — declares which privileged actions the build it serves is allowed
// to offer. This is deliberately coarse: it names whole capabilities ("may add
// data at all"), not individual menu items, so a locked-down deployment cannot
// be defeated by a menu item someone forgot to list.
//
// It is *not* the interface profile (`ui-profile.ts` in the desktop app), which
// hides items to reduce clutter and which the user can turn back on. A denied
// capability is a statement by whoever stood the deployment up, and the UI
// never offers a way to grant it back.
//
// The client-side gate is one half of the model: it stops the app advertising
// and invoking what the deployment forbids. The serving layer still has to
// refuse the corresponding requests, because a client-side-only kiosk mode is a
// suggestion that anyone with devtools declines.

/** A privileged action a deployment can grant or withhold. */
export type DeploymentCapability =
  /** Create, save, or otherwise author the project itself. */
  | "project:edit"
  /** Bring new data into the map from files, URLs, or services. */
  | "data:add"
  /** Run processing/analysis tools (Whitebox, SQL, vector/raster, ML). */
  | "processing:run"
  /** Get data or renderings back out (export image, standalone HTML, …). */
  | "export:data"
  /** Install, load, or manage plugins. */
  | "plugins:install"
  /** Reach the application settings. */
  | "settings:manage";

/** Every capability, in a stable order for docs and tests. */
export const DEPLOYMENT_CAPABILITIES: readonly DeploymentCapability[] = [
  "project:edit",
  "data:add",
  "processing:run",
  "export:data",
  "plugins:install",
  "settings:manage",
];

/**
 * The default grant: everything. `full` must stay the default so an existing
 * deployment that configures nothing behaves exactly as it did before.
 */
export const ALL_DEPLOYMENT_CAPABILITIES: ReadonlySet<DeploymentCapability> = new Set(
  DEPLOYMENT_CAPABILITIES,
);

/** Whether an arbitrary string names a capability we know how to enforce. */
export function isDeploymentCapability(value: string): value is DeploymentCapability {
  return (DEPLOYMENT_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * The reserved token that grants nothing, for a deployment that wants the map
 * and nothing else.
 *
 * Needed because a blank value cannot mean it: the deployment env reader treats
 * an empty string as unset (a `-e VAR=` produces one), and unset has to keep
 * meaning "full" so existing deployments are unchanged. Without a spelling for
 * "none", the most locked-down configuration would be the one you cannot write.
 */
export const NO_DEPLOYMENT_CAPABILITIES = "none";

/**
 * Parse a comma-separated capability list from deployment configuration.
 *
 * Unknown tokens are dropped rather than throwing: a newer container image may
 * be configured with a capability this build does not know about, and the safe
 * reading of an unrecognized grant is "not granted".
 *
 * Fails closed on purpose. An operator who set the variable at all meant to
 * restrict something, so a list that parses to nothing grants nothing — only an
 * absent (or blank) value falls back to the full set, which is the caller's job
 * to detect.
 *
 * @param raw - The configured value, e.g. `"data:add, export:data"`.
 * @returns The granted capabilities, with duplicates and unknown names removed.
 */
export function parseDeploymentCapabilities(raw: string): ReadonlySet<DeploymentCapability> {
  const granted = new Set<DeploymentCapability>();
  if (raw.trim().toLowerCase() === NO_DEPLOYMENT_CAPABILITIES) return granted;
  for (const token of raw.split(",")) {
    const name = token.trim();
    if (isDeploymentCapability(name)) granted.add(name);
  }
  return granted;
}
