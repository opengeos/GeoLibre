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
  MAX_LAYER_LIBRARY_ENTRY_BYTES,
  normalizeLayerLibraryEntries,
  parseLayerLibrary,
  planLayerLibraryAdd,
  serializeLayerLibrary,
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
    assert.deepEqual(result, { ok: false, reason: "too-large" });
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
    assert.deepEqual(result, { ok: false, reason: "too-large" });
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
