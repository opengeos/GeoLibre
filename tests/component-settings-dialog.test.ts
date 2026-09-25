import {
  act,
  fireEvent,
  render,
  screen,
  useAppStore,
  useDesktopSettingsStore,
  within,
} from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { SettingsDialog, openSettingsSection } =
  await import("../apps/geolibre-desktop/src/components/layout/SettingsDialog");

type Section = Parameters<typeof openSettingsSection>[0];

/** Render the Settings menu button (the dialog itself starts closed). */
function renderSettings() {
  return render(
    createElement(SettingsDialog, {
      mapControllerRef: { current: null },
      onOpenManagePlugins: () => {},
      profilePlugins: [],
      themeMode: "light",
      onToggleThemeMode: () => {},
    }),
  );
}

/** Open the dialog at `section` the way other parts of the app deep-link it. */
function openAt(section: Section): HTMLElement {
  act(() => openSettingsSection(section));
  return screen.getByRole("dialog", { name: "Settings" });
}

function checkbox(dialog: HTMLElement, label: string): HTMLInputElement {
  return within(dialog).getByRole("checkbox", { name: label }) as HTMLInputElement;
}

function layoutSettings() {
  return useDesktopSettingsStore.getState().desktopSettings.layout;
}

describe("SettingsDialog", () => {
  it("is closed until something opens it", () => {
    renderSettings();

    assert.equal(screen.queryAllByRole("dialog").length, 0);
  });

  it("opens at the requested section", () => {
    renderSettings();

    const dialog = openAt("layout");

    const toolbarLabels = checkbox(dialog, "Show toolbar labels");
    assert.equal(toolbarLabels.checked, layoutSettings().toolbarLabels);
  });

  it("saves a toggled layout setting to the desktop settings", () => {
    renderSettings();
    const before = layoutSettings().toolbarLabels;

    const dialog = openAt("layout");
    fireEvent.click(checkbox(dialog, "Show toolbar labels"));
    // Toggling only edits the dialog's draft...
    assert.equal(layoutSettings().toolbarLabels, before);

    fireEvent.click(within(dialog).getByRole("button", { name: "Save Settings" }));

    // ...Save commits it and closes the dialog.
    assert.equal(layoutSettings().toolbarLabels, !before);
    assert.equal(screen.queryAllByRole("dialog").length, 0);
  });

  it("discards a toggled setting on Cancel", () => {
    renderSettings();
    const before = layoutSettings().toolbarLabels;

    const dialog = openAt("layout");
    fireEvent.click(checkbox(dialog, "Show toolbar labels"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    assert.equal(layoutSettings().toolbarLabels, before);

    // Reopening starts from the saved value, not the abandoned draft.
    const reopened = openAt("layout");
    assert.equal(checkbox(reopened, "Show toolbar labels").checked, before);
  });

  it("saves a map preference to the project store", () => {
    renderSettings();
    const before = useAppStore.getState().preferences.map.restrictBounds;

    const dialog = openAt("map");
    fireEvent.click(checkbox(dialog, "Restrict map bounds"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save Settings" }));

    assert.equal(useAppStore.getState().preferences.map.restrictBounds, !before);
  });
});
