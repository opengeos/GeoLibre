import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import {
  dataUrlParameters,
  serviceUrlParameter,
  fetchRemoteData,
  mapboxStyleForDataLayer,
  parseRasterUrlStyle,
} from "../apps/geolibre-desktop/src/lib/data-url";

const collection = (id: string) => ({
  type: "FeatureCollection" as const,
  features: [{ type: "Feature" as const, id, properties: {}, geometry: null }],
});

describe("serviceUrlParameter", () => {
  it("accepts supported service-prefill links", () => {
    assert.deepEqual(
      serviceUrlParameter(
        "?add=xyz&serviceUrl=https%3A%2F%2Ftiles.example.com%2F%7Bz%7D%2F%7Bx%7D%2F%7By%7D.png",
      ),
      {
        kind: "xyz",
        url: "https://tiles.example.com/{z}/{x}/{y}.png",
        layer: null,
        styleUrl: null,
      },
    );
  });

  it("carries the requested layer and a vector tileset's style", () => {
    assert.deepEqual(
      serviceUrlParameter(
        "?add=wfs&serviceUrl=https%3A%2F%2Fmaps.example.com%2Fwfs&serviceLayer=osm%3Awater_areas",
      ),
      {
        kind: "wfs",
        url: "https://maps.example.com/wfs",
        layer: "osm:water_areas",
        styleUrl: null,
      },
    );
    assert.deepEqual(
      serviceUrlParameter(
        "?add=ogc-vector-tiles&serviceUrl=https%3A%2F%2Ftiles.example.com%2F%7Bz%7D%2F%7Bx%7D%2F%7By%7D.pbf&serviceStyle=https%3A%2F%2Ftiles.example.com%2Fstyle.json",
      ),
      {
        kind: "ogc-vector-tiles",
        url: "https://tiles.example.com/{z}/{x}/{y}.pbf",
        layer: null,
        styleUrl: "https://tiles.example.com/style.json",
      },
    );
  });

  it("ignores a blank layer and a non-web style link", () => {
    assert.deepEqual(
      serviceUrlParameter(
        "?add=wms&serviceUrl=https://maps.example.com/wms&serviceLayer=%20&serviceStyle=file:///tmp/style.json",
      ),
      { kind: "wms", url: "https://maps.example.com/wms", layer: null, styleUrl: null },
    );
  });

  it("restores lower-case encoded tile-template braces", () => {
    assert.deepEqual(
      serviceUrlParameter(
        "?add=xyz&serviceUrl=https://tiles.example.com/%257bz%257d/%257bx%257d/%257by%257d.png",
      ),
      {
        kind: "xyz",
        url: "https://tiles.example.com/{z}/{x}/{y}.png",
        layer: null,
        styleUrl: null,
      },
    );
  });

  it("rejects unsupported kinds and non-web URLs", () => {
    assert.equal(serviceUrlParameter("?add=bogus&serviceUrl=https://example.com"), null);
    assert.equal(serviceUrlParameter("?add=xyz&serviceUrl=file:///tmp/tiles"), null);
  });
});

describe("per-file ZIP styles", () => {
  const style = {
    version: 8,
    layers: [
      { id: "shared-label", type: "symbol" },
      { id: "parks-fill", source: "parks", type: "fill" },
      { id: "counties-fill", source: "counties.geojson", type: "fill" },
      { id: "roads-line", source: "folder/roads.json", type: "line" },
    ],
  };

  it("keeps shared layers and layers whose source matches the filename stem", () => {
    const selected = mapboxStyleForDataLayer(style, "parks") as typeof style;
    assert.deepEqual(
      selected.layers.map((layer) => layer.id),
      ["shared-label", "parks-fill"],
    );
  });

  it("normalizes source paths and GeoJSON extensions", () => {
    const counties = mapboxStyleForDataLayer(style, "counties") as typeof style;
    const roads = mapboxStyleForDataLayer(style, "roads") as typeof style;
    assert.deepEqual(
      counties.layers.map((layer) => layer.id),
      ["shared-label", "counties-fill"],
    );
    assert.deepEqual(
      roads.layers.map((layer) => layer.id),
      ["shared-label", "roads-line"],
    );
  });

  it("preserves legacy styles that do not declare sources", () => {
    const shared = { version: 8, layers: [{ id: "fill", type: "fill" }] };
    assert.equal(mapboxStyleForDataLayer(shared, "parks"), shared);
  });
});

describe("raster URL styles", () => {
  it("accepts renderer state for an RGB raster", () => {
    assert.deepEqual(
      parseRasterUrlStyle({
        mode: "rgb",
        bands: [4, 3, 2],
        rescale: [
          [0, 3000],
          [0, 3000],
          [0, 3000],
        ],
        opacity: 0.8,
        gamma: 1.1,
        stretch: "sqrt",
      }),
      {
        mode: "rgb",
        bands: [4, 3, 2],
        rescale: [
          [0, 3000],
          [0, 3000],
          [0, 3000],
        ],
        opacity: 0.8,
        gamma: 1.1,
        stretch: "sqrt",
      },
    );
  });

  it("accepts single-band colormap settings", () => {
    assert.deepEqual(
      parseRasterUrlStyle({
        mode: "single",
        bands: [1],
        colormap: "viridis",
        reversed: true,
        nodata: "auto",
      }),
      { mode: "single", bands: [1], colormap: "viridis", reversed: true, nodata: "auto" },
    );
  });

  it("rejects invalid raster settings", () => {
    assert.throws(() => parseRasterUrlStyle({ opacity: 2 }), /between 0 and 1/);
    assert.throws(() => parseRasterUrlStyle({ bands: [0, 1] }), /positive integer/);
    assert.throws(() => parseRasterUrlStyle({ stretch: "cubic" }), /linear, log, or sqrt/);
    assert.throws(() => parseRasterUrlStyle({ version: 8, layers: [] }), /supported raster fields/);
  });
});

describe("data URL deep links", () => {
  it("parses data and style URLs, including an encoded REST endpoint query", () => {
    const endpoint = "https://api.example.com/features?category=parks&limit=20";
    const style = "https://example.com/parks.style.json";
    const parsed = dataUrlParameters(
      `?data=${encodeURIComponent(endpoint)}&style=${encodeURIComponent(style)}`,
    );
    assert.equal(parsed?.[0]?.dataUrl, endpoint);
    assert.equal(parsed?.[0]?.styleUrl, style);
  });

  it("parses raw, unencoded data and style URLs as documented", () => {
    // The spelling docs/user-guide/embedding.md leads with: `:` and `/` are legal
    // in a query value, so a plain https URL needs no encodeURIComponent.
    const parsed = dataUrlParameters(
      "?data=https://assets.geolibre.app/data/places.geojson" +
        "&style=https://assets.geolibre.app/data/sample.style.json",
    );
    assert.equal(parsed?.[0]?.dataUrl, "https://assets.geolibre.app/data/places.geojson");
    assert.equal(parsed?.[0]?.styleUrl, "https://assets.geolibre.app/data/sample.style.json");

    // Only the first `=` of each `&`-delimited pair separates name from value,
    // so a nested `=` survives unencoded — the docs tell readers not to escape it.
    const nested = dataUrlParameters("?data=https://api.example.com/features?category=parks");
    assert.equal(nested?.[0]?.dataUrl, "https://api.example.com/features?category=parks");
  });

  it("parses repeated data URLs and pairs repeated styles by position", () => {
    assert.deepEqual(
      dataUrlParameters(
        "?data=https://example.com/roads.geojson" +
          "&data=https://example.com/buildings.parquet" +
          "&style=https://example.com/roads.style.json" +
          "&style=https://example.com/buildings.style.json",
      ),
      [
        {
          dataUrl: "https://example.com/roads.geojson",
          styleUrl: "https://example.com/roads.style.json",
        },
        {
          dataUrl: "https://example.com/buildings.parquet",
          styleUrl: "https://example.com/buildings.style.json",
        },
      ],
    );
  });

  it("allows an empty positional style when only a later dataset is styled", () => {
    assert.deepEqual(
      dataUrlParameters(
        "?data=https://example.com/roads.geojson" +
          "&data=https://example.com/dem.tif" +
          "&style=&style=https://example.com/dem.style.json",
      ),
      [
        { dataUrl: "https://example.com/roads.geojson", styleUrl: null },
        {
          dataUrl: "https://example.com/dem.tif",
          styleUrl: "https://example.com/dem.style.json",
        },
      ],
    );
  });

  it("rejects non-http data URLs", () => {
    assert.equal(dataUrlParameters("?data=file:///tmp/private.geojson"), null);
  });

  it("loads an extensionless REST endpoint that returns a FeatureCollection", async () => {
    let requested = "";
    const endpoint = "https://api.example.com/v1/features?limit=10";
    const fetchImpl = (async (url: string) => {
      requested = url;
      return Response.json(collection("park"));
    }) as unknown as typeof fetch;
    const result = await fetchRemoteData(endpoint, { fetchImpl });
    assert.equal(requested, endpoint);
    assert.equal(result.kind, "geojson");
    if (result.kind === "geojson") assert.equal(result.layers[0]?.data.features[0]?.id, "park");
  });

  it("loads every GeoJSON file in a ZIP as a separate layer", async () => {
    const archive = zipSync({
      "areas/parks.geojson": strToU8(JSON.stringify(collection("parks"))),
      "roads.json": strToU8(JSON.stringify(collection("roads"))),
      "readme.txt": strToU8("ignored"),
    });
    const fetchImpl = (async () => new Response(archive)) as unknown as typeof fetch;
    const result = await fetchRemoteData("https://example.com/bundle.zip", { fetchImpl });
    assert.equal(result.kind, "geojson");
    if (result.kind === "geojson")
      assert.deepEqual(
        result.layers.map((layer) => layer.name),
        ["parks", "roads"],
      );
  });

  it("detects a ZIP returned by an extensionless REST API endpoint", async () => {
    const archive = zipSync({
      "cities.geojson": strToU8(JSON.stringify(collection("cities"))),
      "counties.geojson": strToU8(JSON.stringify(collection("counties"))),
    });
    const fetchImpl = (async () =>
      new Response(archive, {
        headers: { "Content-Type": "application/zip" },
      })) as unknown as typeof fetch;
    const result = await fetchRemoteData("https://api.example.com/v1/export?format=geojson", {
      fetchImpl,
    });
    assert.equal(result.kind, "geojson");
    if (result.kind === "geojson")
      assert.deepEqual(
        result.layers.map((layer) => layer.name),
        ["cities", "counties"],
      );
  });

  it("detects an API ZIP by its file signature when the content type is generic", async () => {
    const archive = zipSync({ "places.geojson": strToU8(JSON.stringify(collection("places"))) });
    const fetchImpl = (async () =>
      new Response(archive, {
        headers: { "Content-Type": "application/octet-stream" },
      })) as unknown as typeof fetch;
    const result = await fetchRemoteData("https://api.example.com/download/42", { fetchImpl });
    assert.equal(result.kind, "geojson");
    if (result.kind === "geojson") assert.equal(result.layers[0]?.name, "places");
  });

  it("recognizes a COG without downloading the whole raster", async () => {
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      throw new Error("unexpected");
    }) as unknown as typeof fetch;
    const result = await fetchRemoteData("https://example.com/elevation.tif?token=abc", {
      fetchImpl,
    });
    assert.equal(result.kind, "cog");
    assert.equal(fetched, false);
  });

  it("recognizes PMTiles without downloading the archive", async () => {
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      throw new Error("unexpected");
    }) as unknown as typeof fetch;
    const result = await fetchRemoteData("https://example.com/basemap.pmtiles?token=abc", {
      fetchImpl,
    });
    assert.deepEqual(result, {
      kind: "pmtiles",
      name: "basemap",
      url: "https://example.com/basemap.pmtiles?token=abc",
    });
    assert.equal(fetched, false);
  });

  it("recognizes Parquet and GeoParquet without downloading the file eagerly", async () => {
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      throw new Error("unexpected");
    }) as unknown as typeof fetch;
    const parquet = await fetchRemoteData("https://example.com/countries.parquet", { fetchImpl });
    const geoparquet = await fetchRemoteData("https://example.com/roads.geoparquet", {
      fetchImpl,
    });
    assert.deepEqual(parquet, {
      kind: "vector",
      name: "countries",
      url: "https://example.com/countries.parquet",
      format: "geoparquet",
    });
    assert.deepEqual(geoparquet, {
      kind: "vector",
      name: "roads",
      url: "https://example.com/roads.geoparquet",
      format: "geoparquet",
    });
    assert.equal(fetched, false);
  });

  it("names a file whose path carries a literal percent sign", async () => {
    const fetchImpl = (async () => {
      throw new Error("unexpected");
    }) as unknown as typeof fetch;
    const result = await fetchRemoteData("https://example.com/slope-100%.tif", { fetchImpl });
    assert.equal(result.kind, "cog");
    if (result.kind === "cog") assert.equal(result.name, "slope-100%");
  });

  it("refuses a response whose advertised length exceeds the download ceiling", async () => {
    const fetchImpl = (async () =>
      new Response(strToU8("{}"), {
        headers: { "Content-Length": String(400 * 1024 * 1024) },
      })) as unknown as typeof fetch;
    await assert.rejects(
      fetchRemoteData("https://api.example.com/export", { fetchImpl }),
      /too large to open from a URL \(400 MB\)/,
    );
  });

  it("stops reading a chunked response that streams past the ceiling", async () => {
    const chunk = new Uint8Array(8 * 1024 * 1024);
    let served = 0;
    let cancelled = false;
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            served += 1;
            controller.enqueue(chunk);
          },
          cancel() {
            cancelled = true;
          },
        }),
      )) as unknown as typeof fetch;
    await assert.rejects(
      fetchRemoteData("https://api.example.com/stream", { fetchImpl }),
      /too large to open from a URL/,
    );
    assert.equal(cancelled, true);
    // The ceiling is 250 MB, so an endless 8 MB stream is cut off well before
    // it could have buffered an unbounded body.
    assert.ok(served <= 34, `read ${served} chunks`);
  });
});
