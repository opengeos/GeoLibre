import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import {
  draftChangesMetadata,
  draftIssues,
  draftToMetadata,
  metadataToDraft,
} from "../apps/geolibre-desktop/src/components/panels/layer-panel/layer-metadata-draft";
import {
  GEOLIBRE_PARQUET_METADATA_KEY,
  layerParquetKeyValueMetadata,
  parquetKeyValueMetadataOption,
} from "../apps/geolibre-desktop/src/lib/parquet-kv-metadata";
import {
  buildLayerStacItemForExport,
  layerStacAssetHref,
} from "../apps/geolibre-desktop/src/lib/layer-stac-export";

function makeLayer(patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "layer-1",
    name: "Roads",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    ...patch,
  };
}

describe("Metadata dialog draft", () => {
  it("round-trips stored metadata through the form unchanged", () => {
    const stored = {
      title: "Roads",
      keywords: ["roads", "osm"],
      contact: { email: "a@b.org" },
      temporalExtent: { start: "2020-01-01" },
      links: [{ href: "https://x.org", rel: "about" }],
    };
    const draft = metadataToDraft(stored);
    assert.equal(draft.keywords, "roads, osm");
    assert.deepEqual(draftToMetadata(draft), stored);
    assert.equal(draftChangesMetadata(draft, stored), false);
    assert.equal(draftChangesMetadata({ ...draft, title: "Streets" }, stored), true);
  });

  it("treats whitespace-only edits as no change and blank forms as no metadata", () => {
    const draft = metadataToDraft(undefined);
    assert.equal(draftToMetadata(draft), undefined);
    assert.equal(draftChangesMetadata({ ...draft, title: "  " }, undefined), false);
    assert.equal(
      draftChangesMetadata({ ...draft, links: [{ href: "", rel: "x", title: "" }] }, undefined),
      false,
    );
  });

  it("addresses link errors by form row, skipping blank rows", () => {
    const draft = {
      ...metadataToDraft(undefined),
      contactEmail: "nope",
      temporalStart: "2020-02-30",
      links: [
        { href: "", rel: "", title: "" },
        { href: "ftp//broken", rel: "", title: "" },
      ],
    };
    assert.deepEqual(draftIssues(draft), [
      { field: "contact.email", code: "email" },
      { field: "temporalExtent.start", code: "date" },
      { field: "links.1.href", code: "url" },
    ]);
  });
});

describe("GeoParquet key-value metadata", () => {
  it("writes the normalized record under the GeoLibre key", () => {
    assert.equal(layerParquetKeyValueMetadata(makeLayer()), undefined);
    const entries = layerParquetKeyValueMetadata(
      makeLayer({ descriptiveMetadata: { title: " It's " } }),
    );
    assert.deepEqual(entries, { [GEOLIBRE_PARQUET_METADATA_KEY]: '{"title":"It\'s"}' });
  });

  it("builds a quoted KV_METADATA option", () => {
    assert.equal(parquetKeyValueMetadataOption(undefined), "");
    assert.equal(parquetKeyValueMetadataOption({}), "");
    assert.equal(
      parquetKeyValueMetadataOption({ "geolibre:metadata": '{"title":"It\'s"}' }),
      `, KV_METADATA {'geolibre:metadata': '{"title":"It''s"}'}`,
    );
  });
});

describe("STAC export inputs", () => {
  it("uses a remote source URL as the asset, with credentials redacted", () => {
    assert.equal(
      layerStacAssetHref(
        makeLayer({ source: { type: "geojson", url: "https://x.org/a.geojson" } }),
      ),
      "https://x.org/a.geojson",
    );
    const redacted = layerStacAssetHref(
      makeLayer({ type: "cog", source: { url: "https://x.org/a.tif?token=secret" } }),
    );
    assert.ok(redacted?.startsWith("https://x.org/a.tif"));
    assert.equal(redacted?.includes("secret"), false);
    assert.equal(
      layerStacAssetHref(
        makeLayer({ type: "xyz", source: { tiles: ["https://t.org/{z}/{x}/{y}.png"] } }),
      ),
      "https://t.org/{z}/{x}/{y}.png",
    );
  });

  it("leaves local paths and inline data out", () => {
    assert.equal(layerStacAssetHref(makeLayer({ sourcePath: "/home/me/roads.geojson" })), null);
    assert.equal(layerStacAssetHref(makeLayer({ source: { type: "geojson", data: "{}" } })), null);
  });

  it("fills the extent from the layer's features", async () => {
    const item = await buildLayerStacItemForExport(
      makeLayer({
        geojson: {
          type: "FeatureCollection",
          features: [
            { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [1, 2] } },
            { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [3, 4] } },
          ],
        },
      }),
      undefined,
    );
    assert.deepEqual(item.bbox, [1, 2, 3, 4]);
    assert.equal(item.geometry?.type, "Polygon");
  });
});
