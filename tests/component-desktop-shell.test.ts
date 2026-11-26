import {
  act,
  fireEvent,
  render,
  screen,
  useAppStore,
  useDesktopSettingsStore,
  waitFor,
} from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createElement } from "react";
import type { LayoutOptions } from "../apps/geolibre-desktop/src/hooks/useLayoutOptions";
import { useCredentialStorageStatus } from "../apps/geolibre-desktop/src/lib/credential-store";

// Loaded after the harness so the shell's CSS imports and Vite globals resolve.
const { DesktopShell } =
  await import("../apps/geolibre-desktop/src/components/layout/DesktopShell");
const { layoutOptionsFromLocation } =
  await import("../apps/geolibre-desktop/src/hooks/useLayoutOptions");

const DIAGNOSTICS_DESCRIPTION =
  "Recent network requests, MapLibre errors, console warnings, and runtime exceptions.";

afterEach(() => {
  useCredentialStorageStatus.setState({ error: null, revision: 0 });
});

/** The layout the app computes for a plain launch, with optional overrides. */
function layout(overrides: Partial<LayoutOptions> = {}): LayoutOptions {
  return {
    ...layoutOptionsFromLocation(
      useDesktopSettingsStore.getState().desktopSettings.layout,
      useAppStore.getState().deploymentCapabilities,
    ),
    ...overrides,
  };
}

/** Render the shell the way `App` does, with no `?url=` project. */
function renderShell(options: Partial<LayoutOptions> = {}) {
  return render(
    createElement(DesktopShell, {
      layoutOptions: layout(options),
      mapAppAPI: null,
      themeMode: "light",
      onToggleThemeMode: () => {},
    }),
  );
}

describe("DesktopShell", () => {
  it("renders the toolbar, side panels and status bar around a map that failed to start", async () => {
    renderShell();
    assert.ok(screen.getByTestId("desktop-shell"));
    assert.ok(screen.getByRole("button", { name: "Project" }));
    // happy-dom has no WebGL: the map's own boundary catches the failure and
    // the rest of the workspace stays usable.
    await waitFor(() => assert.ok(screen.getByText(/Map failed to render/)));
    assert.ok(screen.getByRole("heading", { level: 1, name: "GeoLibre map workspace" }));
    assert.match(document.body.textContent ?? "", /Zoom:/);
  });

  it("publishes the project generation on the root element until unmount", () => {
    const { unmount } = renderShell();
    const root = document.documentElement;
    assert.equal(
      root.dataset.geolibreProjectGeneration,
      String(useAppStore.getState().projectGeneration),
    );
    unmount();
    assert.equal(root.dataset.geolibreProjectGeneration, undefined);
    assert.equal(root.dataset.geolibreProjectReadyGeneration, undefined);
  });

  it("drops the toolbar, side docks and status bar in a map-only layout", async () => {
    renderShell({ toolbarVisible: false, statusBarVisible: false, panelsHidden: true });
    await waitFor(() => assert.ok(screen.getByText(/Map failed to render/)));
    assert.equal(screen.queryByRole("button", { name: "Project" }), null);
    assert.doesNotMatch(document.body.textContent ?? "", /Zoom:/);
  });

  it("shows a credential storage failure until closed, and again on the next failure", () => {
    renderShell();
    assert.equal(screen.queryByTestId("credential-storage-warning"), null);
    act(() => useCredentialStorageStatus.setState({ error: "keychain locked", revision: 1 }));
    const warning = screen.getByTestId("credential-storage-warning");
    assert.match(warning.textContent ?? "", /keychain locked/);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    assert.equal(screen.queryByTestId("credential-storage-warning"), null);
    act(() => useCredentialStorageStatus.setState({ error: "keychain locked", revision: 2 }));
    assert.ok(screen.getByTestId("credential-storage-warning"));
  });

  it("shows the drop overlay while files are dragged over the shell", () => {
    renderShell();
    const shell = screen.getByTestId("desktop-shell");
    const dataTransfer = { types: ["Files"], files: [], items: [] };
    fireEvent.dragEnter(shell, { dataTransfer });
    assert.ok(screen.getByTestId("file-drop-overlay"));
    fireEvent.dragLeave(shell, { dataTransfer });
    assert.equal(screen.queryByTestId("file-drop-overlay"), null);
    // Dragging text, not files, never shows it.
    fireEvent.dragEnter(shell, { dataTransfer: { types: ["text/plain"], files: [], items: [] } });
    assert.equal(screen.queryByTestId("file-drop-overlay"), null);
  });

  it("opens Diagnostics from the status bar with the map's failure recorded", async () => {
    renderShell();
    await waitFor(() => assert.ok(screen.getByText(/Map failed to render/)));
    assert.equal(screen.queryByText(DIAGNOSTICS_DESCRIPTION), null);
    fireEvent.click(screen.getByRole("button", { name: /^Diagnostics: \d+/ }));
    await waitFor(() => assert.ok(screen.getByText(DIAGNOSTICS_DESCRIPTION)));
  });
});
