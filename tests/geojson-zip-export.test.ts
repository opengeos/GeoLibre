import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import { strFromU8, unzipSync } from "fflate";
import { ensureZipFileName } from "../apps/geolibre-desktop/src/lib/file-names";
import {
  buildGeojsonZipArchive,
  buildProjectGeojsonZipSlug,
  buildUniqueGeojsonZipEntryNames,
  collectGeojsonLayersForExport,
  isExportableGeojsonLayer,
} from "../apps/geolibre-desktop/src/lib/geojson-zip-export";

function makeGeojsonLayer(
  id: string,
  name: string,
  features: FeatureCollection["features"] = [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [0, 0] },
      properties: { name: "A", secret: "hidden-val" },
    },
  ],
  overrides: Partial<GeoLibreLayer> = {},
): GeoLibreLayer {
  return {
    id,
    name,
    type: "geojson",
    visible: true,
    opacity: 1,
    source: {},
    style: {},
    geojson: { type: "FeatureCollection", features },
    metadata: {},
    ...overrides,
  } as GeoLibreLayer;
}

describe("ensureZipFileName", () => {
  it("keeps an existing .zip suffix and appends one when missing", () => {
    assert.equal(ensureZipFileName("world-layers.zip", "fallback"), "world-layers.zip");
    assert.equal(ensureZipFileName("world-layers.ZIP", "fallback"), "world-layers.ZIP");
    assert.equal(ensureZipFileName("world-layers", "fallback"), "world-layers.zip");
  });

  it("falls back to the slug for blank or dots-only names", () => {
    assert.equal(ensureZipFileName("   ", "my-map-geojson"), "my-map-geojson.zip");
    assert.equal(ensureZipFileName("...", "my-map-geojson"), "my-map-geojson.zip");
  });
});

describe("buildProjectGeojsonZipSlug", () => {
  it("normalizes project names and falls back on blank input", () => {
    assert.equal(buildProjectGeojsonZipSlug("Golarion World Map!"), "golarion-world-map-geojson");
    assert.equal(buildProjectGeojsonZipSlug("   "), "untitled-project-geojson");
    assert.equal(buildProjectGeojsonZipSlug("!!!"), "geolibre-map-geojson");
  });
});

describe("isExportableGeojsonLayer", () => {
  it("returns true for exportable geojson layers and false for non-geojson or non-exportable", () => {
    assert.equal(isExportableGeojsonLayer(makeGeojsonLayer("a", "Roads")), true);
    assert.equal(
      isExportableGeojsonLayer(
        makeGeojsonLayer("b", "Locked", [], { capabilities: { export: false } }),
      ),
      false,
    );
    assert.equal(
      isExportableGeojsonLayer({
        ...makeGeojsonLayer("c", "Tiles"),
        type: "xyz",
      } as GeoLibreLayer),
      false,
    );
  });
});

describe("buildUniqueGeojsonZipEntryNames", () => {
  it("sanitizes names, strips redundant .geojson/.json suffixes, and deduplicates case-insensitively", () => {
    const names = buildUniqueGeojsonZipEntryNames([
      { id: "1", name: "Roads.geojson" },
      { id: "2", name: "roads" },
      { id: "3", name: "ROADS.json" },
      { id: "4", name: "Cities / Towns" },
      { id: "5", name: "   " },
    ]);
    assert.equal(names.get("1"), "Roads.geojson");
    assert.equal(names.get("2"), "roads-2.geojson");
    assert.equal(names.get("3"), "ROADS-3.geojson");
    assert.equal(names.get("4"), "Cities-Towns.geojson");
    assert.equal(names.get("5"), "layer.geojson");
  });

  it("escapes Windows reserved device names including dotted forms", () => {
    const names = buildUniqueGeojsonZipEntryNames([
      { id: "1", name: "AUX" },
      { id: "2", name: "con" },
      { id: "3", name: "LPT1" },
      { id: "4", name: "NUL.extra" },
      { id: "5", name: "AUX-layer" },
    ]);
    assert.equal(names.get("1"), "AUX-layer.geojson");
    assert.equal(names.get("2"), "con-layer.geojson");
    assert.equal(names.get("3"), "LPT1-layer.geojson");
    assert.equal(names.get("4"), "NUL-layer.extra.geojson");
    assert.equal(names.get("5"), "AUX-layer-2.geojson");
  });
});

describe("collectGeojsonLayersForExport", () => {
  it("collects exportable layers, filters by layerIds, strips excluded fields, and reports blocked/skipped layers", async () => {
    const roads = makeGeojsonLayer("roads", "Roads", undefined, {
      fieldVisibility: { secret: "excluded" },
    });
    const cities = makeGeojsonLayer("cities", "Cities");
    const blocked = makeGeojsonLayer("blocked", "Blocked Drafts");
    const unresolved = makeGeojsonLayer("empty", "Not Ready", undefined, { geojson: undefined });
    const raster = { ...makeGeojsonLayer("r", "DEM"), type: "cog" } as GeoLibreLayer;

    const collected = await collectGeojsonLayersForExport(
      [roads, cities, blocked, unresolved, raster],
      undefined,
      {
        deps: {
          commitDrafts: (id) => (id === "blocked" ? "blocked" : "none"),
          readLatestLayer: (id) =>
            [roads, cities, blocked, unresolved, raster].find((l) => l.id === id),
          resolveGeojson: async (layer) => layer.geojson ?? null,
          materializeEmbeddable: async () => new Map(),
        },
      },
    );

    assert.deepEqual(
      collected.items.map((item) => item.fileName),
      ["Roads.geojson", "Cities.geojson"],
    );
    assert.deepEqual(collected.items[0].geojson.features[0].properties, { name: "A" });
    assert.deepEqual(collected.blockedDraftLayers, ["Blocked Drafts"]);
    assert.deepEqual(collected.skippedLayers, ["Not Ready"]);

    const subset = await collectGeojsonLayersForExport([roads, cities], undefined, {
      layerIds: new Set(["cities"]),
      deps: {
        commitDrafts: () => "none",
        readLatestLayer: (id) => [roads, cities].find((l) => l.id === id),
        resolveGeojson: async (layer) => layer.geojson ?? null,
      },
    });
    assert.deepEqual(
      subset.items.map((item) => item.layer.id),
      ["cities"],
    );
  });

  it("stops before committing drafts after a project switch, rechecks live export permission, and tolerates per-layer read failures", async () => {
    const a = makeGeojsonLayer("a", "A");
    const b = makeGeojsonLayer("b", "B");
    const c = makeGeojsonLayer("c", "C");
    const committed: string[] = [];
    let bRevoked = false;

    const mixed = await collectGeojsonLayersForExport([a, b, c], undefined, {
      projectGeneration: 1,
      deps: {
        readProjectGeneration: () => 1,
        commitDrafts: (id) => {
          committed.push(id);
          return "none";
        },
        readLatestLayer: (id) => {
          if (id === "b" && bRevoked) return { ...b, capabilities: { export: false } };
          return [a, b, c].find((l) => l.id === id);
        },
        resolveGeojson: async (layer) => {
          if (layer.id === "a") {
            bRevoked = true;
            throw new Error("source getData failed");
          }
          return layer.geojson ?? null;
        },
        materializeEmbeddable: async () => new Map(),
      },
    });

    assert.equal(mixed.aborted, false);
    assert.deepEqual(mixed.skippedLayers, ["A"]);
    // B had export revoked while A was loading, so its drafts were never committed and it was excluded.
    assert.deepEqual(committed, ["a", "c"]);
    assert.deepEqual(
      mixed.items.map((item) => item.layer.id),
      ["c"],
    );

    // Project switch stops before committing the next layer's drafts.
    let gen = 1;
    const committedAfterSwitch: string[] = [];
    const abortedRun = await collectGeojsonLayersForExport([a, b], undefined, {
      projectGeneration: 1,
      deps: {
        readProjectGeneration: () => gen,
        commitDrafts: (id) => {
          committedAfterSwitch.push(id);
          return "none";
        },
        readLatestLayer: (id) => [a, b].find((l) => l.id === id),
        resolveGeojson: async (layer) => {
          gen = 2;
          return layer.geojson ?? null;
        },
      },
    });
    assert.equal(abortedRun.aborted, true);
    assert.deepEqual(committedAfterSwitch, ["a"]);
    assert.deepEqual(abortedRun.items, []);

    // preserveHiddenFields keeps excluded attributes for local source copies.
    const hiddenLayer = makeGeojsonLayer("h", "Hidden", undefined, {
      fieldVisibility: { secret: "excluded" },
    });
    const preserved = await collectGeojsonLayersForExport([hiddenLayer], undefined, {
      preserveHiddenFields: true,
      deps: {
        commitDrafts: () => "none",
        readLatestLayer: () => hiddenLayer,
        resolveGeojson: async (layer) => layer.geojson ?? null,
      },
    });
    assert.deepEqual(preserved.items[0].geojson.features[0].properties, {
      name: "A",
      secret: "hidden-val",
    });
  });
});

describe("buildGeojsonZipArchive", () => {
  it("packages multiple FeatureCollections into a valid readable ZIP archive", async () => {
    const fc1: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [1, 2] },
          properties: { id: 1 },
        },
      ],
    };
    const fc2: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [3, 4] },
          properties: { id: 2 },
        },
      ],
    };

    const bytes = await buildGeojsonZipArchive([
      { fileName: "roads.geojson", geojson: fc1 },
      { fileName: "cities.geojson", geojson: fc2 },
    ]);
    const entries = unzipSync(bytes);
    assert.deepEqual(Object.keys(entries).sort(), ["cities.geojson", "roads.geojson"]);
    assert.deepEqual(JSON.parse(strFromU8(entries["roads.geojson"])), fc1);
    assert.deepEqual(JSON.parse(strFromU8(entries["cities.geojson"])), fc2);
  });
});
