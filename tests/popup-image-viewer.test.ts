import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { createIdentifyPopupRows } from "../packages/map/src/feature-popup";

// The lightbox an image row opens is a document-level `aria-modal` dialog, so
// what it does to focus and to the Escape key is the interesting part: the
// globe installs its own `window` Escape handler that clears the Identify
// popup underneath (`cesium-interactions.ts`), and the popup the lightbox was
// opened from must survive closing the lightbox.
const original = {
  window: globalThis.window,
  document: globalThis.document,
  HTMLAnchorElement: globalThis.HTMLAnchorElement,
  HTMLElement: globalThis.HTMLElement,
};
afterEach(() => {
  Object.assign(globalThis, original);
});

/**
 * Render an Identify row for one remote image and hand back the pieces a test
 * needs: the trigger to click, and a count of how many Escape presses reached
 * the window (where the globe's popup-clearing handler lives).
 */
function setup() {
  const { window, document } = parseHTML("<html><body></body></html>");
  // The image row branches on `instanceof HTMLAnchorElement` to tell a remote
  // image's link apart from an inline data URL's button, and the viewer checks
  // `activeElement instanceof HTMLElement` before holding on to it.
  Object.assign(globalThis, {
    window,
    document,
    HTMLAnchorElement: window.HTMLAnchorElement,
    HTMLElement: window.HTMLElement,
  });
  let escapesAtWindow = 0;
  window.addEventListener("keydown", (event: Event) => {
    if ((event as KeyboardEvent).key === "Escape") escapesAtWindow += 1;
  });
  const rows = createIdentifyPopupRows({ image: "https://cameras.example/cam-1.jpg" }, undefined, {
    popup: { fields: [{ field: "image", label: "Camera", kind: "image" }] },
  });
  document.body.append(rows as unknown as Node);
  const trigger = rows.querySelector<HTMLElement>(".geolibre-popup-image-link")!;
  // linkedom tracks neither focus nor `activeElement`, so stand in for the
  // browser: clicking the link focuses it, and the viewer's focus calls are
  // recorded rather than applied.
  const focused: string[] = [];
  trigger.focus = () => focused.push("trigger");
  Object.defineProperty(document, "activeElement", { configurable: true, value: trigger });
  return {
    document,
    window,
    trigger,
    focused,
    escapesAtWindow: () => escapesAtWindow,
    viewers: () => document.querySelectorAll(".geolibre-popup-image-viewer").length,
    pressEscape: () => {
      const event = new window.Event("keydown", { bubbles: true, cancelable: true }) as Event & {
        key: string;
      };
      event.key = "Escape";
      document.dispatchEvent(event);
    },
  };
}

describe("popup image viewer", () => {
  it("keeps Escape from reaching the globe's own popup handler", () => {
    const f = setup();
    f.trigger.click();
    assert.equal(f.viewers(), 1);

    f.pressEscape();
    assert.equal(f.viewers(), 0);
    // The Identify popup behind the lightbox stays open, because the globe's
    // window handler never saw this Escape.
    assert.equal(f.escapesAtWindow(), 0);

    // With the lightbox gone, Escape is the globe's again.
    f.pressEscape();
    assert.equal(f.escapesAtWindow(), 1);
  });

  it("tears the previous lightbox down through close(), listener and all", () => {
    const f = setup();
    f.trigger.click();
    f.trigger.click();
    assert.equal(f.viewers(), 1);

    // Closing the one remaining lightbox must leave no listener behind from the
    // first: a stale one would swallow this Escape too.
    f.document.querySelector<HTMLElement>(".geolibre-photo-fullscreen-close")!.click();
    assert.equal(f.viewers(), 0);
    f.pressEscape();
    assert.equal(f.escapesAtWindow(), 1);
  });

  it("holds Tab inside the dialog and returns focus to the trigger", () => {
    const f = setup();
    f.trigger.click();
    const closeButton = f.document.querySelector<HTMLElement>(".geolibre-photo-fullscreen-close")!;
    const closeFocused: string[] = [];
    closeButton.focus = () => closeFocused.push("close");

    const tab = new f.window.Event("keydown", { bubbles: true, cancelable: true }) as Event & {
      key: string;
    };
    tab.key = "Tab";
    f.document.dispatchEvent(tab);
    assert.equal(tab.defaultPrevented, true);
    assert.deepEqual(closeFocused, ["close"]);

    closeButton.click();
    assert.deepEqual(f.focused, ["trigger"]);
  });
});
