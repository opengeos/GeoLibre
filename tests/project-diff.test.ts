import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature, FeatureCollection } from "geojson";
import {
  createEmptyProject,
  DEFAULT_LAYER_STYLE,
  diffFeatureCollections,
  diffProjects,
  jsonValuesEqual,
  parseProject,
  previewValue,
  serializeProject,
  type GeoLibreLayer,
  type GeoLibreProject,
} from "@geolibre/core";

function point(
  x: number,
  y: number,
  properties: Record<string, unknown> = {},
  id?: number | string,
) {
  const feature: Feature = {
    type: "Feature",
    geometry: { type: "Point", coordinates: [x, y] },
    properties,
  };
  if (id !== undefined) feature.id = id;
  return feature;
}

function fc(features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

function layer(id: string, over: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id,
    name: `Layer ${id}`,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    ...over,
  };
}

function project(layers: GeoLibreLayer[], over: Partial<GeoLibreProject> = {}): GeoLibreProject {
  const base = createEmptyProject("Demo");
  const styles: GeoLibreProject["styles"] = {};
  for (const item of layers) styles[item.id] = item.style;
  return { ...base, layers, styles, ...over };
}

/** A JSON round trip, the shape an autosave snapshot comes back in. */
function roundTrip(value: GeoLibreProject): GeoLibreProject {
  return parseProject(serializeProject(value));
}

describe("diffProjects", () => {
  it("reports nothing for identical and round-tripped projects", () => {
    const p = project([layer("a", { geojson: fc([point(1, 2, { n: 1 })]) }), layer("b")], {
      plugins: {
        manifestUrls: [],
        activePluginIds: ["swipe"],
        mapControlPositions: { swipe: "top-left" },
        settings: { swipe: { orientation: "vertical" } },
      },
    });
    assert.equal(diffProjects(p, p).changeCount, 0);
    const diff = diffProjects(roundTrip(p), p);
    assert.equal(diff.changeCount, 0, JSON.stringify(diff));
  });

  it("detects added and removed layers with feature counts", () => {
    const before = project([layer("a"), layer("b", { geojson: fc([point(0, 0), point(1, 1)]) })]);
    const after = project([layer("a"), layer("c", { name: "New", geojson: fc([point(0, 0)]) })]);
    const diff = diffProjects(before, after);
    assert.deepEqual(
      diff.layers.added.map((l) => [l.id, l.name, l.featureCount]),
      [["c", "New", 1]],
    );
    assert.deepEqual(
      diff.layers.removed.map((l) => [l.id, l.featureCount]),
      [["b", 2]],
    );
    assert.equal(diff.layers.changed.length, 0);
    assert.equal(diff.changeCount, 2);
  });

  it("detects renames, visibility and opacity changes", () => {
    const before = project([layer("a")]);
    const after = project([layer("a", { name: "Renamed", visible: false, opacity: 0.5 })]);
    const [change] = diffProjects(before, after).layers.changed;
    assert.deepEqual(change.renamed, { before: "Layer a", after: "Renamed" });
    assert.deepEqual(change.visibility, { before: true, after: false });
    assert.deepEqual(change.opacity, { before: 1, after: 0.5 });
    assert.equal(change.name, "Renamed");
  });

  it("reports only the layer that moved, not every layer it passed", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const before = project(ids.map((id) => layer(id)));
    // Move "a" from the bottom to the top.
    const after = project(["b", "c", "d", "e", "a"].map((id) => layer(id)));
    const diff = diffProjects(before, after);
    assert.equal(diff.layers.reordered, true);
    assert.deepEqual(
      diff.layers.changed.map((l) => [l.id, l.moved]),
      [["a", { before: 0, after: 4 }]],
    );
  });

  it("does not flag order changes caused only by additions and removals", () => {
    const before = project([layer("a"), layer("b"), layer("c")]);
    const after = project([layer("x"), layer("a"), layer("c"), layer("y")]);
    const diff = diffProjects(before, after);
    assert.equal(diff.layers.reordered, false);
    assert.equal(diff.layers.changed.length, 0);
  });

  it("summarizes style keys and label keys separately with before/after values", () => {
    const before = project([layer("a")]);
    const after = project([
      layer("a", {
        style: {
          ...DEFAULT_LAYER_STYLE,
          fillColor: "#ff0000",
          strokeWidth: 4,
          labels: { ...DEFAULT_LAYER_STYLE.labels, enabled: true, field: "name" },
        },
      }),
    ]);
    const [change] = diffProjects(before, after).layers.changed;
    const style = Object.fromEntries(change.style.map((c) => [c.path, c]));
    assert.equal(style.fillColor.after, "#ff0000");
    assert.equal(style.fillColor.before, DEFAULT_LAYER_STYLE.fillColor);
    assert.equal(style.strokeWidth.after, "4");
    assert.ok(!change.style.some((c) => c.path.startsWith("labels")));
    const labels = Object.fromEntries(change.labels.map((c) => [c.path, c]));
    assert.equal(labels.enabled.before, "false");
    assert.equal(labels.enabled.after, "true");
    assert.equal(labels.field.after, "name");
  });

  it("prefers the top-level styles map, mirroring project load", () => {
    const a = layer("a");
    const before = project([a]);
    const after = project([a]);
    after.styles = { a: { ...DEFAULT_LAYER_STYLE, fillColor: "#123456" } };
    const [change] = diffProjects(before, after).layers.changed;
    assert.deepEqual(
      change.style.map((c) => c.path),
      ["fillColor"],
    );
  });

  it("reports filter expression and quick filter changes", () => {
    const before = project([layer("a")]);
    const after = project([
      layer("a", {
        filterExpression: [">", ["get", "pop"], 1000],
        quickFilters: [{ id: "q", field: "kind", kind: "category", values: ["x"] } as never],
      }),
    ]);
    const [change] = diffProjects(before, after).layers.changed;
    assert.deepEqual(change.filter.map((c) => c.path).sort(), ["filterExpression", "quickFilters"]);
    const expression = change.filter.find((c) => c.path === "filterExpression")!;
    assert.equal(expression.before, undefined);
    assert.equal(expression.after, '[">",["get","pop"],1000]');
  });

  it("reports source, popup and metadata changes in their groups", () => {
    const before = project([layer("a", { source: { type: "raster", tiles: ["https://a/{z}"] } })]);
    const after = project([
      layer("a", {
        source: { type: "raster", tiles: ["https://b/{z}"] },
        metadata: { attribution: "Me" },
        popup: { mode: "fields" } as never,
      }),
    ]);
    const [change] = diffProjects(before, after).layers.changed;
    assert.deepEqual(
      change.source.map((c) => c.path),
      ["source.tiles"],
    );
    assert.deepEqual(change.other.map((c) => c.path).sort(), ["metadata.attribution", "popup"]);
  });

  it("truncates long previews", () => {
    const before = project([layer("a")]);
    const after = project([layer("a", { metadata: { note: "x".repeat(500) } })]);
    const [change] = diffProjects(before, after, { maxPreviewLength: 20 }).layers.changed;
    const note = change.other[0].after!;
    assert.equal(note.length, 20);
    assert.ok(note.endsWith("…"));
  });

  it("detects camera, basemap and projection changes", () => {
    const before = createEmptyProject("P");
    const after: GeoLibreProject = {
      ...before,
      mapView: { ...before.mapView, zoom: before.mapView.zoom + 2, center: [10, 20] },
      basemapStyleUrl: "https://example.com/style.json",
      basemapOpacity: 0.4,
      preferences: {
        ...before.preferences,
        map: { ...before.preferences.map, projection: "mercator", maxZoom: 18 },
      },
    };
    const diff = diffProjects(before, after);
    assert.deepEqual(diff.camera.map((c) => c.path).sort(), ["center", "zoom"]);
    assert.equal(diff.camera.find((c) => c.path === "center")!.after, "10.00000, 20.00000");
    assert.deepEqual(diff.basemap.map((c) => c.path).sort(), ["basemapOpacity", "basemapStyleUrl"]);
    assert.deepEqual(diff.projection, [{ path: "projection", before: "globe", after: "mercator" }]);
    assert.deepEqual(
      diff.preferences.map((c) => c.path),
      ["map.maxZoom"],
    );
  });

  it("ignores sub-epsilon camera jitter", () => {
    const before = createEmptyProject("P");
    const after = {
      ...before,
      mapView: { ...before.mapView, zoom: before.mapView.zoom + 1e-9 },
    };
    assert.equal(diffProjects(before, after).camera.length, 0);
  });

  it("reports plugin activation, deactivation and settings changes per plugin", () => {
    const before = project([], {
      plugins: {
        manifestUrls: ["https://a/plugin.json"],
        activePluginIds: ["swipe", "legend"],
        mapControlPositions: { swipe: "top-left" },
        settings: { swipe: { orientation: "vertical" }, legend: { title: "L" } },
      },
    });
    const after = project([], {
      plugins: {
        manifestUrls: ["https://b/plugin.json"],
        activePluginIds: ["swipe", "minimap"],
        mapControlPositions: { swipe: "top-right" },
        settings: { swipe: { orientation: "horizontal" }, legend: { title: "L" } },
      },
    });
    const diff = diffProjects(before, after);
    const byId = Object.fromEntries(diff.plugins.map((p) => [p.id, p]));
    assert.equal(byId.minimap.status, "added");
    assert.equal(byId.legend.status, "removed");
    assert.equal(byId.swipe.status, "changed");
    assert.deepEqual(byId.swipe.changes.map((c) => c.path).sort(), [
      "position",
      "settings.orientation",
    ]);
    assert.deepEqual(diff.pluginManifests, {
      added: ["https://b/plugin.json"],
      removed: ["https://a/plugin.json"],
    });
  });

  it("reports title, description and other metadata, description first", () => {
    const before = project([], { metadata: { description: "Old", author: "A" } });
    const after = project([], {
      name: "New title",
      metadata: { author: "B", description: "New" },
    });
    const diff = diffProjects(before, after);
    assert.deepEqual(
      diff.metadata.map((c) => c.path),
      ["name", "description", "author"],
    );
    assert.equal(diff.metadata[0].before, "Demo");
    assert.equal(diff.metadata[0].after, "New title");
  });

  it("lists other changed top-level sections without treating empty as changed", () => {
    const before = project([], { widgets: [] });
    const after = project([], {
      widgets: [{ id: "w", layerId: "a", type: "bar" } as never],
      comments: [],
    });
    assert.deepEqual(diffProjects(before, after).sections, ["widgets"]);
  });
});

describe("diffFeatureCollections", () => {
  it("matches features by id", () => {
    const before = fc([point(0, 0, { v: 1 }, 1), point(1, 1, { v: 1 }, 2), point(2, 2, {}, 3)]);
    const after = fc([
      point(0, 0, { v: 1 }, 1), // unchanged
      point(1, 1, { v: 2 }, 2), // properties changed
      point(5, 5, {}, 4), // added; id 3 removed
    ]);
    assert.deepEqual(diffFeatureCollections(before, after), {
      added: 1,
      removed: 1,
      modified: 1,
      unchanged: 1,
      matchedBy: "id",
    });
  });

  it("treats a moved feature with an id as modified", () => {
    const summary = diffFeatureCollections(fc([point(0, 0, {}, "a")]), fc([point(9, 9, {}, "a")]));
    assert.equal(summary.modified, 1);
  });

  it("falls back to geometry matching when features have no id", () => {
    const before = fc([point(0, 0, { v: 1 }), point(1, 1, { v: 1 }), point(2, 2), point(2, 2)]);
    const after = fc([
      point(0, 0, { v: 1 }), // unchanged
      point(1, 1, { v: 9 }), // same geometry, new properties → modified
      point(2, 2), // one of the duplicates removed
      point(7, 7), // moved/added
    ]);
    assert.deepEqual(diffFeatureCollections(before, after), {
      added: 1,
      removed: 1,
      modified: 1,
      unchanged: 2,
      matchedBy: "geometry",
    });
  });

  it("reports mixed matching and handles duplicate ids", () => {
    const before = fc([point(0, 0, {}, 1), point(0, 0, {}, 1), point(3, 3)]);
    const after = fc([point(0, 0, {}, 1), point(3, 3)]);
    const summary = diffFeatureCollections(before, after);
    assert.equal(summary.matchedBy, "mixed");
    assert.equal(summary.removed, 1);
    assert.equal(summary.unchanged, 2);
  });

  it("feeds a layer's feature summary and skips shared collections", () => {
    const shared = fc([point(0, 0)]);
    const unchanged = diffProjects(
      project([layer("a", { geojson: shared })]),
      project([layer("a", { geojson: shared, opacity: 0.3 })]),
    );
    assert.equal(unchanged.layers.changed[0].features, undefined);
    const edited = diffProjects(
      project([layer("a", { geojson: fc([point(0, 0)]) })]),
      project([layer("a", { geojson: fc([point(0, 0), point(1, 1)]) })]),
    );
    assert.equal(edited.layers.changed[0].features?.added, 1);
  });

  it("handles absent collections", () => {
    assert.deepEqual(diffFeatureCollections(undefined, fc([point(0, 0, {}, 1)])), {
      added: 1,
      removed: 0,
      modified: 0,
      unchanged: 0,
      matchedBy: "id",
    });
  });

  it("stays fast on large collections and reuses feature hashes", () => {
    const count = 50_000;
    const features: Feature[] = [];
    for (let i = 0; i < count; i++) {
      features.push(point(i / 1000, i / 2000, { name: `feature ${i}`, value: i }, i));
    }
    const before = project([layer("big", { geojson: fc(features) })]);
    const parsedBefore = roundTrip(before);
    const edited = features.slice();
    edited[10] = point(0, 0, { name: "edited" }, 10);
    edited.push(point(1, 1, {}, count));
    const after = project([layer("big", { geojson: fc(edited) })]);

    let start = performance.now();
    const diff = diffProjects(parsedBefore, after);
    const firstMs = performance.now() - start;
    assert.deepEqual(diff.layers.changed[0].features, {
      added: 1,
      removed: 0,
      modified: 1,
      unchanged: count - 1,
      matchedBy: "id",
    });
    // Generous bound: catches accidental quadratic work, not machine speed.
    assert.ok(firstMs < 5_000, `diff took ${firstMs.toFixed(0)} ms`);

    start = performance.now();
    diffProjects(parsedBefore, after);
    const secondMs = performance.now() - start;
    assert.ok(secondMs < 5_000, `cached diff took ${secondMs.toFixed(0)} ms`);
  });
});

describe("helpers", () => {
  it("jsonValuesEqual treats undefined keys as absent", () => {
    assert.ok(jsonValuesEqual({ a: 1, b: undefined }, { a: 1 }));
    assert.ok(!jsonValuesEqual({ a: 1 }, { a: 2 }));
    assert.ok(!jsonValuesEqual([1, 2], [2, 1]));
  });

  it("previewValue bounds the work on huge values", () => {
    const huge = Array.from({ length: 1_000_000 }, (_, i) => i);
    const preview = previewValue(huge, 30)!;
    assert.equal(preview.length, 30);
    assert.ok(preview.startsWith("[0,1,2"));
    assert.equal(previewValue(undefined), undefined);
    assert.equal(previewValue({ a: undefined, b: 1 }), '{"b":1}');
  });
});
