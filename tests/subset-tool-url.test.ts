import type { GeoLibreLayer } from "@geolibre/core";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  layersForSubsetUrl,
  subsetUrlFieldValues,
  subsetUrlToolKind,
} from "../apps/geolibre-desktop/src/lib/subset-tool-url";

function layer(partial: Partial<GeoLibreLayer>): GeoLibreLayer {
  return {
    id: "l1",
    name: "layer",
    type: "cog",
    source: {},
    visible: true,
    opacity: 1,
    style: {} as GeoLibreLayer["style"],
    metadata: {},
    ...partial,
  };
}

describe("subsetUrlToolKind", () => {
  it("maps each subset extractor to its raster family", () => {
    assert.equal(subsetUrlToolKind("extract_cog_subset"), "cog");
    assert.equal(subsetUrlToolKind("extract_wms_subset"), "wms");
    assert.equal(subsetUrlToolKind("extract_xyz_tile_subset"), "xyz");
  });

  it("returns null for non-subset tools", () => {
    assert.equal(subsetUrlToolKind("slope"), null);
    assert.equal(subsetUrlToolKind(""), null);
  });
});

describe("layersForSubsetUrl", () => {
  const cogRemote = layer({
    id: "cog-remote",
    type: "cog",
    source: { url: "https://example.com/dem.tif" },
  });
  const cogLocal = layer({
    id: "cog-local",
    type: "cog",
    source: {},
    metadata: { localBytesUrl: "blob:abc" },
  });
  const wms = layer({
    id: "wms",
    type: "wms",
    source: { url: "https://example.com/wms", layers: "topo" },
  });
  const xyz = layer({
    id: "xyz",
    type: "xyz",
    source: { tiles: ["https://example.com/{z}/{x}/{y}.png"] },
  });
  const all = [cogRemote, cogLocal, wms, xyz];

  it("offers only remote COGs to the COG extractor (a blob COG is excluded)", () => {
    assert.deepEqual(
      layersForSubsetUrl("extract_cog_subset", all).map((l) => l.id),
      ["cog-remote"],
    );
  });

  it("offers WMS layers to the WMS extractor and XYZ to the XYZ extractor", () => {
    assert.deepEqual(
      layersForSubsetUrl("extract_wms_subset", all).map((l) => l.id),
      ["wms"],
    );
    assert.deepEqual(
      layersForSubsetUrl("extract_xyz_tile_subset", all).map((l) => l.id),
      ["xyz"],
    );
  });

  it("returns nothing for a non-subset tool", () => {
    assert.deepEqual(layersForSubsetUrl("slope", all), []);
  });
});

describe("subsetUrlFieldValues", () => {
  it("fills the COG url from a remote source, rejecting a blob-only COG", () => {
    assert.deepEqual(
      subsetUrlFieldValues(
        "extract_cog_subset",
        layer({ source: { url: "https://example.com/dem.tif" } }),
      ),
      { url: "https://example.com/dem.tif" },
    );
    assert.equal(
      subsetUrlFieldValues(
        "extract_cog_subset",
        layer({ source: {}, metadata: { localBytesUrl: "blob:abc" } }),
      ),
      null,
    );
  });

  it("fills WMS url plus layers, and styles when present", () => {
    assert.deepEqual(
      subsetUrlFieldValues(
        "extract_wms_subset",
        layer({
          type: "wms",
          source: {
            url: "https://example.com/wms",
            layers: "topo",
            styles: "default",
          },
        }),
      ),
      { url: "https://example.com/wms", layers: "topo", styles: "default" },
    );
  });

  it("requires both a url and layer name for WMS", () => {
    assert.equal(
      subsetUrlFieldValues(
        "extract_wms_subset",
        layer({ type: "wms", source: { url: "https://example.com/wms" } }),
      ),
      null,
    );
  });

  it("fills the XYZ template plus tile size and normalized subdomains", () => {
    assert.deepEqual(
      subsetUrlFieldValues(
        "extract_xyz_tile_subset",
        layer({
          type: "xyz",
          source: {
            tiles: ["https://{s}.example.com/{z}/{x}/{y}.png"],
            tileSize: 512,
            subdomains: ["a", "b", "c"],
          },
        }),
      ),
      {
        url: "https://{s}.example.com/{z}/{x}/{y}.png",
        tile_size: "512",
        subdomains: "abc",
      },
    );
  });
});
