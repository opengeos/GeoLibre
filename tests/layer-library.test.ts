import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import {
  captureLayerLibraryEntry,
  canSaveLayerToLibrary,
  controlRendersLayer,
  createLayerLibraryEntryId,
  DEFAULT_LAYER_STYLE,
  hasRestorableLayerSource,
  LAYER_LIBRARY_BUNDLE_TYPE,
  LAYER_LIBRARY_BUNDLE_VERSION,
  layerLibraryEntryNeedsLocalFile,
  MAX_LAYER_LIBRARY_ENTRIES,
  MAX_LAYER_LIBRARY_ENTRY_BYTES,
  normalizeLayerLibraryEntries,
  parseLayerLibrary,
  planLayerLibraryAdd,
  serializeLayerLibrary,
  unresolvedLayerLibraryJoins,
  type GeoLibreLayer,
  type LayerLibraryEntry,
} from "@geolibre/core";

const CAPTURE_OPTIONS = { id: "entry-1", addedAt: "2026-07-29T00:00:00.000Z" };

function layer(overrides: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "layer-1",
    name: "Cities",
    type: "geojson",
    source: {},
    visible: true,
    opacity: 0.8,
    style: { ...DEFAULT_LAYER_STYLE, fillColor: "#ff0000" },
    metadata: {},
    ...overrides,
  };
}

/** A FeatureCollection whose serialized JSON is roughly `bytes` long. */
function bulkyFeatures(bytes: number): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [0, 0] },
        properties: { blob: "x".repeat(bytes) },
      },
    ],
  };
}

const POINTS: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [1, 2] },
      properties: { name: "a" },
    },
  ],
};

describe("hasRestorableLayerSource", () => {
  it("accepts a source URL, tile template, or remembered original URL", () => {
    assert.equal(
      hasRestorableLayerSource({ source: { url: "https://example.com/a.fgb" }, metadata: {} }),
      true,
    );
    assert.equal(
      hasRestorableLayerSource({ source: { tiles: ["https://t/{z}/{x}/{y}.png"] }, metadata: {} }),
      true,
    );
    assert.equal(
      hasRestorableLayerSource({ source: {}, metadata: { originalUrl: "https://example.com/x" } }),
      true,
    );
  });

  it("rejects an inline GeoJSON source and blank URLs", () => {
    // `data` as an inline FeatureCollection is the data itself, not a source to
    // re-fetch; only a URL string counts.
    assert.equal(hasRestorableLayerSource({ source: { data: POINTS }, metadata: {} }), false);
    assert.equal(
      hasRestorableLayerSource({ source: { url: "   ", tiles: [""] }, metadata: {} }),
      false,
    );
  });
});

describe("canSaveLayerToLibrary", () => {
  it("accepts a layer with a source, a re-readable local path, or features", () => {
    assert.equal(canSaveLayerToLibrary(layer({ source: { url: "https://x/a.fgb" } })), true);
    assert.equal(
      canSaveLayerToLibrary(
        layer({ sourcePath: "/data/cities.geojson", metadata: { localFileReloadable: true } }),
      ),
      true,
    );
    assert.equal(canSaveLayerToLibrary(layer({ geojson: POINTS })), true);
  });

  it("accepts a locally-opened raster, whose absolute path lives in metadata", () => {
    // The raster control records the absolute path in `metadata.localFilePath`
    // (what restoreRasterLayers re-reads) and keeps only the basename in
    // `sourcePath`, so requiring `localFileReloadable` alone would make a
    // locally-opened COG unsaveable.
    const cog = layer({
      type: "cog",
      source: { type: "raster" },
      sourcePath: "dem.tif",
      metadata: {
        externalNativeLayer: true,
        customLayerType: "raster",
        sourceKind: "maplibre-gl-raster",
        localFilePath: "/data/dem.tif",
      },
    });
    assert.equal(canSaveLayerToLibrary(cog, { canRestoreControlPainted: () => true }), true);
  });

  it("does not treat a browser-picked file's bare name as a re-readable path", () => {
    // A file picked in the browser has no path, but `createVectorStoreLayer`
    // still records the bare name in `sourcePath` for display, and omits
    // `localFileReloadable` — the flag that marks a genuinely re-readable path.
    assert.equal(canSaveLayerToLibrary(layer({ sourcePath: "us_cities.geojson" })), false);
    // Nor a relative or traversing path a hand-edited project could smuggle in.
    assert.equal(
      canSaveLayerToLibrary(
        layer({ sourcePath: "data/cities.geojson", metadata: { localFileReloadable: true } }),
      ),
      false,
    );
    assert.equal(
      canSaveLayerToLibrary(
        layer({ sourcePath: "/data/../../etc/passwd", metadata: { localFileReloadable: true } }),
      ),
      false,
    );
  });

  it("accepts a control-painted layer whose features live only in its control", () => {
    // A tiles-mode Add Vector Layer layer has no `layer.geojson`, no re-fetchable
    // source, and no path — but the save handler can read its features out of the
    // control, so the gate must not hide what the capture path can embed.
    const tilesMode = layer({
      type: "vector-tiles",
      source: { type: "vector" },
      sourcePath: "cities.geojson",
      metadata: {
        externalNativeLayer: true,
        customLayerType: "vector-fill",
        sourceKind: "maplibre-gl-vector",
      },
    });
    assert.equal(canSaveLayerToLibrary(tilesMode, { canRestoreControlPainted: () => true }), false);
    assert.equal(
      canSaveLayerToLibrary(tilesMode, {
        canRestoreControlPainted: () => true,
        hasMaterializableFeatures: () => true,
      }),
      true,
    );
    // Still refused when it cannot be re-rendered, whatever the features say.
    assert.equal(
      canSaveLayerToLibrary(tilesMode, {
        canRestoreControlPainted: () => false,
        hasMaterializableFeatures: () => true,
      }),
      false,
    );
  });

  it("rejects a layer with nothing to re-add from", () => {
    assert.equal(canSaveLayerToLibrary(layer()), false);
    assert.equal(
      canSaveLayerToLibrary(layer({ geojson: { type: "FeatureCollection", features: [] } })),
      false,
    );
  });

  it("refuses a control-painted layer the host cannot re-render", () => {
    // Saving one anyway would produce an entry that re-adds into the Layers
    // panel and draws nothing, so it must not be offered at all.
    const controlPainted = layer({
      source: { url: "https://example.com/a.tif" },
      metadata: { externalNativeLayer: true, sourceKind: "some-deckgl-control" },
    });
    assert.equal(canSaveLayerToLibrary(controlPainted), false);
    assert.equal(
      canSaveLayerToLibrary(controlPainted, { canRestoreControlPainted: () => false }),
      false,
    );
    assert.equal(
      canSaveLayerToLibrary(controlPainted, { canRestoreControlPainted: () => true }),
      true,
    );
  });

  it("agrees with controlRendersLayer about which layers need the predicate", () => {
    // `controlRendersLayer` is the flag layer-sync's dispatch branches on, and
    // the desktop app's `canRestoreLibraryLayer` reads the same predicate: an
    // external-native layer WITHOUT `customLayerType` is rebuilt from the record
    // by the map sync, so it needs no restore pass to be saveable.
    const rebuiltBySync = layer({
      type: "pmtiles",
      source: { url: "https://example.com/a.pmtiles" },
      metadata: { externalNativeLayer: true, sourceKind: "pmtiles-url" },
    });
    assert.equal(controlRendersLayer(rebuiltBySync), false);
    assert.equal(
      canSaveLayerToLibrary(rebuiltBySync, {
        canRestoreControlPainted: (candidate) => !controlRendersLayer(candidate),
      }),
      true,
    );
    const needsItsControl = layer({
      type: "cog",
      source: { url: "https://example.com/a.tif" },
      metadata: {
        externalNativeLayer: true,
        // The real shape a Vantor/STAC COG layer carries.
        customLayerType: "raster",
        sourceKind: "cog-url",
      },
    });
    assert.equal(controlRendersLayer(needsItsControl), true);
    assert.equal(
      canSaveLayerToLibrary(needsItsControl, {
        canRestoreControlPainted: (candidate) => !controlRendersLayer(candidate),
      }),
      false,
    );
  });

  it("does not consult the host predicate for a layer GeoLibre renders itself", () => {
    let asked = false;
    const plain = layer({ source: { url: "https://example.com/a.fgb" } });
    assert.equal(
      canSaveLayerToLibrary(plain, {
        canRestoreControlPainted: () => {
          asked = true;
          return false;
        },
      }),
      true,
    );
    assert.equal(asked, false);
  });
});

describe("captureLayerLibraryEntry", () => {
  it("captures the source spec and presentation state, not the data", () => {
    const result = captureLayerLibraryEntry(
      layer({
        source: { type: "geojson", data: "https://example.com/cities.geojson" },
        // The attribute-table copy of the features: re-fetchable from the URL,
        // so it must not be embedded in the entry.
        geojson: POINTS,
        joins: [
          {
            id: "join-1",
            joinLayerId: "layer-2",
            targetField: "id",
            joinField: "id",
            fields: ["pop"],
          },
        ],
        virtualFields: [{ id: "vf-1", name: "double", expression: "1 + 1" }],
        attributeForm: { fields: [{ field: "name", widget: "text" }] },
      }),
      CAPTURE_OPTIONS,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.entry.geojson, undefined);
    assert.equal(result.entry.name, "Cities");
    assert.equal(result.entry.layerType, "geojson");
    assert.equal(result.entry.opacity, 0.8);
    assert.equal(result.entry.style.fillColor, "#ff0000");
    assert.equal(result.entry.source.data, "https://example.com/cities.geojson");
    assert.equal(result.entry.joins?.length, 1);
    assert.equal(result.entry.virtualFields?.length, 1);
    assert.ok(result.entry.attributeForm);
  });

  it("embeds features when no source can supply them", () => {
    const result = captureLayerLibraryEntry(layer({ geojson: POINTS }), CAPTURE_OPTIONS);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.entry.geojson, POINTS);
    assert.equal(result.entry.needsLocalFile, undefined);
  });

  it("rewinds a resolved XYZ endpoint to the template it came from", () => {
    // `prepareLayerForSave` does this for project files: an xyz layer's live
    // source can hold a session-resolved endpoint while metadata.originalUrl keeps
    // the template. A library entry outlives the session, so baking in the
    // resolved host would make it replay a stale endpoint forever.
    const result = captureLayerLibraryEntry(
      layer({
        type: "xyz",
        source: { type: "raster", tiles: ["https://resolved.example.net/a/{z}/{x}/{y}.png"] },
        metadata: {
          originalUrl: "https://tiles.example.com/{z}/{x}/{y}.png",
          resolvedUrl: "https://resolved.example.net/a/{z}/{x}/{y}.png",
        },
      }),
      CAPTURE_OPTIONS,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.entry.source.tiles, ["https://tiles.example.com/{z}/{x}/{y}.png"]);
    assert.equal(result.entry.source.url, "https://tiles.example.com/{z}/{x}/{y}.png");
    assert.equal("resolvedUrl" in result.entry.metadata, false);
  });

  it("leaves a non-xyz source alone", () => {
    // The rewind is xyz-specific; a WMS/vector source must not have `tiles`
    // fabricated onto it from an unrelated metadata field.
    const result = captureLayerLibraryEntry(
      layer({ type: "wms", source: { type: "raster", url: "https://wms.example.com/service" } }),
      CAPTURE_OPTIONS,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.entry.source.tiles, undefined);
    assert.equal(result.entry.source.url, "https://wms.example.com/service");
  });

  it("measures the size cap in UTF-8 bytes, not UTF-16 units", () => {
    // Each of these characters is one UTF-16 unit but three UTF-8 bytes, so a
    // length-based check would pass an entry at ~3x the real cap.
    const justUnderInUnits = "気".repeat(Math.floor(MAX_LAYER_LIBRARY_ENTRY_BYTES / 2));
    const result = captureLayerLibraryEntry(
      layer({
        geojson: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: { type: "Point", coordinates: [0, 0] },
              properties: { name: justUnderInUnits },
            },
          ],
        },
      }),
      CAPTURE_OPTIONS,
    );
    assert.deepEqual(result, { ok: false, reason: "features-too-large" });
  });

  it("does not capture project-specific placement or transient metadata", () => {
    const result = captureLayerLibraryEntry(
      layer({
        source: { url: "https://example.com/a.png" },
        groupId: "group-1",
        beforeId: "layer-9",
        metadata: { originalUrl: "https://example.com/a.png", resolvedUrl: "/proxy/a.png" },
      }),
      CAPTURE_OPTIONS,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal("groupId" in result.entry, false);
    assert.equal("beforeId" in result.entry, false);
    assert.equal(result.entry.metadata.resolvedUrl, undefined);
    assert.equal(result.entry.metadata.originalUrl, "https://example.com/a.png");
  });

  it("does not alias the live layer's objects", () => {
    const source = { url: "https://example.com/a.fgb" };
    const target = layer({ source });
    const result = captureLayerLibraryEntry(target, CAPTURE_OPTIONS);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    target.style.fillColor = "#00ff00";
    source.url = "https://example.com/changed.fgb";
    assert.equal(result.entry.style.fillColor, "#ff0000");
    assert.equal(result.entry.source.url, "https://example.com/a.fgb");
  });

  it("refuses a layer with nothing to re-add from", () => {
    const result = captureLayerLibraryEntry(layer(), CAPTURE_OPTIONS);
    assert.deepEqual(result, { ok: false, reason: "no-source" });
  });

  it("drops a stale embedded copy when the source can re-fetch the data", () => {
    // An Add Vector Layer layer loaded from a project carries a web-restore
    // copy in metadata. With a real URL to re-read from, the entry must not
    // carry (or resurrect) that blob.
    const result = captureLayerLibraryEntry(
      layer({
        source: { url: "https://example.com/big.geojson" },
        metadata: {
          externalNativeLayer: true,
          sourceKind: "maplibre-gl-vector",
          embeddedGeoJSON: bulkyFeatures(2_000),
        },
      }),
      CAPTURE_OPTIONS,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal("embeddedGeoJSON" in result.entry.metadata, false);
    assert.equal(result.entry.metadata.sourceKind, "maplibre-gl-vector");
  });

  it("embeds a control-painted layer's features where its restore pass reads them", () => {
    // A control-painted layer draws from metadata.embeddedGeoJSON (the same
    // field the project Embed/Share flow writes), not from `geojson`, and the
    // local-file reload flag is cleared so the embedded copy wins.
    const result = captureLayerLibraryEntry(
      layer({
        metadata: {
          externalNativeLayer: true,
          sourceKind: "maplibre-gl-vector",
          localFileReloadable: true,
        },
        sourcePath: "/data/cities.geojson",
      }),
      { ...CAPTURE_OPTIONS, features: POINTS },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.entry.geojson, undefined);
    assert.deepEqual(result.entry.metadata.embeddedGeoJSON, POINTS);
    assert.equal("localFileReloadable" in result.entry.metadata, false);
  });

  it("captures a control-painted layer that has no path and no store features", () => {
    // The true no-path case: a browser-picked or tiles-mode Add Vector Layer
    // layer. Everything the entry needs comes from the caller's materialized
    // features, so the capture must not depend on `sourcePath` or `layer.geojson`.
    const result = captureLayerLibraryEntry(
      layer({
        type: "vector-tiles",
        source: { type: "vector" },
        sourcePath: "cities.geojson",
        metadata: {
          externalNativeLayer: true,
          customLayerType: "vector-fill",
          sourceKind: "maplibre-gl-vector",
        },
      }),
      { ...CAPTURE_OPTIONS, features: POINTS },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.entry.metadata.embeddedGeoJSON, POINTS);
    assert.equal(result.entry.sourcePath, undefined);
    assert.equal(result.entry.needsLocalFile, undefined);
  });

  it("prefers caller-supplied features over the layer's attribute-table copy", () => {
    const result = captureLayerLibraryEntry(layer({ geojson: POINTS }), {
      ...CAPTURE_OPTIONS,
      features: { type: "FeatureCollection", features: [...POINTS.features, ...POINTS.features] },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.entry.geojson?.features.length, 2);
  });

  it("falls back to a path-only entry for an oversized local file", () => {
    const result = captureLayerLibraryEntry(
      layer({
        sourcePath: "/data/huge.geojson",
        metadata: { localFileReloadable: true },
        geojson: bulkyFeatures(MAX_LAYER_LIBRARY_ENTRY_BYTES + 1_000),
      }),
      CAPTURE_OPTIONS,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.entry.geojson, undefined);
    assert.equal(result.entry.sourcePath, "/data/huge.geojson");
    assert.equal(result.entry.needsLocalFile, true);
    assert.equal(layerLibraryEntryNeedsLocalFile(result.entry), true);
  });

  it("refuses oversized in-memory features with no file to fall back to", () => {
    const result = captureLayerLibraryEntry(
      layer({ geojson: bulkyFeatures(MAX_LAYER_LIBRARY_ENTRY_BYTES + 1_000) }),
      CAPTURE_OPTIONS,
    );
    assert.deepEqual(result, { ok: false, reason: "features-too-large" });
  });

  it("blames the configuration, not the features, when there is a live source", () => {
    // A layer with a re-fetchable source embeds nothing, so an over-cap entry is
    // over because of its own style/form/joins. Reporting "features-too-large"
    // here would send the user looking at their data instead.
    const result = captureLayerLibraryEntry(
      layer({
        source: { url: "https://example.com/a.geojson" },
        style: {
          ...DEFAULT_LAYER_STYLE,
          vectorRules: Array.from({ length: 20_000 }, (_unused, index) => ({
            id: `r${index}`,
            label: `rule ${index}`.padEnd(300, "x"),
            filter: '["==", ["get", "kind"], "a"]',
            color: "#ff0000",
            isElse: false,
          })),
        },
      }),
      CAPTURE_OPTIONS,
    );
    assert.deepEqual(result, { ok: false, reason: "config-too-large" });
  });

  it("refuses an oversized browser-picked file, whose bare name cannot be re-read", () => {
    // There is no path to degrade to, so this must fail rather than save an
    // entry that could never be re-added.
    const result = captureLayerLibraryEntry(
      layer({
        sourcePath: "huge.geojson",
        geojson: bulkyFeatures(MAX_LAYER_LIBRARY_ENTRY_BYTES + 1_000),
      }),
      CAPTURE_OPTIONS,
    );
    assert.deepEqual(result, { ok: false, reason: "features-too-large" });
  });
});

describe("planLayerLibraryAdd", () => {
  it("builds a layer record under a fresh id, always visible", () => {
    const captured = captureLayerLibraryEntry(
      layer({ source: { url: "https://example.com/a.fgb" }, type: "flatgeobuf", visible: false }),
      CAPTURE_OPTIONS,
    );
    assert.equal(captured.ok, true);
    if (!captured.ok) return;
    const plan = planLayerLibraryAdd(captured.entry, { id: "layer-new" });
    assert.equal(plan.kind, "layer");
    if (plan.kind !== "layer") return;
    assert.equal(plan.layer.id, "layer-new");
    assert.equal(plan.layer.name, "Cities");
    assert.equal(plan.layer.type, "flatgeobuf");
    assert.equal(plan.layer.visible, true);
    assert.equal(plan.layer.opacity, 0.8);
    assert.equal(plan.layer.style.fillColor, "#ff0000");
    assert.equal(plan.layer.source.url, "https://example.com/a.fgb");
  });

  it("round-trips embedded features into the re-added layer", () => {
    const captured = captureLayerLibraryEntry(layer({ geojson: POINTS }), CAPTURE_OPTIONS);
    assert.equal(captured.ok, true);
    if (!captured.ok) return;
    const plan = planLayerLibraryAdd(captured.entry, { id: "layer-new" });
    assert.equal(plan.kind, "layer");
    if (plan.kind !== "layer") return;
    assert.deepEqual(plan.layer.geojson, POINTS);
  });

  it("asks the host to re-read the file for a path-only entry, carrying its config", () => {
    // The host's file import builds a default-styled layer, so the entry's saved
    // configuration has to travel with the plan or the re-add loses it.
    const plan = planLayerLibraryAdd(
      {
        id: "entry-1",
        name: "Huge",
        addedAt: "",
        layerType: "geojson",
        source: {},
        style: { ...DEFAULT_LAYER_STYLE, fillColor: "#e11d48" },
        opacity: 0.4,
        metadata: {},
        sourcePath: "/data/huge.geojson",
        needsLocalFile: true,
        joins: [
          { id: "j1", joinLayerId: "layer-2", targetField: "id", joinField: "id", fields: ["pop"] },
        ],
        virtualFields: [{ id: "vf1", name: "double", expression: "1 + 1" }],
      },
      { id: "layer-new" },
    );
    assert.equal(plan.kind, "local-file");
    if (plan.kind !== "local-file") return;
    assert.equal(plan.path, "/data/huge.geojson");
    assert.equal(plan.config.name, "Huge");
    assert.equal(plan.config.opacity, 0.4);
    assert.equal(plan.config.style.fillColor, "#e11d48");
    assert.equal(plan.config.joins?.length, 1);
    assert.equal(plan.config.virtualFields?.length, 1);
  });

  it("adds a path-only entry as a layer when its path is not re-readable", () => {
    // A hand-edited bundle can claim needsLocalFile with a relative path; the
    // plan must not hand that to the host's file read.
    const plan = planLayerLibraryAdd(
      {
        id: "entry-1",
        name: "Sketchy",
        addedAt: "",
        layerType: "geojson",
        source: { data: "https://example.com/a.geojson" },
        style: { ...DEFAULT_LAYER_STYLE },
        opacity: 1,
        metadata: {},
        sourcePath: "../../etc/passwd",
        needsLocalFile: true,
      },
      { id: "layer-new" },
    );
    assert.equal(plan.kind, "layer");
  });

  it("does not alias the entry, so re-adding twice yields independent layers", () => {
    const entry: LayerLibraryEntry = {
      id: "entry-1",
      name: "Cities",
      addedAt: "",
      layerType: "geojson",
      source: { data: "https://example.com/a.geojson" },
      style: { ...DEFAULT_LAYER_STYLE },
      opacity: 1,
      metadata: { tag: "keep" },
    };
    const first = planLayerLibraryAdd(entry, { id: "a" });
    const second = planLayerLibraryAdd(entry, { id: "b" });
    assert.equal(first.kind === "layer" && second.kind === "layer", true);
    if (first.kind !== "layer" || second.kind !== "layer") return;
    first.layer.style.fillColor = "#123456";
    first.layer.metadata.tag = "changed";
    assert.notEqual(second.layer.style.fillColor, "#123456");
    assert.equal(second.layer.metadata.tag, "keep");
    assert.equal(entry.metadata.tag, "keep");
  });
});

describe("unresolvedLayerLibraryJoins", () => {
  const withJoins = (joins: LayerLibraryEntry["joins"]) => ({ joins });

  it("reports a join whose source layer is not in the target project", () => {
    assert.deepEqual(
      unresolvedLayerLibraryJoins(
        withJoins([
          { id: "j1", joinLayerId: "layer-present", targetField: "id", joinField: "id" },
          { id: "j2", joinLayerId: "layer-elsewhere", targetField: "id", joinField: "id" },
        ]),
        ["layer-present", "layer-other"],
      ),
      ["layer-elsewhere"],
    );
  });

  it("ignores a disabled join and an entry with no joins", () => {
    assert.deepEqual(
      unresolvedLayerLibraryJoins(
        withJoins([
          {
            id: "j1",
            joinLayerId: "gone",
            targetField: "id",
            joinField: "id",
            enabled: false,
          },
        ]),
        [],
      ),
      [],
    );
    assert.deepEqual(unresolvedLayerLibraryJoins({}, ["a"]), []);
  });

  it("reports nothing when every join resolves", () => {
    assert.deepEqual(
      unresolvedLayerLibraryJoins(
        withJoins([{ id: "j1", joinLayerId: "a", targetField: "id", joinField: "id" }]),
        ["a", "b"],
      ),
      [],
    );
  });
});

describe("normalizeLayerLibraryEntries", () => {
  const valid = {
    id: "e1",
    name: "Cities",
    addedAt: "2026-01-01",
    layerType: "geojson",
    source: { data: "https://example.com/a.geojson" },
    style: { fillColor: "#abcdef" },
    opacity: 0.5,
    metadata: {},
  };

  it("keeps a valid entry and completes its style against the defaults", () => {
    const [entry] = normalizeLayerLibraryEntries([valid]);
    assert.equal(entry.id, "e1");
    assert.equal(entry.style.fillColor, "#abcdef");
    assert.equal(entry.style.strokeWidth, DEFAULT_LAYER_STYLE.strokeWidth);
    assert.equal(entry.opacity, 0.5);
  });

  it("drops entries missing an id, a name, or a known layer type", () => {
    assert.deepEqual(normalizeLayerLibraryEntries([{ ...valid, id: "  " }]), []);
    assert.deepEqual(normalizeLayerLibraryEntries([{ ...valid, name: "" }]), []);
    assert.deepEqual(normalizeLayerLibraryEntries([{ ...valid, layerType: "hologram" }]), []);
    assert.deepEqual(normalizeLayerLibraryEntries("nope"), []);
  });

  it("drops an entry with nothing to re-add from", () => {
    assert.deepEqual(normalizeLayerLibraryEntries([{ ...valid, source: {} }]), []);
  });

  it("keeps a control-painted entry whose data is in metadata.embeddedGeoJSON", () => {
    const entries = normalizeLayerLibraryEntries([
      {
        ...valid,
        source: {},
        metadata: { externalNativeLayer: true, embeddedGeoJSON: POINTS },
      },
    ]);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].metadata.embeddedGeoJSON, POINTS);
  });

  it("de-duplicates by id, keeping the first occurrence", () => {
    const entries = normalizeLayerLibraryEntries([valid, { ...valid, name: "Later" }]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, "Cities");
  });

  it("rejects a style value whose type or enum disagrees with the default", () => {
    const [entry] = normalizeLayerLibraryEntries([
      { ...valid, style: { strokeWidth: "thick", markerShape: "hexagon", fillOpacity: 0.25 } },
    ]);
    assert.equal(entry.style.strokeWidth, DEFAULT_LAYER_STYLE.strokeWidth);
    assert.equal(entry.style.markerShape, DEFAULT_LAYER_STYLE.markerShape);
    assert.equal(entry.style.fillOpacity, 0.25);
  });

  it("clamps an out-of-range or non-numeric opacity to 1", () => {
    assert.equal(normalizeLayerLibraryEntries([{ ...valid, opacity: 4 }])[0].opacity, 1);
    assert.equal(normalizeLayerLibraryEntries([{ ...valid, opacity: "half" }])[0].opacity, 1);
  });

  it("ignores needsLocalFile without a path to read", () => {
    const [entry] = normalizeLayerLibraryEntries([{ ...valid, needsLocalFile: true }]);
    assert.equal(entry.needsLocalFile, undefined);
  });

  it("drops a sourcePath an importing host must not be told to read", () => {
    // A bundle is shareable, so a crafted entry could otherwise aim the host's
    // file read at any path on the importing user's disk.
    for (const path of ["cities.geojson", "data/cities.geojson", "/data/../../etc/shadow"]) {
      const [entry] = normalizeLayerLibraryEntries([
        { ...valid, sourcePath: path, needsLocalFile: true },
      ]);
      assert.equal(entry.sourcePath, undefined, path);
      assert.equal(entry.needsLocalFile, undefined, path);
    }
    const [kept] = normalizeLayerLibraryEntries([
      { ...valid, sourcePath: "/data/cities.geojson", needsLocalFile: true },
    ]);
    assert.equal(kept.sourcePath, "/data/cities.geojson");
    assert.equal(kept.needsLocalFile, true);
  });

  it("validates metadata.localFilePath, the second path a raster entry carries", () => {
    // `restoreRasterLayers` re-reads this field, so a bundle must not be able to
    // keep a clean-looking `sourcePath` while redirecting that read elsewhere.
    const rasterEntry = {
      ...valid,
      layerType: "cog",
      source: { type: "raster" },
      sourcePath: "/safe/file.tif",
    };
    for (const path of ["/data/../../etc/shadow", "file.tif", "", 42]) {
      const [entry] = normalizeLayerLibraryEntries([
        { ...rasterEntry, metadata: { localFilePath: path } },
      ]);
      assert.equal(entry.metadata.localFilePath, undefined, String(path));
      // The validated sourcePath is unaffected by dropping the bad metadata path.
      assert.equal(entry.sourcePath, "/safe/file.tif");
    }
    const [kept] = normalizeLayerLibraryEntries([
      { ...rasterEntry, metadata: { localFilePath: "/data/dem.tif" } },
    ]);
    assert.equal(kept.metadata.localFilePath, "/data/dem.tif");
  });

  it("keeps a local raster entry whose only path is metadata.localFilePath", () => {
    // Its source has no URL and it has no features, so the "anything to re-add
    // from" gate has to count that path or the entry would vanish on load.
    const entries = normalizeLayerLibraryEntries([
      {
        ...valid,
        layerType: "cog",
        source: { type: "raster" },
        sourcePath: "dem.tif",
        metadata: { sourceKind: "maplibre-gl-raster", localFilePath: "/data/dem.tif" },
      },
    ]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].metadata.localFilePath, "/data/dem.tif");
    // The basename is not a re-readable path, so it is not kept as one.
    assert.equal(entries[0].sourcePath, undefined);
  });

  it("enforces the per-entry size cap on import, not only on capture", () => {
    // A bundle is produced elsewhere, so without this an externally-assembled
    // file could push tens of MB of embedded features per entry into IndexedDB.
    const oversized = {
      ...valid,
      id: "e-big",
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [0, 0] },
            properties: { blob: "x".repeat(MAX_LAYER_LIBRARY_ENTRY_BYTES + 1_000) },
          },
        ],
      },
    };
    assert.deepEqual(normalizeLayerLibraryEntries([oversized]), []);
    // A normal entry alongside it still survives.
    const kept = normalizeLayerLibraryEntries([oversized, valid]);
    assert.deepEqual(
      kept.map((entry) => entry.id),
      ["e1"],
    );
  });

  it("caps how many entries one pass keeps", () => {
    const many = Array.from({ length: MAX_LAYER_LIBRARY_ENTRIES + 25 }, (_unused, index) => ({
      ...valid,
      id: `e${index}`,
    }));
    assert.equal(normalizeLayerLibraryEntries(many).length, MAX_LAYER_LIBRARY_ENTRIES);
  });

  it("drops malformed optional blocks rather than the whole entry", () => {
    const [entry] = normalizeLayerLibraryEntries([
      { ...valid, joins: "many", virtualFields: [], attributeForm: [], geojson: { type: "Point" } },
    ]);
    assert.equal(entry.joins, undefined);
    assert.equal(entry.virtualFields, undefined);
    assert.equal(entry.attributeForm, undefined);
    assert.equal(entry.geojson, undefined);
  });

  it("drops join, virtual-field, and form members missing the keys their engine needs", () => {
    const [entry] = normalizeLayerLibraryEntries([
      {
        ...valid,
        joins: [
          { id: "j1", joinLayerId: "l2", targetField: "id", joinField: "id" },
          { id: "j2", joinLayerId: "l3" },
        ],
        virtualFields: [
          { id: "vf1", name: "ok", expression: "1" },
          { id: "vf2", name: "no expression" },
        ],
        attributeForm: { fields: [{ field: "name", widget: "text" }, { widget: "text" }] },
      },
    ]);
    assert.deepEqual(
      entry.joins?.map((join) => join.id),
      ["j1"],
    );
    assert.deepEqual(
      entry.virtualFields?.map((field) => field.id),
      ["vf1"],
    );
    assert.deepEqual(
      entry.attributeForm?.fields.map((field) => field.field),
      ["name"],
    );
  });

  it("drops a block entirely when no member survives", () => {
    const [entry] = normalizeLayerLibraryEntries([
      {
        ...valid,
        joins: [{ id: "j1" }],
        virtualFields: [{ name: "nameless" }],
        attributeForm: { fields: [{ widget: "text" }] },
      },
    ]);
    assert.equal(entry.joins, undefined);
    assert.equal(entry.virtualFields, undefined);
    assert.equal(entry.attributeForm, undefined);
  });
});

describe("serializeLayerLibrary / parseLayerLibrary", () => {
  const entries = normalizeLayerLibraryEntries([
    {
      id: "e1",
      name: "Cities",
      addedAt: "2026-01-01",
      layerType: "geojson",
      source: { data: "https://example.com/a.geojson" },
      style: { fillColor: "#abcdef" },
      opacity: 1,
      metadata: {},
    },
  ]);

  it("round-trips a bundle", () => {
    const json = serializeLayerLibrary(entries);
    const parsed = JSON.parse(json);
    assert.equal(parsed.type, LAYER_LIBRARY_BUNDLE_TYPE);
    assert.equal(parsed.version, LAYER_LIBRARY_BUNDLE_VERSION);
    assert.deepEqual(parseLayerLibrary(json), entries);
  });

  it("redacts per-user credentials from the exported bundle only", () => {
    // Export is a share action, so an authenticated 3D Tiles layer's bearer
    // token must not travel with it — while the local entry keeps it so
    // re-adding on this machine still works.
    const [withToken] = normalizeLayerLibraryEntries([
      {
        id: "e-auth",
        name: "Authenticated tileset",
        addedAt: "",
        layerType: "3d-tiles",
        source: {
          url: "https://example.com/tileset.json",
          requestHeaders: { Authorization: "Bearer super-secret" },
        },
        opacity: 1,
        metadata: {},
      },
    ]);
    assert.deepEqual(withToken.source.requestHeaders, { Authorization: "Bearer super-secret" });
    const exported = serializeLayerLibrary([withToken]);
    assert.equal(exported.includes("super-secret"), false);
    const [reimported] = parseLayerLibrary(exported);
    assert.equal("requestHeaders" in reimported.source, false);
    // The rest of the source survives, so the recipient only re-enters the token.
    assert.equal(reimported.source.url, "https://example.com/tileset.json");
  });

  it("redacts credentials embedded in source URLs and tile templates", () => {
    // Plenty of services authenticate in the URL rather than a header, so
    // redacting only requestHeaders would still ship a key in a shared bundle.
    const [entry] = normalizeLayerLibraryEntries([
      {
        id: "e-key",
        name: "Keyed tiles",
        addedAt: "",
        layerType: "xyz",
        source: {
          url: "https://tiles.example.com/service?api_key=SECRET1&style=dark",
          tiles: ["https://tiles.example.com/{z}/{x}/{y}.png?access_token=SECRET2&tileSize=512"],
        },
        opacity: 1,
        metadata: { originalUrl: "https://tiles.example.com/{z}/{x}/{y}.png?key=SECRET3" },
      },
    ]);
    const exported = serializeLayerLibrary([entry]);
    for (const secret of ["SECRET1", "SECRET2", "SECRET3"]) {
      assert.equal(exported.includes(secret), false, secret);
    }
    const [reimported] = parseLayerLibrary(exported);
    // Everything that is not a credential survives, including the tile
    // placeholders, so the entry stays usable once a key is supplied again.
    assert.equal(reimported.source.url, "https://tiles.example.com/service?style=dark");
    assert.deepEqual(reimported.source.tiles, [
      "https://tiles.example.com/{z}/{x}/{y}.png?tileSize=512",
    ]);
    assert.equal(reimported.metadata.originalUrl, "https://tiles.example.com/{z}/{x}/{y}.png");
    // The in-memory entry is untouched, so re-adding locally still works.
    assert.equal(entry.source.url, "https://tiles.example.com/service?api_key=SECRET1&style=dark");
  });

  it("redacts every URL-shaped source field, not a named list of them", () => {
    // A URL-backed GeoJSON layer keeps its URL in `source.data`, which
    // `hasRestorableLayerSource` already treats as re-fetchable — so it has to be
    // swept too, along with any field a future layer type puts a URL in.
    const [entry] = normalizeLayerLibraryEntries([
      {
        id: "e-data",
        name: "Remote GeoJSON",
        addedAt: "",
        layerType: "geojson",
        source: {
          type: "geojson",
          data: "https://api.example.com/features.geojson?token=SECRET_DATA",
          someFutureUrl: "https://api.example.com/x?api_key=SECRET_FUTURE",
          maxzoom: 14,
        },
        opacity: 1,
        metadata: {},
      },
    ]);
    const exported = serializeLayerLibrary([entry]);
    assert.equal(exported.includes("SECRET_DATA"), false);
    assert.equal(exported.includes("SECRET_FUTURE"), false);
    const [reimported] = parseLayerLibrary(exported);
    assert.equal(reimported.source.data, "https://api.example.com/features.geojson");
    assert.equal(reimported.source.someFutureUrl, "https://api.example.com/x");
    // Non-string values are untouched.
    assert.equal(reimported.source.maxzoom, 14);
    assert.equal(reimported.source.type, "geojson");
  });

  it("sweeps credentials out of a nested source object", () => {
    // A layer type that groups its endpoint and auth one level down must not slip
    // a token past export just because it is not a top-level string.
    const [entry] = normalizeLayerLibraryEntries([
      {
        id: "e-nested",
        name: "Nested config",
        addedAt: "",
        layerType: "zarr",
        source: {
          url: "https://example.com/store.zarr",
          store: {
            endpoint: "https://example.com/store.zarr?api_key=SECRET_NESTED",
            requestHeaders: { Authorization: "Bearer SECRET_HEADER" },
            options: { mirrors: ["https://mirror.example.com/a?token=SECRET_DEEP"] },
          },
        },
        opacity: 1,
        metadata: {},
      },
    ]);
    const exported = serializeLayerLibrary([entry]);
    for (const secret of ["SECRET_NESTED", "SECRET_HEADER", "SECRET_DEEP"]) {
      assert.equal(exported.includes(secret), false, secret);
    }
    const [reimported] = parseLayerLibrary(exported);
    const store = reimported.source.store as Record<string, unknown>;
    assert.equal(store.endpoint, "https://example.com/store.zarr");
    assert.equal("requestHeaders" in store, false);
    assert.deepEqual((store.options as { mirrors: string[] }).mirrors, [
      "https://mirror.example.com/a",
    ]);
  });

  it("redacts password-style query parameters", () => {
    const [entry] = normalizeLayerLibraryEntries([
      {
        id: "e-pw",
        name: "Basic auth service",
        addedAt: "",
        layerType: "wms",
        source: { url: "https://wms.example.com/s?user=bob&password=SECRET_PW&LAYERS=a" },
        opacity: 1,
        metadata: {},
      },
    ]);
    const exported = serializeLayerLibrary([entry]);
    assert.equal(exported.includes("SECRET_PW"), false);
    const [reimported] = parseLayerLibrary(exported);
    assert.equal(reimported.source.url, "https://wms.example.com/s?user=bob&LAYERS=a");
  });

  it("leaves an inline GeoJSON source untouched on export", () => {
    // `source.data` can also be the features themselves; the sweep must not
    // mangle a FeatureCollection while looking for URLs.
    const [entry] = normalizeLayerLibraryEntries([
      {
        id: "e-inline",
        name: "Drawn features",
        addedAt: "",
        layerType: "geojson",
        source: { type: "geojson", data: POINTS },
        opacity: 1,
        metadata: { embeddedGeoJSON: POINTS },
      },
    ]);
    const [reimported] = parseLayerLibrary(serializeLayerLibrary([entry]));
    assert.deepEqual(reimported.source.data, POINTS);
  });

  it("redacts a credential in a URL fragment or in userinfo", () => {
    const [entry] = normalizeLayerLibraryEntries([
      {
        id: "e-frag",
        name: "Odd URLs",
        addedAt: "",
        layerType: "xyz",
        source: {
          // OAuth implicit flow returns the token in the fragment.
          url: "https://tiles.example.com/a#access_token=SECRET_FRAG&token_type=bearer",
          tiles: ["https://user:SECRET_PASS@tiles.example.com/{z}/{x}/{y}.png"],
        },
        opacity: 1,
        metadata: {},
      },
    ]);
    const exported = serializeLayerLibrary([entry]);
    assert.equal(exported.includes("SECRET_FRAG"), false);
    assert.equal(exported.includes("SECRET_PASS"), false);
    const [reimported] = parseLayerLibrary(exported);
    // The non-credential fragment parameter and the host both survive.
    assert.equal(reimported.source.url, "https://tiles.example.com/a#token_type=bearer");
    assert.deepEqual(reimported.source.tiles, ["https://tiles.example.com/{z}/{x}/{y}.png"]);
  });

  it("keeps a plain anchor fragment intact", () => {
    const [entry] = normalizeLayerLibraryEntries([
      {
        id: "e-anchor",
        name: "Anchored",
        addedAt: "",
        layerType: "geojson",
        source: { data: "https://example.com/doc.geojson#section-2" },
        opacity: 1,
        metadata: {},
      },
    ]);
    const [reimported] = parseLayerLibrary(serializeLayerLibrary([entry]));
    assert.equal(reimported.source.data, "https://example.com/doc.geojson#section-2");
  });

  it("leaves a credential-free URL byte-identical", () => {
    const [entry] = normalizeLayerLibraryEntries([
      {
        id: "e-plain",
        name: "Plain tiles",
        addedAt: "",
        layerType: "wms",
        source: {
          url: "https://wms.example.com/service?SERVICE=WMS&LAYERS=a,b&FORMAT=image/png",
          tiles: ["https://t.example.com/{z}/{x}/{y}.png"],
        },
        opacity: 1,
        metadata: {},
      },
    ]);
    const [reimported] = parseLayerLibrary(serializeLayerLibrary([entry]));
    assert.equal(reimported.source.url, entry.source.url);
    assert.deepEqual(reimported.source.tiles, entry.source.tiles);
  });

  it("strips a stale per-session metadata key when reading entries back", () => {
    // useLayerLibraryPersistence normalizes on every startup load, so an older
    // record (or a hand-edited bundle) must not keep replaying a dev-server
    // proxy rewrite.
    const [entry] = normalizeLayerLibraryEntries([
      {
        id: "e-stale",
        name: "XYZ",
        addedAt: "",
        layerType: "xyz",
        source: { tiles: ["https://tiles.example.com/{z}/{x}/{y}.png"] },
        opacity: 1,
        metadata: { originalUrl: "https://tiles.example.com/{z}/{x}/{y}.png", resolvedUrl: "/p/x" },
      },
    ]);
    assert.equal("resolvedUrl" in entry.metadata, false);
    assert.equal(entry.metadata.originalUrl, "https://tiles.example.com/{z}/{x}/{y}.png");
  });

  it("accepts a hand-authored bare array", () => {
    assert.deepEqual(parseLayerLibrary(JSON.stringify(entries)), entries);
  });

  it("refuses invalid JSON, a foreign file, a newer version, and an empty bundle", () => {
    assert.throws(() => parseLayerLibrary("{"), /invalid JSON/);
    assert.throws(
      () => parseLayerLibrary(JSON.stringify({ type: "something-else" })),
      /not a valid/i,
    );
    assert.throws(
      () =>
        parseLayerLibrary(
          JSON.stringify({ type: LAYER_LIBRARY_BUNDLE_TYPE, version: 99, entries }),
        ),
      /Unsupported/,
    );
    assert.throws(
      () =>
        parseLayerLibrary(
          JSON.stringify({
            type: LAYER_LIBRARY_BUNDLE_TYPE,
            version: LAYER_LIBRARY_BUNDLE_VERSION,
            entries: [],
          }),
        ),
      /no usable entries/,
    );
  });
});

describe("createLayerLibraryEntryId", () => {
  it("returns distinct non-empty ids", () => {
    const a = createLayerLibraryEntryId();
    const b = createLayerLibraryEntryId();
    assert.ok(a.length > 0);
    assert.notEqual(a, b);
  });
});
