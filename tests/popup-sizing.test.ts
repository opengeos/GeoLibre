import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import {
  applyPopupImageHeight,
  applyPopupWidth,
  createIdentifyPopupElement,
  createIdentifyPopupRows,
  identifyPopupShellMaxWidth,
  IDENTIFY_POPUP_SHELL_PADDING,
} from "../packages/map/src/feature-popup";
import { POPUP_MAX_WIDTH_RANGE, type LayerPopupConfig } from "@geolibre/core";

// A popup's width and image height are author settings (`LayerPopupConfig`,
// discussion #2304) that the renderer applies as inline style and a CSS custom
// property, because both have to beat a stylesheet rule: the Tailwind cap on
// the popup root, and the `.geolibre-popup-image` height in `index.css`.
const original = {
  window: globalThis.window,
  document: globalThis.document,
  HTMLAnchorElement: globalThis.HTMLAnchorElement,
  HTMLElement: globalThis.HTMLElement,
};
afterEach(() => {
  Object.assign(globalThis, original);
});

function withDocument() {
  const { window, document } = parseHTML("<html><body></body></html>");
  Object.assign(globalThis, {
    window,
    document,
    HTMLAnchorElement: window.HTMLAnchorElement,
    HTMLElement: window.HTMLElement,
  });
  return document;
}

const CITY = { name: "Olympia", photo: "https://photos.example/olympia.jpg" };

const PHOTO_POPUP: LayerPopupConfig = {
  titleField: "name",
  fields: [
    { field: "name", label: "Site" },
    { field: "photo", label: "Photo", kind: "image" },
  ],
};

/** The same layer without the picture, so only the text rows are drawn. */
const TEXT_POPUP: LayerPopupConfig = {
  titleField: "name",
  fields: [{ field: "name", label: "Site" }],
};

describe("popup width", () => {
  it("leaves the root's default cap alone when nothing is configured", () => {
    withDocument();
    const root = createIdentifyPopupElement("Sites", CITY, undefined, { popup: PHOTO_POPUP });
    assert.equal(root.style.maxWidth, "");
    assert.equal(root.style.width, "");
  });

  it("caps the root at the configured width, and the viewport too", () => {
    withDocument();
    const root = createIdentifyPopupElement("Sites", CITY, undefined, {
      popup: { ...PHOTO_POPUP, maxWidth: 480 },
    });
    assert.equal(root.style.maxWidth, "min(480px, calc(100vw - 48px))");
    // `width` rides along: the image-popup rule in index.css otherwise pins the
    // popup to 420px and the wider cap would never be reached.
    assert.equal(root.style.width, "min(480px, calc(100vw - 48px))");
  });

  it("leaves a text-only popup free to shrink to its content", () => {
    withDocument();
    const root = createIdentifyPopupElement("Sites", CITY, undefined, {
      popup: { ...TEXT_POPUP, maxWidth: 480 },
    });
    // The author's value is this popup's ceiling, not its size: without a
    // picture there is no fixed-width CSS rule to override, and pinning it
    // would pad every short feature out to 480px.
    assert.equal(root.style.maxWidth, "min(480px, calc(100vw - 48px))");
    assert.equal(root.style.width, "");
    assert.equal(root.querySelector(".geolibre-popup-image"), null);
  });

  it("clamps a width a hand-edited project put out of range", () => {
    withDocument();
    const root = createIdentifyPopupElement("Sites", CITY, undefined, {
      popup: { ...PHOTO_POPUP, maxWidth: 4000 },
    });
    const cap = `min(${POPUP_MAX_WIDTH_RANGE.max}px, calc(100vw - 48px))`;
    assert.equal(root.style.maxWidth, cap);
    assert.equal(root.style.width, cap);
  });

  it("clears the width for an unusable value rather than throwing", () => {
    withDocument();
    const document = globalThis.document;
    const root = document.createElement("div") as unknown as HTMLElement;
    applyPopupWidth(root, { maxWidth: "wide" } as unknown as LayerPopupConfig);
    assert.equal(root.style.maxWidth, "");
  });

  it("widens the MapLibre shell past the root so it cannot clip it", () => {
    assert.equal(identifyPopupShellMaxWidth(undefined), "560px");
    assert.equal(
      identifyPopupShellMaxWidth({ maxWidth: 480 }),
      `${480 + IDENTIFY_POPUP_SHELL_PADDING}px`,
    );
    // Clamped first, so the shell tracks the width actually rendered.
    assert.equal(
      identifyPopupShellMaxWidth({ maxWidth: 4000 }),
      `${POPUP_MAX_WIDTH_RANGE.max + IDENTIFY_POPUP_SHELL_PADDING}px`,
    );
  });
});

describe("popup image height", () => {
  it("publishes no custom property when nothing is configured", () => {
    withDocument();
    const rows = createIdentifyPopupRows(CITY, undefined, { popup: PHOTO_POPUP });
    assert.equal(rows.style.getPropertyValue("--geolibre-popup-image-height"), "");
  });

  it("publishes the configured height for the stylesheet to read", () => {
    withDocument();
    const rows = createIdentifyPopupRows(CITY, undefined, {
      popup: { ...PHOTO_POPUP, imageHeight: 320 },
    });
    assert.equal(rows.style.getPropertyValue("--geolibre-popup-image-height"), "320px");
    // The image itself keeps the class the stylesheet rule is keyed on.
    assert.ok(rows.querySelector(".geolibre-popup-image"));
  });

  it("ignores an unusable height rather than throwing", () => {
    withDocument();
    const document = globalThis.document;
    const rows = document.createElement("div") as unknown as HTMLElement;
    applyPopupImageHeight(rows, { imageHeight: null } as unknown as LayerPopupConfig);
    assert.equal(rows.style.getPropertyValue("--geolibre-popup-image-height"), "");
  });

  it("caps an inline base64 thumbnail through the same custom property", () => {
    withDocument();
    const inline =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const rows = createIdentifyPopupRows({ photo: inline }, undefined, {
      popup: { imageHeight: 240 },
    });
    assert.equal(rows.style.getPropertyValue("--geolibre-popup-image-height"), "240px");
    assert.ok(rows.querySelector(".geolibre-popup-inline-image"));
  });
});
