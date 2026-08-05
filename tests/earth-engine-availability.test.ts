import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isEarthEngineAvailable,
  isGoogleOAuthLoopbackAvailable,
} from "../packages/plugins/src/plugins/earth-engine-auth";
import { isIpadDesktopUserAgent } from "../packages/core/src/platform";

// Earth Engine sign-in needs the Rust loopback OAuth listener, which binds
// 127.0.0.1 to receive Google's redirect. Accepting an inbound connection needs
// the `com.apple.security.network.server` entitlement, and App Review rejected
// GeoLibre Desktop 2.4.0 over it (guideline 2.4.5). The Apple App Store builds
// therefore compile the listener out, and this predicate is what keeps the UI
// from offering a sign-in that cannot work. If it ever returns true for a
// packaged Apple build again, the entitlement has to come back with it.
describe("isEarthEngineAvailable", () => {
  it("is unavailable in a packaged Apple App Store build", () => {
    assert.equal(isEarthEngineAvailable(true, true), false);
  });

  it("stays available in every other packaged build (Developer ID, Windows, Linux, Android)", () => {
    assert.equal(isEarthEngineAvailable(false, true), true);
  });

  it("stays available in a browser, including Safari on iOS", () => {
    // Not a packaged app, so Google's popup/redirect flow applies and no
    // loopback listener is involved — the entitlement never enters into it.
    assert.equal(isEarthEngineAvailable(true, false), true);
    assert.equal(isEarthEngineAvailable(false, false), true);
  });

  it("defaults to available under plain Node, where no Apple runtime is detected", () => {
    // Both defaults resolve to false. Node does expose a global `navigator`
    // (userAgent "Node.js/<major>"), but it matches none of the Apple UA
    // patterns, and the Vite define is absent outside a bundled build.
    assert.equal(isEarthEngineAvailable(), true);
  });
});

// Earth Engine sign-in and the Add Data → Google Drive picker are gated by the
// same `#[cfg]` in src-tauri/src/lib.rs: one loopback listener backs both, and
// the App Store builds compile it out. They therefore have to answer this
// question identically. The Drive picker originally shipped its own copy of the
// rule, which omitted the iPadOS 13+ case and so offered a picker that could
// not work on an iPad; these lock the two together instead.
describe("isGoogleOAuthLoopbackAvailable", () => {
  it("is the predicate Earth Engine availability is defined as", () => {
    for (const appleAppStore of [true, false]) {
      for (const packagedApp of [true, false]) {
        assert.equal(
          isEarthEngineAvailable(appleAppStore, packagedApp),
          isGoogleOAuthLoopbackAvailable(appleAppStore, packagedApp),
          `disagreed for appleAppStore=${appleAppStore} packagedApp=${packagedApp}`,
        );
      }
    }
  });

  it("is false only for a packaged Apple App Store build", () => {
    assert.equal(isGoogleOAuthLoopbackAvailable(true, true), false);
    assert.equal(isGoogleOAuthLoopbackAvailable(false, true), true);
    assert.equal(isGoogleOAuthLoopbackAvailable(true, false), true);
    assert.equal(isGoogleOAuthLoopbackAvailable(false, false), true);
  });
});

describe("isIpadDesktopUserAgent", () => {
  // The rule the Drive picker's own copy of the check used to miss. iPadOS 13+
  // requests desktop sites by default, so an iPad's UA claims macOS and only
  // multi-touch distinguishes it from a real Mac.
  const IPAD_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

  it("identifies an iPad reporting a desktop Macintosh user agent", () => {
    assert.equal(isIpadDesktopUserAgent(IPAD_UA, 5), true);
  });

  it("does not mistake a real Mac for an iPad", () => {
    assert.equal(isIpadDesktopUserAgent(IPAD_UA, 0), false);
    assert.equal(isIpadDesktopUserAgent(IPAD_UA, 1), false);
    assert.equal(isIpadDesktopUserAgent(IPAD_UA, undefined), false);
  });
});
