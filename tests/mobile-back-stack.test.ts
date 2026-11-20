import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  dispatchMobileBack,
  registerMobileBackHandler,
  resetMobileBackHandlers,
} from "../apps/geolibre-desktop/src/lib/mobile-back-stack";

describe("mobile back-handler stack", () => {
  beforeEach(() => {
    resetMobileBackHandlers();
  });

  it("invokes handlers in LIFO order and stops at the first handler that consumes back", () => {
    const log: string[] = [];
    const unregSheet = registerMobileBackHandler(() => {
      log.push("sheet");
      return true;
    });
    const unregOverlay = registerMobileBackHandler(() => {
      log.push("overlay");
      return true;
    });

    assert.equal(dispatchMobileBack(), true);
    assert.deepEqual(log, ["overlay"]);

    unregOverlay();
    assert.equal(dispatchMobileBack(), true);
    assert.deepEqual(log, ["overlay", "sheet"]);

    unregSheet();
    assert.equal(dispatchMobileBack(), false);
  });

  it("falls through handlers that return false", () => {
    const log: string[] = [];
    registerMobileBackHandler(() => {
      log.push("base");
      return true;
    });
    registerMobileBackHandler(() => {
      log.push("inactive");
      return false;
    });

    assert.equal(dispatchMobileBack(), true);
    assert.deepEqual(log, ["inactive", "base"]);
  });

  it("keeps an overlay handler above a stable base handler even as base state changes", () => {
    const log: string[] = [];
    const baseState = { openTab: "layers" as string | null };
    registerMobileBackHandler(() => {
      if (baseState.openTab !== null) {
        log.push(`sheet:${baseState.openTab}`);
        baseState.openTab = null;
        return true;
      }
      return false;
    });
    const unregCrosshair = registerMobileBackHandler(() => {
      log.push("crosshair");
      return true;
    });

    // Mutating base state without re-registering must leave crosshair on top.
    baseState.openTab = "field";
    assert.equal(dispatchMobileBack(), true);
    assert.deepEqual(log, ["crosshair"]);

    unregCrosshair();
    assert.equal(dispatchMobileBack(), true);
    assert.deepEqual(log, ["crosshair", "sheet:field"]);
  });
});
