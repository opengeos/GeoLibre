import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type LayerStyle } from "@geolibre/core";
import { ensureGeneratedImageHandler } from "../packages/map/src/generated-images";
import {
  KML_ICON_URL_PROPERTY,
  markerImageValue,
  prepareKmlFeatureIcons,
  prepareMarker,
} from "../packages/map/src/markers";

function categorizedMarker(patch: Partial<LayerStyle> = {}): LayerStyle {
  return {
    ...DEFAULT_LAYER_STYLE,
    markerEnabled: true,
    markerShape: "circle",
    markerColor: "#3b82f6",
    markerSize: 18,
    vectorStyleMode: "categorized",
    vectorStyleProperty: "status",
    vectorStyleStops: [
      { value: "good", color: "#339084" },
      { value: "bad", color: "#fde725" },
    ],
    ...patch,
  };
}

describe("markerImageValue", () => {
  it("selects a separately colored built-in marker for each category", () => {
    assert.deepEqual(markerImageValue(categorizedMarker()), [
      "match",
      ["to-string", ["get", "status"]],
      "good",
      "geolibre-marker-circle-339084-18",
      "bad",
      "geolibre-marker-circle-fde725-18",
      "geolibre-marker-circle-3b82f6-18",
    ]);
  });

  it("creates distinct parameterized SVG sprites for category colors", () => {
    const value = markerImageValue(
      categorizedMarker({
        markerShape: "custom",
        markerSvg:
          '<svg xmlns="http://www.w3.org/2000/svg"><path fill="param(fill)" d="M0 0h10v10z"/></svg>',
      }),
    );

    assert.ok(Array.isArray(value));
    const imageIds = [value[3], value[5], value[6]];
    assert.ok(
      imageIds.every((id) => typeof id === "string" && id.startsWith("geolibre-marker-svg-")),
    );
    assert.equal(new Set(imageIds).size, 3);
  });

  it("creates distinct category sprites when the SVG is supplied by URL", () => {
    const value = markerImageValue(
      categorizedMarker({
        markerShape: "custom",
        markerSvg: "https://example.com/tree.svg",
      }),
    );

    assert.ok(Array.isArray(value));
    assert.equal(new Set([value[3], value[5], value[6]]).size, 3);
  });

  it("uses the base marker for invalid expression color outputs", () => {
    const value = markerImageValue(
      categorizedMarker({
        vectorStyleMode: "expression",
        vectorStyleExpression: '["match",["get","status"],"good","red","#fde725"]',
      }),
    );

    assert.ok(Array.isArray(value));
    assert.equal(value[3], "geolibre-marker-circle-3b82f6-18");
    assert.equal(value[4], "geolibre-marker-circle-fde725-18");
  });

  it("recursively converts colors in zoom-scoped rule expressions", () => {
    const value = markerImageValue(
      categorizedMarker({
        vectorStyleMode: "expression",
        vectorStyleExpression:
          '["step",["zoom"],["case",["get","selected"],"#339084","#fde725"],10,["case",["get","selected"],"#fde725","#339084"]]',
      }),
    );

    assert.deepEqual(value, [
      "step",
      ["zoom"],
      [
        "case",
        ["get", "selected"],
        "geolibre-marker-circle-339084-18",
        "geolibre-marker-circle-fde725-18",
      ],
      10,
      [
        "case",
        ["get", "selected"],
        "geolibre-marker-circle-fde725-18",
        "geolibre-marker-circle-339084-18",
      ],
    ]);
  });

  it("selects a marker per class for graduated stops", () => {
    assert.deepEqual(
      markerImageValue(
        categorizedMarker({
          vectorStyleMode: "graduated",
          vectorStyleProperty: "pop",
          vectorStyleStops: [
            { value: 0, color: "#339084" },
            { value: 100, color: "#fde725" },
          ],
        }),
      ),
      [
        "step",
        ["to-number", ["get", "pop"], 0],
        "geolibre-marker-circle-339084-18",
        100,
        "geolibre-marker-circle-fde725-18",
      ],
    );
  });

  it("bakes the canonical color for shorthand and upper-case hex outputs", () => {
    const value = markerImageValue(
      categorizedMarker({
        vectorStyleMode: "expression",
        vectorStyleExpression: '["match",["get","status"],"good","fff","#FDE725"]',
      }),
    );

    assert.ok(Array.isArray(value));
    // "fff" would be handed to fillStyle verbatim and draw black.
    assert.equal(value[3], "geolibre-marker-circle-ffffff-18");
    assert.equal(value[4], "geolibre-marker-circle-fde725-18");
  });

  it("bakes the else-rule color when no rule is drawable", () => {
    const value = markerImageValue(
      categorizedMarker({
        vectorStyleMode: "rule-based",
        vectorRules: [
          {
            id: "else",
            label: "Other",
            filter: "",
            color: "#fde725",
            enabled: true,
            isElse: true,
          },
        ],
      }),
    );

    assert.equal(value, "geolibre-marker-circle-fde725-18");
  });

  it("keeps categorized marker fallback inside a mixed KML icon expression", () => {
    const markerImage = markerImageValue(categorizedMarker());
    const value = prepareKmlFeatureIcons(
      {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [0, 0] },
            properties: { [KML_ICON_URL_PROPERTY]: "data:image/png;base64,AA==" },
          },
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [1, 1] },
            properties: { status: "good" },
          },
        ],
      },
      markerImage,
    );

    assert.ok(Array.isArray(value));
    assert.deepEqual(value[value.length - 1], markerImage);
  });
});

describe("custom SVG marker fetches", () => {
  it("retries a remote SVG whose first fetch failed", async () => {
    // Run the registered sprite factory the way styleimagemissing does.
    let missing: ((event: { id: string }) => void) | undefined;
    const map = {
      on: (_event: string, handler: (event: { id: string }) => void) => {
        missing = handler;
      },
      hasImage: () => false,
      addImage: () => {},
    };
    ensureGeneratedImageHandler(map as never);

    // The sprite is rasterized through an Image; erroring out keeps the test
    // off the canvas APIs while still exercising the fetch path.
    class StubImage {
      decoding = "";
      crossOrigin = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    const previousImage = globalThis.Image;
    const previousFetch = globalThis.fetch;
    let calls = 0;
    globalThis.Image = StubImage as never;
    globalThis.fetch = (() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("offline"))
        : Promise.resolve({ ok: true, text: () => Promise.resolve("<svg/>") });
    }) as never;

    try {
      const id = prepareMarker(
        categorizedMarker({
          markerShape: "custom",
          markerSvg: "https://example.com/retry.svg",
          vectorStyleMode: "single",
        }),
      );
      assert.ok(id);
      missing?.({ id });
      await new Promise((resolve) => setTimeout(resolve, 0));
      missing?.({ id });
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      globalThis.Image = previousImage;
      globalThis.fetch = previousFetch;
    }

    // A failed fetch must not be cached, or the marker stays uncolorized for
    // the rest of the session.
    assert.equal(calls, 2);
  });
});
