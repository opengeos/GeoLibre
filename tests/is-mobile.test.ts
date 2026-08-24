import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAndroid, isDesktopRuntime, isMobile } from "../apps/geolibre-desktop/src/lib/is-mobile";

describe("isMobile", () => {
  it("detects Android (incl. the Tauri webview UA)", () => {
    assert.equal(
      isMobile(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120 Mobile Safari/537.36 wv",
      ),
      true,
    );
  });

  it("detects iPhone and iPad", () => {
    assert.equal(isMobile("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"), true);
    assert.equal(isMobile("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)"), true);
  });

  it("is false for desktop browsers", () => {
    assert.equal(
      isMobile(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      ),
      false,
    );
    assert.equal(isMobile("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1"), false);
    assert.equal(isMobile("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120"), false);
  });

  it("detects iPadOS 13+ reporting a desktop Macintosh UA (multi-touch)", () => {
    const iPadDesktopUA =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
    assert.equal(isMobile(iPadDesktopUA, 5), true);
  });

  it("is false for a real Mac (Macintosh UA, no multi-touch)", () => {
    const macUA =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
    assert.equal(isMobile(macUA, 0), false);
    assert.equal(isMobile(macUA, 1), false);
  });

  it("is false for an empty user agent", () => {
    assert.equal(isMobile(""), false);
  });
});

describe("isAndroid", () => {
  it("detects the Android WebView user agent", () => {
    assert.equal(
      isAndroid(
        "Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 Version/4.0 Chrome/138 Mobile Safari/537.36 wv",
      ),
      true,
    );
  });

  it("does not classify iOS or desktop user agents as Android", () => {
    assert.equal(isAndroid("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"), false);
    assert.equal(isAndroid("Mozilla/5.0 (X11; Linux x86_64) Chrome/138 Safari/537.36"), false);
  });
});

describe("isDesktopRuntime", () => {
  const DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/138 Safari/537.36";
  const IPAD_UA =
    "Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
  const IPAD_DESKTOP_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15";

  /** Runs `body` with a stubbed `window`, with or without the Tauri marker. */
  function withWindow(tauri: boolean, body: () => void) {
    const globals = globalThis as { window?: unknown };
    const had = "window" in globals;
    const previous = globals.window;
    globals.window = tauri ? { __TAURI_INTERNALS__: {} } : {};
    try {
      body();
    } finally {
      if (had) globals.window = previous;
      else delete globals.window;
    }
  }

  it("is true only inside the Tauri shell on a desktop OS", () => {
    withWindow(true, () => {
      assert.equal(isDesktopRuntime(DESKTOP_UA, 0), true);
    });
  });

  it("is false in the packaged mobile apps, which are Tauri too", () => {
    withWindow(true, () => {
      // The iPad case from GeoLibre#2091, both the mobile and the desktop-class
      // user agent iPadOS can report.
      assert.equal(isDesktopRuntime(IPAD_UA, 5), false);
      assert.equal(isDesktopRuntime(IPAD_DESKTOP_UA, 5), false);
      assert.equal(
        isDesktopRuntime(
          "Mozilla/5.0 (Linux; Android 16; Pixel 8) Chrome/138 Mobile Safari/537.36 wv",
          5,
        ),
        false,
      );
    });
  });

  it("is false in a browser, mobile or not", () => {
    withWindow(false, () => {
      assert.equal(isDesktopRuntime(DESKTOP_UA, 0), false);
      assert.equal(isDesktopRuntime(IPAD_UA, 5), false);
    });
  });
});
