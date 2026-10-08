import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { MAX_VECTOR_BYTES } from "../packages/plugins/src/plugins/remote-file-formats";
import {
  citedSections,
  contractMessage,
  packageDir,
  readPackageFile,
  readPublishedText,
  readRepoFile,
} from "./helpers/upstream-contract";

/**
 * Contract tests for the upstream internals GeoLibre mirrors by hand (#2858).
 *
 * Every entry under "Dependency bumps that need a manual check" in
 * docs/maintenance.md describes something an upstream package does not export
 * — a class name, a private field, a constant, the shape of a function body —
 * that GeoLibre copies or patches. A bump that moves one fails no build; the
 * feature just stops working. Each test below checks the **installed**
 * package (never a fake) for exactly the shape GeoLibre relies on, so a
 * Dependabot bump that breaks a mirror fails `npm run test:frontend` with a
 * message naming the section to read.
 *
 * Packages that import cleanly under Node are exercised directly (a real
 * constructor, a real prototype). Packages that touch the DOM/WebGL at load,
 * and contracts that live inside a function body, are checked against the
 * published files' text instead; those tests say so.
 *
 * Mirrors with their own dedicated real-package tests are not repeated here
 * (GlobeControl, blend modes, PMTiles ids, basemap DOM, lidar canvas class,
 * point-cloud colours, zarr-cesium, raster picker, deck.gl `_props`,
 * Tileset3D, style-spec). `tauri-plugin-persisted-scope` is a Rust mirror,
 * covered by the Rust tests in `apps/geolibre-desktop/src-tauri/src/lib.rs`.
 */

/** Matches `cls` as a whole class token, not as a prefix of a longer one. */
function hasClassToken(text: string, cls: string): boolean {
  const escaped = cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(text);
}

/**
 * The text of a function's own source, for contracts inside a method body.
 *
 * @param fn - A function read off a real prototype.
 * @returns Its source text.
 */
function sourceOf(fn: unknown): string {
  assert.equal(typeof fn, "function", "expected a function on the upstream prototype");
  return (fn as (...args: unknown[]) => unknown).toString();
}

/**
 * The literal a repository source file assigns to a top-level constant, for
 * mirrors kept in modules a test cannot cheaply import.
 *
 * @param file - Repo-relative path.
 * @param name - The constant's name.
 * @returns The text between `=` and the terminating `;`.
 */
function repoConstant(file: string, name: string): string {
  const match = readRepoFile(file).match(new RegExp(`const ${name}\\s*=\\s*([\\s\\S]*?);\\n`));
  assert.ok(match, `${file} no longer declares ${name}; update tests/upstream-contracts.test.ts`);
  return match[1];
}

describe("maplibre-gl", () => {
  const section = "`maplibre-gl`";

  it("still offsets the default Marker pin by DEFAULT_MARKER_OFFSET_Y", () => {
    // Text check: the offset is assigned inside the Marker constructor, which
    // needs a DOM to run, and is not exposed on the instance's public API.
    const mirror = Number(
      repoConstant(
        "apps/geolibre-desktop/src/components/storymap/storymap-engine.ts",
        "DEFAULT_MARKER_OFFSET_Y",
      ),
    );
    const text = readPublishedText("maplibre-gl", { dir: "dist" });
    // The first offset assigned after the constructor flags the default pin;
    // a custom element gets `[0,0]` in the branch before it.
    const match = text.match(
      /_defaultMarker=!0[\s\S]*?_offset=\w+\.convert\(\w+\?\.offset\|\|\[0,(-?\d+)\]\)/,
    );
    assert.ok(
      match,
      contractMessage(
        "maplibre-gl",
        section,
        "the Marker constructor no longer defaults its offset with `options?.offset || [0, N]`",
      ),
    );
    assert.equal(
      Number(match[1]),
      mirror,
      contractMessage(
        "maplibre-gl",
        section,
        `the default Marker pin offset is now ${match[1]} px, DEFAULT_MARKER_OFFSET_Y is ${mirror}`,
      ),
    );
  });

  it("keeps a geojson source's data on `_data` as `{ geojson }`", async () => {
    const maplibre = await import("maplibre-gl");
    const GeoJSONSource = maplibre.GeoJSONSource as unknown as new (
      id: string,
      options: { type: "geojson"; data: GeoJSON.GeoJSON },
      dispatcher: unknown,
      parent: unknown,
    ) => { _data?: unknown; setData(data: GeoJSON.GeoJSON): unknown };
    const dispatcher = { getActor: () => ({ sendAsync: async () => ({}) }) };
    const initial: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
    const source = new GeoJSONSource(
      "contract",
      { type: "geojson", data: initial },
      dispatcher,
      undefined,
    );
    const next: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [1, 2] } },
      ],
    };
    source.setData(next);
    assert.deepEqual(
      source._data,
      { geojson: next },
      contractMessage(
        "maplibre-gl",
        "`maplibre-gl-lidar` (`packages/plugins/package.json`) — half checked by the compiler",
        "GeoJSONSource no longer stores setData's value as `_data.geojson` (lidar-measure-mirror reads it)",
      ),
    );
  });
});

describe("mapbox-gl", () => {
  it("keeps a geojson source's data on `_data` as the raw value", () => {
    // Text check: mapbox-gl touches `window` at import time.
    const text = readPublishedText("mapbox-gl", { workspace: "packages/map", dir: "dist" });
    assert.match(
      text,
      /setData\((\w+)\)\{return this\._data=\1[,;]/,
      contractMessage(
        "mapbox-gl",
        "`maplibre-gl-lidar` (`packages/plugins/package.json`) — half checked by the compiler",
        "GeoJSONSource.setData no longer stores its argument on `_data` (lidar-measure-mirror reads it)",
        "packages/map",
      ),
    );
  });
});

describe("@carbonplan/zarr-layer", () => {
  it("looks up the shift/world-offset uniforms without throwing", () => {
    // Text check: the lookup is inside the WebGL program factory.
    const section = "Patched packages (`patches/`)";
    const text = readPublishedText("@carbonplan/zarr-layer", { workspace: "packages/plugins" });
    for (const uniform of ["shift_x", "shift_y", "u_worldXOffset"]) {
      assert.ok(
        text.includes(`gl.getUniformLocation(program, "${uniform}")`),
        contractMessage(
          "@carbonplan/zarr-layer",
          section,
          `createShaderProgram no longer looks up "${uniform}" with gl.getUniformLocation`,
          "packages/plugins",
        ),
      );
      assert.ok(
        !text.includes(`mustGetUniformLocation(gl, program, "${uniform}")`),
        contractMessage(
          "@carbonplan/zarr-layer",
          section,
          `createShaderProgram looks up "${uniform}" with the throwing mustGetUniformLocation again (Mesa GPUs lose the layer at zoom >= 12)`,
          "packages/plugins",
        ),
      );
    }
  });

  it("gates its own fetches on the private minZoom the Dynamical plugin writes", () => {
    const section = "`@carbonplan/zarr-layer` — private `minZoom`";
    const text = readPublishedText("@carbonplan/zarr-layer", { workspace: "packages/plugins" });
    for (const [token, what] of [
      ["this.minZoom = minzoom", "the constructor no longer stores `minzoom` on `this.minZoom`"],
      ["zoom >= this.minZoom", "isZoomInRange no longer reads `this.minZoom`"],
    ]) {
      assert.ok(
        text.includes(token),
        contractMessage("@carbonplan/zarr-layer", section, what, "packages/plugins"),
      );
    }
  });
});

describe("Web Services control packages", () => {
  const section = "Web Services control packages (`packages/plugins/package.json`)";
  // The class names `index.css` styles each docked panel through. Text check:
  // the controls build their DOM in onAdd and ship their CSS as files.
  const mirrored: Record<string, string[]> = {
    "maplibre-gl-fema-wms": [
      "plugin-control",
      "plugin-control-panel",
      "plugin-control-header",
      "plugin-control-close",
      "plugin-control-content",
      "plugin-control-resize-handle",
      "plugin-control-toggle",
      "fema-wms-popup",
    ],
    "maplibre-gl-nasa-earthdata": [
      "plugin-control",
      "plugin-control-panel",
      "plugin-control-header",
      "plugin-control-close",
      "plugin-control-content",
      "plugin-control-toggle",
      "maplibre-gl-nasa-earthdata",
      "nasa-body",
      "nasa-category",
      "nasa-category-layers",
      "nasa-layer-info",
      "nasa-layer-main",
      "nasa-layer-row",
      "nasa-layer-title",
      "nasa-results",
    ],
    "maplibre-gl-enviroatlas": [
      "enviroatlas-control",
      "enviroatlas-panel",
      "enviroatlas-header",
      "enviroatlas-close",
      "enviroatlas-resizer",
      "enviroatlas-toggle",
    ],
    "maplibre-gl-national-map": [
      "national-map",
      "national-map-panel",
      "national-map-header",
      "national-map-close",
      "national-map-resize-handle",
      "national-map-toggle",
    ],
  };
  const css = readRepoFile("apps/geolibre-desktop/src/index.css");

  for (const [pkg, classes] of Object.entries(mirrored)) {
    it(`${pkg} still renders the classes index.css styles`, () => {
      const text = readPublishedText(pkg, { workspace: "packages/plugins" });
      for (const cls of classes) {
        assert.ok(
          hasClassToken(css, `.${cls}`),
          `index.css no longer styles .${cls}; drop it from the mirrored list in tests/upstream-contracts.test.ts`,
        );
        assert.ok(
          hasClassToken(text, cls),
          contractMessage(
            pkg,
            section,
            `the published files no longer contain the class "${cls}"`,
            "packages/plugins",
          ),
        );
      }
    });
  }
});

describe("maplibre-gl-components", () => {
  const section = "`maplibre-gl-components` (`packages/plugins/package.json`)";

  it("still renders the panel classes Record Video rasterizes", () => {
    // Text check: the selector lives in a React component, and the classes are
    // set inside each control's onAdd.
    const selector = repoConstant(
      "apps/geolibre-desktop/src/components/layout/RecordVideoDialog.tsx",
      "MAP_PANEL_SELECTOR",
    );
    const classes = [...selector.matchAll(/\.(maplibre-gl-[\w-]+)/g)].map((m) => m[1]);
    assert.deepEqual(classes.sort(), [
      "maplibre-gl-colorbar",
      "maplibre-gl-html-control",
      "maplibre-gl-legend",
    ]);
    const text = readPublishedText("maplibre-gl-components", { workspace: "packages/plugins" });
    for (const cls of classes) {
      assert.ok(
        hasClassToken(text, cls),
        contractMessage(
          "maplibre-gl-components",
          section,
          `no rendered control carries the class "${cls}" (MAP_PANEL_SELECTOR)`,
          "packages/plugins",
        ),
      );
    }
  });

  it("keeps MeasureControl's private `_panel` and `_sourceId`", async () => {
    const { MeasureControl } = await import("maplibre-gl-components");
    const control = new MeasureControl({}) as unknown as Record<string, unknown>;
    assert.ok(
      "_panel" in control,
      contractMessage(
        "maplibre-gl-components",
        section,
        "MeasureControl has no `_panel` field (measurePanelElement)",
      ),
    );
    assert.equal(
      typeof control._sourceId,
      "string",
      contractMessage(
        "maplibre-gl-components",
        section,
        "MeasureControl has no string `_sourceId` field (measureSourceId)",
      ),
    );
    assert.ok((control._sourceId as string).length > 0);
  });
});

describe("maplibre-gl-vector", () => {
  const section = "`maplibre-gl-vector` (`packages/plugins/package.json`)";
  // Text check: both values are module-private in the control's chunk.
  const text = () => readPublishedText("maplibre-gl-vector", { workspace: "packages/plugins" });

  it("still caps remote files at MAX_VECTOR_BYTES", () => {
    // Accepts `N` or `B ** E - S` (the 2 GiB - 1 form it ships as), parsed by
    // hand rather than evaluated.
    const match = text().match(
      /MAX_REMOTE_FILE_BYTES\s*=\s*(\d+)(?:\s*\*\*\s*(\d+)\s*-\s*(\d+))?\s*;/,
    );
    assert.ok(
      match,
      contractMessage(
        "maplibre-gl-vector",
        section,
        "MAX_REMOTE_FILE_BYTES is gone or no longer `N` / `B ** E - S`",
        "packages/plugins",
      ),
    );
    const [, base, exponent, subtrahend] = match;
    const upstream =
      exponent === undefined ? Number(base) : Number(base) ** Number(exponent) - Number(subtrahend);
    assert.equal(
      upstream,
      MAX_VECTOR_BYTES,
      contractMessage(
        "maplibre-gl-vector",
        section,
        `MAX_REMOTE_FILE_BYTES is ${upstream}, MAX_VECTOR_BYTES is ${MAX_VECTOR_BYTES}`,
        "packages/plugins",
      ),
    );
  });

  it("still filters KML icons on KML_ICON_PROPERTY", () => {
    const mirror = JSON.parse(
      repoConstant("packages/plugins/src/plugins/vector-layer-sync.ts", "KML_ICON_PROPERTY"),
    ) as string;
    assert.ok(
      text().includes(`["has", ${JSON.stringify(mirror)}]`),
      contractMessage(
        "maplibre-gl-vector",
        section,
        `the KML icon layer no longer filters on ["has", "${mirror}"]`,
        "packages/plugins",
      ),
    );
  });
});

describe("maplibre-gl-lidar", () => {
  it("still routes streamed clouds the way isStreamedLidarUrl copies", async () => {
    const { LidarControl } = await import("maplibre-gl-lidar");
    const body = sourceOf(LidarControl.prototype.loadPointCloud);
    for (const snippet of [
      'source.endsWith("/ept.json")',
      'source.includes("/ept.json?")',
      "/\\.copc\\./i.test(source)",
    ]) {
      assert.ok(
        body.includes(snippet),
        contractMessage(
          "maplibre-gl-lidar",
          "`maplibre-gl-lidar` (`packages/plugins/package.json`) — half checked by the compiler",
          `LidarControl.loadPointCloud no longer routes on \`${snippet}\` (isStreamedLidarUrl in data-url.ts)`,
        ),
      );
    }
  });
});

describe("maplibre-gl-layer-control", () => {
  const section = "`maplibre-gl-layer-control` (`packages/map/package.json`) — private internals";

  it("keeps the private members LayerControlInternalState lists", async () => {
    const { LayerControl } = await import("maplibre-gl-layer-control");
    const control = new LayerControl({}) as unknown as Record<string, unknown> & {
      state?: Record<string, unknown>;
    };
    for (const field of ["panel", "basemapLayerIds", "state"]) {
      assert.ok(
        field in control,
        contractMessage(
          "maplibre-gl-layer-control",
          section,
          `LayerControl has no \`${field}\` field`,
          "packages/map",
        ),
      );
    }
    assert.equal(
      typeof control.state?.collapsed,
      "boolean",
      contractMessage(
        "maplibre-gl-layer-control",
        section,
        "`state.collapsed` is not a boolean",
        "packages/map",
      ),
    );
    assert.ok(
      control.state && "layerStates" in control.state,
      contractMessage(
        "maplibre-gl-layer-control",
        section,
        "LayerControl has no `state.layerStates`",
        "packages/map",
      ),
    );
    assert.equal(
      typeof (LayerControl.prototype as unknown as Record<string, unknown>).buildLayerItems,
      "function",
      contractMessage(
        "maplibre-gl-layer-control",
        section,
        "LayerControl has no `buildLayerItems()` method",
        "packages/map",
      ),
    );
  });

  it("still renders the row DOM the host patches in place", () => {
    // Text check: rows are built in onAdd against a live map.
    const text = readPublishedText("maplibre-gl-layer-control", { workspace: "packages/map" });
    for (const cls of [
      "maplibregl-ctrl-layer-control",
      "layer-control-item",
      "layer-control-checkbox",
      "layer-control-opacity",
      "layer-control-name",
    ]) {
      assert.ok(
        hasClassToken(text, cls),
        contractMessage(
          "maplibre-gl-layer-control",
          section,
          `no element carries the class "${cls}"`,
          "packages/map",
        ),
      );
    }
    assert.ok(
      text.includes("dataset.layerId"),
      contractMessage(
        "maplibre-gl-layer-control",
        section,
        "rows no longer carry `data-layer-id` via dataset.layerId",
        "packages/map",
      ),
    );
  });
});

describe("maplibre-gl-splat", () => {
  const section = "`maplibre-gl-splat` (`packages/plugins/package.json`) — private internals";

  it("keeps the private fields splatting.ts reserves ids and placements through", async () => {
    const { GaussianSplatControl } = await import("maplibre-gl-splat");
    const control = new GaussianSplatControl({}) as unknown as {
      _layerCounter?: unknown;
      _modelCounter?: unknown;
      _splatLayers?: unknown;
      _modelLayers?: unknown;
      _state?: { rotation?: unknown; scale?: unknown };
      _options?: { defaultModelRotation?: unknown; flyTo?: unknown };
    };
    const message = (detail: string) =>
      contractMessage("maplibre-gl-splat", section, detail, "packages/plugins");
    assert.equal(control._layerCounter, 0, message("`_layerCounter` no longer starts at 0"));
    assert.equal(control._modelCounter, 0, message("`_modelCounter` no longer starts at 0"));
    assert.ok(control._splatLayers instanceof Map, message("`_splatLayers` is not a Map"));
    assert.ok(control._modelLayers instanceof Map, message("`_modelLayers` is not a Map"));
    assert.ok(
      Array.isArray(control._state?.rotation),
      message("`_state.rotation` is not an array"),
    );
    assert.equal(typeof control._state?.scale, "number", message("`_state.scale` is not a number"));
    assert.ok(
      Array.isArray(control._options?.defaultModelRotation),
      message("`_options.defaultModelRotation` is not an array"),
    );
    assert.equal(
      typeof control._options?.flyTo,
      "boolean",
      message("`_options.flyTo` is not a boolean"),
    );
  });

  it("still names assets from the counters and records their placement", async () => {
    const { GaussianSplatControl } = await import("maplibre-gl-splat");
    const message = (detail: string) =>
      contractMessage("maplibre-gl-splat", section, detail, "packages/plugins");
    const cases = [
      {
        method: "loadSplat",
        id: "`splat-${this._layerCounter++}`",
        map: "_splatLayers",
        rotation: "this._state.rotation",
      },
      {
        method: "loadModel",
        id: "`model-${this._modelCounter++}`",
        map: "_modelLayers",
        rotation: "this._options.defaultModelRotation",
      },
    ] as const;
    for (const { method, id, map, rotation } of cases) {
      const body = sourceOf(
        (GaussianSplatControl.prototype as unknown as Record<string, unknown>)[method],
      );
      assert.ok(body.includes(id), message(`${method} no longer names assets ${id}`));
      assert.match(
        body,
        new RegExp(`this\\.${map}\\.set\\(\\w+, \\{[^}]*longitude[^}]*latitude[^}]*altitude`),
        message(`${method} no longer records longitude/latitude/altitude in ${map}`),
      );
      assert.ok(
        body.includes(`?? ${rotation}`),
        message(`${method} no longer defaults rotation from ${rotation}`),
      );
      assert.ok(
        body.includes("this._options.flyTo"),
        message(`${method} no longer consults _options.flyTo`),
      );
    }
  });
});

describe("@geoman-io/maplibre-geoman-free", () => {
  const section =
    "`@geoman-io/maplibre-geoman-free` (`packages/plugins/package.json`) — change-mode internals";

  // Text check: Geoman needs a live map to construct, and the hook points are
  // inside its action classes. Both workspaces nest their own copy, and the
  // app loads those, not the root one.
  for (const workspace of ["packages/plugins", "apps/geolibre-desktop"]) {
    it(`keeps the change-mode cutVertex hook points (${workspace} copy)`, () => {
      const text = readPublishedText("@geoman-io/maplibre-geoman-free", { workspace });
      const types = readPackageFile(
        "@geoman-io/maplibre-geoman-free",
        "dist/maplibre-geoman.d.ts",
        workspace,
      );
      const message = (detail: string) =>
        contractMessage("@geoman-io/maplibre-geoman-free", section, detail, workspace);
      assert.ok(
        text.includes("actionInstances = {}"),
        message("Geoman no longer has a plain `actionInstances` object"),
      );
      assert.ok(
        text.includes("this.gm.actionInstances[e] = n"),
        message(
          "actions are no longer registered by assigning `gm.actionInstances[key]` (the Proxy set trap)",
        ),
      );
      assert.ok(
        text.includes("`${e.actionType}__${e.mode}`"),
        message(
          "action instance keys are no longer `${actionType}__${mode}` (GeoLibre hooks `edit__change`)",
        ),
      );
      assert.match(
        text,
        /mode = "change";\s*cutVertexShapeTypes = \[/,
        message("the change-mode action class no longer declares cutVertexShapeTypes"),
      );
      assert.ok(
        text.includes("await this.cutVertex(e)"),
        message(
          "change mode no longer calls `this.cutVertex(e)`, so an instance override would be bypassed",
        ),
      );
      assert.match(
        text,
        /async cutVertex\(e\) \{\s*let t = e\.featureData;\s*if \(e\.markerData\.type !== "vertex"/,
        message("cutVertex no longer reads `featureData` / `markerData.type` from its event"),
      );
      assert.ok(text.includes("this.gm.features.delete("), message("`gm.features.delete` is gone"));
      assert.ok(
        text.includes("EditChange.cutVertex: feature not updated"),
        message("the MultiLineString failure log moved; check whether upstream now supports it"),
      );
      assert.ok(
        /fireFeatureUpdatedEvent\(\{\s*sourceFeatures,\s*targetFeatures,\s*markerData/.test(types),
        message(
          "fireFeatureUpdatedEvent no longer takes { sourceFeatures, targetFeatures, markerData }",
        ),
      );
      assert.match(
        types,
        /interface PositionData \{\s*coordinate: LngLatTuple;\s*path: Array<string \| number>;/,
        message("vertex marker positions no longer carry { coordinate, path }"),
      );
    });
  }
});

describe("maplibre-gl-planetary-computer", () => {
  const section =
    "`maplibre-gl-planetary-computer` (`packages/plugins/package.json`) — private STAC client";

  it("keeps the private STAC client fields the CORS-safe subclass reuses", async () => {
    const { PlanetaryComputerControl, STACClient } = await import("maplibre-gl-planetary-computer");
    const message = (detail: string) =>
      contractMessage("maplibre-gl-planetary-computer", section, detail, "packages/plugins");
    const client = new STACClient() as unknown as Record<string, unknown>;
    assert.ok("abortController" in client, message("STACClient has no `abortController` field"));
    const proto = STACClient.prototype as unknown as Record<string, unknown>;
    for (const method of ["fetch", "getBaseUrl", "getCollections", "search", "searchWithContext"]) {
      assert.equal(
        typeof proto[method],
        "function",
        message(`STACClient has no \`${method}\` method`),
      );
    }
    assert.match(
      sourceOf(proto.fetch),
      /^async fetch\(\w+, \w+\)/,
      message("STACClient.fetch is no longer fetch(path, init)"),
    );

    const original = STACClient.prototype.getCollections;
    let loads = 0;
    STACClient.prototype.getCollections = async function () {
      loads++;
      return [];
    };
    try {
      const control = new PlanetaryComputerControl({}) as unknown as Record<string, unknown>;
      assert.ok(
        control._stacClient instanceof STACClient,
        message("the control no longer keeps its client on `_stacClient`"),
      );
      assert.equal(
        loads,
        0,
        message("the control now loads collections in its constructor, before the swap"),
      );
    } finally {
      STACClient.prototype.getCollections = original;
    }
  });

  it("issues only GET requests outside search", async () => {
    const { STACClient } = await import("maplibre-gl-planetary-computer");
    const methods: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      return new Response(JSON.stringify({ collections: [], features: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const client = new STACClient();
      await client.getCollections();
      await client.getCollection("x");
      await client.getCollectionItems("x");
      await client.getItem("x", "y");
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.deepEqual(
      methods,
      ["GET", "GET", "GET", "GET"],
      contractMessage(
        "maplibre-gl-planetary-computer",
        section,
        "a STACClient read now sends a non-GET request, which the Planetary Computer API rejects cross-origin",
        "packages/plugins",
      ),
    );
  });
});

describe("maplibre-gl-raster", () => {
  const section = "`maplibre-gl-raster` — stretch and gamma curves";

  it("still applies stretch then gamma with the curves the opacity mirror inverts", () => {
    // Text check: pushAdjustments and the shader modules are module-private.
    const text = readPublishedText("maplibre-gl-raster", { workspace: "packages/plugins" });
    const message = (detail: string) =>
      contractMessage("maplibre-gl-raster", section, detail, "packages/plugins");
    const body = text.match(/function pushAdjustments\(state, pipeline\) \{([\s\S]*?)\n\}/)?.[1];
    assert.ok(body, message("pushAdjustments(state, pipeline) is gone"));
    assert.match(
      body,
      /module: LogStretch,\s*props: \{ strength: 99 \}/,
      message("the log stretch strength is no longer 99"),
    );
    assert.ok(body.includes("module: SqrtStretch"), message("the sqrt stretch module is gone"));
    assert.ok(
      body.indexOf("module: Gamma") > body.indexOf("module: SqrtStretch"),
      message("gamma no longer runs after the stretch"),
    );
    assert.ok(
      text.includes("color.rgb = log(1.0 + k * x) / log(1.0 + k);"),
      message("the log stretch curve changed"),
    );
    assert.ok(
      text.includes("color.rgb = sqrt(clamp(color.rgb, 0.0, 1.0));"),
      message("the sqrt stretch curve changed"),
    );
    assert.ok(
      text.includes(
        "pow(clamp(color.rgb, 0.0, 1.0), vec3(1.0 / max(gammaModule.gammaValue, 0.0001)))",
      ),
      message("the gamma curve changed"),
    );
  });
});

describe("cesium / @cesium/widgets", () => {
  const section = "`cesium` / `@cesium/engine` / `@cesium/widgets` — runtime assets fetched by URL";
  const buildDir = path.join(packageDir("cesium", "apps/geolibre-desktop"), "Build/Cesium");

  it("ships exactly the runtime directories the asset copy stages", () => {
    const runtimeDirs = JSON.parse(
      repoConstant(
        "apps/geolibre-desktop/vite-plugins/copy-cesium-assets.ts",
        "RUNTIME_DIRS",
      ).replace(/\s*as const$/, ""),
    ) as string[];
    const shipped = readdirSync(buildDir).filter((entry) =>
      statSync(path.join(buildDir, entry)).isDirectory(),
    );
    assert.deepEqual(
      shipped.sort(),
      [...runtimeDirs].sort(),
      contractMessage(
        "cesium",
        section,
        "Build/Cesium's directories no longer match RUNTIME_DIRS (an added one is never copied and 404s at runtime)",
        "apps/geolibre-desktop",
      ),
    );
  });

  it("still ships every stylesheet the globe links and the classes index.css restyles", () => {
    const paths = [
      ...repoConstant("packages/map/src/CesiumCanvas.tsx", "CESIUM_CSS_PATHS").matchAll(
        /"(\/Widgets\/[^"]+)"/g,
      ),
    ].map((m) => m[1]);
    assert.ok(
      paths.length > 0,
      "CESIUM_CSS_PATHS parsed empty; update tests/upstream-contracts.test.ts",
    );
    for (const css of paths) {
      assert.ok(
        existsSync(path.join(buildDir, css)),
        contractMessage(
          "cesium",
          section,
          `Build/Cesium${css} is gone (CESIUM_CSS_PATHS)`,
          "apps/geolibre-desktop",
        ),
      );
    }
    const cesiumCss = paths
      .map((css) => readPackageFile("cesium", `Build/Cesium${css}`, "apps/geolibre-desktop"))
      .join("\n");
    const appCss = readRepoFile("apps/geolibre-desktop/src/index.css");
    const restyled = [...new Set([...appCss.matchAll(/\.(cesium-[\w-]+)/g)].map((m) => m[1]))];
    assert.ok(restyled.length > 0);
    for (const cls of restyled) {
      assert.ok(
        hasClassToken(cesiumCss, cls),
        contractMessage(
          "cesium",
          section,
          `index.css restyles .${cls}, which no linked Cesium stylesheet defines any more`,
          "apps/geolibre-desktop",
        ),
      );
    }
  });

  it("keeps the widget view-model observables the toolbar translates", () => {
    // Text check: @cesium/widgets touches `window` at import time.
    const read = (file: string) => readPackageFile("@cesium/widgets", file, "packages/map");
    const message = (detail: string) =>
      contractMessage("@cesium/widgets", section, detail, "packages/map");
    assert.match(
      read("Source/HomeButton/HomeButtonViewModel.js"),
      /knockout\.track\(this, \[\s*"tooltip"\s*\]\)/,
      message("HomeButtonViewModel no longer tracks `tooltip`"),
    );
    const sceneMode = read("Source/SceneModePicker/SceneModePickerViewModel.js");
    for (const field of ["tooltip2D", "tooltip3D", "tooltipColumbusView"]) {
      assert.ok(
        sceneMode.includes(`"${field}"`),
        message(`SceneModePickerViewModel no longer tracks \`${field}\``),
      );
    }
    const fullscreen = read("Source/FullscreenButton/FullscreenButtonViewModel.js");
    for (const field of ["isFullscreen", "isFullscreenEnabled"]) {
      assert.ok(
        fullscreen.includes(`this.${field} =`),
        message(`FullscreenButtonViewModel has no \`${field}\``),
      );
    }
  });
});

describe("failure messages", () => {
  it("cite sections that exist in docs/maintenance.md", () => {
    const headings = new Set(
      readRepoFile("docs/maintenance.md")
        .split("\n")
        .filter((line) => line.startsWith("### "))
        .map((line) => line.slice(4).trim()),
    );
    assert.ok(citedSections.size > 0);
    for (const section of citedSections) {
      assert.ok(
        headings.has(section),
        `contract messages cite a missing docs/maintenance.md heading: ${section}`,
      );
    }
  });
});
