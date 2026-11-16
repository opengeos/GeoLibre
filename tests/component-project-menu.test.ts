import { render, screen, useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import type { DeploymentCapability } from "@geolibre/core";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { ProjectMenu } =
  await import("../apps/geolibre-desktop/src/components/layout/toolbar/ProjectMenu");

const noop = () => {};

/** Render the Project menu trigger with no-op handlers. */
function renderProjectMenu() {
  return render(
    createElement(ProjectMenu, {
      chrome: {
        buttonClass: "",
        buttonSize: "sm",
        iconClassName: "",
        renderLabel: (label: string) => label,
      },
      collaborationEnabled: false,
      shareHostStatus: "default",
      onNewProject: noop,
      onOpenFromFile: noop,
      onOpenFromUrl: noop,
      onOpenGallery: noop,
      onImportQgisProject: noop,
      onImportArcgisProject: noop,
      onImportLayerStyles: noop,
      onOpenRecent: noop,
      onOpenHistory: noop,
      onSave: noop,
      onSaveAs: noop,
      onShare: noop,
      onExportHtml: noop,
      onExportLayerStyles: noop,
      onExportLayers: noop,
      onCollaborate: noop,
      onPrintLayout: noop,
      onOpenOfflineBasemap: noop,
    }),
  );
}

/** Pin the deployment's capabilities for the current test. */
function grant(...capabilities: DeploymentCapability[]) {
  useAppStore.getState().setDeploymentCapabilities(capabilities);
}

describe("ProjectMenu", () => {
  it("renders its button with the default full grant", () => {
    renderProjectMenu();
    assert.ok(screen.getByRole("button", { name: "Project" }));
  });

  // Issue #3474: `capabilities: []` used to leave a button that opened an
  // empty menu.
  it("drops its button when the deployment grants no capabilities", () => {
    grant();
    renderProjectMenu();
    assert.equal(screen.queryByRole("button", { name: "Project" }), null);
  });

  it("keeps its button when only export is granted", () => {
    grant("export:data");
    renderProjectMenu();
    assert.ok(screen.getByRole("button", { name: "Project" }));
  });

  it("keeps its button when only project authoring is granted", () => {
    grant("project:edit");
    renderProjectMenu();
    assert.ok(screen.getByRole("button", { name: "Project" }));
  });
});
