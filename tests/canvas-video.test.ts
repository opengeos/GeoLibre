import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CANVAS_VIDEO_MIME_CANDIDATES,
  canvasVideoExtensionForMime,
  pickCanvasVideoMimeType,
} from "../packages/plugins/src/plugins/canvas-video";

describe("pickCanvasVideoMimeType", () => {
  it("returns the first supported candidate", () => {
    assert.equal(
      pickCanvasVideoMimeType(CANVAS_VIDEO_MIME_CANDIDATES, () => true),
      "video/mp4;codecs=avc1.42E01E",
    );
  });

  it("falls back to WebM when MP4 is unsupported", () => {
    assert.equal(
      pickCanvasVideoMimeType(CANVAS_VIDEO_MIME_CANDIDATES, (type) =>
        type.startsWith("video/webm"),
      ),
      "video/webm;codecs=vp9",
    );
  });

  it("returns null when nothing is supported", () => {
    assert.equal(
      pickCanvasVideoMimeType(CANVAS_VIDEO_MIME_CANDIDATES, () => false),
      null,
    );
  });
});

describe("canvasVideoExtensionForMime", () => {
  it("maps MP4 MIME types to mp4 and the rest to webm", () => {
    assert.equal(canvasVideoExtensionForMime("video/mp4;codecs=avc1"), "mp4");
    assert.equal(canvasVideoExtensionForMime("video/mp4"), "mp4");
    assert.equal(canvasVideoExtensionForMime("video/webm;codecs=vp9"), "webm");
    assert.equal(canvasVideoExtensionForMime("application/octet"), "webm");
  });
});
