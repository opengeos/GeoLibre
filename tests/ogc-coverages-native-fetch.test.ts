import "./helpers/dom";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { discoverOgcCoverages } from "../apps/geolibre-desktop/src/lib/ogc-api-coverages";
import { fetchUrlResponse } from "../apps/geolibre-desktop/src/lib/native-http";

const nativeDescriptor = Object.getOwnPropertyDescriptor(window, "__TAURI_INTERNALS__");
afterEach(() => {
  if (nativeDescriptor) Object.defineProperty(window, "__TAURI_INTERNALS__", nativeDescriptor);
  else Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

test("native discovery sends Accept and resolves links against the final URL", async () => {
  const item = JSON.parse(
    readFileSync(new URL("./fixtures/ogc-coverages/gdps-collection.json", import.meta.url), "utf8"),
  );
  item.links = [
    {
      rel: "http://www.opengis.net/def/rel/ogc/1.0/coverage",
      href: "./coverage",
      type: "application/prs.coverage+json",
    },
  ];
  const calls: string[] = [];
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke: async (command: string, args: { url: string; accept: string; maxBytes: number }) => {
        assert.equal(command, "fetch_url_response");
        assert.equal(args.accept, "application/json");
        assert.equal(args.maxBytes, 2 * 1024 * 1024);
        calls.push(args.url);
        return {
          status: 200,
          content_type: "application/json",
          final_url: "https://example.org/resolved/collections/gdps-temperature?token=kept",
          body: Array.from(new TextEncoder().encode(JSON.stringify(item))),
        };
      },
    },
  });
  const [collection] = await discoverOgcCoverages(
    "https://example.org/api/collections/gdps-temperature?token=kept",
    new AbortController().signal,
  );
  assert.equal(calls.length, 1);
  assert.equal(
    collection.links[0].href,
    "https://example.org/resolved/collections/coverage?token=kept",
  );
});

test("the native response wrapper remains compatible with older hosts without a final URL", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke: async (_command: string, args: Record<string, unknown>) => {
        assert.equal(Object.hasOwn(args, "accept"), false);
        return {
          status: 200,
          body: [1, 2],
          content_type: "application/octet-stream",
        };
      },
    },
  });
  const response = await fetchUrlResponse("https://example.org/coverage");
  assert.equal(response.url, "https://example.org/coverage");
  assert.deepEqual(Array.from(response.body), [1, 2]);
});

test("native discovery preserves HTTP failure status even when the error body exceeds its cap", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke: async (command: string, args: Record<string, unknown>) => {
        assert.equal(command, "fetch_url_response");
        assert.equal(args.discardErrorBody, true);
        return { status: 503, final_url: args.url, content_type: "text/html", body: [] };
      },
    },
  });
  await assert.rejects(
    discoverOgcCoverages("https://example.org/collections", new AbortController().signal),
    /OGC API HTTP 503/,
  );
});
