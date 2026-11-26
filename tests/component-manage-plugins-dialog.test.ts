import {
  fireEvent,
  mockFetch,
  render,
  screen,
  useDesktopSettingsStore,
  waitFor,
  within,
} from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";

// Loaded after the harness so the dialog's CSS imports and Vite globals resolve.
const { ManagePluginsDialog } =
  await import("../apps/geolibre-desktop/src/components/layout/ManagePluginsDialog");

const HEATMAP_URL = "https://plugins.example.com/heatmap/plugin.json";
const TIDES_URL = "https://plugins.example.com/tides/plugin.json";

const REGISTRY = {
  plugins: [
    {
      id: "test-heatmap",
      name: "Test Heatmap",
      version: "1.2.0",
      manifestUrl: HEATMAP_URL,
      description: "Density surfaces from points",
      author: "Mapper",
    },
    {
      id: "test-tides",
      name: "Test Tides",
      version: "0.4.0",
      manifestUrl: TIDES_URL,
      description: "Tide gauge readings",
    },
  ],
};

/** Serve the plugin registry (or a failure) and count registry requests. */
function registry(response: { status: number; body: unknown }) {
  let requests = 0;
  mockFetch(async (input) => {
    if (String(input).includes("registry")) requests += 1;
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  });
  return () => requests;
}

const manifestUrls = () => useDesktopSettingsStore.getState().desktopSettings.pluginManifestUrls;
const text = () => document.body.textContent ?? "";

function renderDialog() {
  return render(
    createElement(ManagePluginsDialog, {
      open: true,
      onOpenChange: () => {},
      mapControllerRef: { current: null },
    }),
  );
}

describe("ManagePluginsDialog", () => {
  it("lists registry plugins and filters them by search", async () => {
    registry({ status: 200, body: REGISTRY });
    renderDialog();
    await waitFor(() => assert.ok(text().includes("Test Tides")));
    assert.ok(text().includes("Test Heatmap"));
    assert.ok(text().includes("Density surfaces from points"));
    fireEvent.change(screen.getByRole("textbox", { name: "Search plugins" }), {
      target: { value: "tide" },
    });
    assert.ok(text().includes("Test Tides"));
    assert.ok(!text().includes("Test Heatmap"));
  });

  it("installs a plugin by adding its manifest URL, then uninstalls after confirmation", async () => {
    registry({ status: 200, body: REGISTRY });
    renderDialog();
    await waitFor(() => assert.ok(text().includes("Test Heatmap")));
    fireEvent.click(screen.getByRole("button", { name: "Install Test Heatmap" }));
    assert.deepEqual(manifestUrls(), [HEATMAP_URL]);
    // Installed but not yet registered by the plugin manager.
    await waitFor(() => assert.ok(screen.getByRole("button", { name: "Uninstall Test Heatmap" })));
    assert.ok(text().includes("Installed (1)"));

    fireEvent.click(screen.getByRole("button", { name: "Uninstall Test Heatmap" }));
    assert.deepEqual(manifestUrls(), [HEATMAP_URL]);
    fireEvent.click(screen.getByRole("button", { name: "Confirm uninstall Test Heatmap" }));
    assert.deepEqual(manifestUrls(), []);
  });

  it("splits the list into installed and not-installed sections", async () => {
    const state = useDesktopSettingsStore.getState();
    useDesktopSettingsStore.setState({
      desktopSettings: { ...state.desktopSettings, pluginManifestUrls: [TIDES_URL] },
    });
    registry({ status: 200, body: REGISTRY });
    renderDialog();
    await waitFor(() => assert.ok(text().includes("Installed (1)")));
    assert.ok(text().includes("Not installed (1)"));
    fireEvent.click(screen.getByRole("button", { name: "Not installed (1)" }));
    assert.ok(text().includes("Test Heatmap"));
    assert.ok(!text().includes("Test Tides"));
    fireEvent.click(screen.getByRole("button", { name: "Installed (1)" }));
    assert.ok(text().includes("Test Tides"));
    assert.ok(!text().includes("Test Heatmap"));
  });

  it("shows a registry failure and reloads on Refresh", async () => {
    const requests = registry({ status: 503, body: {} });
    renderDialog();
    await waitFor(() => assert.ok(/HTTP 503/.test(text())));
    const before = requests();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => assert.ok(requests() > before));
  });

  it("adds a sideloaded manifest URL from Settings and rejects an insecure one", async () => {
    registry({ status: 200, body: { plugins: [] } });
    renderDialog();
    await waitFor(() => assert.ok(text().includes("No plugins are listed in the registry.")));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const input = screen.getByRole("textbox", { name: "Plugin manifest URL" });
    fireEvent.change(input, { target: { value: "http://plugins.example.com/x/plugin.json" } });
    // The directory row has its own Add button; use the one beside this field.
    fireEvent.click(within(input.parentElement!).getByRole("button", { name: "Add" }));
    assert.ok(text().includes("Manifest URLs must use HTTPS"));
    assert.deepEqual(manifestUrls(), []);
    fireEvent.change(input, { target: { value: "https://plugins.example.com/x/plugin.json" } });
    fireEvent.keyDown(input, { key: "Enter" });
    assert.deepEqual(manifestUrls(), ["https://plugins.example.com/x/plugin.json"]);
    assert.ok(!text().includes("Manifest URLs must use HTTPS"));
  });
});
