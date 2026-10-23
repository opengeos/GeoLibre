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

  it("shares one sprite across categories for a raster image marker", () => {
    // A PNG cannot be recolored, so baking a copy per class color is waste.
    for (const markerSvg of ["data:image/png;base64,AA==", "https://example.com/sign.png"]) {
      const value = markerImageValue(categorizedMarker({ markerShape: "custom", markerSvg }));
      assert.ok(Array.isArray(value));
      assert.equal(new Set([value[3], value[5], value[6]]).size, 1);
    }
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
        : Promise.resolve({
            ok: true,
            headers: new Headers({ "content-type": "image/svg+xml" }),
            text: () => Promise.resolve("<svg/>"),
          });
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

describe("custom image marker sources", () => {
  // Bake one marker and report what the rasterizing Image was asked to load,
  // plus how many times the source was fetched.
  async function loadedSource(
    markerSvg: string,
    respond: (url: string) => { contentType: string; body: string },
  ): Promise<{ src: string | undefined; fetches: string[] }> {
    let missing: ((event: { id: string }) => void) | undefined;
    ensureGeneratedImageHandler({
      on: (_event: string, handler: (event: { id: string }) => void) => {
        missing = handler;
      },
      hasImage: () => false,
      addImage: () => {},
    } as never);
    let src: string | undefined;
    class StubImage {
      decoding = "";
      crossOrigin = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(value: string) {
        src = value;
        queueMicrotask(() => this.onerror?.());
      }
    }
    const fetches: string[] = [];
    const previousImage = globalThis.Image;
    const previousFetch = globalThis.fetch;
    globalThis.Image = StubImage as never;
    globalThis.fetch = ((url: string) => {
      fetches.push(url);
      const { contentType, body } = respond(url);
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": contentType } }),
      );
    }) as never;
    try {
      const id = prepareMarker(
        categorizedMarker({ markerShape: "custom", markerSvg, vectorStyleMode: "single" }),
        "#ff0000",
      );
      assert.ok(id);
      missing?.({ id });
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      globalThis.Image = previousImage;
      globalThis.fetch = previousFetch;
    }
    return { src, fetches };
  }

  const PARAM_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg"><path fill="param(fill)" d="M0 0h1v1z"/></svg>';

  it("colorizes inline SVG markup", async () => {
    const { src, fetches } = await loadedSource(PARAM_SVG, () => {
      throw new Error("inline markup must not be fetched");
    });
    assert.deepEqual(fetches, []);
    assert.ok(src?.startsWith("data:image/svg+xml"));
    assert.match(decodeURIComponent(src!), /fill="#ff0000"/);
  });

  it("loads a raster data URL as-is without fetching it", async () => {
    const url = "data:image/png;base64,iVBORw0KGgo=";
    const { src, fetches } = await loadedSource(url, () => {
      throw new Error("a raster data URL must not be fetched");
    });
    assert.deepEqual(fetches, []);
    assert.equal(src, url);
  });

  it("loads a remote PNG URL as an image instead of reading it as SVG text", async () => {
    const url = "https://example.com/icons/sign.png";
    const { src, fetches } = await loadedSource(url, () => {
      throw new Error("a .png URL must not be fetched as text");
    });
    assert.deepEqual(fetches, []);
    assert.equal(src, url);
  });

  it("passes a remote URL through when its content type is a raster image", async () => {
    const url = "https://example.com/icon?id=7";
    const { src, fetches } = await loadedSource(url, () => ({
      contentType: "image/png",
      body: "\u0089PNG binary",
    }));
    assert.deepEqual(fetches, [url]);
    assert.equal(src, url);
  });

  it("colorizes a remote SVG URL", async () => {
    const url = "https://example.com/icons/tree.svg?v=2";
    const { src, fetches } = await loadedSource(url, () => ({
      contentType: "image/svg+xml",
      body: PARAM_SVG,
    }));
    assert.deepEqual(fetches, [url]);
    assert.ok(src?.startsWith("data:image/svg+xml"));
    assert.match(decodeURIComponent(src!), /fill="#ff0000"/);
  });
});
