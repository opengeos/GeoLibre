import { interpolateRampColors, type GeoLibreLayer } from "@geolibre/core";
import proj4 from "proj4";
import type { ArcgisRasterLayer, ArcgisSdk } from "./arcgis-sdk";
import { getZarrStore } from "./zarr-source";
import { cssToArcgisColor } from "./arcgis-layers";

/** Read regular CF grids through public Zarrita APIs, independent of a map. */
export async function openArcgisZarrGrid(layer: GeoLibreLayer, signal: AbortSignal) {
  const zarr = await import("zarrita");
  const source = layer.source;
  const variable = String(source.variable || "");
  if (!variable) throw new Error("A Zarr variable is required");
  const cache = new Map<string, Uint8Array | undefined>();
  let cacheBytes = 0;
  const refs = source.kerchunkRefs;
  const referenceStore = refs
    ? new (await import("./kerchunk-reference-store")).KerchunkReferenceStore(
        refs as import("./kerchunk-reference-store").KerchunkRefs,
        { headers: source.headers as Record<string, string> | undefined },
      )
    : undefined;
  const base =
    getZarrStore(layer.id) ??
    referenceStore ??
    new zarr.FetchStore(String(source.url), {
      overrides: { headers: source.headers as Record<string, string> | undefined },
    });
  const store = zarr.withByteCaching(base, {
    cache: {
      has: (key) => cache.has(key),
      get: (key) => cache.get(key),
      set(key, value) {
        cacheBytes -= cache.get(key)?.byteLength ?? 0;
        cache.delete(key);
        cache.set(key, value);
        cacheBytes += value?.byteLength ?? 0;
        while ((cacheBytes > 32 * 1024 * 1024 || cache.size > 2048) && cache.size) {
          const first = cache.keys().next().value!;
          cacheBytes -= cache.get(first)?.byteLength ?? 0;
          cache.delete(first);
        }
      },
    },
  });
  const root = zarr.root(store);
  const array = await zarr.open(root.resolve(variable), { kind: "array", signal });
  if (!array.is("number")) throw new Error("Zarr rendering requires a numeric array");
  const names = array.dimensionNames;
  if (!names) throw new Error("Zarr requires named spatial dimensions");
  const spatial = source.spatialDimensions as { lon?: string; lat?: string } | undefined;
  const xDim = names.findIndex((name) =>
    spatial?.lon ? name === spatial.lon : /^(lon|longitude|x)$/i.test(name),
  );
  const yDim = names.findIndex((name) =>
    spatial?.lat ? name === spatial.lat : /^(lat|latitude|y)$/i.test(name),
  );
  if (xDim < 0 || yDim < 0 || xDim === yDim)
    throw new Error("Zarr requires separate one-dimensional spatial axes");
  const crs = String(source.proj4 || source.crs || "EPSG:4326");
  const transform = proj4("EPSG:4326", crs);
  const geographic = /^(EPSG:4326|WGS84)$/i.test(crs);
  const explicit = source.bounds as number[] | undefined;
  const parent = variable.includes("/") ? variable.slice(0, variable.lastIndexOf("/") + 1) : "";
  async function axis(dim: number, horizontal: boolean) {
    const count = array.shape[dim];
    if (count > 1_000_000) throw new Error("Zarr coordinate axis exceeds one million cells");
    if (count < 2) throw new Error("Zarr spatial axes require at least two cells");
    let first: number, last: number;
    let units = "";
    try {
      const coordinate = await zarr.open(root.resolve(parent + names![dim]), {
        kind: "array",
        signal,
      });
      if (
        !coordinate.is("number") ||
        coordinate.shape.length !== 1 ||
        coordinate.shape[0] !== count
      )
        throw new Error("Zarr spatial coordinates must be one-dimensional");
      units = String(coordinate.attrs.units ?? "");
      // Read the coordinate vector to reject curvilinear/irregular placement,
      // rather than silently stretching those grids onto a regular raster.
      const values = await zarr.get(coordinate, [null], { signal });
      first = Number(values.data[0]);
      last = Number(values.data[count - 1]);
      const step = (last - first) / (count - 1);
      for (let i = 0; i < count; i++)
        if (
          !Number.isFinite(Number(values.data[i])) ||
          Math.abs(Number(values.data[i]) - (first + step * i)) >
            Math.max(Math.abs(step) * 0.001, 1e-7)
        )
          throw new Error("ArcGIS Zarr currently requires regularly spaced spatial coordinates");
    } catch (error) {
      if (!(error instanceof zarr.NotFoundError) || !explicit) throw error;
      const min = explicit[horizontal ? 0 : 1],
        max = explicit[horizontal ? 2 : 3];
      const step = (max - min) / count;
      first = horizontal ? min + step / 2 : max - step / 2;
      last = horizontal ? max - step / 2 : min + step / 2;
    }
    const step = (last - first) / (count - 1);
    if (!Number.isFinite(step) || step === 0) throw new Error("Invalid Zarr spatial coordinates");
    return {
      first,
      units,
      step,
      count,
      min: Math.min(first, last) - Math.abs(step) / 2,
      max: Math.max(first, last) + Math.abs(step) / 2,
    };
  }
  const [xAxis, yAxis] = await Promise.all([axis(xDim, true), axis(yDim, false)]);
  if (
    !source.crs &&
    !source.proj4 &&
    !explicit &&
    ((/^x$/i.test(names[xDim]) && !/degrees?_east/i.test(xAxis.units)) ||
      (/^y$/i.test(names[yDim]) && !/degrees?_north/i.test(yAxis.units)))
  )
    throw new Error("Specify the CRS for Zarr x/y coordinates");
  function selectionFor(selector: Record<string, unknown>) {
    const selection: (number | import("zarrita").Slice)[] = names!.map(() => 0);
    for (let i = 0; i < names!.length; i++) {
      if (i === xDim || i === yDim) continue;
      const value = selector[names![i]] ?? 0;
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 0 ||
        value >= array.shape[i]
      )
        throw new Error(`Zarr selector ${names![i]} must be an in-range integer index`);
      selection[i] = value;
    }
    return selection;
  }
  const initialSelector = (source.selector ?? {}) as Record<string, unknown>;
  selectionFor(initialSelector);
  const colors = (
    Array.isArray(source.colormap) && source.colormap.length
      ? source.colormap
      : interpolateRampColors(String(source.colormap || "viridis"), 256)
  ) as string[];
  const ramp = colors.map((color) => cssToArcgisColor(color));
  const clim = Array.isArray(source.clim) ? source.clim.map(Number) : [0, 1];
  if (clim.length !== 2 || !clim.every(Number.isFinite) || clim[1] <= clim[0])
    throw new Error("Zarr color limits must increase");
  const scale = Number(array.attrs.scale_factor ?? 1),
    offset = Number(array.attrs.add_offset ?? 0);
  if (!Number.isFinite(scale) || !Number.isFinite(offset))
    throw new Error("Zarr scale_factor and add_offset must be finite numbers");
  const fill = array.attrs._FillValue ?? array.fillValue;
  const bounds = [xAxis.min, yAxis.min, xAxis.max, yAxis.max];
  const corners = [
    [bounds[0], bounds[1]],
    [bounds[0], bounds[3]],
    [bounds[2], bounds[1]],
    [bounds[2], bounds[3]],
  ].map((p) => transform.inverse(p));
  const extent: [number, number, number, number] = [
    Math.min(...corners.map((p) => p[0])),
    Math.min(...corners.map((p) => p[1])),
    Math.max(...corners.map((p) => p[0])),
    Math.max(...corners.map((p) => p[1])),
  ];
  if (geographic) {
    const shift = Math.round((extent[0] + extent[2]) / 720) * 360;
    extent[0] -= shift;
    extent[2] -= shift;
    if (extent[0] < -180 || extent[2] > 180) {
      extent[0] = -180;
      extent[2] = 180;
    }
  }
  extent[1] = Math.min(85.05112878, Math.max(-85.05112878, extent[1]));
  extent[3] = Math.max(extent[1], Math.min(85.05112878, extent[3]));
  return {
    extent,
    async renderTile(
      z: number,
      x: number,
      y: number,
      requestSignal: AbortSignal,
      selector = initialSelector,
    ) {
      const selection = selectionFor(selector);
      requestSignal.throwIfAborted();
      const rgba = new Uint8ClampedArray(256 * 256 * 4);
      const xs = new Int32Array(256 * 256).fill(-1),
        ys = new Int32Array(256 * 256);
      let minX = Infinity,
        minY = Infinity,
        maxX = -1,
        maxY = -1;
      for (let row = 0; row < 256; row++)
        for (let col = 0; col < 256; col++) {
          const lon = ((x + (col + 0.5) / 256) / 2 ** z) * 360 - 180;
          const lat =
            (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + (row + 0.5) / 256)) / 2 ** z))) * 180) /
            Math.PI;
          const p = transform.forward([lon, lat]);
          if (geographic) p[0] += Math.round(((xAxis.min + xAxis.max) / 2 - p[0]) / 360) * 360;
          const ix = Math.round((p[0] - xAxis.first) / xAxis.step),
            iy = Math.round((p[1] - yAxis.first) / yAxis.step);
          if (
            !Number.isFinite(ix) ||
            !Number.isFinite(iy) ||
            ix < 0 ||
            iy < 0 ||
            ix >= xAxis.count ||
            iy >= yAxis.count
          )
            continue;
          const at = row * 256 + col;
          xs[at] = ix;
          ys[at] = iy;
          minX = Math.min(minX, ix);
          maxX = Math.max(maxX, ix);
          minY = Math.min(minY, iy);
          maxY = Math.max(maxY, iy);
        }
      if (maxX < 0) return rgba;
      // Bound the returned window even when a low-zoom tile spans a large grid.
      const stepX = Math.max(1, Math.ceil((maxX - minX + 1) / 512)),
        stepY = Math.max(1, Math.ceil((maxY - minY + 1) / 512));
      const pick = [...selection];
      pick[xDim] = zarr.slice(minX, maxX + 1, stepX);
      pick[yDim] = zarr.slice(minY, maxY + 1, stepY);
      const chunk = await zarr.get(array, pick, { signal: requestSignal });
      const xi = xDim < yDim ? 0 : 1,
        yi = 1 - xi;
      for (let i = 0; i < xs.length; i++) {
        if (xs[i] < 0) continue;
        const cx = Math.min(chunk.shape[xi] - 1, Math.round((xs[i] - minX) / stepX)),
          cy = Math.min(chunk.shape[yi] - 1, Math.round((ys[i] - minY) / stepY));
        const raw = Number(chunk.data[cx * chunk.stride[xi] + cy * chunk.stride[yi]]);
        if (!Number.isFinite(raw) || raw === fill) continue;
        const value = raw * scale + offset,
          t = Math.max(0, Math.min(1, (value - clim[0]) / (clim[1] - clim[0]))) * (ramp.length - 1);
        const lo = Math.floor(t),
          hi = Math.ceil(t),
          f = t - lo;
        for (let c = 0; c < 3; c++) rgba[i * 4 + c] = ramp[lo][c] * (1 - f) + ramp[hi][c] * f;
        rgba[i * 4 + 3] = (ramp[lo][3] * (1 - f) + ramp[hi][3] * f) * 255;
      }
      return rgba;
    },
  };
}

export interface ArcgisZarrLayer extends ArcgisRasterLayer {
  setSelector(selector: Record<string, unknown>): void;
  refresh(): void;
}

export function createArcgisZarrLayer(
  sdk: ArcgisSdk,
  layer: GeoLibreLayer,
  properties: Record<string, unknown>,
) {
  const lifetime = new AbortController();
  let sliceLifetime = new AbortController();
  let selector = (layer.source.selector ?? {}) as Record<string, unknown>;
  let selectorKey = JSON.stringify(selector);
  let ready: ReturnType<typeof openArcgisZarrGrid> | undefined;
  const prepare = () =>
    (ready ??= openArcgisZarrGrid(layer, lifetime.signal).catch((error: unknown) => {
      ready = undefined;
      throw error;
    }));
  const Native = sdk.layers.BaseTileLayer.createSubclass({
    setSelector(this: ArcgisZarrLayer, next: Record<string, unknown>) {
      const key = JSON.stringify(next);
      if (key === selectorKey) return;
      selector = { ...next };
      selectorKey = key;
      sliceLifetime.abort();
      sliceLifetime = new AbortController();
      this.refresh();
    },
    load(this: ArcgisRasterLayer) {
      this.addResolvingPromise(
        prepare().then(({ extent }) => {
          if (this.destroyed) return;
          this.fullExtent = sdk.webMercatorUtils.geographicToWebMercator(
            new sdk.Extent({
              xmin: extent[0],
              ymin: extent[1],
              xmax: extent[2],
              ymax: extent[3],
              spatialReference: { wkid: 4326 },
            }),
          );
        }),
      );
    },
    async fetchTile(z: number, y: number, x: number, options?: { signal?: AbortSignal }) {
      const selected = selector;
      const signal = AbortSignal.any([
        lifetime.signal,
        sliceLifetime.signal,
        ...(options?.signal ? [options.signal] : []),
      ]);
      signal.throwIfAborted();
      const grid = await prepare();
      signal.throwIfAborted();
      const rgba = await grid.renderTile(z, x, y, signal, selected);
      signal.throwIfAborted();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 256;
      canvas.getContext("2d")!.putImageData(new ImageData(rgba, 256, 256), 0, 0);
      return canvas;
    },
  });
  return { layer: new Native(properties), dispose: () => lifetime.abort() };
}
