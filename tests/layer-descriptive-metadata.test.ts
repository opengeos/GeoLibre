import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  DEFAULT_BASEMAP,
  DEFAULT_LAYER_STYLE,
  STAC_PROCESSING_EXTENSION,
  buildLayerStacItem,
  captureLayerLibraryEntry,
  createEmptyProject,
  isValidMetadataDate,
  isValidMetadataEmail,
  isValidMetadataUrl,
  metadataDateToRfc3339,
  normalizeLayerDescriptiveMetadata,
  normalizeLayerLibraryEntries,
  parseMetadataKeywords,
  parseProject,
  planLayerLibraryAdd,
  projectFromStore,
  serializeProject,
  stacAssetMediaType,
  validateLayerDescriptiveMetadata,
  type GeoLibreLayer,
  type LayerDescriptiveMetadata,
} from "@geolibre/core";
import { setHistoryCoalesceMs } from "../packages/core/src/history";
import { redo, undo, useAppStore } from "../packages/core/src/store";

const FULL_METADATA: LayerDescriptiveMetadata = {
  title: "Rivers of Tennessee",
  abstract: "Major rivers digitized from 1:24k topographic maps.",
  keywords: ["hydrology", "rivers"],
  license: "CC-BY-4.0",
  attribution: "© Tennessee GIS",
  contact: { name: "Ada Lovelace", email: "ada@example.org", organization: "TN GIS" },
  lineage: "Digitized in 2019; generalized with Douglas-Peucker (10 m).",
  temporalExtent: { start: "2019-01-01", end: "2019-12-31" },
  links: [
    { href: "https://example.org/rivers", rel: "about", title: "Project page" },
    { href: "https://example.org/license" },
  ],
};

function makeLayer(patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "layer-rivers",
    name: "Rivers",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: { type: "FeatureCollection", features: [] },
    ...patch,
  };
}

function roundTrip(layer: GeoLibreLayer): GeoLibreLayer | undefined {
  const project = projectFromStore({
    projectName: "Metadata",
    mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
    basemapStyleUrl: DEFAULT_BASEMAP,
    basemapVisible: true,
    basemapOpacity: 1,
    layers: [layer],
    preferences: createEmptyProject().preferences,
    metadata: {},
  });
  return parseProject(serializeProject(project)).layers[0];
}

describe("normalizeLayerDescriptiveMetadata", () => {
  it("keeps a complete record unchanged", () => {
    assert.deepEqual(normalizeLayerDescriptiveMetadata(FULL_METADATA), FULL_METADATA);
  });

  it("trims fields and drops blanks, duplicate keywords and links without an address", () => {
    assert.deepEqual(
      normalizeLayerDescriptiveMetadata({
        title: "  Roads ",
        abstract: "   ",
        keywords: [" roads", "Roads", "", 7, "transport "],
        contact: { name: " ", email: "a@b.co" },
        temporalExtent: { start: "", end: " 2020-05-01 " },
        links: [
          { href: " ", title: "orphan label" },
          { href: "https://x.org", rel: " " },
        ],
        unknown: "ignored",
      }),
      {
        title: "Roads",
        keywords: ["roads", "transport"],
        contact: { email: "a@b.co" },
        temporalExtent: { end: "2020-05-01" },
        links: [{ href: "https://x.org" }],
      },
    );
  });

  it("returns undefined for an empty or malformed record", () => {
    assert.equal(normalizeLayerDescriptiveMetadata(undefined), undefined);
    assert.equal(normalizeLayerDescriptiveMetadata([]), undefined);
    assert.equal(normalizeLayerDescriptiveMetadata("title"), undefined);
    assert.equal(
      normalizeLayerDescriptiveMetadata({ title: " ", keywords: [], contact: {}, links: [] }),
      undefined,
    );
  });

  it("keeps a malformed value so the dialog can show and fix it", () => {
    assert.deepEqual(normalizeLayerDescriptiveMetadata({ contact: { email: "not-an-email" } }), {
      contact: { email: "not-an-email" },
    });
  });
});

describe("parseMetadataKeywords", () => {
  it("splits on commas, trims and de-duplicates case-insensitively", () => {
    assert.deepEqual(parseMetadataKeywords("roads, Transport ,, roads,osm"), [
      "roads",
      "Transport",
      "osm",
    ]);
    assert.deepEqual(parseMetadataKeywords("  "), []);
  });
});

describe("metadata field validation", () => {
  it("checks email shape", () => {
    assert.equal(isValidMetadataEmail("ada@example.org"), true);
    assert.equal(isValidMetadataEmail("ada@example"), false);
    assert.equal(isValidMetadataEmail("ada example.org"), false);
  });

  it("accepts absolute data URLs and rejects script schemes and relative paths", () => {
    assert.equal(isValidMetadataUrl("https://example.org/a"), true);
    assert.equal(isValidMetadataUrl("s3://bucket/key.tif"), true);
    assert.equal(isValidMetadataUrl("mailto:ada@example.org"), true);
    assert.equal(isValidMetadataUrl("javascript:alert(1)"), false);
    assert.equal(isValidMetadataUrl("data:text/html,hi"), false);
    assert.equal(isValidMetadataUrl("/relative/path"), false);
  });

  it("accepts ISO 8601 dates and date-times naming real instants", () => {
    for (const value of [
      "2020-02-29",
      "2020-01-01T10:00",
      "2020-01-01T10:00:30Z",
      "2020-01-01T10:00:30.5+02:00",
    ]) {
      assert.equal(isValidMetadataDate(value), true, value);
    }
    for (const value of [
      "2021-02-29",
      "2020-13-01",
      "2020-1-1",
      "01/02/2020",
      "2020-01-01T25:00",
    ]) {
      assert.equal(isValidMetadataDate(value), false, value);
    }
    // Years below 100 are real years, not 1900-1999 (Date.UTC's legacy rule).
    assert.equal(isValidMetadataDate("0099-01-01"), true);
    assert.equal(isValidMetadataDate("0099-02-29"), false);
  });

  it("converts dates to RFC 3339, covering a whole day for date-only bounds", () => {
    assert.equal(metadataDateToRfc3339("2020-05-01", "start"), "2020-05-01T00:00:00Z");
    assert.equal(metadataDateToRfc3339("2020-05-01", "end"), "2020-05-01T23:59:59Z");
    assert.equal(metadataDateToRfc3339("2020-05-01T12:30", "start"), "2020-05-01T12:30:00.000Z");
    assert.equal(
      metadataDateToRfc3339("2020-05-01T12:30:00+02:00", "start"),
      "2020-05-01T10:30:00.000Z",
    );
    // A compact offset converts the same as the colon form.
    assert.equal(
      metadataDateToRfc3339("2020-05-01T12:30:00+0200", "start"),
      "2020-05-01T10:30:00.000Z",
    );
    assert.equal(metadataDateToRfc3339("nope", "start"), null);
  });

  it("reports each invalid field by path", () => {
    assert.deepEqual(validateLayerDescriptiveMetadata(FULL_METADATA), []);
    assert.deepEqual(
      validateLayerDescriptiveMetadata({
        contact: { email: "bad" },
        temporalExtent: { start: "2020-31-01", end: "2020-01-01" },
        links: [{ href: "https://ok.org" }, { href: "javascript:alert(1)" }],
      }),
      [
        { field: "contact.email", code: "email" },
        { field: "temporalExtent.start", code: "date" },
        { field: "links.1.href", code: "url" },
      ],
    );
    assert.deepEqual(
      validateLayerDescriptiveMetadata({
        temporalExtent: { start: "2021-01-01", end: "2020-01-01" },
      }),
      [{ field: "temporalExtent.end", code: "dateOrder" }],
    );
    // The same day as both bounds is a valid (one-day) interval.
    assert.deepEqual(
      validateLayerDescriptiveMetadata({
        temporalExtent: { start: "2020-01-01", end: "2020-01-01" },
      }),
      [],
    );
  });
});

describe("project round trip", () => {
  it("persists descriptive metadata through save and reopen", () => {
    const reopened = roundTrip(makeLayer({ descriptiveMetadata: FULL_METADATA }));
    assert.deepEqual(reopened?.descriptiveMetadata, FULL_METADATA);
  });

  it("never writes an empty record", () => {
    const layer = makeLayer({
      descriptiveMetadata: { title: "  ", keywords: [], contact: {} },
    });
    const project = projectFromStore({
      projectName: "Metadata",
      mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
      basemapStyleUrl: DEFAULT_BASEMAP,
      basemapVisible: true,
      basemapOpacity: 1,
      layers: [layer],
      preferences: createEmptyProject().preferences,
      metadata: {},
    });
    assert.equal("descriptiveMetadata" in (project.layers[0] ?? {}), false);
    assert.equal(serializeProject(project).includes("descriptiveMetadata"), false);
  });

  it("loads an older project without the block unchanged", () => {
    const project = createEmptyProject("Old");
    const json = JSON.stringify({ ...project, layers: [makeLayer()] });
    const layer = parseProject(json).layers[0];
    assert.equal(layer?.descriptiveMetadata, undefined);
    assert.equal(layer && "descriptiveMetadata" in layer, false);
  });

  it("cleans a hand-edited block on load", () => {
    const project = createEmptyProject("Edited");
    const json = JSON.stringify({
      ...project,
      layers: [
        makeLayer({ descriptiveMetadata: { title: " T ", keywords: "not-a-list" } as never }),
      ],
    });
    assert.deepEqual(parseProject(json).layers[0]?.descriptiveMetadata, { title: "T" });
  });
});

describe("store setter", () => {
  beforeEach(() => {
    setHistoryCoalesceMs(0);
    useAppStore.getState().newProject({ name: "metadata" });
    useAppStore.getState().addLayer(makeLayer());
  });

  it("normalizes, records one undo step per save, and removes an emptied record", () => {
    const { setLayerDescriptiveMetadata } = useAppStore.getState();
    const current = () => useAppStore.getState().layers[0]?.descriptiveMetadata;
    setLayerDescriptiveMetadata("layer-rivers", { title: " Rivers v2 ", keywords: ["a", "A"] });
    assert.deepEqual(current(), { title: "Rivers v2", keywords: ["a"] });
    setLayerDescriptiveMetadata("layer-rivers", { title: "Rivers v3" });
    assert.deepEqual(current(), { title: "Rivers v3" });

    undo();
    assert.deepEqual(current(), { title: "Rivers v2", keywords: ["a"] });
    redo();
    assert.deepEqual(current(), { title: "Rivers v3" });

    setLayerDescriptiveMetadata("layer-rivers", { title: "  " });
    assert.equal(current(), undefined);
    assert.equal(useAppStore.getState().isDirty, true);
  });
});

describe("layer library", () => {
  it("captures and reapplies descriptive metadata", () => {
    const geojson = {
      type: "FeatureCollection" as const,
      features: [
        {
          type: "Feature" as const,
          properties: {},
          geometry: { type: "Point" as const, coordinates: [0, 0] },
        },
      ],
    };
    const layer = makeLayer({ descriptiveMetadata: FULL_METADATA, geojson });
    const captured = captureLayerLibraryEntry(layer, {
      id: "entry-1",
      addedAt: "2026-01-01T00:00:00Z",
    });
    assert.equal(captured.ok, true);
    if (!captured.ok) return;
    assert.deepEqual(captured.entry.descriptiveMetadata, FULL_METADATA);
    const [restored] = normalizeLayerLibraryEntries([captured.entry]);
    assert.deepEqual(restored?.descriptiveMetadata, FULL_METADATA);
    const plan = planLayerLibraryAdd(captured.entry, { id: "new-layer" });
    assert.equal(plan.kind, "layer");
    if (plan.kind === "layer") assert.deepEqual(plan.layer.descriptiveMetadata, FULL_METADATA);
  });
});

describe("buildLayerStacItem", () => {
  const now = new Date("2026-10-04T12:00:00Z");

  it("maps every field onto a STAC 1.0 Item", () => {
    const item = buildLayerStacItem(makeLayer({ descriptiveMetadata: FULL_METADATA }), {
      bbox: [-90, 34, -81, 37],
      assetHref: "https://example.org/rivers.geojson",
      now,
    });
    assert.deepEqual(item, {
      type: "Feature",
      stac_version: "1.0.0",
      stac_extensions: [STAC_PROCESSING_EXTENSION],
      id: "layer-rivers",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-90, 34],
            [-81, 34],
            [-81, 37],
            [-90, 37],
            [-90, 34],
          ],
        ],
      },
      bbox: [-90, 34, -81, 37],
      properties: {
        datetime: null,
        title: "Rivers of Tennessee",
        description: "Major rivers digitized from 1:24k topographic maps.",
        keywords: ["hydrology", "rivers"],
        start_datetime: "2019-01-01T00:00:00Z",
        end_datetime: "2019-12-31T23:59:59Z",
        license: "CC-BY-4.0",
        providers: [
          {
            name: "TN GIS",
            roles: ["producer"],
            description: "Contact: Ada Lovelace, ada@example.org",
          },
        ],
        "geolibre:attribution": "© Tennessee GIS",
        "processing:lineage": "Digitized in 2019; generalized with Douglas-Peucker (10 m).",
      },
      links: [
        { href: "https://example.org/rivers", rel: "about", title: "Project page" },
        { href: "https://example.org/license", rel: "related" },
      ],
      assets: {
        data: {
          href: "https://example.org/rivers.geojson",
          type: "application/geo+json",
          title: "Rivers of Tennessee",
          roles: ["data"],
        },
      },
    });
  });

  it("satisfies the STAC Item structural requirements with no metadata at all", () => {
    const item = buildLayerStacItem(makeLayer(), { now });
    assert.equal(item.type, "Feature");
    assert.equal(item.stac_version, "1.0.0");
    assert.equal(typeof item.id, "string");
    // No extent: STAC allows a null geometry, and then forbids a bbox.
    assert.equal(item.geometry, null);
    assert.equal("bbox" in item, false);
    assert.equal(item.properties.datetime, "2026-10-04T12:00:00.000Z");
    assert.equal(item.properties.title, "Rivers");
    assert.deepEqual(item.links, []);
    assert.deepEqual(item.assets, {});
    assert.deepEqual(item.stac_extensions, []);
    // A valid Item is JSON-serializable as-is.
    assert.deepEqual(JSON.parse(JSON.stringify(item)), item);
  });

  it("uses datetime for an instant or a one-sided interval", () => {
    const instant = buildLayerStacItem(
      makeLayer({
        descriptiveMetadata: {
          temporalExtent: { start: "2020-06-01", end: "2020-06-01T00:00:00Z" },
        },
      }),
      { now },
    );
    assert.equal(instant.properties.datetime, "2020-06-01T00:00:00Z");
    assert.equal("start_datetime" in instant.properties, false);
    const openEnded = buildLayerStacItem(
      makeLayer({ descriptiveMetadata: { temporalExtent: { end: "2021-03-04" } } }),
      { now },
    );
    assert.equal(openEnded.properties.datetime, "2021-03-04T23:59:59Z");
  });

  it("exports a free-text license as proprietary and keeps the text", () => {
    const item = buildLayerStacItem(
      makeLayer({ descriptiveMetadata: { license: "Public domain (US Government work)" } }),
      { now },
    );
    assert.equal(item.properties.license, "proprietary");
    assert.equal(item.properties["geolibre:license"], "Public domain (US Government work)");
    assert.match(String(item.properties.license), /^[\w\-.+]+$/);
  });

  it("drops invalid links and builds point and antimeridian footprints", () => {
    const point = buildLayerStacItem(
      makeLayer({ descriptiveMetadata: { links: [{ href: "javascript:alert(1)" }] } }),
      { bbox: [10, 20, 10, 20], now },
    );
    assert.deepEqual(point.links, []);
    assert.deepEqual(point.geometry, { type: "Point", coordinates: [10, 20] });
    const crossing = buildLayerStacItem(makeLayer(), { bbox: [170, -10, -170, 10], now });
    assert.equal(crossing.geometry?.type, "MultiPolygon");
    assert.deepEqual(crossing.bbox, [170, -10, -170, 10]);
    const invalid = buildLayerStacItem(makeLayer(), { bbox: [0, 95, 1, 96], now });
    assert.equal(invalid.geometry, null);
  });

  it("names the provider from whatever contact field exists", () => {
    const item = buildLayerStacItem(
      makeLayer({ descriptiveMetadata: { contact: { email: "ada@example.org" } } }),
      { now },
    );
    assert.deepEqual(item.properties.providers, [
      { name: "ada@example.org", roles: ["producer"], description: "Contact: ada@example.org" },
    ]);
  });
});

describe("stacAssetMediaType", () => {
  it("guesses from the extension, then the layer type", () => {
    assert.equal(
      stacAssetMediaType("https://x.org/a.tif?sig=1", "cog"),
      "image/tiff; application=geotiff; profile=cloud-optimized",
    );
    assert.equal(
      stacAssetMediaType("https://x.org/a.parquet", "geoparquet"),
      "application/vnd.apache.parquet",
    );
    assert.equal(
      stacAssetMediaType("https://x.org/a.pmtiles", "pmtiles"),
      "application/vnd.pmtiles",
    );
    assert.equal(stacAssetMediaType("https://x.org/features", "geojson"), "application/geo+json");
    assert.equal(stacAssetMediaType("https://x.org/{z}/{x}/{y}.png", "xyz"), undefined);
  });
});
