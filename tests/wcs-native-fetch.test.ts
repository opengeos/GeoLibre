import "./helpers/dom";
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, it } from "node:test";
import { DOMParser } from "linkedom";

const nativeDescriptor = Object.getOwnPropertyDescriptor(window, "__TAURI_INTERNALS__");
const parserDescriptor = Object.getOwnPropertyDescriptor(globalThis, "DOMParser");
Object.defineProperty(globalThis, "DOMParser", { configurable: true, value: DOMParser });
const { discoverWcs, downloadWcs } = await import("../apps/geolibre-desktop/src/lib/wcs-fetch");
const calls: URL[] = [];
let rejection: unknown = "Request failed with status 400 Bad Request";
const legacy =
  '<WCS_Capabilities version="1.0.0"><CoverageOfferingBrief><name>legacy</name></CoverageOfferingBrief></WCS_Capabilities>';

beforeEach(() => {
  calls.length = 0;
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke: async (command: string, args: { url: string; maxBytes: number }) => {
        assert.equal(command, "fetch_url_bytes");
        const url = new URL(args.url);
        assert.equal(
          args.maxBytes,
          (url.searchParams.get("REQUEST") === "GetCoverage" ? 128 : 32) * 1024 * 1024,
        );
        calls.push(url);
        if (url.searchParams.get("VERSION") === "2.0.1") throw rejection;
        return Array.from(new TextEncoder().encode(legacy));
      },
    },
  });
});

afterEach(() => {
  if (nativeDescriptor) Object.defineProperty(window, "__TAURI_INTERNALS__", nativeDescriptor);
  else Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

for (const status of [400, 404, 406, 500, 501]) {
  it(`retries legacy discovery after native HTTP ${status}`, async () => {
    rejection = `Request failed with status ${status}`;
    const result = await discoverWcs(
      "https://example.org/wcs?token=kept",
      new AbortController().signal,
    );
    assert.equal(result[0].name, "legacy");
    assert.deepEqual(
      calls.map((url) => url.searchParams.get("VERSION")),
      ["2.0.1", "1.0.0"],
    );
    assert.ok(calls.every((url) => url.searchParams.get("token") === "kept"));
  });
}

it("normalizes native coverage HTTP refusals without retrying", async () => {
  for (const status of [400, 403, 404]) {
    rejection = `Request failed with status ${status} Bad Request`;
    calls.length = 0;
    await assert.rejects(
      downloadWcs(
        "https://example.org/wcs?VERSION=2.0.1&REQUEST=GetCoverage",
        "coverage",
        new AbortController().signal,
      ),
      new RegExp(`^Error: WCS HTTP ${status}$`),
    );
    assert.equal(calls.length, 1);
  }
});

it("does not retry native authentication, timeout or metadata-limit failures", async () => {
  for (const error of [
    "Request failed with status 403 Forbidden",
    "native request timeout",
    "download limit exceeded",
  ]) {
    calls.length = 0;
    rejection = error;
    await assert.rejects(discoverWcs("https://example.org/wcs", new AbortController().signal));
    assert.equal(calls.length, 1);
  }
});

after(() => {
  if (parserDescriptor) Object.defineProperty(globalThis, "DOMParser", parserDescriptor);
});
