import assert from "node:assert/strict";
import { it } from "node:test";
import { createArcgisZarrLayer, openArcgisZarrGrid } from "../packages/map/src/arcgis-zarr";
import { compileArcgisLayer } from "../packages/map/src/arcgis-layers";
import { registerZarrStore, readNativeZarrDimensions } from "../packages/map/src/zarr-source";
import type { ArcgisSdk } from "../packages/map/src/arcgis-sdk";
import { geojsonLayer } from "./helpers/layer-fixtures";

it("compares kerchunk manifests by identity without serializing their contents", () => {
  const refs = {
    toJSON() {
      throw new Error("manifest must not be serialized");
    },
  };
  const layer = geojsonLayer({
    type: "zarr",
    source: { url: "https://example.test/data.json", variable: "air", kerchunkRefs: refs },
  });
  const signature = (source: typeof layer.source) => {
    const plan = compileArcgisLayer({ ...layer, source });
    if (plan.kind !== "zarr") throw new Error("Expected Zarr");
    return plan.renderSignature;
  };
  assert.equal(signature(layer.source), signature({ ...layer.source, selector: { time: 1 } }));
  assert.notEqual(
    signature(layer.source),
    signature({ ...layer.source, kerchunkRefs: { ...refs } }),
  );
  assert.equal(
    signature(layer.source),
    signature({ ...layer.source, clim: [-20, 40], colormap: "magma" }),
    "cosmetic restyles retain the prepared grid and byte cache",
  );
});

it("renders the selected CF slice with north-up orientation, packing and fill masking", async () => {
  const bytes = new Map<string, Uint8Array>();
  const json = (path: string, value: unknown) =>
    bytes.set(path, new TextEncoder().encode(JSON.stringify(value)));
  function array(
    name: string,
    shape: number[],
    dims: string[],
    values: number[],
    attrs: object = {},
  ) {
    json(`/${name}/.zarray`, {
      zarr_format: 2,
      shape,
      chunks: shape,
      dtype: "<f8",
      fill_value: null,
      order: "C",
      filters: null,
      compressor: null,
    });
    json(`/${name}/.zattrs`, { _ARRAY_DIMENSIONS: dims, ...attrs });
    bytes.set(
      `/${name}/${shape.map(() => 0).join(".")}`,
      new Uint8Array(new Float64Array(values).buffer),
    );
  }
  array("lat", [2], ["lat"], [-45, 45]);
  array("lon", [2], ["lon"], [-90, 90]);
  array("time", [2], ["time"], [0, 1]);
  array("air", [2, 2, 2], ["time", "lat", "lon"], [1, 2, 3, 4, 10, 20, 30, -999], {
    scale_factor: 2,
    add_offset: 10,
    _FillValue: -999,
  });
  const layer = geojsonLayer({
    type: "zarr",
    source: {
      url: "local-zarr://test",
      variable: "air",
      selector: { time: 1 },
      clim: [0, 100],
      colormap: ["#000000", "#ffffff"],
    },
  });
  const reads: string[] = [];
  let failReads = false;
  const dispose = registerZarrStore(layer.id, {
    get: async (key) => {
      if (failReads) throw new Error("Temporary store failure");
      reads.push(key);
      return bytes.get(key);
    },
  });
  const abort = new AbortController();
  try {
    const grid = await openArcgisZarrGrid(layer, abort.signal);
    const rgba = await grid.renderTile(0, 0, 0, abort.signal);
    const pixel = (x: number, y: number) =>
      Array.from(rgba.slice((y * 256 + x) * 4, (y * 256 + x) * 4 + 4));
    assert.ok(Math.abs(pixel(64, 64)[0] - 179) <= 1);
    assert.equal(pixel(64, 64)[3], 255);
    assert.ok(Math.abs(pixel(64, 192)[0] - 77) <= 1);
    assert.equal(pixel(192, 64)[3], 0);
    const previousReads = reads.length;
    const earlier = await grid.renderTile(0, 0, 0, abort.signal, { time: 0 });
    assert.notDeepEqual(earlier, rgba);
    assert.equal(reads.length, previousReads, "time stepping reuses axes and cached chunks");
    await assert.rejects(grid.renderTile(0, 0, 0, abort.signal, { time: 2 }), /in-range/);
    array("nj", [2], ["nj"], [-45, 45]);
    array("ni", [2], ["ni"], [-90, 90]);
    array("custom", [2, 2, 2], ["time", "nj", "ni"], [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(
      await readNativeZarrDimensions({
        ...layer,
        source: {
          ...layer.source,
          variable: "custom",
          spatialDimensions: { lat: "nj", lon: "ni" },
        },
      }),
      { time: [0, 1] },
    );
    for (const latitudes of [
      [86, 89],
      [-89, -86],
    ]) {
      array("polarLat", [2], ["polarLat"], latitudes);
      array("polar", [2, 2], ["polarLat", "lon"], [1, 2, 3, 4]);
      const polar = await openArcgisZarrGrid(
        {
          ...layer,
          source: {
            ...layer.source,
            variable: "polar",
            selector: {},
            spatialDimensions: { lat: "polarLat", lon: "lon" },
            crs: "EPSG:4326",
          },
        },
        abort.signal,
      );
      assert.ok(polar.extent[1] <= polar.extent[3]);
      assert.ok(polar.extent[1] >= -85.05112878);
      assert.ok(polar.extent[3] <= 85.05112878);
    }
    array("crossLon", [2], ["crossLon"], [170, 190]);
    array("crossing", [2, 2], ["lat", "crossLon"], [1, 2, 3, 4]);
    const crossing = await openArcgisZarrGrid(
      {
        ...layer,
        source: {
          ...layer.source,
          variable: "crossing",
          selector: {},
          spatialDimensions: { lat: "lat", lon: "crossLon" },
          proj4: "+proj=longlat +datum=WGS84 +no_defs",
        },
      },
      abort.signal,
    );
    assert.equal(crossing.extent[2] - crossing.extent[0], 40);
    array("easting", [2], ["easting"], [500_000, 500_100]);
    array("northing", [2], ["northing"], [4_000_000, 4_000_100]);
    array("projected", [2, 2], ["northing", "easting"], [1, 2, 3, 4]);
    await assert.rejects(
      openArcgisZarrGrid(
        {
          ...layer,
          source: {
            ...layer.source,
            variable: "projected",
            selector: {},
            spatialDimensions: { lat: "northing", lon: "easting" },
          },
        },
        abort.signal,
      ),
      /Specify the CRS/,
    );
    const originalFetch = globalThis.fetch;
    let projectionRequests = 0;
    globalThis.fetch = async (input) => {
      assert.equal(String(input), "https://epsg.io/26915.proj4");
      projectionRequests++;
      return new Response(
        "+proj=utm +zone=15 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs",
      );
    };
    try {
      const projected = await openArcgisZarrGrid(
        {
          ...layer,
          source: {
            ...layer.source,
            variable: "projected",
            selector: {},
            spatialDimensions: { lat: "northing", lon: "easting" },
            crs: "EPSG:26915",
          },
        },
        abort.signal,
      );
      assert.equal(projectionRequests, 1);
      assert.ok(projected.extent.every(Number.isFinite));
    } finally {
      globalThis.fetch = originalFetch;
    }
    for (const attribute of ["scale_factor", "add_offset"]) {
      array("invalidPacking", [2, 2], ["lat", "lon"], [1, 2, 3, 4], { [attribute]: "invalid" });
      await assert.rejects(
        openArcgisZarrGrid(
          {
            ...layer,
            source: { ...layer.source, variable: "invalidPacking", selector: {} },
          },
          abort.signal,
        ),
        /scale_factor and add_offset must be finite/,
      );
    }
    array("bounded", [2, 3], ["y", "x"], [1, 2, 3, 4, 5, 6]);
    const bounded = await openArcgisZarrGrid(
      {
        ...layer,
        source: {
          ...layer.source,
          variable: "bounded",
          selector: {},
          bounds: [-10, -20, 20, 40],
        },
      },
      abort.signal,
    );
    assert.deepEqual(bounded.extent, [-10, -20, 20, 40]);
    // Exercise the native preparation promise against the real Zarr metadata reader.
    class Native {
      pending?: Promise<unknown>;
      refreshes = 0;
      addResolvingPromise(promise: Promise<unknown>) {
        this.pending = promise;
      }
      refresh() {
        this.refreshes++;
      }
    }
    const sdk = {
      layers: {
        BaseTileLayer: {
          createSubclass(definition: object) {
            Object.assign(Native.prototype, definition);
            return Native;
          },
        },
      },
      Extent: class {
        constructor(props: object) {
          Object.assign(this, props);
        }
      },
      webMercatorUtils: { geographicToWebMercator: (extent: object) => extent },
    } as unknown as ArcgisSdk;
    const native = createArcgisZarrLayer(sdk, layer, {});
    const loading = native.layer as unknown as {
      load(): void;
      pending: Promise<unknown>;
      refreshes: number;
      setStyle(source: typeof layer.source): void;
    };
    try {
      failReads = true;
      loading.load();
      await assert.rejects(loading.pending);
      failReads = false;
      loading.load();
      await loading.pending;
      assert.ok(native.layer.fullExtent);
      loading.setStyle({ ...layer.source, clim: [0, 50] });
      assert.equal(loading.refreshes, 1);
    } finally {
      native.dispose();
    }
    abort.abort();
    await assert.rejects(grid.renderTile(0, 0, 0, abort.signal), { name: "AbortError" });
  } finally {
    dispose();
  }
});
