import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeDesktopSettings,
  type DesktopSettings,
} from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";
import { normalizeSharedDesktopSettings } from "../apps/geolibre-desktop/src/lib/desktop-settings-url";
import {
  applyInterfaceSettings,
  fetchInterfaceFile,
  INTERFACE_FILE_TYPE,
  parseInterfaceFile,
  serializeInterfaceFile,
} from "../apps/geolibre-desktop/src/lib/interface-settings-file";

function settings(): DesktopSettings {
  const base = normalizeDesktopSettings({});
  return {
    ...base,
    language: "fr",
    shareToken: "secret-token",
    pluginManifestUrls: ["https://plugins.example.com/plugin.json"],
    layout: { ...base.layout, stylePanelVisible: false, toolbarLabels: false },
    theme: { scheme: "custom", customColor: "#123456" },
    uiProfile: {
      ...base.uiProfile,
      enabled: true,
      level: null,
      locked: true,
      hiddenDataSources: ["postgres"],
      hiddenMenus: ["help"],
    },
  };
}

describe("interface files", () => {
  it("export only presentation settings, never credentials or a lock", () => {
    const file = JSON.parse(serializeInterfaceFile(settings()));
    assert.equal(file.type, INTERFACE_FILE_TYPE);
    assert.deepEqual(Object.keys(file).sort(), [
      "language",
      "layout",
      "theme",
      "type",
      "uiProfile",
      "version",
    ]);
    assert.equal(file.uiProfile.locked, false);
    assert.doesNotMatch(JSON.stringify(file), /secret-token|plugins\.example/);
  });

  it("round-trip through import", () => {
    const imported = parseInterfaceFile(serializeInterfaceFile(settings()));
    assert.equal(imported.language, "fr");
    assert.equal(imported.layout?.stylePanelVisible, false);
    assert.equal(imported.theme?.customColor, "#123456");
    assert.deepEqual(imported.uiProfile?.hiddenDataSources, ["postgres"]);
    assert.equal(imported.uiProfile?.locked, false);
  });

  it("work as a settingsUrl= target", () => {
    const shared = normalizeSharedDesktopSettings(JSON.parse(serializeInterfaceFile(settings())));
    assert.equal(shared.layout.stylePanelVisible, false);
    assert.deepEqual(shared.uiProfile.hiddenMenus, ["help"]);
  });

  it("apply only the keys a file sets", () => {
    const imported = parseInterfaceFile(JSON.stringify({ uiProfile: { hiddenPlugins: ["x"] } }));
    assert.deepEqual(Object.keys(imported), ["uiProfile"]);
    const current = settings();
    const next = applyInterfaceSettings(current, imported);
    assert.deepEqual(next.uiProfile.hiddenPlugins, ["x"]);
    assert.deepEqual(next.layout, current.layout);
    assert.deepEqual(next.theme, current.theme);
    assert.equal(next.shareToken, "secret-token");
  });

  it("keep the profile fields a partial file leaves out", () => {
    const imported = parseInterfaceFile(JSON.stringify({ uiProfile: { hiddenPlugins: ["x"] } }));
    const next = applyInterfaceSettings(settings(), imported);
    assert.equal(next.uiProfile.enabled, true);
    assert.deepEqual(next.uiProfile.hiddenDataSources, ["postgres"]);
    assert.deepEqual(next.uiProfile.hiddenMenus, ["help"]);
    // The lock is never imported, even onto a locked profile.
    assert.equal(next.uiProfile.locked, false);
  });

  it("refuse a file too large to be one", () => {
    assert.throws(
      () => parseInterfaceFile(JSON.stringify({ language: "x".repeat(300 * 1024) })),
      /too large/,
    );
  });

  it("refuse other files and newer versions", () => {
    assert.throws(() => parseInterfaceFile("nope"), /invalid JSON/);
    assert.throws(() => parseInterfaceFile("{}"), /sets no interface settings/);
    assert.throws(
      () => parseInterfaceFile(JSON.stringify({ type: "geolibre-layers" })),
      /Not a valid/,
    );
    assert.throws(
      () => parseInterfaceFile(JSON.stringify({ type: INTERFACE_FILE_TYPE, version: 2 })),
      /Unsupported/,
    );
  });

  it("load from an http(s) URL only", async () => {
    const body = serializeInterfaceFile(settings());
    const fetchImpl = (async () => new Response(body)) as typeof fetch;
    const imported = await fetchInterfaceFile("https://example.com/ui.json", { fetchImpl });
    assert.equal(imported.language, "fr");
    await assert.rejects(fetchInterfaceFile("file:///etc/passwd", { fetchImpl }), /http\(s\)/);
    // A body past the cap is refused while it streams, length header or not.
    const huge = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < 40; i += 1) controller.enqueue(new Uint8Array(16 * 1024));
            controller.close();
          },
        }),
      )) as typeof fetch;
    await assert.rejects(
      fetchInterfaceFile("https://example.com/ui.json", { fetchImpl: huge }),
      /too large/,
    );
    const notFound = (async () => new Response("", { status: 404 })) as typeof fetch;
    await assert.rejects(
      fetchInterfaceFile("https://example.com/ui.json", { fetchImpl: notFound }),
      /HTTP 404/,
    );
  });
});
