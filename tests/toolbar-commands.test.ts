import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildToolbarCommands,
  type ToolbarCommandContext,
} from "../apps/geolibre-desktop/src/components/layout/toolbar/toolbar-commands";
import { IS_MAS_BUILD } from "../apps/geolibre-desktop/src/lib/build-flags";
import { useCvdPreviewStore } from "../apps/geolibre-desktop/src/lib/cvd-preview-store";
import { IS_STORE_BUILD } from "../apps/geolibre-desktop/src/lib/updates";

const noop = () => {};

/**
 * A context whose handlers are all no-ops: the registry's shape (ids, gates)
 * depends only on the flags and the plugin list, never on what a command runs.
 *
 * @param overrides - Flags or values to change from the fully enabled default.
 * @returns A complete command context.
 */
function context(overrides: Partial<ToolbarCommandContext> = {}): ToolbarCommandContext {
  const panel = { visible: false, toggle: noop };
  const base: Partial<ToolbarCommandContext> = {
    t: ((key: string) => key) as unknown as ToolbarCommandContext["t"],
    themeMode: "light",
    shareAvailable: true,
    collaboration: { enabled: true },
    capabilities: { nativeMapInstance: true },
    primaryRenderer: "maplibre",
    plugins: [
      { id: "demo", name: "Demo" },
      { id: "menu-managed", name: "Menu managed" },
    ],
    paletteExcludedPluginIds: new Set(["menu-managed"]),
    effectsPluginId: "effects",
    isPluginEngineSupported: () => true,
    earthEngineAvailable: true,
    isActive: () => false,
    mapControllerRef: { current: null },
    addLayer: new Proxy({} as ToolbarCommandContext["addLayer"], { get: () => noop }),
    panels: new Proxy({} as ToolbarCommandContext["panels"], { get: () => panel }),
    ...overrides,
  };
  // Every handler the test does not name is a no-op.
  return new Proxy(base, {
    get: (target, key) => (key in target ? target[key as keyof typeof target] : noop),
  }) as ToolbarCommandContext;
}

const ids = (overrides?: Partial<ToolbarCommandContext>) =>
  buildToolbarCommands(context(overrides)).map((command) => command.id);

// The full registry, captured from the inline array in TopToolbar.tsx before
// it moved here (#2858). A change to this list changes the command palette,
// the cheat sheet, and the global shortcuts, so it must be deliberate. Since
// captured it has only gained the Georeferencer, Field Collection, GPS
// Tracking, Simplify Interface, Line of Sight, Starter Examples, and Color
// Vision Preview commands.
const FULL_REGISTRY_IDS = [
  "project.new",
  "project.examples",
  "project.open-file",
  "project.open-url",
  "project.save",
  "project.save-as",
  "project.share",
  "project.collaborate",
  "project.print-layout",
  "add.vector",
  "add.raster",
  "add.osm-pbf",
  "add.delimited-text",
  "add.cad",
  "add.gpx",
  "add.landxml",
  "add.mbtiles",
  "add.xyz",
  "add.wms",
  "add.wfs",
  "add.wmts",
  "add.arcgis",
  "add.video",
  "add.deckgl-viz",
  "add.postgres",
  "add.mssql",
  "add.iceberg",
  "add.stac",
  "add.geoparquet",
  "add.flatgeobuf",
  "add.pmtiles",
  "add.zarr",
  "add.netcdf",
  "add.lidar",
  "add.splatting",
  "add.3d-tiles",
  "add.duckdb",
  "add.comment",
  "proc.whitebox",
  "proc.sql",
  "proc.python",
  "proc.assistant",
  "proc.geocode",
  "proc.modelBuilder",
  "proc.obiaWorkbench",
  "proc.batchTools",
  "proc.segmentation",
  "proc.objectDetection",
  "proc.segmentEverything",
  "proc.lineOfSight",
  "proc.conversion.vector-to-geoparquet",
  "proc.conversion.vector-to-flatgeobuf",
  "proc.conversion.vector-to-shapefile",
  "proc.conversion.vector-to-geopackage",
  "proc.conversion.csv-to-geoparquet",
  "proc.conversion.vector-to-pmtiles",
  "proc.conversion.raster-to-pmtiles",
  "proc.conversion.raster-to-cog",
  "proc.vector.buffer",
  "proc.vector.centroids",
  "proc.vector.convex-hull",
  "proc.vector.dissolve",
  "proc.vector.bounding-box",
  "proc.vector.simplify",
  "proc.vector.decode-polyline",
  "proc.vector.encode-polyline",
  "proc.vector.clip",
  "proc.vector.intersection",
  "proc.vector.difference",
  "proc.vector.union",
  "proc.vector.spatial-join",
  "proc.vector.attribute-join",
  "proc.vector.select-by-value",
  "proc.vector.select-by-location",
  "proc.vector.reproject",
  "proc.vector.explode",
  "proc.vector.aggregate",
  "proc.vector.smooth",
  "proc.vector.extract-vertices",
  "proc.vector.points-along-geometry",
  "proc.vector.grid",
  "proc.vector.voronoi",
  "proc.vector.dggs-grid",
  "proc.vector.dggs-bin",
  "proc.vector.dggs-compact",
  "proc.raster.hillshade",
  "proc.raster.slope",
  "proc.raster.aspect",
  "proc.raster.reproject",
  "proc.raster.resample",
  "proc.raster.clip-extent",
  "proc.raster.clip-mask",
  "proc.raster.polygonize",
  "proc.raster.contour",
  "proc.raster.interpolate",
  "proc.raster.zonal",
  "proc.raster.raster-calc",
  "proc.raster.spectral-index",
  "proc.raster.reclassify",
  "proc.raster.mosaic",
  "proc.raster.focal",
  "proc.georeferencer",
  "proc.planetary-computer",
  "proc.earth-engine",
  "control.navigation",
  "control.fullscreen",
  "control.compass",
  "control.geolocate",
  "control.globe",
  "control.terrain",
  "control.scale",
  "control.attribution",
  "control.logo",
  "control.maptoolkit-logo",
  "control.effects",
  "control.directions",
  "control.search",
  "control.colorbar",
  "control.legend",
  "control.html",
  "control.image",
  "control.measure",
  "control.bookmark",
  "control.minimap",
  "control.view-state",
  "control.field-collection",
  "control.gps-tracking",
  "view.zoom-in",
  "view.zoom-out",
  "view.previous",
  "view.next",
  "view.reset-north",
  "view.reset-pitch",
  "view.reset-pitch-bearing",
  "view.set-view",
  "view.comments",
  "view.theme",
  "view.color-vision.protanopia",
  "view.color-vision.deuteranopia",
  "view.color-vision.tritanopia",
  "view.color-vision.achromatopsia",
  "view.color-vision.off",
  "help.shortcuts",
  "help.website",
  "help.github",
  "help.diagnostics",
  "help.feedback",
  "help.updates",
  "help.about",
  "plugin.demo",
  "settings.manage-plugins",
  "settings.style-manager",
  "settings.simplify-interface",
];

describe("buildToolbarCommands", () => {
  it("keeps the full command id list unchanged", (t) => {
    // The snapshot is of the regular desktop/web build; the store builds
    // compile out a few commands, checked separately below.
    if (IS_MAS_BUILD || IS_STORE_BUILD) {
      t.skip("store build flags are set");
      return;
    }
    assert.deepEqual(ids(), FULL_REGISTRY_IDS);
  });

  it("has unique ids", () => {
    const all = ids();
    assert.equal(new Set(all).size, all.length);
  });

  it("drops share, collaborate, and the canvas-reading AI commands when unavailable", () => {
    const gated = ids({
      shareAvailable: false,
      collaboration: { enabled: false },
      capabilities: { nativeMapInstance: false },
      earthEngineAvailable: false,
    });
    for (const id of [
      "project.share",
      "project.collaborate",
      "proc.objectDetection",
      "proc.segmentEverything",
      "proc.lineOfSight",
      "proc.earth-engine",
    ]) {
      assert.ok(!gated.includes(id), `${id} should be gated out`);
    }
    assert.deepEqual(
      gated,
      ids().filter(
        (id) =>
          ![
            "project.share",
            "project.collaborate",
            "proc.objectDetection",
            "proc.segmentEverything",
            "proc.lineOfSight",
            "proc.earth-engine",
          ].includes(id),
      ),
    );
  });

  it("gives menu-managed plugins no toggle command", () => {
    assert.ok(ids().includes("plugin.demo"));
    assert.ok(!ids().includes("plugin.menu-managed"));
  });

  it("keeps the global shortcuts on the same commands", () => {
    const shortcuts = buildToolbarCommands(context())
      .filter((command) => command.shortcut)
      .map((command) => [command.id, command.shortcut]);
    assert.deepEqual(shortcuts, [
      ["project.new", { key: "n", mod: true, shift: false }],
      ["project.open-file", { key: "o", mod: true, shift: false }],
      ["project.save", { key: "s", mod: true, shift: false }],
      ["project.save-as", { key: "s", mod: true, shift: true }],
      ["add.comment", { key: "c", shift: false }],
      ["view.previous", { key: "[" }],
      ["view.next", { key: "]" }],
      ["view.reset-north", { key: "n" }],
      ["view.reset-pitch", { key: "u" }],
      ["view.reset-pitch-bearing", { key: "r" }],
    ]);
  });

  it("opens the Georeferencer, Field Collection, GPS Tracking, and Settings → Interface", () => {
    const calls: string[] = [];
    const record = (name: string) => (open?: unknown) => calls.push(`${name}:${String(open)}`);
    const commands = buildToolbarCommands(
      context({
        setGeoreferencerOpen: record("georeferencer"),
        setFieldCollectionOpen: record("fieldCollection"),
        setGpsTrackingOpen: record("gpsTracking"),
        onSimplifyInterface: () => calls.push("simplifyInterface"),
      }),
    );
    for (const id of [
      "proc.georeferencer",
      "control.field-collection",
      "control.gps-tracking",
      "settings.simplify-interface",
    ]) {
      commands.find((command) => command.id === id)?.run();
    }
    assert.deepEqual(calls, [
      "georeferencer:true",
      "fieldCollection:true",
      "gpsTracking:true",
      "simplifyInterface",
    ]);
  });

  it("opens the starter examples and switches the color vision preview", () => {
    let examplesOpened = 0;
    const commands = buildToolbarCommands(
      context({ openStarterExamples: () => (examplesOpened += 1) }),
    );
    const run = (id: string) => {
      const command = commands.find((entry) => entry.id === id);
      assert.ok(command, `${id} should exist`);
      command.run();
    };
    run("project.examples");
    assert.equal(examplesOpened, 1);
    try {
      run("view.color-vision.deuteranopia");
      assert.equal(useCvdPreviewStore.getState().mode, "deuteranopia");
      run("view.color-vision.achromatopsia");
      assert.equal(useCvdPreviewStore.getState().mode, "achromatopsia");
      run("view.color-vision.off");
      assert.equal(useCvdPreviewStore.getState().mode, null);
    } finally {
      useCvdPreviewStore.getState().setMode(null);
    }
  });

  it("explains why a plugin cannot run on the live renderer", () => {
    const [command] = buildToolbarCommands(
      context({ isPluginEngineSupported: () => false }),
    ).filter((entry) => entry.id === "plugin.demo");
    assert.equal(command?.disabledReason, "renderer.pluginUnsupported");
  });
});
