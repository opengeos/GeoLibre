/**
 * What this deployment and this session may do: deployment capabilities
 * (issue #1673) and the application role / privilege model (issue #1672).
 * Excluded from the project file and from undo history.
 */
import { ALL_DEPLOYMENT_CAPABILITIES, type DeploymentCapability } from "../deployment-capabilities";
import {
  createDefaultAppCapabilities,
  hasAppPrivilege,
  normalizeAppPrivileges,
  resolveRolePrivileges,
} from "../capabilities";
import type { AppCapabilities, AppPrivilege, AppRole } from "../types";
import type { SliceCreator } from "./types";

export interface CapabilitiesSlice {
  /**
   * What this *deployment* is allowed to do (issue #1673). Set once at startup
   * from the deployment configuration; never from a project file, a URL
   * parameter, or anything else the visitor controls, and never edited from the
   * UI. Defaults to the full set so an unconfigured build behaves as before.
   *
   * Excluded from the project file and from undo history: it describes the
   * server that served the app, not the document being edited.
   */
  deploymentCapabilities: ReadonlySet<DeploymentCapability>;
  /**
   * Ephemeral application capability model (issue #1672). Gating role and
   * privileges for the current session/deployment. Excluded from the project file
   * and undo history.
   */
  capabilities: AppCapabilities;

  /**
   * Narrow what this deployment may do. Intended for the startup path only —
   * calling it later would leave already-rendered surfaces stale.
   */
  setDeploymentCapabilities: (capabilities: Iterable<DeploymentCapability>) => void;
  /**
   * Assign an application role (e.g. "viewer", "editor", "publisher", "administrator", "custom"),
   * deriving the effective privileges and optional reason.
   */
  setAppRole: (
    role: AppRole,
    options?: { customPrivileges?: AppPrivilege[]; reason?: string },
  ) => void;
  /** Set explicit custom privileges and an optional reason. */
  setAppPrivileges: (privileges: AppPrivilege[], reason?: string) => void;
  /** Grant an individual application privilege. */
  grantAppPrivilege: (privilege: AppPrivilege) => void;
  /** Revoke an individual application privilege with an optional reason. */
  revokeAppPrivilege: (privilege: AppPrivilege, reason?: string) => void;
  /** Reset application capabilities back to the default unconstrained Administrator role. */
  resetAppCapabilities: () => void;
  /** Check if the current capabilities grant the requested privilege. */
  hasAppPrivilege: (privilege: AppPrivilege) => boolean;
}

export const createCapabilitiesSlice: SliceCreator<CapabilitiesSlice> = (set, get) => ({
  deploymentCapabilities: ALL_DEPLOYMENT_CAPABILITIES,
  capabilities: createDefaultAppCapabilities(),

  setDeploymentCapabilities: (capabilities) =>
    set({ deploymentCapabilities: new Set(capabilities) }),

  // A new role or privilege list is a new policy, so the per-privilege reasons
  // recorded against the old one go with it — carrying them forward would
  // explain a grant that is no longer withheld for that cause.
  setAppRole: (role, options) => {
    const privileges = resolveRolePrivileges(role, options?.customPrivileges);
    set({
      capabilities: {
        role,
        privileges,
        reason: options?.reason,
      },
    });
  },

  setAppPrivileges: (privileges, reason) => {
    set({
      capabilities: {
        role: "custom",
        privileges: normalizeAppPrivileges(privileges) ?? [],
        reason,
      },
    });
  },

  // An ad-hoc grant or revoke makes the set no longer the bundle its role
  // names, so the role becomes "custom" — the same thing setAppPrivileges
  // does for an explicit list. Leaving it as "editor" while the privileges
  // are not the editor bundle would mislead anything that branches on the
  // role rather than checking a privilege.
  grantAppPrivilege: (privilege) => {
    const current = get().capabilities;
    if (current.privileges.includes(privilege)) return;
    const { [privilege]: _granted, ...privilegeReasons } = current.privilegeReasons ?? {};
    set({
      capabilities: {
        ...current,
        role: "custom",
        privileges: [...current.privileges, privilege],
        privilegeReasons,
      },
    });
  },

  // The reason is filed against this privilege, not against the whole set:
  // revoking a second privilege for a different cause must not relabel the
  // first one's explanation. `reason` stays the fallback for the rest.
  //
  // Re-revoking an already-withheld privilege is not a no-op when it carries
  // a new reason: restating why something is denied is a real operation, and
  // an early return would silently keep the stale explanation on screen.
  revokeAppPrivilege: (privilege, reason) => {
    const current = get().capabilities;
    const held = current.privileges.includes(privilege);
    if (!held && !reason) return;
    set({
      capabilities: {
        ...current,
        role: held ? "custom" : current.role,
        privileges: held ? current.privileges.filter((p) => p !== privilege) : current.privileges,
        privilegeReasons: reason
          ? { ...current.privilegeReasons, [privilege]: reason }
          : current.privilegeReasons,
      },
    });
  },

  resetAppCapabilities: () => {
    set({ capabilities: createDefaultAppCapabilities() });
  },

  hasAppPrivilege: (privilege) => {
    return hasAppPrivilege(get().capabilities, privilege);
  },
});
