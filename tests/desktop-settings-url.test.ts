import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyTemporaryDesktopSettings,
  shouldPersistDesktopSettings,
} from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";
import {
  desktopSettingsUrl,
  fetchDesktopSettings,
  sharedSettingsLanguage,
} from "../apps/geolibre-desktop/src/lib/desktop-settings-url";

describe("desktop settings URL", () => {
  it("prefers settingsUrl and accepts the discussion's settingUrl spelling", () => {
    assert.equal(
      desktopSettingsUrl("?settingsUrl=https%3A%2F%2Fexample.com%2Fa.json"),
      "https://example.com/a.json",
    );
    assert.equal(
      desktopSettingsUrl("?settingUrl=https%3A%2F%2Fexample.com%2Fb.json"),
      "https://example.com/b.json",
    );
    assert.equal(
      desktopSettingsUrl("?settingsUrl=&settingUrl=https%3A%2F%2Fexample.com%2Fb.json"),
      "https://example.com/b.json",
    );
    assert.equal(desktopSettingsUrl("?url=project.json"), null);
  });

  it("fetches without trusting a stale cached settings file and normalizes it", async () => {
    let init: RequestInit | undefined;
    const fetchImpl = (async (_url: string, requestInit?: RequestInit) => {
      init = requestInit;
      return new Response(
        JSON.stringify({
          layout: { toolbarLabels: false },
          uiProfile: { enabled: true, hiddenMenus: ["help", "help"] },
          shareToken: "remote-token-must-not-load",
          cesiumIonToken: "remote-cesium-token-must-not-load",
          aiProfiles: [{ id: "remote", fieldValues: { API_KEY: "secret" } }],
          pluginManifestUrls: ["https://evil.example/plugin.json"],
          startup: { mode: "specific", projectPath: "/remote/path" },
        }),
      );
    }) as typeof fetch;

    const settings = await fetchDesktopSettings("https://example.com/settings.json", {
      fetchImpl,
      timeoutMs: 500,
    });
    assert.equal(init?.cache, "no-cache");
    assert.equal(init?.credentials, "same-origin");
    assert.ok(init?.signal);
    assert.equal(settings.layout.toolbarLabels, false);
    assert.deepEqual(settings.uiProfile.hiddenMenus, ["help"]);
    assert.equal(settings.shareToken, "");
    assert.equal(settings.cesiumIonToken, "");
    assert.deepEqual(settings.aiProfiles, []);
    assert.deepEqual(settings.pluginManifestUrls, []);
    assert.equal(settings.startup.mode, "default");
  });

  it("reports HTTP, malformed JSON, and non-object documents", async () => {
    await assert.rejects(
      fetchDesktopSettings("https://example.com/missing.json", {
        fetchImpl: async () => new Response("", { status: 404 }),
      }),
      /HTTP 404/,
    );
    await assert.rejects(
      fetchDesktopSettings("https://example.com/bad.json", {
        fetchImpl: async () => new Response("{"),
      }),
      /not valid JSON/,
    );
    await assert.rejects(
      fetchDesktopSettings("https://example.com/list.json", {
        fetchImpl: async () => new Response("[]"),
      }),
      /must be a JSON object/,
    );
  });

  it("actually aborts a settings request after its timeout", async () => {
    let signal: AbortSignal | null = null;
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
      });
    }) as typeof fetch;

    await assert.rejects(
      fetchDesktopSettings("https://example.com/stalled.json", { fetchImpl, timeoutMs: 5 }),
      (error: Error) => error.name === "TimeoutError",
    );
    assert.equal(signal?.aborted, true);
  });

  it("lets a remote language replace the saved language before render", () => {
    const available = ["en", "de", "fr"];
    // The app may have initialized from a saved `de`; main.tsx switches to the
    // resolved remote `fr` before mounting React.
    assert.equal(sharedSettingsLanguage("?settingsUrl=settings.json", "fr", available), "fr");
    assert.equal(sharedSettingsLanguage("?settingsUrl=settings.json", "unknown", available), null);
  });

  it("keeps locale and lang URL parameters above a remote language", () => {
    const available = ["en", "de", "fr"];
    assert.equal(sharedSettingsLanguage("?locale=de", "fr", available), null);
    assert.equal(sharedSettingsLanguage("?lang=de", "fr", available), null);
    // An unsupported explicit locale follows the existing fallback behavior.
    assert.equal(sharedSettingsLanguage("?locale=unknown", "fr", available), "fr");
  });

  it("keeps a shared-settings session out of persistent storage", () => {
    assert.equal(shouldPersistDesktopSettings(), true);
    applyTemporaryDesktopSettings({ layout: { toolbarLabels: false } });
    assert.equal(shouldPersistDesktopSettings(), false);
  });
});
