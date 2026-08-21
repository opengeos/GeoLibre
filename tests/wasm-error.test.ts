import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isRasterTooLargeForWasm,
  messageFromThrown,
} from "../apps/geolibre-desktop/src/lib/wasm-error";

const FALLBACK = "Could not convert this file.";

/** The exact refusal geolibre-wasm returns for the raster in GeoLibre#1743. */
const TOO_LARGE =
  "raster too large to fully decode in 32-bit WASM: 110162x51992 x 1 band(s) = " +
  "5727542704 cells. Use geotiff_info for metadata, or stream tiles with CogStream.";

describe("messageFromThrown", () => {
  it("keeps a bare string, which is how wasm-bindgen rejects", () => {
    // Reading the message off `err instanceof Error` alone dropped the whole
    // thing and left the user with the fallback, so the size limit looked like
    // an unexplained bug.
    assert.equal(messageFromThrown(TOO_LARGE, FALLBACK), TOO_LARGE);
  });

  it("reads an Error's message", () => {
    assert.equal(
      messageFromThrown(new Error("Not a readable GeoTIFF."), FALLBACK),
      "Not a readable GeoTIFF.",
    );
  });

  it("reads a message off a plain object", () => {
    // Workers structured-clone a rejection into a bare object, losing the
    // prototype but keeping the message.
    assert.equal(messageFromThrown({ message: "decode failed" }, FALLBACK), "decode failed");
  });

  it("falls back for values carrying nothing readable", () => {
    for (const empty of [null, undefined, 0, "", "   ", {}, { message: "" }, { message: 7 }, []]) {
      assert.equal(messageFromThrown(empty, FALLBACK), FALLBACK, `for ${JSON.stringify(empty)}`);
    }
  });

  it("falls back for an Error with an empty message", () => {
    assert.equal(messageFromThrown(new Error(""), FALLBACK), FALLBACK);
  });
});

describe("isRasterTooLargeForWasm", () => {
  it("recognizes the engine's size refusal", () => {
    assert.equal(isRasterTooLargeForWasm(TOO_LARGE), true);
  });

  it("does not claim unrelated conversion failures are about size", () => {
    // These must keep the engine's own wording, with no "use the desktop app"
    // advice bolted on: the desktop app would fail on them too.
    assert.equal(isRasterTooLargeForWasm("Unsupported sample format"), false);
    assert.equal(isRasterTooLargeForWasm("Not a readable GeoTIFF."), false);
    assert.equal(isRasterTooLargeForWasm(FALLBACK), false);
    assert.equal(isRasterTooLargeForWasm(""), false);
  });

  it("needs the whole documented phrase, not a fragment of it", () => {
    // A fragment could show up in a message about something else entirely, and
    // sending someone to install GDAL over an unrelated failure is worse than
    // staying quiet. Missing a reworded refusal only drops the extra hint.
    assert.equal(isRasterTooLargeForWasm("too large to fully decode"), false);
    assert.equal(isRasterTooLargeForWasm("raster too large"), false);
  });
});
