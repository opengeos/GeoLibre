import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isMobile } from "../apps/geolibre-desktop/src/lib/is-mobile";

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
