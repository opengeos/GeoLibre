import "./helpers/dom";
import { it } from "node:test";
import assert from "node:assert/strict";
import { downloadBytes } from "../apps/geolibre-desktop/src/lib/download-bytes";

it("downloads the bytes and defers revoking the URL until after the anchor click", async (t) => {
  const events: string[] = [];
  const blobUrl = "blob:download-test";
  let savedBlob: Blob | undefined;
  t.mock.method(URL, "createObjectURL", (blob: Blob) => {
    savedBlob = blob;
    return blobUrl;
  });
  t.mock.method(URL, "revokeObjectURL", (url: string) => {
    assert.equal(url, blobUrl);
    events.push("revoke");
  });
  const prototype = Object.getPrototypeOf(document.createElement("a"));
  t.mock.method(prototype, "click", function (this: HTMLAnchorElement) {
    assert.equal(this.download, "result.tif");
    assert.equal(this.href, blobUrl);
    assert.equal(this.isConnected, true);
    events.push("click");
  });
  downloadBytes(new Uint8Array([1, 2, 3]), "result.tif");
  assert.equal(savedBlob?.size, 3);
  assert.deepEqual(events, ["click"]);
  assert.equal(document.querySelector('a[download="result.tif"]'), null);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events, ["click", "revoke"]);
});
