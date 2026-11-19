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
});
