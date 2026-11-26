import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { NasaEarthdataControl } from "maplibre-gl-nasa-earthdata";
import { isolateMaplibreRegistry } from "../apps/geolibre-desktop/vite-plugins/isolate-maplibre-registry";
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
 * covered by the Rust tests in `apps/geolibre-desktop/src-tauri/src/image_scope.rs`.
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

describe("maplibre-gl and mapbox-gl class registries", () => {
  const file = (pkg: string, name: string) =>
    readFileSync(path.resolve("node_modules", pkg, "dist", name), "utf8");

  it("still collide on the property isolateMaplibreRegistry renames", () => {
    const maplibre = file("maplibre-gl", "maplibre-gl.mjs");
    const isolated = isolateMaplibreRegistry(
      maplibre,
      "/node_modules/maplibre-gl/dist/maplibre-gl.mjs",
    );
    assert.match(maplibre, /_classRegistryKey/, "see 'mapbox-gl' in docs/maintenance.md");
    assert.ok(isolated !== null, "the plugin must rewrite MapLibre's main bundle");
    assert.doesNotMatch(isolated, /_classRegistryKey/);
    assert.match(file("mapbox-gl", "mapbox-gl.js"), /_classRegistryKey/);
  });

  it("only rewrites MapLibre's main-thread bundle", () => {
    assert.equal(
      isolateMaplibreRegistry("_classRegistryKey", "/node_modules/mapbox-gl/dist/x.js"),
      null,
    );
    assert.equal(
      isolateMaplibreRegistry(
        "_classRegistryKey",
        "/node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs",
      ),
      null,
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

  it("still serializes map.getLayer and keeps a style's own layer on getOwnLayer", () => {
    // The Mapbox engine's plugin mirror identifies a native layer by
    // style.getOwnLayer (OwnedPaintResets), because map.getLayer returns a
    // fresh serialized copy. If getOwnLayer goes, dashes on plugin layers stop
    // resetting to solid with no error, so pin both halves here.
    const text = readPublishedText("mapbox-gl", { workspace: "packages/map", dir: "dist" });
    const message = contractMessage(
      "mapbox-gl",
      "`mapbox-gl`",
      "map.getLayer no longer serializes, or Style.getOwnLayer is gone (OwnedPaintResets reads it)",
      "packages/map",
    );
    assert.match(text, /getOwnLayer\(\w+(,\w+)?\)\{/, message);
    assert.match(text, /getLayer\(\w+\)\{[^}]*getOwnLayer\(\w+\)[^}]*serialize\(\)/, message);
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

  it("still renders the Zarr popup table class index.css re-themes", () => {
    // index.css overrides the popup table's hardcoded light-theme colours; a
    // rename would silently drop the override and bring back the dark-mode
    // contrast bug.
    const cls = "maplibre-gl-zarr-layer-popup-table";
    assert.ok(hasClassToken(readRepoFile("apps/geolibre-desktop/src/index.css"), cls));
    const text = readPublishedText("maplibre-gl-components", { workspace: "packages/plugins" });
    assert.ok(
      hasClassToken(text, cls),
      contractMessage(
        "maplibre-gl-components",
        section,
        `the Zarr layer popup no longer carries the class "${cls}" (index.css dark-mode override)`,
        "packages/plugins",
      ),
    );
  });

  it("still renders the PMTiles popup classes index.css re-themes", () => {
    // index.css re-keys the feature-picking popup's hardcoded white table onto
    // the theme tokens; a rename would silently bring back the white block in
    // dark mode.
    const classes = [
      "maplibre-gl-pmtiles-popup",
      "maplibre-gl-pmtiles-popup-header",
      "maplibre-gl-pmtiles-popup-table",
      "maplibre-gl-pmtiles-popup-key",
      "maplibre-gl-pmtiles-popup-value",
      "maplibre-gl-pmtiles-popup-empty",
    ];
    const css = readRepoFile("apps/geolibre-desktop/src/index.css");
    const text = readPublishedText("maplibre-gl-components", { workspace: "packages/plugins" });
    for (const cls of classes) {
      assert.ok(hasClassToken(css, cls));
      assert.ok(
        hasClassToken(text, cls),
        contractMessage(
          "maplibre-gl-components",
          section,
          `the PMTiles feature-picking popup no longer carries the class "${cls}" (index.css dark-mode override)`,
          "packages/plugins",
        ),
      );
    }
  });
});

describe("maplibre-gl-vector", () => {
  const section = "`maplibre-gl-vector` (`packages/plugins/package.json`)";
  // Both values are exported (0.12+); GeoLibre keeps copies so the startup
  // path never imports the control's chunk.

  it("still caps remote files at MAX_VECTOR_BYTES", async () => {
    const { MAX_REMOTE_FILE_BYTES } = await import("maplibre-gl-vector");
    assert.equal(
      MAX_REMOTE_FILE_BYTES,
      MAX_VECTOR_BYTES,
      contractMessage(
        "maplibre-gl-vector",
        section,
        `MAX_REMOTE_FILE_BYTES is ${MAX_REMOTE_FILE_BYTES}, MAX_VECTOR_BYTES is ${MAX_VECTOR_BYTES}`,
        "packages/plugins",
      ),
    );
  });

  it("still filters KML icons on KML_ICON_PROPERTY", async () => {
    const { KML_ICON_URL_PROPERTY } = await import("maplibre-gl-vector");
    const mirror = JSON.parse(
      repoConstant("packages/plugins/src/plugins/vector-layer-sync.ts", "KML_ICON_PROPERTY"),
    ) as string;
    assert.equal(
      mirror,
      KML_ICON_URL_PROPERTY,
      contractMessage(
        "maplibre-gl-vector",
        section,
        `KML_ICON_URL_PROPERTY is "${KML_ICON_URL_PROPERTY}", KML_ICON_PROPERTY is "${mirror}"`,
        "packages/plugins",
      ),
    );
  });
});

describe("maplibre-gl-lidar", () => {
  it("still routes streamed clouds the way isStreamedLidarUrl copies", async () => {
    // loadPointCloud routes through the exported isStreamedPointCloudUrl
    // (0.22+); data-url.ts keeps a copy to stay off the lidar chunk.
    const { isStreamedPointCloudUrl } = await import("maplibre-gl-lidar");
    const { isStreamedLidarUrl } = await import("../apps/geolibre-desktop/src/lib/data-url");
    for (const url of [
      "https://example.com/cloud/ept.json",
      "https://example.com/cloud/ept.json?token=1",
      "https://example.com/a.copc.laz",
      "https://example.com/A.COPC.LAZ?sig=x",
      "https://example.com/a.laz",
      "https://example.com/a.las",
      "https://example.com/ept.json.bak",
    ]) {
      assert.equal(
        isStreamedLidarUrl(url),
        isStreamedPointCloudUrl(url),
        contractMessage(
          "maplibre-gl-lidar",
          "`maplibre-gl-lidar` (`packages/plugins/package.json`) — half checked by the compiler",
          `isStreamedPointCloudUrl("${url}") disagrees with isStreamedLidarUrl in data-url.ts`,
        ),
      );
    }
  });
});

describe("maplibre-gl-raster", () => {
  // The package loads deck.gl and WebGL code, so this reads the published text.
  it("still keeps deck.gl rasters out of the depth buffer", () => {
    assert.ok(
      readPublishedText("maplibre-gl-raster").includes("depthWriteEnabled: false"),
      contractMessage(
        "maplibre-gl-raster",
        "`maplibre-gl-raster` — rasters stay out of the depth buffer",
        "the published bundle no longer sets `depthWriteEnabled: false` on raster layers",
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
    "`@geoman-io/maplibre-geoman-free` (`packages/plugins/package.json`) — change-mode and shape-marker internals";

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
      assert.match(
        text,
        /return this\.gm\.options\.settings\.snapDistance\s*;/,
        message("the snapping engine no longer reads options.settings.snapDistance"),
      );
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

    it(`keeps the shape-markers getSegmentMiddlePosition hook points (${workspace} copy)`, () => {
      const text = readPublishedText("@geoman-io/maplibre-geoman-free", { workspace });
      const message = (detail: string) =>
        contractMessage("@geoman-io/maplibre-geoman-free", section, detail, workspace);
      assert.match(
        text,
        /mode = "shape_markers";/,
        message(
          "the shape-markers helper mode is renamed (GeoLibre hooks `helper__shape_markers`)",
        ),
      );
      assert.match(
        text,
        /this\.gm\.actionInstances\[e\] = n, await n\.startAction\(\);/,
        message(
          "helpers are no longer registered before startAction(), so markers may be built before the patch",
        ),
      );
      assert.ok(
        text.includes("middle: this.getSegmentMiddlePosition("),
        message(
          "edge markers no longer get their position from `this.getSegmentMiddlePosition`, so the instance override is bypassed",
        ),
      );
      assert.match(
        text,
        /getSegmentMiddlePosition\(e\) \{\s*let t = this\.gm\.mapAdapter\.project\(e\.start\.coordinate\)/,
        message(
          "getSegmentMiddlePosition no longer takes a { start, end } segment, or no longer projects to the screen (check whether #3382 is fixed upstream)",
        ),
      );
      assert.ok(
        text.includes("e.start.path.slice(0, e.start.path.length - 1).concat([-1])"),
        message("edge marker paths are no longer the start's path ending in -1"),
      );
      assert.match(
        text,
        /n = \[\.\.\.e\.markerData\.segment\.end\.path\], r = n\.pop\(\)/,
        message("insertVertex no longer splices at the edge end's path"),
      );
    });
  }
});

describe("maplibre-gl-planetary-computer", () => {
  const section =
    "`maplibre-gl-planetary-computer` (`packages/plugins/package.json`): client, restore, and sync contract";
  const message = (detail: string) =>
    contractMessage("maplibre-gl-planetary-computer", section, detail, "packages/plugins");

  /** The parts of a MapLibre map the control's layer manager touches. */
  function fakeMap() {
    const sources = new Map<string, unknown>();
    let layers: Array<{
      id: string;
      layout: Record<string, unknown>;
      paint: Record<string, unknown>;
    }> = [];
    return {
      sources,
      order: () => layers.map((layer) => layer.id),
      getContainer: () => ({ appendChild() {}, classList: { add() {}, remove() {} } }),
      addSource: (id: string, source: unknown) => void sources.set(id, source),
      removeSource: (id: string) => void sources.delete(id),
      getSource: (id: string) => sources.get(id),
      addLayer: (layer: (typeof layers)[number], beforeId?: string) => {
        const index = beforeId ? layers.findIndex((candidate) => candidate.id === beforeId) : -1;
        if (index >= 0) layers.splice(index, 0, layer);
        else layers.push(layer);
      },
      removeLayer: (id: string) => {
        layers = layers.filter((layer) => layer.id !== id);
      },
      getLayer: (id: string) => layers.find((layer) => layer.id === id),
      getStyle: () => ({ layers }),
      setLayoutProperty: (id: string, name: string, value: unknown) => {
        const layer = layers.find((candidate) => candidate.id === id);
        if (layer) layer.layout[name] = value;
      },
      setPaintProperty: (id: string, name: string, value: unknown) => {
        const layer = layers.find((candidate) => candidate.id === id);
        if (layer) layer.paint[name] = value;
      },
    };
  }

  const item = {
    id: "ITEM",
    type: "Feature",
    stac_version: "1.0.0",
    geometry: { type: "Point", coordinates: [0, 0] },
    bbox: [-1, -1, 1, 1],
    properties: { datetime: "2024-01-01T00:00:00Z" },
    links: [],
    assets: { visual: { href: "https://example.test/visual.tif" } },
    collection: "sentinel-2-l2a",
  };

  it("uses the client it is given and loads nothing in its constructor", async () => {
    const { PlanetaryComputerControl, STACClient } = await import("maplibre-gl-planetary-computer");
    let loads = 0;
    const client = new STACClient(undefined, {
      fetch: (async () => {
        loads++;
        return new Response(JSON.stringify({ collections: [] }), { status: 200 });
      }) as typeof fetch,
    });
    const control = new PlanetaryComputerControl({ stacClient: client });
    assert.equal(
      control.getStacClient(),
      client,
      message("the control no longer uses the `stacClient` option"),
    );
    assert.equal(loads, 0, message("the control now loads collections in its constructor"));
  });

  it("searches with a GET and issues only GET requests for the other reads", async () => {
    const { STACClient } = await import("maplibre-gl-planetary-computer");
    const requests: string[] = [];
    const client = new STACClient("https://stac.test", {
      fetch: (async (url: unknown, init?: RequestInit) => {
        requests.push(`${init?.method ?? "GET"} ${String(url)}`);
        return new Response(JSON.stringify({ collections: [], features: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    await client.getCollections();
    await client.getCollection("x");
    await client.getCollectionItems("x");
    await client.getItem("x", "y");
    await client.search({ collections: ["x"], limit: 1 });
    assert.deepEqual(
      requests.map((request) => request.split(" ")[0]),
      ["GET", "GET", "GET", "GET", "GET"],
      message(
        "a STACClient read now sends a non-GET request, which the Planetary Computer API has rejected cross-origin",
      ),
    );
    assert.equal(
      requests[4],
      "GET https://stac.test/search?collections=x&limit=1",
      message("search is no longer a GET /search with the parameters in the query string"),
    );
  });

  it("re-creates a saved layer under its id and stores updates verbatim", async () => {
    const { PlanetaryComputerControl } = await import("maplibre-gl-planetary-computer");
    const control = new PlanetaryComputerControl({ autoLoadCollections: false });
    const map = fakeMap();
    // Test scaffolding only: `onAdd` builds the panel DOM, and there is no
    // document under `node --test`, so the control is attached by hand through
    // `_map`, `_layerManager`, and a no-op `_renderContent`. GeoLibre's own
    // code touches none of these. If an upstream rename breaks this setup, fix
    // the setup; the assertions below are the public behavior under contract.
    const internals = control as unknown as { _map: unknown; _layerManager: unknown };
    const { LayerManager } = await import("maplibre-gl-planetary-computer");
    internals._map = map;
    internals._layerManager = new LayerManager(map as never, control.getTilerClient());
    (control as unknown as { _renderContent: () => void })._renderContent = () => {};

    const events: string[] = [];
    control.on("layer:add", () => events.push("add"));
    control.on("layer:update", () => events.push("update"));

    map.addLayer({ id: "above", layout: {}, paint: {} });
    const layer = control.addItemLayer(item as never, {
      id: "saved-id",
      sourceId: "saved-source",
      visible: false,
      opacity: 0.37,
      beforeId: "above",
    });
    assert.equal(layer.id, "saved-id", message("addItemLayer ignores the `id` option"));
    assert.equal(layer.sourceId, "saved-source", message("addItemLayer ignores `sourceId`"));
    assert.deepEqual(map.order(), ["saved-id", "above"], message("`beforeId` is not honored"));
    assert.deepEqual(events, ["add"], message("addItemLayer no longer emits one layer:add"));

    // The store <-> control sync compares these with ===, so they must not be
    // coerced or rounded on the way through updateLayer.
    control.updateLayer("saved-id", { visible: true, opacity: 0.123456789 });
    const updated = control.getState().activeLayers.find((active) => active.id === "saved-id");
    assert.equal(updated?.opacity, 0.123456789, message("updateLayer rounds or coerces opacity"));
    assert.equal(updated?.visible, true, message("updateLayer coerces visible"));
    assert.deepEqual(events, ["add", "update"]);

    // With `mosaicId` the mosaic is added synchronously, which the restore path
    // relies on to add it while the store sync is suspended.
    const collection = { id: "sentinel-2-l2a", title: "Sentinel-2" };
    void control.addMosaicLayer(collection as never, {
      id: "mosaic-id",
      mosaicId: "pc1.search",
      searchParams: { datetime: "2024-06-01T00:00:00Z/2024-08-31T23:59:59Z" },
    });
    const mosaic = control.getState().activeLayers.find((active) => active.id === "mosaic-id");
    assert.ok(mosaic, message("addMosaicLayer with `mosaicId` no longer adds synchronously"));
    assert.equal(mosaic?.type, "mosaic");
    assert.match(
      String((map.sources.get(mosaic.sourceId) as { tiles: string[] }).tiles[0]),
      /\/mosaic\/pc1\.search\/tiles\/WebMercatorQuad\//,
      message("mosaic tiles are no longer served under the registered search id"),
    );
  });
});

describe("maplibre-gl-raster", () => {
  const section = "`maplibre-gl-raster` — stretch and gamma curves";

  it("inverts stretch and gamma like the opacity mirror", async () => {
    const { invertAdjustments, applyAdjustments } = await import("maplibre-gl-raster");
    const { invertRasterAdjustments } =
      await import("../packages/plugins/src/plugins/raster-symbology");
    for (const stretch of ["linear", "sqrt", "log"] as const) {
      for (const gamma of [0.4, 1, 2.2]) {
        for (let step = 0; step <= 16; step += 1) {
          const t = step / 16;
          const expected = invertAdjustments(t, { stretch, gamma });
          assert.ok(
            Math.abs(invertRasterAdjustments(t, stretch, gamma) - expected) < 1e-9,
            contractMessage(
              "maplibre-gl-raster",
              section,
              `invertAdjustments(${t}, { stretch: "${stretch}", gamma: ${gamma} }) is ${expected}, the mirror disagrees`,
              "packages/plugins",
            ),
          );
          // The exported inverse must still undo the exported forward curve.
          assert.ok(Math.abs(applyAdjustments(expected, { stretch, gamma }) - t) < 1e-6);
        }
      }
    }
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
    const appCss = [
      readRepoFile("apps/geolibre-desktop/src/index.css"),
      readRepoFile("apps/geolibre-desktop/src/styles/plugins/cesium-toolbar.css"),
    ].join("\n");
    const restyled = [...new Set([...appCss.matchAll(/\.(cesium-[\w-]+)/g)].map((m) => m[1]))];
    assert.ok(restyled.length > 0);
    for (const cls of restyled) {
      assert.ok(
        hasClassToken(cesiumCss, cls),
        contractMessage(
          "cesium",
          section,
          `Cesium CSS overrides restyle .${cls}, which no linked Cesium stylesheet defines any more`,
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

describe("geotiff", () => {
  const section = "`geotiff` (`packages/processing/package.json`) — private `actualizedFields`";

  it("keeps parsed tags in a Map keyed by tag number", async () => {
    const { fromArrayBuffer, writeArrayBuffer } = await import("geotiff");
    const bytes = writeArrayBuffer(new Uint8Array(4), {
      width: 2,
      height: 2,
    } as Parameters<typeof writeArrayBuffer>[1]) as ArrayBuffer;
    const image = await (await fromArrayBuffer(bytes)).getImage();
    const fields = (image.fileDirectory as unknown as { actualizedFields?: unknown })
      .actualizedFields;
    const message = (detail: string) =>
      contractMessage("geotiff", section, detail, "packages/processing");
    assert.ok(fields instanceof Map, message("fileDirectory.actualizedFields is no longer a Map"));
    assert.ok(fields.has(339), message("SampleFormat is no longer stored under tag 339"));
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
