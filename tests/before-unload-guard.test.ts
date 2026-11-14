import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALL_APP_PRIVILEGES,
  ALL_DEPLOYMENT_CAPABILITIES,
  type AppPrivilege,
  type DeploymentCapability,
} from "@geolibre/core";
import {
  type BeforeUnloadGuardState,
  shouldWarnBeforeUnload,
} from "../apps/geolibre-desktop/src/hooks/useBeforeUnloadGuard";

function state(overrides: Partial<BeforeUnloadGuardState> = {}): BeforeUnloadGuardState {
  return {
    isDirty: true,
    deploymentCapabilities: ALL_DEPLOYMENT_CAPABILITIES,
    privileges: ALL_APP_PRIVILEGES,
    search: "",
    ...overrides,
  };
}

const DATA_LINK =
  "?data=https://example.com/counties.geojson&data=https://example.com/quakes.parquet";

describe("shouldWarnBeforeUnload", () => {
  it("warns about unsaved changes in the authoring layout", () => {
    assert.equal(shouldWarnBeforeUnload(state()), true);
    assert.equal(shouldWarnBeforeUnload(state({ search: DATA_LINK })), true);
  });

  it("stays quiet for a clean project", () => {
    assert.equal(shouldWarnBeforeUnload(state({ isDirty: false })), false);
  });

  it("stays quiet in the read-only viewer, where saving is unavailable", () => {
    assert.equal(shouldWarnBeforeUnload(state({ search: `${DATA_LINK}&layout=viewer` })), false);
    assert.equal(shouldWarnBeforeUnload(state({ search: "?layout=Viewer" })), false);
    // Drawing in the viewer still offers no way to save the project.
    assert.equal(shouldWarnBeforeUnload(state({ search: "?layout=viewer&draw" })), false);
  });

  it("stays quiet when the toolbar, and with it every Save entry point, is hidden", () => {
    assert.equal(shouldWarnBeforeUnload(state({ search: "?toolbar=hidden" })), false);
    assert.equal(shouldWarnBeforeUnload(state({ search: "?toolbar=icons" })), true);
  });

  it("stays quiet in the map-only chrome", () => {
    assert.equal(shouldWarnBeforeUnload(state({ search: `${DATA_LINK}&maponly` })), false);
    assert.equal(shouldWarnBeforeUnload(state({ search: "?maponly=true" })), false);
    // An explicit falsy value keeps the full chrome, and the guard with it.
    assert.equal(shouldWarnBeforeUnload(state({ search: "?maponly=false" })), true);
  });

  it("stays quiet when the deployment withholds project editing", () => {
    const capabilities = new Set<DeploymentCapability>(
      [...ALL_DEPLOYMENT_CAPABILITIES].filter((capability) => capability !== "project:edit"),
    );
    assert.equal(shouldWarnBeforeUnload(state({ deploymentCapabilities: capabilities })), false);
  });

  it("stays quiet when the session role withholds saving", () => {
    const privileges: AppPrivilege[] = ALL_APP_PRIVILEGES.filter(
      (privilege) => privilege !== "project:save",
    );
    assert.equal(shouldWarnBeforeUnload(state({ privileges })), false);
  });
});
