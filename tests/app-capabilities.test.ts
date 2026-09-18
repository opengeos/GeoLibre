import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  ALL_APP_PRIVILEGES,
  ROLE_PRIVILEGES,
  appPrivilegeReason,
  createDefaultAppCapabilities,
  hasAppPrivilege,
  intersectPrivileges,
  normalizeAppPrivileges,
  projectFromStore,
  resolveRolePrivileges,
  serializeProject,
  undo,
  redo,
  useAppStore,
  type AppPrivilege,
  type AppRole,
} from "../packages/core/src/index";

describe("application capability model", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "CapabilityTest" });
    useAppStore.getState().resetAppCapabilities();
  });

  describe("privilege and role definitions", () => {
    it("defines all 14 standard application privileges", () => {
      assert.equal(ALL_APP_PRIVILEGES.length, 14);
      assert.ok(ALL_APP_PRIVILEGES.includes("layers:edit"));
      assert.ok(ALL_APP_PRIVILEGES.includes("layers:add-remote"));
      assert.ok(ALL_APP_PRIVILEGES.includes("layers:add-local"));
      assert.ok(ALL_APP_PRIVILEGES.includes("processing:run"));
      assert.ok(ALL_APP_PRIVILEGES.includes("processing:sidecar"));
      assert.ok(ALL_APP_PRIVILEGES.includes("project:save"));
      assert.ok(ALL_APP_PRIVILEGES.includes("project:share"));
      assert.ok(ALL_APP_PRIVILEGES.includes("project:share-public"));
      assert.ok(ALL_APP_PRIVILEGES.includes("plugins:install"));
      assert.ok(ALL_APP_PRIVILEGES.includes("assistant:use"));
      assert.ok(ALL_APP_PRIVILEGES.includes("connections:manage"));
      assert.ok(ALL_APP_PRIVILEGES.includes("export:data"));
      assert.ok(ALL_APP_PRIVILEGES.includes("export:image"));
      assert.ok(ALL_APP_PRIVILEGES.includes("settings:manage"));
    });

    it("viewer role only grants export privileges", () => {
      const viewerPrivileges = ROLE_PRIVILEGES.viewer;
      assert.deepEqual([...viewerPrivileges].sort(), ["export:data", "export:image"].sort());
    });

    it("editor role grants viewer privileges plus local authoring and processing", () => {
      const editorPrivileges = ROLE_PRIVILEGES.editor;
      assert.ok(editorPrivileges.includes("export:data"));
      assert.ok(editorPrivileges.includes("export:image"));
      assert.ok(editorPrivileges.includes("layers:edit"));
      assert.ok(editorPrivileges.includes("layers:add-local"));
      assert.ok(editorPrivileges.includes("layers:add-remote"));
      assert.ok(editorPrivileges.includes("processing:run"));
      assert.ok(editorPrivileges.includes("project:save"));
      // Editor does not have public share, plugin install, or sidecar
      assert.ok(!editorPrivileges.includes("project:share-public"));
      assert.ok(!editorPrivileges.includes("plugins:install"));
    });

    it("publisher role grants editor privileges plus sharing, sidecar, and assistant", () => {
      const publisherPrivileges = ROLE_PRIVILEGES.publisher;
      assert.ok(publisherPrivileges.includes("project:share"));
      assert.ok(publisherPrivileges.includes("project:share-public"));
      assert.ok(publisherPrivileges.includes("processing:sidecar"));
      assert.ok(publisherPrivileges.includes("assistant:use"));
      assert.ok(!publisherPrivileges.includes("plugins:install"));
      assert.ok(!publisherPrivileges.includes("connections:manage"));
    });

    it("administrator role grants every application privilege", () => {
      assert.deepEqual(ROLE_PRIVILEGES.administrator, ALL_APP_PRIVILEGES);
    });
  });

  describe("resolveRolePrivileges", () => {
    it("resolves predefined bundles for standard roles", () => {
      assert.deepEqual(resolveRolePrivileges("viewer"), ROLE_PRIVILEGES.viewer);
      assert.deepEqual(resolveRolePrivileges("editor"), ROLE_PRIVILEGES.editor);
      assert.deepEqual(resolveRolePrivileges("publisher"), ROLE_PRIVILEGES.publisher);
      assert.deepEqual(resolveRolePrivileges("administrator"), ALL_APP_PRIVILEGES);
    });

    it("resolves custom privileges filtering out unknown entries and duplicates", () => {
      const custom = resolveRolePrivileges("custom", [
        "export:image",
        "processing:run",
        "export:image", // duplicate
        "unknown:privilege" as AppPrivilege,
      ]);
      assert.deepEqual(custom, ["export:image", "processing:run"]);
    });

    it("returns empty array for custom role without privileges", () => {
      assert.deepEqual(resolveRolePrivileges("custom"), []);
      assert.deepEqual(resolveRolePrivileges("custom", []), []);
    });
  });

  describe("intersectPrivileges", () => {
    it("returns single set unchanged when only one set is provided", () => {
      assert.deepEqual(intersectPrivileges(["export:data", "export:image"]), [
        "export:data",
        "export:image",
      ]);
    });

    it("returns empty array when given no sets", () => {
      assert.deepEqual(intersectPrivileges(), []);
    });

    it("correctly computes intersection of multiple role privilege sets", () => {
      const deploymentPrivileges: AppPrivilege[] = [
        "export:image",
        "export:data",
        "processing:run",
      ];
      const userPrivileges: AppPrivilege[] = ["export:image", "layers:edit", "processing:run"];
      const shareLinkPrivileges: AppPrivilege[] = ["export:image", "export:data"];

      const effective = intersectPrivileges(
        deploymentPrivileges,
        userPrivileges,
        shareLinkPrivileges,
      );
      assert.deepEqual(effective, ["export:image"]);
    });

    it("returns empty array when privilege sets are disjoint", () => {
      const setA: AppPrivilege[] = ["plugins:install"];
      const setB: AppPrivilege[] = ["export:data"];
      assert.deepEqual(intersectPrivileges(setA, setB), []);
    });
  });

  describe("hasAppPrivilege", () => {
    it("returns true when privilege is present in capabilities", () => {
      const caps = { role: "viewer" as AppRole, privileges: ["export:image" as AppPrivilege] };
      assert.equal(hasAppPrivilege(caps, "export:image"), true);
      assert.equal(hasAppPrivilege(caps, "layers:edit"), false);
    });

    it("defaults to true when capabilities object is undefined", () => {
      assert.equal(hasAppPrivilege(undefined, "layers:edit"), true);
    });
  });

  describe("normalizeAppPrivileges", () => {
    it("returns undefined for non-array values", () => {
      assert.equal(normalizeAppPrivileges(null), undefined);
      assert.equal(normalizeAppPrivileges("export:data"), undefined);
      assert.equal(normalizeAppPrivileges({}), undefined);
    });

    it("filters out invalid strings and deduplicates", () => {
      const normalized = normalizeAppPrivileges(["layers:edit", "bogus", "layers:edit", 123]);
      assert.deepEqual(normalized, ["layers:edit"]);
    });

    it("returns empty array for an empty array input", () => {
      assert.deepEqual(normalizeAppPrivileges([]), []);
    });
  });

  describe("store integration", () => {
    it("initializes with default Administrator capabilities", () => {
      const state = useAppStore.getState();
      assert.equal(state.capabilities.role, "administrator");
      assert.equal(state.capabilities.privileges.length, ALL_APP_PRIVILEGES.length);
      assert.equal(state.hasAppPrivilege("plugins:install"), true);
    });

    it("setAppRole updates role, derived privileges, and reason", () => {
      useAppStore.getState().setAppRole("viewer", { reason: "Kiosk deployment" });
      const state = useAppStore.getState();
      assert.equal(state.capabilities.role, "viewer");
      assert.deepEqual(state.capabilities.privileges, ROLE_PRIVILEGES.viewer);
      assert.equal(state.capabilities.reason, "Kiosk deployment");
      assert.equal(state.hasAppPrivilege("export:data"), true);
      assert.equal(state.hasAppPrivilege("layers:edit"), false);
    });

    it("setAppPrivileges updates custom privileges and reason", () => {
      useAppStore
        .getState()
        .setAppPrivileges(["export:data", "processing:run"], "Custom classroom");
      const state = useAppStore.getState();
      assert.equal(state.capabilities.role, "custom");
      assert.deepEqual(state.capabilities.privileges, ["export:data", "processing:run"]);
      assert.equal(state.capabilities.reason, "Custom classroom");
      assert.equal(state.hasAppPrivilege("processing:run"), true);
      assert.equal(state.hasAppPrivilege("plugins:install"), false);
    });

    it("grantAppPrivilege adds a privilege without duplicates", () => {
      useAppStore.getState().setAppRole("viewer");
      assert.equal(useAppStore.getState().hasAppPrivilege("processing:run"), false);

      useAppStore.getState().grantAppPrivilege("processing:run");
      assert.equal(useAppStore.getState().hasAppPrivilege("processing:run"), true);

      // Granting again does not create duplicate entries
      const countBefore = useAppStore.getState().capabilities.privileges.length;
      useAppStore.getState().grantAppPrivilege("processing:run");
      assert.equal(useAppStore.getState().capabilities.privileges.length, countBefore);
    });

    it("revokeAppPrivilege removes a privilege and optionally sets reason", () => {
      useAppStore.getState().setAppRole("editor");
      assert.equal(useAppStore.getState().hasAppPrivilege("layers:edit"), true);

      useAppStore.getState().revokeAppPrivilege("layers:edit", "Read-only mode");
      assert.equal(useAppStore.getState().hasAppPrivilege("layers:edit"), false);
      assert.equal(
        appPrivilegeReason(useAppStore.getState().capabilities, "layers:edit"),
        "Read-only mode",
      );
    });

    it("keeps each revocation's reason to itself", () => {
      useAppStore.getState().setAppRole("editor");
      useAppStore.getState().revokeAppPrivilege("layers:edit", "Read-only mode");
      useAppStore.getState().revokeAppPrivilege("project:save", "License limit");

      const { capabilities } = useAppStore.getState();
      assert.equal(appPrivilegeReason(capabilities, "layers:edit"), "Read-only mode");
      assert.equal(appPrivilegeReason(capabilities, "project:save"), "License limit");
    });

    it("falls back to the set-wide reason for a privilege with none of its own", () => {
      useAppStore.getState().setAppRole("viewer", { reason: "Kiosk deployment" });
      const { capabilities } = useAppStore.getState();
      assert.equal(appPrivilegeReason(capabilities, "project:save"), "Kiosk deployment");

      useAppStore.getState().revokeAppPrivilege("export:data", "License limit");
      const revoked = useAppStore.getState().capabilities;
      assert.equal(appPrivilegeReason(revoked, "export:data"), "License limit");
      assert.equal(appPrivilegeReason(revoked, "project:save"), "Kiosk deployment");
    });

    it("marks the role custom once an ad-hoc grant or revoke leaves the bundle", () => {
      useAppStore.getState().setAppRole("editor");
      useAppStore.getState().revokeAppPrivilege("layers:edit", "Read-only mode");
      assert.equal(useAppStore.getState().capabilities.role, "custom");

      useAppStore.getState().setAppRole("viewer");
      useAppStore.getState().grantAppPrivilege("layers:edit");
      assert.equal(useAppStore.getState().capabilities.role, "custom");
    });

    it("re-revoking an already-withheld privilege updates its reason", () => {
      useAppStore.getState().setAppRole("editor");
      useAppStore.getState().revokeAppPrivilege("project:save", "Read-only mode");
      useAppStore.getState().revokeAppPrivilege("project:save", "License limit");

      const { capabilities } = useAppStore.getState();
      assert.equal(appPrivilegeReason(capabilities, "project:save"), "License limit");
      assert.equal(capabilities.privileges.includes("project:save"), false);
    });

    it("granting a privilege back drops the reason it was revoked with", () => {
      useAppStore.getState().setAppRole("editor");
      useAppStore.getState().revokeAppPrivilege("layers:edit", "Read-only mode");
      useAppStore.getState().grantAppPrivilege("layers:edit");

      const { capabilities } = useAppStore.getState();
      assert.equal(capabilities.privilegeReasons?.["layers:edit"], undefined);
    });

    it("setAppRole clears per-privilege reasons from the previous policy", () => {
      useAppStore.getState().setAppRole("editor");
      useAppStore.getState().revokeAppPrivilege("project:save", "License limit");
      useAppStore.getState().setAppRole("viewer", { reason: "Kiosk deployment" });

      const { capabilities } = useAppStore.getState();
      assert.equal(appPrivilegeReason(capabilities, "project:save"), "Kiosk deployment");
    });

    it("resetAppCapabilities restores default administrator role", () => {
      useAppStore.getState().setAppRole("viewer", { reason: "Restricted" });
      useAppStore.getState().resetAppCapabilities();

      const state = useAppStore.getState();
      assert.equal(state.capabilities.role, "administrator");
      assert.equal(state.capabilities.privileges.length, ALL_APP_PRIVILEGES.length);
      assert.equal(state.capabilities.reason, undefined);
    });

    it("capabilities slice is ephemeral and excluded from project serialization and undo history", () => {
      useAppStore.getState().setAppRole("viewer", { reason: "Demo mode" });
      const project = projectFromStore(useAppStore.getState());
      assert.equal(
        "capabilities" in project,
        false,
        "projectFromStore must not include capabilities",
      );
      const serialized = JSON.parse(serializeProject(project));
      assert.equal(
        "capabilities" in serialized,
        false,
        "capabilities must not be serialized into project file",
      );

      // Undo/redo must not alter capabilities state
      useAppStore.getState().setBasemapOpacity(0.5);
      useAppStore.getState().setAppRole("editor");
      undo();
      assert.equal(
        useAppStore.getState().capabilities.role,
        "editor",
        "undo must not revert ephemeral capabilities",
      );
      redo();
      assert.equal(
        useAppStore.getState().capabilities.role,
        "editor",
        "redo must not alter ephemeral capabilities",
      );
    });
  });
});
