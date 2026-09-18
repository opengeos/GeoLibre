import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSendKey } from "../apps/geolibre-desktop/src/lib/assistant/send-key";

describe("assistant composer send key", () => {
  it("sends on a bare Enter", () => {
    assert.equal(isSendKey({ key: "Enter" }, true), true);
  });

  it("still sends on Ctrl/Cmd+Enter, the shortcut it replaced", () => {
    assert.equal(isSendKey({ key: "Enter", ctrlKey: true }, true), true);
    assert.equal(isSendKey({ key: "Enter", metaKey: true }, true), true);
  });

  it("leaves Shift+Enter and Alt+Enter to insert a newline", () => {
    assert.equal(isSendKey({ key: "Enter", shiftKey: true }, true), false);
    assert.equal(isSendKey({ key: "Enter", altKey: true }, true), false);
  });

  it("does not send while an IME is composing", () => {
    // Enter confirms a CJK candidate; sending there would fire off a half-typed
    // message on every word.
    assert.equal(isSendKey({ key: "Enter", isComposing: true }, true), false);
  });

  it("treats WebKit's keyCode 229 as composition too", () => {
    // Safari has reported the IME's confirming Enter with isComposing already
    // false, so the legacy code is the only signal left.
    assert.equal(isSendKey({ key: "Enter", keyCode: 229 }, true), false);
    assert.equal(isSendKey({ key: "Enter", keyCode: 13 }, true), true);
  });

  it("leaves the press alone when the panel cannot send", () => {
    // An empty draft or a run in flight: the key must fall through rather than
    // be swallowed, so Enter still types a newline mid-run.
    assert.equal(isSendKey({ key: "Enter" }, false), false);
  });

  it("ignores every other key", () => {
    for (const key of ["a", "ArrowUp", "Escape", "Tab"]) {
      assert.equal(isSendKey({ key }, true), false);
    }
  });
});
