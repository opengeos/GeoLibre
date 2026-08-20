import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  desktopSettingsUrl,
  fetchDesktopSettings,
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
        }),
      );
    }) as typeof fetch;

    const settings = await fetchDesktopSettings("https://example.com/settings.json", fetchImpl);
    assert.equal(init?.cache, "no-cache");
    assert.equal(init?.credentials, "same-origin");
    assert.equal(settings.layout.toolbarLabels, false);
    assert.deepEqual(settings.uiProfile.hiddenMenus, ["help"]);
  });

  it("reports HTTP, malformed JSON, and non-object documents", async () => {
    await assert.rejects(
      fetchDesktopSettings(
        "https://example.com/missing.json",
        async () => new Response("", { status: 404 }),
      ),
      /HTTP 404/,
    );
    await assert.rejects(
      fetchDesktopSettings("https://example.com/bad.json", async () => new Response("{")),
      /not valid JSON/,
    );
    await assert.rejects(
      fetchDesktopSettings("https://example.com/list.json", async () => new Response("[]")),
      /must be a JSON object/,
    );
  });
});
