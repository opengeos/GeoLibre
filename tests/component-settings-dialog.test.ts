import {
  act,
  fireEvent,
  i18n,
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
// The same post-harness import rule applies to the Tauri-backed credential module.
const { setProjectCredentialsWritable } =
  await import("../apps/geolibre-desktop/src/lib/project-credentials");

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

// Each section's heading, used to check that exactly that section renders.
const SECTION_TITLE_KEYS: Record<Section, string> = {
  language: "settings.languagePack.title",
  map: "settings.map.constraintsTitle",
  layout: "settings.layout.title",
  appearance: "settings.appearance.title",
  interface: "settings.interface.title",
  geocoding: "settings.geocoding.title",
  ai: "settings.ai.title",
  cloudStorage: "settings.cloudStorage.title",
  environment: "settings.env.tokenTitle",
  startup: "settings.startup.title",
  updates: "settings.updates.title",
};

/** The text of every section heading (h3) in the open dialog. */
function headings(dialog: HTMLElement): string[] {
  return Array.from(dialog.querySelectorAll("h3"), (node) => node.textContent ?? "");
}

describe("SettingsDialog", () => {
  for (const section of Object.keys(SECTION_TITLE_KEYS) as Section[]) {
    it(`renders only the ${section} section when opened there`, () => {
      // The Updates section is desktop-only; pretend to be Tauri for it.
      if (section === "updates") {
        Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
      }
      try {
        renderSettings();
        const dialog = openAt(section);
        const shown = headings(dialog);
        for (const [other, key] of Object.entries(SECTION_TITLE_KEYS)) {
          assert.equal(
            shown.includes(i18n.t(key)),
            other === section,
            `${other} heading while showing ${section}`,
          );
        }
      } finally {
        delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      }
    });
  }

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

  it("does not promise project keychain storage when desktop hydration failed", () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    setProjectCredentialsWritable(false);
    try {
      renderSettings();
      const dialog = openAt("geocoding");
      fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "mapbox" } });
      assert.match(
        dialog.textContent ?? "",
        /project credential storage in the system keychain is unavailable/i,
      );
      assert.doesNotMatch(
        dialog.textContent ?? "",
        /Tokens and API keys you save in GeoLibre are stored in your system keychain/,
      );
      assert.doesNotMatch(dialog.textContent ?? "", /Keys are kept in your system keychain/);

      fireEvent.click(within(dialog).getByRole("button", { name: "Environment" }));
      assert.match(dialog.textContent ?? "", /saving a local project asks whether to keep/i);
      assert.doesNotMatch(
        dialog.textContent ?? "",
        /Values marked secret are kept in your system keychain/,
      );
      setProjectCredentialsWritable(true);
      fireEvent.click(within(dialog).getByRole("button", { name: "Geocoding" }));
      assert.match(dialog.textContent ?? "", /Keys are kept in your system keychain/);
      fireEvent.click(within(dialog).getByRole("button", { name: "Environment" }));
      assert.match(
        dialog.textContent ?? "",
        /Values marked secret are kept in your system keychain/,
      );
    } finally {
      setProjectCredentialsWritable(false);
      delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });
});
