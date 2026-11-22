import { act, cleanup, render, resetStores, screen, useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createElement } from "react";
import { createEmptyProject } from "@geolibre/core";
import type { ArcgisImportReport } from "../apps/geolibre-desktop/src/hooks/useArcgisImportReport";
import type { ArcgisWorkspaceRepairSession } from "../apps/geolibre-desktop/src/lib/arcgis-workspace-repair";
import { geojsonLayer } from "./helpers/layer-fixtures";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { useArcgisImportReport } =
  await import("../apps/geolibre-desktop/src/hooks/useArcgisImportReport");
const { ArcgisImportReportDialog } =
  await import("../apps/geolibre-desktop/src/components/layout/toolbar/ArcgisImportReportDialog");

/** Render the hook and hand back its latest state. */
function renderReport(): () => ArcgisImportReport {
  let report: ArcgisImportReport | null = null;
  function Harness() {
    report = useArcgisImportReport(() => {});
    return null;
  }
  render(createElement(Harness));
  return () => {
    assert.ok(report, "hook rendered");
    return report;
  };
}

/** An import report for the open project with one layer waiting for C:\Old. */
function showReport(report: () => ArcgisImportReport): ArcgisWorkspaceRepairSession {
  const layer = geojsonLayer({ id: "roads", name: "Roads", geojson: undefined });
  const session: ArcgisWorkspaceRepairSession = {
    projectPath: "/projects/city.mapx",
    order: ["roads"],
    storeIds: new Map(),
    pending: new Map([["roads", { layer, source: { workspace: "C:\\Old", file: "roads.shp" } }]]),
    projectLoadCount: useAppStore.getState().projectLoadCount,
  };
  act(() =>
    report().show([{ layerName: "Roads", reason: "data-not-found", layerId: "roads" }], session),
  );
  assert.equal(report().repairGroups.length, 1);
  return session;
}

/**
 * Stand in for the desktop app: the folder picker waits until the test
 * answers it, and every other command is recorded.
 */
function stubDesktop() {
  const commands: string[] = [];
  let answer: (folder: string | null) => void = () => {};
  let list: (entries: unknown[]) => void = () => {};
  const globals = window as Window & { __TAURI_INTERNALS__?: unknown };
  globals.__TAURI_INTERNALS__ = {
    invoke: (command: string) => {
      commands.push(command);
      if (command === "plugin:dialog|open") {
        return new Promise((resolve) => {
          answer = resolve;
        });
      }
      if (command === "plugin:fs|read_dir") {
        return new Promise((resolve) => {
          list = resolve;
        });
      }
      return Promise.reject(new Error(`unexpected ${command}`));
    },
  };
  return {
    commands,
    answer: (folder: string | null) => answer(folder),
    list: (entries: unknown[]) => list(entries),
    restore: () => delete globals.__TAURI_INTERNALS__,
  };
}

const openOther = () =>
  act(() => useAppStore.getState().loadProject({ ...createEmptyProject(), name: "Other" }));

afterEach(() => {
  cleanup();
  resetStores();
});

describe("ArcGIS Pro import report", () => {
  it("stays open through a collaboration refresh and closes once another project opens", () => {
    const report = renderReport();
    showReport(report);
    act(() =>
      useAppStore.setState((state) => ({ projectGeneration: state.projectGeneration + 1 })),
    );
    assert.notEqual(report().warnings, null);
    openOther();
    assert.equal(report().warnings, null);
    assert.deepEqual(report().repairGroups, []);
  });

  it("adds nothing when another project opens while the folder picker is up", async () => {
    const desktop = stubDesktop();
    try {
      const report = renderReport();
      showReport(report);
      const locating = report().locate(report().repairGroups[0].key);
      await act(async () => {});
      assert.equal(report().repairBusy, true);
      openOther();
      assert.equal(report().warnings, null);
      desktop.answer("/Users/analyst/moved");
      await act(() => locating);
      // The picked folder is never listed or read, and nothing is added.
      assert.deepEqual(desktop.commands, ["plugin:dialog|open"]);
      assert.deepEqual(useAppStore.getState().layers, []);
      assert.equal(report().repairBusy, false);
    } finally {
      desktop.restore();
    }
  });

  it("reads nothing when another project opens while the folder is being listed", async () => {
    const desktop = stubDesktop();
    try {
      const report = renderReport();
      showReport(report);
      const locating = report().locate(report().repairGroups[0].key);
      await act(async () => {});
      desktop.answer("/Users/analyst/moved");
      await act(async () => {});
      assert.deepEqual(desktop.commands, ["plugin:dialog|open", "plugin:fs|read_dir"]);
      openOther();
      desktop.list([{ name: "roads.shp", isDirectory: false, isFile: true, isSymlink: false }]);
      await act(() => locating);
      // The listing came back for a replaced project: no file is read.
      assert.deepEqual(desktop.commands, ["plugin:dialog|open", "plugin:fs|read_dir"]);
      assert.deepEqual(useAppStore.getState().layers, []);
      assert.equal(report().repairBusy, false);
    } finally {
      desktop.restore();
    }
  });

  it("refuses a network-share folder without reading it", async () => {
    const desktop = stubDesktop();
    try {
      const report = renderReport();
      act(() => useAppStore.getState().addLayer(geojsonLayer({ id: "kept", name: "Kept" })));
      showReport(report);
      const locating = report().locate(report().repairGroups[0].key);
      await act(async () => {});
      desktop.answer("\\\\server\\gis\\Data");
      await act(() => locating);
      assert.equal(report().repairResult?.networkFolder, true);
      assert.deepEqual(desktop.commands, ["plugin:dialog|open"]);
      assert.deepEqual(
        useAppStore.getState().layers.map((layer) => layer.id),
        ["kept"],
      );
      assert.equal(report().repairGroups.length, 1);
    } finally {
      desktop.restore();
    }
  });

  it("offers a Locate folder and counts only layers that did not load", () => {
    const report: ArcgisImportReport = {
      warnings: [
        { layerName: "Roads", reason: "data-not-found", layerId: "roads" },
        {
          layerName: "Roads",
          reason: "symbology-partial",
          symbologyIssue: "visual-variables",
          layerId: "roads",
        },
      ],
      repairGroups: [
        { key: "c:\\old", label: "C:\\Old", layerIds: ["roads"], layerNames: ["Roads"] },
      ],
      repairBusy: false,
      repairResult: null,
      show: () => {},
      close: () => {},
      locate: async () => {},
    };
    render(createElement(ArcgisImportReportDialog, { report }));
    // One layer did not load; its symbology note is not counted as another.
    screen.getByText("The project was imported, but 1 layer could not be loaded.");
    screen.getByText("Locate moved data");
    screen.getByText("C:\\Old");
    screen.getByRole("button", { name: "Locate folder…" });
  });

  it("says only the drawing differs once every layer has loaded", () => {
    const report: ArcgisImportReport = {
      warnings: [
        {
          layerName: "Roads",
          reason: "symbology-partial",
          symbologyIssue: "visual-variables",
          layerId: "roads",
        },
      ],
      repairGroups: [],
      repairBusy: false,
      repairResult: { folder: "C:\\New", restored: 1, remaining: 0 },
      show: () => {},
      close: () => {},
      locate: async () => {},
    };
    render(createElement(ArcgisImportReportDialog, { report }));
    screen.getByText(
      "The project was imported, but some of it is not shown exactly as in ArcGIS Pro.",
    );
    screen.getByText("Loaded 1 layer from the chosen folder.");
    assert.equal(screen.queryByRole("button", { name: "Locate folder…" }), null);
  });
});
