import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Command } from "../apps/geolibre-desktop/src/lib/commands";
import {
  commandAppPrivileges,
  commandCapability,
  editMenuItemCapability,
  filterCommandsByCapabilities,
  filterCommandsByPrivileges,
  projectMenuItemCapability,
} from "../apps/geolibre-desktop/src/lib/deployment-gates";
import {
  ALL_DEPLOYMENT_CAPABILITIES,
  type DeploymentCapability,
} from "../packages/core/src/deployment-capabilities";
import { ROLE_PRIVILEGES } from "../packages/core/src/capabilities";

function command(id: string): Command {
  return { id, title: id, group: "Group", run: () => {} };
}

describe("commandCapability", () => {
  it("maps each command family to the capability it needs", () => {
    assert.equal(commandCapability("add.vector"), "data:add");
    assert.equal(commandCapability("proc.whitebox"), "processing:run");
    assert.equal(commandCapability("proc.conversion.pmtiles"), "processing:run");
    assert.equal(commandCapability("project.save"), "project:edit");
    assert.equal(commandCapability("project.open-url"), "project:edit");
    assert.equal(commandCapability("settings.style-manager"), "settings:manage");
  });

  it("puts plugin activation and the marketplace under plugins:install", () => {
    assert.equal(commandCapability("plugin.reverse-geocode"), "plugins:install");
    // Despite its `settings.` id, "Manage plugins" opens the marketplace.
    assert.equal(commandCapability("settings.manage-plugins"), "plugins:install");
  });

  it("treats the print layout and Share as exports, not project authoring", () => {
    assert.equal(commandCapability("project.print-layout"), "export:data");
    assert.equal(commandCapability("project.share"), "export:data");
  });

  it("classifies a command the same way the Project menu classifies it", () => {
    // The two tables key off different ids for the same action, so they can
    // silently disagree; a mismatch hides an item in the menu while leaving it
    // live in the palette.
    for (const [commandId, menuItemId] of [
      ["project.new", "project.new"],
      ["project.save", "project.save"],
      ["project.save-as", "project.saveAs"],
      ["project.open-file", "project.openFrom"],
      ["project.open-url", "project.openFrom"],
      ["project.share", "project.share"],
      ["project.collaborate", "project.collaborate"],
      ["project.print-layout", "project.printLayout"],
    ] as const) {
      assert.equal(
        commandCapability(commandId),
        projectMenuItemCapability(menuItemId),
        `${commandId} vs ${menuItemId}`,
      );
    }
  });

  it("treats a review comment as project authoring, not adding data", () => {
    assert.equal(commandCapability("add.comment"), "project:edit");
  });

  it("leaves camera, decoration, and help commands unprivileged", () => {
    assert.equal(commandCapability("view.zoom-in"), undefined);
    assert.equal(commandCapability("control.legend"), undefined);
    assert.equal(commandCapability("help.about"), undefined);
  });
});

describe("filterCommandsByCapabilities", () => {
  const registry = [
    "project.save",
    "add.vector",
    "proc.whitebox",
    "settings.style-manager",
    "view.zoom-in",
  ].map(command);

  it("keeps every command when the deployment grants everything", () => {
    assert.deepEqual(
      filterCommandsByCapabilities(registry, ALL_DEPLOYMENT_CAPABILITIES).map((c) => c.id),
      registry.map((c) => c.id),
    );
  });

  it("drops the commands whose capability was withheld", () => {
    assert.deepEqual(
      filterCommandsByCapabilities(registry, new Set<DeploymentCapability>()).map((c) => c.id),
      ["view.zoom-in"],
    );
  });

  it("keeps a granted family while dropping a denied one", () => {
    assert.deepEqual(
      filterCommandsByCapabilities(registry, new Set<DeploymentCapability>(["data:add"])).map(
        (c) => c.id,
      ),
      ["add.vector", "view.zoom-in"],
    );
  });
});

describe("projectMenuItemCapability", () => {
  it("gates the authoring items on project:edit", () => {
    for (const id of [
      "project.new",
      "project.openFrom",
      "project.openRecent",
      "project.import",
      "project.history",
      "project.save",
      "project.saveAs",
      "project.duplicate",
      "project.saveAsTemplate",
      "project.collaborate",
      "project.storymap",
    ]) {
      assert.equal(projectMenuItemCapability(id), "project:edit", id);
    }
  });

  it("gates the items that get data back out on export:data", () => {
    for (const id of [
      "project.share",
      "project.exportHtml",
      "project.print",
      "project.printLayout",
      "project.offlineRegion",
    ]) {
      assert.equal(projectMenuItemCapability(id), "export:data", id);
    }
  });

  it("returns undefined for an id it does not gate", () => {
    assert.equal(projectMenuItemCapability("project.unknown"), undefined);
  });
});

describe("editMenuItemCapability", () => {
  it("gates the items that change the project on project:edit", () => {
    assert.equal(editMenuItemCapability("edit.undo"), "project:edit");
    assert.equal(editMenuItemCapability("edit.redo"), "project:edit");
    assert.equal(editMenuItemCapability("edit.exportSelection"), "project:edit");
  });

  it("leaves the selection tools unprivileged", () => {
    // Selection lives in ephemeral store state, never in the project file.
    for (const id of [
      "edit.selectByExpression",
      "edit.selectByLocation",
      "edit.zoomToSelection",
      "edit.invertSelection",
      "edit.clearSelection",
    ]) {
      assert.equal(editMenuItemCapability(id), undefined, id);
    }
  });
});

describe("commandAppPrivileges", () => {
  it("maps each command family to the privileges it needs", () => {
    assert.deepEqual(commandAppPrivileges("proc.whitebox"), {
      privileges: ["processing:run"],
      mode: "any",
    });
    assert.deepEqual(commandAppPrivileges("proc.assistant"), {
      privileges: ["assistant:use"],
      mode: "any",
    });
    assert.deepEqual(commandAppPrivileges("project.save"), {
      privileges: ["project:save"],
      mode: "any",
    });
    assert.deepEqual(commandAppPrivileges("project.save-as"), {
      privileges: ["project:save"],
      mode: "any",
    });
    assert.deepEqual(commandAppPrivileges("project.share"), {
      privileges: ["project:share"],
      mode: "any",
    });
    assert.deepEqual(commandAppPrivileges("project.print-layout"), {
      privileges: ["export:image"],
      mode: "any",
    });
    assert.deepEqual(commandAppPrivileges("settings.style-manager"), {
      privileges: ["settings:manage"],
      mode: "any",
    });
    assert.deepEqual(commandAppPrivileges("plugin.reverse-geocode"), {
      privileges: ["plugins:install"],
      mode: "any",
    });
    assert.deepEqual(commandAppPrivileges("settings.manage-plugins"), {
      privileges: ["plugins:install"],
      mode: "any",
    });
  });

  it("requires both privileges for every sidecar-backed family", () => {
    // A sidecar tool is a processing tool first, which is how ProcessingMenu
    // gates the same three. `proc.conversion.*` and `proc.raster.*` must not
    // fall through to the generic `proc.` entry.
    const sidecar = { privileges: ["processing:run", "processing:sidecar"], mode: "all" };
    assert.deepEqual(commandAppPrivileges("proc.segmentation"), sidecar);
    assert.deepEqual(commandAppPrivileges("proc.conversion.vector-to-pmtiles"), sidecar);
    assert.deepEqual(commandAppPrivileges("proc.raster.hillshade"), sidecar);
    // Turf runs client-side, so the vector tools need only processing:run.
    assert.deepEqual(commandAppPrivileges("proc.vector.buffer"), {
      privileges: ["processing:run"],
      mode: "any",
    });
    // Both run client-side via onnxruntime-web, not the sidecar.
    assert.deepEqual(commandAppPrivileges("proc.segmentEverything"), {
      privileges: ["processing:run"],
      mode: "any",
    });
    assert.deepEqual(commandAppPrivileges("proc.objectDetection"), {
      privileges: ["processing:run"],
      mode: "any",
    });
  });

  it("admits an Add Data command on either add privilege", () => {
    assert.deepEqual(commandAppPrivileges("add.vector"), {
      privileges: ["layers:add-local", "layers:add-remote"],
      mode: "any",
    });
    // A review comment annotates the project rather than bringing data in.
    assert.deepEqual(commandAppPrivileges("add.comment"), {
      privileges: ["layers:edit"],
      mode: "any",
    });
  });

  it("classifies the catalog browsers as remote data, matching the Processing menu", () => {
    assert.deepEqual(commandAppPrivileges("proc.planetary-computer"), {
      privileges: ["layers:add-remote"],
      mode: "any",
    });
    assert.deepEqual(commandAppPrivileges("proc.earth-engine"), {
      privileges: ["layers:add-remote"],
      mode: "any",
    });
  });

  it("treats collaboration as sharing, matching the Project menu", () => {
    assert.deepEqual(commandAppPrivileges("project.collaborate"), {
      privileges: ["project:share"],
      mode: "any",
    });
  });

  it("leaves navigation, help, and opening a project unprivileged", () => {
    assert.equal(commandAppPrivileges("view.zoom-in"), undefined);
    assert.equal(commandAppPrivileges("control.measure"), undefined);
    assert.equal(commandAppPrivileges("help.about"), undefined);
    assert.equal(commandAppPrivileges("project.open-url"), undefined);
  });
});

describe("filterCommandsByPrivileges", () => {
  const registry = [
    "project.save",
    "project.share",
    "add.vector",
    "proc.whitebox",
    "proc.assistant",
    "settings.style-manager",
    "view.zoom-in",
  ].map(command);

  it("keeps every command for the administrator role", () => {
    assert.deepEqual(
      filterCommandsByPrivileges(registry, ROLE_PRIVILEGES.administrator).map((c) => c.id),
      registry.map((c) => c.id),
    );
  });

  it("leaves a viewer only the unprivileged commands", () => {
    // The palette, cheat sheet, and shortcut layer call run() directly, so a
    // viewer must not reach Ctrl+S or the Whitebox toolbox through them.
    assert.deepEqual(
      filterCommandsByPrivileges(registry, ROLE_PRIVILEGES.viewer).map((c) => c.id),
      ["view.zoom-in"],
    );
  });

  it("gives an editor authoring and processing but not sharing or the assistant", () => {
    const ids = filterCommandsByPrivileges(registry, ROLE_PRIVILEGES.editor).map((c) => c.id);
    assert.deepEqual(ids, ["project.save", "add.vector", "proc.whitebox", "view.zoom-in"]);
  });

  it("drops everything privileged when the role grants nothing", () => {
    assert.deepEqual(
      filterCommandsByPrivileges(registry, []).map((c) => c.id),
      ["view.zoom-in"],
    );
  });

  it("withholds sidecar tools from a role missing either half", () => {
    const sidecarRegistry = [
      "proc.segmentation",
      "proc.conversion.vector-to-pmtiles",
      "proc.raster.hillshade",
      "proc.vector.buffer",
    ].map(command);

    // The editor bundle runs tools but has no sidecar, which is exactly the case
    // the Processing menu greys out — the palette must not offer a way around it.
    assert.deepEqual(
      filterCommandsByPrivileges(sidecarRegistry, ROLE_PRIVILEGES.editor).map((c) => c.id),
      ["proc.vector.buffer"],
    );
    // The mirror image: a sidecar grant alone is not permission to run tools.
    assert.deepEqual(filterCommandsByPrivileges(sidecarRegistry, ["processing:sidecar"]), []);
    // The publisher bundle holds both halves.
    assert.deepEqual(
      filterCommandsByPrivileges(sidecarRegistry, ROLE_PRIVILEGES.publisher).map((c) => c.id),
      sidecarRegistry.map((c) => c.id),
    );
  });
});
