import type { AsyncReadable } from "zarrita";
import { assertSecureRequestHeaders } from "./kerchunk-reference-store";

// Store objects stay out of project JSON. Local folders and kerchunk manifests
// register the same reader used by their importer before adding their record.
const stores = new Map<string, AsyncReadable>();
export function registerZarrStore(id: string, store: AsyncReadable): () => void {
  stores.set(id, store);
  return () => {
    if (stores.get(id) === store) stores.delete(id);
  };
}
export function getZarrStore(id: string): AsyncReadable | undefined {
  return stores.get(id);
}

// Request headers for authenticated stores (a bearer token, an API key) are
// credentials, so they live here for the session instead of on the layer
// record: anything on `layer.source` reaches saved, autosaved, and shared
// project JSON (opengeos/GeoLibre#2643). Kept for the whole session rather than
// dropped with the layer, so undoing a removal brings back a layer that still
// authenticates.
const sessionHeaders = new Map<string, Record<string, string>>();

/**
 * Remember an authenticated Zarr layer's request headers for this session only.
 *
 * @param id - The layer id the headers belong to.
 * @param headers - The headers, or undefined/empty to forget any stored ones.
 */
export function registerZarrHeaders(id: string, headers: Record<string, string> | undefined): void {
  if (headers && Object.keys(headers).length > 0) sessionHeaders.set(id, { ...headers });
  else sessionHeaders.delete(id);
}

/**
 * The request headers a Zarr layer's reads should send.
 *
 * Prefers the session-only entry from {@link registerZarrHeaders}, and falls
 * back to `source.headers` for a project saved before headers moved out of the
 * layer record, so such a project still opens.
 *
 * @param layer - The Zarr layer.
 * @returns The headers, or undefined when the store is public.
 */
export function zarrRequestHeaders(
  layer: Pick<import("@geolibre/core").GeoLibreLayer, "id" | "source">,
): Record<string, string> | undefined {
  return (
    sessionHeaders.get(layer.id) ?? (layer.source.headers as Record<string, string> | undefined)
  );
}

/** Coordinate values for the renderer-neutral Time Slider registration. */
export async function readNativeZarrDimensions(
  layer: import("@geolibre/core").GeoLibreLayer,
): Promise<Record<string, number[]> | null> {
  const zarr = await import("zarrita");
  const source = layer.source;
  const headers = zarrRequestHeaders(layer);
  const referenceStore = source.kerchunkRefs
    ? new (await import("./kerchunk-reference-store")).KerchunkReferenceStore(
        source.kerchunkRefs as import("./kerchunk-reference-store").KerchunkRefs,
        {
          headers,
          sourceUrl: String(source.url),
        },
      )
    : undefined;
  if (!referenceStore && !getZarrStore(layer.id))
    assertSecureRequestHeaders(String(source.url), headers);
  const store =
    getZarrStore(layer.id) ??
    referenceStore ??
    new zarr.FetchStore(String(source.url), {
      overrides: {
        headers,
        ...(headers && Object.keys(headers).length ? { redirect: "error" } : {}),
      },
    });
  const root = zarr.root(store),
    variable = String(source.variable);
  const array = await zarr.open(root.resolve(variable), { kind: "array" });
  const parent = variable.includes("/") ? variable.slice(0, variable.lastIndexOf("/") + 1) : "";
  const result: Record<string, number[]> = {};
  const spatial = source.spatialDimensions as { lat?: string; lon?: string } | undefined;
  for (const name of array.dimensionNames ?? []) {
    if (
      (spatial?.lat ? name === spatial.lat : /^(lat|latitude|y)$/i.test(name)) ||
      (spatial?.lon ? name === spatial.lon : /^(lon|longitude|x)$/i.test(name))
    )
      continue;
    try {
      const coordinate = await zarr.open(root.resolve(parent + name), { kind: "array" });
      // CF time axes are often int64 ("days since ..."), which zarrita reads as
      // BigInt; skipping them left such a cube with no Time Slider binding.
      if (
        !(coordinate.is("number") || coordinate.is("bigint")) ||
        coordinate.shape.length !== 1 ||
        coordinate.shape[0] > 1_000_000
      )
        continue;
      const values = await zarr.get(coordinate, [null]);
      const raw = Array.from(values.data as ArrayLike<number | bigint>);
      // Number() rounds a BigInt past 2^53 silently, so an int64 axis in
      // nanoseconds (datetime64[ns], ~1.7e18) would collapse adjacent
      // timestamps. Leave such an axis out rather than bind a wrong one.
      if (
        raw.some(
          (value) =>
            typeof value === "bigint" &&
            (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)),
        )
      )
        continue;
      result[name] = raw.map(Number);
    } catch (error) {
      if (!(error instanceof zarr.NotFoundError)) throw error;
    }
  }
  return Object.keys(result).length ? result : null;
}
