import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { isInlineImageList, resolvePopupRows } from "../packages/core/src/popup";
import { createIdentifyPopupRows } from "../packages/map/src/feature-popup";

const original = { window: globalThis.window, document: globalThis.document };
afterEach(() => {
  Object.assign(globalThis, original);
});

const PNG_A = "data:image/png;base64,AAAA";
const PNG_B = "data:image/jpeg;base64,BBBB";

describe("inline image lists in the Identify popup (#3477)", () => {
  it("recognizes only non-empty lists of inline raster images", () => {
    assert.equal(isInlineImageList([PNG_A, PNG_B]), true);
    assert.equal(isInlineImageList([]), false);
    assert.equal(isInlineImageList([PNG_A, "photo.jpg"]), false);
    assert.equal(isInlineImageList(["data:image/svg+xml;base64,AAAA"]), false);
    assert.equal(isInlineImageList(PNG_A), false);
  });

  it("draws a feature's geolibre_photos as thumbnails, not as base64 text", () => {
    const { window, document } = parseHTML("<html><body></body></html>");
    Object.assign(globalThis, { window, document });
    const rows = createIdentifyPopupRows({
      name: "Hydrant",
      photo: PNG_A,
      geolibre_photos: [PNG_A, PNG_B],
    });
    const gallery = rows.querySelector(".geolibre-popup-inline-image-list");
    assert.ok(gallery, "the photo list renders as a gallery");
    const sources = [...gallery.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    assert.deepEqual(sources, [PNG_A, PNG_B]);
    assert.equal(rows.textContent?.includes("base64"), false);
  });

  it("keeps a photo list out of the hover tooltip", () => {
    const rows = resolvePopupRows(
      { name: "Hydrant", geolibre_photos: [PNG_A] },
      {
        hover: true,
        popup: {
          fields: [
            { field: "name", hover: true },
            { field: "geolibre_photos", hover: true },
          ],
        },
      },
    );
    assert.deepEqual(
      rows.map((row) => row.field),
      ["name"],
    );
  });
});
