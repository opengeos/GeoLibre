import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import {
  featureCollectionByteLength,
  isSerializationTooLargeError,
  utf8ByteLength,
} from "../apps/geolibre-desktop/src/lib/project-serialization-limits";

const encodedLength = (text: string) => new TextEncoder().encode(text).length;

describe("isSerializationTooLargeError", () => {
  it("recognizes each engine's string-cap message", () => {
    assert.equal(isSerializationTooLargeError(new RangeError("Invalid string length")), true);
    assert.equal(isSerializationTooLargeError(new Error("Out of memory")), true);
    assert.equal(isSerializationTooLargeError(new Error("allocation size overflow")), true);
  });

  it("does not file other failures under size", () => {
    assert.equal(
      isSerializationTooLargeError(new RangeError("Maximum call stack size exceeded")),
      false,
    );
    assert.equal(
      isSerializationTooLargeError(new TypeError("Converting circular structure to JSON")),
      false,
    );
    assert.equal(isSerializationTooLargeError("Invalid string length"), false);
    assert.equal(isSerializationTooLargeError(undefined), false);
  });
});

describe("utf8ByteLength", () => {
  it("matches TextEncoder across one- to four-byte characters", () => {
    for (const text of ["", "abc", "café", "東京", "مرحبا", "🌍 map", "a\u{10FFFF}b"]) {
      assert.equal(utf8ByteLength(text), encodedLength(text), text);
    }
  });

  it("counts a lone surrogate as the replacement character TextEncoder writes", () => {
    for (const text of ["\uD800", "x\uDC00y", "\uD83D!"]) {
      assert.equal(utf8ByteLength(text), encodedLength(text));
    }
  });
});

describe("featureCollectionByteLength", () => {
  const point = (name: string, x: number) => ({
    type: "Feature" as const,
    properties: { name },
    geometry: { type: "Point" as const, coordinates: [x, 1.5] },
  });

  it("equals the encoded length of the whole collection", () => {
    const cases: FeatureCollection[] = [
      { type: "FeatureCollection", features: [] },
      { type: "FeatureCollection", features: [point("one", 0)] },
      {
        type: "FeatureCollection",
        features: [point("Zürich", 8.5), point("東京", 139.7), point("🌍", -0.1)],
      },
      {
        type: "FeatureCollection",
        bbox: [-1, -1, 1, 1],
        features: [point("a", 1), point("b", 2)],
      },
    ];
    for (const collection of cases) {
      assert.equal(
        featureCollectionByteLength(collection),
        encodedLength(JSON.stringify(collection)),
      );
    }
  });

  it("writes an unserializable entry as null, like JSON.stringify", () => {
    const collection = {
      type: "FeatureCollection",
      features: [point("a", 1), undefined],
    } as unknown as FeatureCollection;
    assert.equal(
      featureCollectionByteLength(collection),
      encodedLength(JSON.stringify(collection)),
    );
  });

  it("never stringifies the whole collection at once", () => {
    // Simulates the engine's string cap: any single string past the limit
    // throws, the way V8 raises "Invalid string length" (GeoLibre#3025).
    const features = Array.from({ length: 200 }, (_unused, index) => point(`f${index}`, index));
    const collection: FeatureCollection = { type: "FeatureCollection", features };
    const expected = encodedLength(JSON.stringify(collection));
    const original = JSON.stringify;
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
      const text = original(...args);
      if (typeof text === "string" && text.length > 1_000) {
        throw new RangeError("Invalid string length");
      }
      return text;
    }) as typeof JSON.stringify;
    try {
      assert.equal(featureCollectionByteLength(collection), expected);
    } finally {
      JSON.stringify = original;
    }
  });
});
