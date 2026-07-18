import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { latLonBoxCorners } from "../apps/geolibre-desktop/src/lib/kml";
import {
  findArchiveEntry,
  imageMimeFromName,
  normalizeArchivePath,
} from "../apps/geolibre-desktop/src/lib/kml-overlays";

const bytes = (label: string): Uint8Array => new TextEncoder().encode(label);

function assertCornersClose(actual: [number, number][], expected: [number, number][]): void {
  assert.equal(actual.length, expected.length);
  actual.forEach(([lng, lat], index) => {
    const [expLng, expLat] = expected[index];
    assert.ok(
      Math.abs(lng - expLng) < 1e-9 && Math.abs(lat - expLat) < 1e-9,
      `corner ${index} was [${lng}, ${lat}], expected ~[${expLng}, ${expLat}]`,
    );
  });
}

describe("latLonBoxCorners", () => {
  it("returns corners in MapLibre image-source order when unrotated", () => {
    // top-left, top-right, bottom-right, bottom-left
    assert.deepEqual(latLonBoxCorners(10, 0, 10, 0, 0), [
      [0, 10],
      [10, 10],
      [10, 0],
      [0, 0],
    ]);
  });

  it("treats a missing/zero rotation as the unrotated box", () => {
    const unrotated = latLonBoxCorners(48, 45, 3, -1, 0);
    assert.deepEqual(latLonBoxCorners(48, 45, 3, -1, 0), unrotated);
  });

  it("maps each corner to its opposite for a 180-degree rotation", () => {
    // A half turn about the center swaps diagonally opposite corners, and the
    // longitude-scaling cancels, so the result is integer-clean (up to the
    // floating-point epsilon of sin(180deg)).
    assertCornersClose(latLonBoxCorners(10, 0, 10, 0, 180), [
      [10, 0],
      [0, 0],
      [0, 10],
      [10, 10],
    ]);
  });

  it("preserves the box center under any rotation", () => {
    const corners = latLonBoxCorners(20, 10, 40, 20, 37);
    const meanLng = corners.reduce((sum, [lng]) => sum + lng, 0) / corners.length;
    const meanLat = corners.reduce((sum, [, lat]) => sum + lat, 0) / corners.length;
    assert.ok(Math.abs(meanLng - 30) < 1e-9, `center lng was ${meanLng}`);
    assert.ok(Math.abs(meanLat - 15) < 1e-9, `center lat was ${meanLat}`);
  });
});

describe("normalizeArchivePath", () => {
  it("strips ./, leading slashes, backslashes, query, and lower-cases", () => {
    assert.equal(normalizeArchivePath("./Files/Overlay.PNG"), "files/overlay.png");
    assert.equal(normalizeArchivePath("/a/b.png"), "a/b.png");
    assert.equal(normalizeArchivePath("dir\\image.jpg"), "dir/image.jpg");
    assert.equal(normalizeArchivePath("img.png?v=2#frag"), "img.png");
  });

  it("decodes percent-encoding", () => {
    assert.equal(normalizeArchivePath("files/my%20overlay.png"), "files/my overlay.png");
  });
});

describe("findArchiveEntry", () => {
  const entries: Record<string, Uint8Array> = {
    "doc.kml": bytes("kml"),
    "files/overlay.png": bytes("overlay"),
    "assets/legend.png": bytes("legend"),
  };

  it("finds an exact entry", () => {
    assert.equal(findArchiveEntry(entries, "files/overlay.png"), entries["files/overlay.png"]);
  });

  it("finds via a normalized relative href", () => {
    assert.equal(findArchiveEntry(entries, "./Files/Overlay.png"), entries["files/overlay.png"]);
  });

  it("falls back to a unique basename match", () => {
    assert.equal(
      findArchiveEntry(entries, "somewhere/else/overlay.png"),
      entries["files/overlay.png"],
    );
  });

  it("does not guess when a basename is ambiguous", () => {
    const ambiguous: Record<string, Uint8Array> = {
      "a/overlay.png": bytes("a"),
      "b/overlay.png": bytes("b"),
    };
    assert.equal(findArchiveEntry(ambiguous, "c/overlay.png"), undefined);
  });

  it("returns undefined when nothing matches", () => {
    assert.equal(findArchiveEntry(entries, "missing.png"), undefined);
  });

  it("does not resolve inherited prototype members", () => {
    // A crafted href must not pull `Object.prototype.__proto__`/`constructor`
    // out of the bracket lookup instead of a real archive entry.
    assert.equal(findArchiveEntry(entries, "__proto__"), undefined);
    assert.equal(findArchiveEntry(entries, "constructor"), undefined);
    assert.equal(findArchiveEntry(entries, "hasOwnProperty"), undefined);
  });
});

describe("imageMimeFromName", () => {
  it("maps common image extensions", () => {
    assert.equal(imageMimeFromName("overlay.png"), "image/png");
    assert.equal(imageMimeFromName("photo.JPG"), "image/jpeg");
    assert.equal(imageMimeFromName("frame.jpeg"), "image/jpeg");
    assert.equal(imageMimeFromName("map.tif?x=1"), "image/tiff");
  });

  it("falls back to a generic type for unknown extensions", () => {
    assert.equal(imageMimeFromName("data.bin"), "application/octet-stream");
  });
});
