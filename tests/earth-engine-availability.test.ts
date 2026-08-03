import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isEarthEngineAvailable } from "../packages/plugins/src/plugins/earth-engine-auth";

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
