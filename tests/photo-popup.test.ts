import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { createPhotoPopupElement } from "../packages/map/src/photo-popup";

// The geotagged-photo popup is shared by the MapLibre and Mapbox canvases; its
// thumbnail opens the fullscreen viewer from the keyboard too (#2475).
const original = {
  window: globalThis.window,
  document: globalThis.document,
  HTMLElement: globalThis.HTMLElement,
  requestAnimationFrame: globalThis.requestAnimationFrame,
};
afterEach(() => {
  Object.assign(globalThis, original);
});

function withDocument() {
  const { window, document } = parseHTML("<html><body></body></html>");
  Object.assign(globalThis, {
    window,
    document,
    HTMLElement: window.HTMLElement,
    requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
  });
  return { window, document };
}

const PHOTO = "data:image/png;base64,iVBORw0KGgo=";

// linkedom's KeyboardEvent drops `key`, so build a plain event carrying it.
function keydown(window: Window, key: string): Event {
  const event = new window.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "key", { value: key });
  return event;
}

describe("createPhotoPopupElement", () => {
  // linkedom has no focus model, so where focus lands (the close button, then
  // back on the thumbnail) is checked in the browser; this pins the wiring.
  it("opens the viewer with Enter, keeps Tab inside it, and closes on Escape", () => {
    const { window, document } = withDocument();
    const root = createPhotoPopupElement({ name: "Pic", photo: PHOTO });
    document.body.appendChild(root);
    const image = root.querySelector("img")!;
    assert.equal(image.getAttribute("tabindex"), "0");
    assert.equal(image.getAttribute("role"), "button");

    image.dispatchEvent(keydown(window, "Enter"));
    const viewer = document.querySelector(".geolibre-photo-fullscreen");
    assert.ok(viewer, "Enter opens the viewer");

    const tab = keydown(window, "Tab");
    document.dispatchEvent(tab);
    assert.equal(tab.defaultPrevented, true);

    document.dispatchEvent(keydown(window, "Escape"));
    assert.equal(document.querySelector(".geolibre-photo-fullscreen"), null);
  });

  it("uses the translated labels", () => {
    withDocument();
    const root = createPhotoPopupElement(
      { name: "NoPic" },
      {
        photo: "Foto",
        noPreview: "Keine Vorschau",
        viewFullResolution: "a",
        viewFullscreen: "b",
        close: "Schließen",
      },
    );
    assert.match(root.textContent ?? "", /Keine Vorschau/);
  });
});
