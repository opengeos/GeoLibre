// Whether a shortcut into the AI assistant may be shown outside the menus.
//
// A button elsewhere in the app that opens the assistant (the SQL Workspace's
// "Fix" and "Explain") is one more way to run the `proc.assistant` command, so
// it answers to the same three gates the command palette applies to that
// command: the deployment capability, the session's application privilege, and
// the interface profile. Asking the gate tables about the command id, rather
// than restating "processing:run + assistant:use + processing.assistant" here,
// is what keeps this in step when one of those tables changes.

import type { AppPrivilege, DeploymentCapability } from "@geolibre/core";
import type { UiProfileSettings } from "../hooks/useDesktopSettings";
import { filterCommandsForPalette } from "./command-profile-gates";
import type { Command } from "./commands";
import { filterCommandsByCapabilities, filterCommandsByPrivileges } from "./deployment-gates";

/** The palette command that opens the assistant (`toolbar-commands.ts`). */
export const ASSISTANT_COMMAND_ID = "proc.assistant";

const ASSISTANT_COMMAND: Command = {
  id: ASSISTANT_COMMAND_ID,
  title: "",
  group: "",
  run: () => {},
};

/** What decides whether the assistant is offered. */
export interface AssistantAvailabilityInput {
  /** What this deployment may do. */
  deploymentCapabilities: ReadonlySet<DeploymentCapability>;
  /** What the session's role may do. */
  privileges: readonly AppPrivilege[];
  /** The stored interface-profile settings. */
  uiProfile: UiProfileSettings;
  /** Whether the app runs on Android/iOS. */
  mobile: boolean;
}

/**
 * Whether the assistant is offered to this user, by the command palette's own
 * rules for the command that opens it.
 *
 * @param input The deployment capabilities, role privileges, interface
 *   profile, and platform.
 * @returns False when any gate would drop the assistant command.
 */
export function isAssistantOffered(input: AssistantAvailabilityInput): boolean {
  const allowed = filterCommandsByPrivileges(
    filterCommandsByCapabilities([ASSISTANT_COMMAND], input.deploymentCapabilities),
    input.privileges,
  );
  return filterCommandsForPalette(allowed, input.uiProfile, input.mobile).length > 0;
}
