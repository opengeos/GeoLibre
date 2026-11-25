import { Window } from "happy-dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fetchRemoteData,
  isThreeDTilesUrl,
  remoteName,
  serviceUrlParameter,
} from "../apps/geolibre-desktop/src/lib/data-url";
import { arcgisLayerTypeFromUrl } from "../packages/plugins/src/plugins/arcgis-layer";

/** A fetch that fails the test if a loader downloads what it should hand on by URL. */
function noFetch() {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    throw new Error("unexpected download");
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("?data= formats added for the browser extension", () => {
  it("hands FlatGeobuf to the vector control by URL", async () => {
    const { calls, fetchImpl } = noFetch();
    assert.deepEqual(await fetchRemoteData("https://example.com/parcels.fgb", { fetchImpl }), {
      kind: "vector",
      name: "parcels",
      url: "https://example.com/parcels.fgb",
      format: "flatgeobuf",
    });
    assert.deepEqual(
      await fetchRemoteData("https://example.com/roads.flatgeobuf?sig=1", {
        fetchImpl,
      }),
      {
        kind: "vector",
        name: "roads",
        url: "https://example.com/roads.flatgeobuf?sig=1",
        format: "flatgeobuf",
      },
    );
    assert.deepEqual(calls, []);
  });

  it("routes a tileset.json to 3D Tiles, named after its folder, without downloading it", async () => {
    const { calls, fetchImpl } = noFetch();
    assert.deepEqual(
      await fetchRemoteData("https://tiles.example.com/city%20center/tileset.json?key=a", {
        fetchImpl,
      }),
      {
        kind: "3d-tiles",
        name: "city center",
        url: "https://tiles.example.com/city%20center/tileset.json?key=a",
      },
    );
    assert.deepEqual(calls, []);
  });

  it("honours a 3d-tiles dataType hint on an extensionless endpoint", async () => {
    const { calls, fetchImpl } = noFetch();
    // Plugin handlers are not consulted for a built-in hint.
    const fileHandlers = {
      ready: Promise.resolve(),
      list: () => {
        throw new Error("handlers consulted");
      },
      forDataType: () => {
        throw new Error("handlers consulted");
      },
    };
    assert.deepEqual(
      await fetchRemoteData("https://api.example.com/tiles/42", {
        fetchImpl,
        dataType: "3d-tiles",
        fileHandlers: fileHandlers as never,
      }),
      { kind: "3d-tiles", name: "42", url: "https://api.example.com/tiles/42" },
    );
    assert.deepEqual(calls, []);
  });

  it("recognizes only a tileset.json entry document as 3D Tiles", () => {
    assert.equal(isThreeDTilesUrl("https://example.com/a/tileset.json"), true);
    assert.equal(isThreeDTilesUrl("https://example.com/a/TILESET.JSON?x=1"), true);
    assert.equal(isThreeDTilesUrl("https://example.com/a/mytileset.json"), false);
    assert.equal(isThreeDTilesUrl("https://example.com/a/tileset.geojson"), false);
  });

  it("strips the new extensions from layer names", () => {
    assert.equal(remoteName("https://example.com/parcels.fgb"), "parcels");
    assert.equal(remoteName("https://example.com/ride.gpx"), "ride");
  });
});

describe("?add=zarr deep link", () => {
  it("opens the Add Zarr dialog on the store URL", () => {
    assert.deepEqual(
      serviceUrlParameter(
        `?add=zarr&serviceUrl=${encodeURIComponent("https://data.example.com/sst.zarr")}`,
      ),
      {
        kind: "zarr",
        url: "https://data.example.com/sst.zarr",
        layer: null,
        styleUrl: null,
      },
    );
    assert.equal(serviceUrlParameter("?add=zarr"), null);
  });
});

describe("arcgisLayerTypeFromUrl", () => {
  it("reads the layer type from the service segment", () => {
    const base = "https://gis.example.com/arcgis/rest/services/X";
    assert.equal(arcgisLayerTypeFromUrl(`${base}/FeatureServer/0`), "feature");
    assert.equal(arcgisLayerTypeFromUrl(`${base}/MapServer`), "map-service");
    assert.equal(arcgisLayerTypeFromUrl(`${base}/mapserver/`), "map-service");
    assert.equal(arcgisLayerTypeFromUrl(`${base}/ImageServer`), "image-service");
    assert.equal(arcgisLayerTypeFromUrl(`${base}/VectorTileServer`), "vector-tile");
  });

  it("returns null for anything it cannot place", () => {
    assert.equal(arcgisLayerTypeFromUrl(""), null);
    assert.equal(arcgisLayerTypeFromUrl("not a url"), null);
    assert.equal(arcgisLayerTypeFromUrl("https://example.com/MapServerless/x"), null);
  });
});

it("parses GPX waypoints, tracks and routes through the desktop GPX parser", async () => {
  const window = new Window();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "DOMParser");
  Object.defineProperty(globalThis, "DOMParser", { configurable: true, value: window.DOMParser });
  try {
    const xml =
      '<gpx version="1.1"><wpt lat="35" lon="-84"><name>Start</name></wpt><trk><name>Track</name><trkseg><trkpt lat="35" lon="-84"/><trkpt lat="36" lon="-83"/></trkseg></trk><rte><name>Route</name><rtept lat="35" lon="-84"/><rtept lat="35.5" lon="-83.5"/></rte></gpx>';
    const data = await fetchRemoteData("https://example.com/ride.GPX?token=abc", {
      fetchImpl: async () => new Response(xml),
    });
    assert.equal(data.kind, "geojson");
    if (data.kind !== "geojson") throw Error("Expected split GPX layers");
    assert.equal(data.layers.length, 3);
    assert.deepEqual(
      data.layers.map((layer) => layer.data.features[0].geometry?.type),
      ["Point", "LineString", "LineString"],
    );
    assert.ok(
      data.layers.every((layer) => layer.sourcePath === "https://example.com/ride.GPX?token=abc"),
    );
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "DOMParser", descriptor);
    else Reflect.deleteProperty(globalThis, "DOMParser");
    await window.happyDOM.close();
  }
});
