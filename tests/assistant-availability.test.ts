import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ASSISTANT_COMMAND_ID,
  isAssistantOffered,
  type AssistantAvailabilityInput,
} from "../apps/geolibre-desktop/src/lib/assistant-availability";
import { commandMenuItem } from "../apps/geolibre-desktop/src/lib/command-profile-gates";
import {
  commandAppPrivileges,
  commandCapability,
} from "../apps/geolibre-desktop/src/lib/deployment-gates";
import {
  DEFAULT_UI_PROFILE_SETTINGS,
  type UiProfileSettings,
} from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";
import { ALL_APP_PRIVILEGES } from "../packages/core/src/capabilities";
import {
  ALL_DEPLOYMENT_CAPABILITIES,
  type DeploymentCapability,
} from "../packages/core/src/deployment-capabilities";

const OPEN: AssistantAvailabilityInput = {
  deploymentCapabilities: ALL_DEPLOYMENT_CAPABILITIES,
  privileges: ALL_APP_PRIVILEGES,
  uiProfile: DEFAULT_UI_PROFILE_SETTINGS,
  mobile: false,
};

const profile = (patch: Partial<UiProfileSettings>): UiProfileSettings => ({
  ...DEFAULT_UI_PROFILE_SETTINGS,
  enabled: true,
  ...patch,
});

describe("isAssistantOffered", () => {
  it("offers the assistant in an unrestricted deployment, on desktop and mobile", () => {
    assert.equal(isAssistantOffered(OPEN), true);
    assert.equal(isAssistantOffered({ ...OPEN, mobile: true }), true);
  });

  it("follows the deployment capability the assistant command needs", () => {
    const required = commandCapability(ASSISTANT_COMMAND_ID);
    assert.ok(required, "the assistant command is capability-gated");
    const without = new Set<DeploymentCapability>(ALL_DEPLOYMENT_CAPABILITIES);
    without.delete(required);
    assert.equal(isAssistantOffered({ ...OPEN, deploymentCapabilities: without }), false);
  });

  it("follows the application privilege the assistant command needs", () => {
    const rule = commandAppPrivileges(ASSISTANT_COMMAND_ID);
    assert.deepEqual(rule?.privileges, ["assistant:use"]);
    assert.equal(
      isAssistantOffered({
        ...OPEN,
        privileges: ALL_APP_PRIVILEGES.filter((privilege) => privilege !== "assistant:use"),
      }),
      false,
    );
    assert.equal(isAssistantOffered({ ...OPEN, privileges: [] }), false);
  });

  it("follows the interface profile: the Processing menu and the assistant item", () => {
    const item = commandMenuItem(ASSISTANT_COMMAND_ID);
    assert.equal(item, "processing.assistant");
    assert.equal(isAssistantOffered({ ...OPEN, uiProfile: profile({}) }), true);
    assert.equal(
      isAssistantOffered({ ...OPEN, uiProfile: profile({ hiddenMenuItems: [item] }) }),
      false,
    );
    assert.equal(
      isAssistantOffered({ ...OPEN, uiProfile: profile({ hiddenMenus: ["processing"] }) }),
      false,
    );
    // Hidden lists are inert while the profile is switched off.
    assert.equal(
      isAssistantOffered({
        ...OPEN,
        uiProfile: profile({ enabled: false, hiddenMenuItems: [item] }),
      }),
      true,
    );
  });
});
