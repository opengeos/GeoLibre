import { fireEvent, render, screen, useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { createElement } from "react";
import { renderHook } from "@testing-library/react";
import { createEmptyProject } from "@geolibre/core";
import { geojsonLayer } from "./helpers/layer-fixtures";
import {
  normalizeDesktopSettings,
  useDesktopSettingsStore,
} from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";
import {
  encodeInlineProjectFragment,
  INLINE_PROJECT_FRAGMENT_KEY,
} from "../apps/geolibre-desktop/src/lib/inline-project-fragment";

const { useStartupProject } = await import("../apps/geolibre-desktop/src/hooks/useStartupProject");
const { NewProjectDialog } =
  await import("../apps/geolibre-desktop/src/components/layout/NewProjectDialog");

const suffix = "/Library/Application Support/org.geolibre.app/picked-documents";
const oldRoot = `/private/var/mobile/Containers/Data/Application/old${suffix}`;
const currentRoot = `/private/var/mobile/Containers/Data/Application/current${suffix}`;
const relative = "/3cb9b477-d563-4d3e-8503-263ec23c01c5/data/roads.geojson";
const retained = geojsonLayer({
  id: "retained",
  sourcePath: oldRoot + relative,
  geojson: undefined,
  metadata: { localFileReloadable: true },
});

function configureRetainedDefaults() {
  const current = useDesktopSettingsStore.getState().desktopSettings;
  useDesktopSettingsStore.getState().setDesktopSettings({
    ...current,
    startup: {
      ...current.startup,
      layers: {
        fileName: "retained.json",
        path: "retained.json",
        layers: [retained],
        layerGroups: [],
      },
    },
  });
  return useDesktopSettingsStore.getState().desktopSettings.startup.layers;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  useAppStore.getState().setNativeDocumentCopyRoot(null);
  useAppStore.getState().newProject();
  useAppStore.getState().clearRecentProjects();
  useDesktopSettingsStore.getState().setDesktopSettings(normalizeDesktopSettings({}));
  useAppStore.getState().setNativeDocumentCopyError("Imported-file access is unavailable.");
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
  useAppStore.getState().setNativeDocumentCopyRoot(null);
  useAppStore.getState().newProject();
  useDesktopSettingsStore.getState().setDesktopSettings(normalizeDesktopSettings({}));
});

it("opens the startup workspace without discarding unavailable configured default layers", () => {
  const defaults = configureRetainedDefaults();
  const hook = renderHook(() => useStartupProject());
  try {
    assert.equal(hook.result.current.settled, true);
    assert.equal(hook.result.current.restoring, false);
    assert.equal(useAppStore.getState().layers.length, 0);
    assert.equal(
      useDesktopSettingsStore.getState().desktopSettings.startup.layers === defaults,
      true,
    );
    assert.equal(defaults?.layers[0].sourcePath, oldRoot + relative);
  } finally {
    hook.unmount();
  }
});

it("lets New Project create a blank workspace while keeping retained startup preferences", async () => {
  const defaults = configureRetainedDefaults();
  let created = 0;
  render(
    createElement(NewProjectDialog, {
      open: true,
      onOpenChange: () => undefined,
      onSaveCurrentProject: async () => true,
      onProjectCreated: () => {
        created++;
      },
    }),
  );
  fireEvent.doubleClick(await screen.findByRole("button", { name: "Blank" }));
  assert.equal(created, 1);
  assert.equal(useAppStore.getState().layers.length, 0);
  assert.equal(
    useDesktopSettingsStore.getState().desktopSettings.startup.layers === defaults,
    true,
  );
});

it("preserves a held inline payload and restores it on the next successful launch", () => {
  const project = createEmptyProject("Pending inline project");
  project.layers = [retained];
  const hash = `#${INLINE_PROJECT_FRAGMENT_KEY}=${encodeInlineProjectFragment(project)}`;
  window.history.replaceState(null, "", hash);
  const held = renderHook(() => useStartupProject());
  try {
    assert.equal(held.result.current.settled, true);
    assert.equal(useAppStore.getState().layers.length, 0);
    assert.equal(window.location.hash, hash);
  } finally {
    held.unmount();
  }
  useAppStore.getState().setNativeDocumentCopyRoot(currentRoot);
  const restored = renderHook(() => useStartupProject());
  try {
    assert.equal(restored.result.current.settled, true);
    assert.equal(window.location.hash, "");
    assert.equal(useAppStore.getState().layers[0].sourcePath, currentRoot + relative);
    assert.equal(project.layers[0].sourcePath, oldRoot + relative);
  } finally {
    restored.unmount();
  }
});

it("still consumes a malformed inline payload during an imported-file outage", () => {
  window.history.replaceState(null, "", `#${INLINE_PROJECT_FRAGMENT_KEY}=broken`);
  const hook = renderHook(() => useStartupProject());
  try {
    assert.equal(hook.result.current.settled, true);
    assert.equal(window.location.hash, "");
    assert.equal(useAppStore.getState().layers.length, 0);
  } finally {
    hook.unmount();
  }
});
