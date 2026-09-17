import type { AsyncReadable } from "zarrita";

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

/** Coordinate values for the renderer-neutral Time Slider registration. */
export async function readNativeZarrDimensions(
  layer: import("@geolibre/core").GeoLibreLayer,
): Promise<Record<string, number[]> | null> {
  const zarr = await import("zarrita");
  const source = layer.source;
  const referenceStore = source.kerchunkRefs
    ? new (await import("./kerchunk-reference-store")).KerchunkReferenceStore(
        source.kerchunkRefs as import("./kerchunk-reference-store").KerchunkRefs,
        { headers: source.headers as Record<string, string> | undefined },
      )
    : undefined;
  const store =
    getZarrStore(layer.id) ??
    referenceStore ??
    new zarr.FetchStore(String(source.url), {
      overrides: { headers: source.headers as Record<string, string> | undefined },
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
      if (
        !coordinate.is("number") ||
        coordinate.shape.length !== 1 ||
        coordinate.shape[0] > 1_000_000
      )
        continue;
      const values = await zarr.get(coordinate, [null]);
      result[name] = Array.from(values.data);
    } catch (error) {
      if (!(error instanceof zarr.NotFoundError)) throw error;
    }
  }
  return Object.keys(result).length ? result : null;
}
