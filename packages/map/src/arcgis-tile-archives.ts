import type { ArcgisLayerPlan } from "./arcgis-layers";
import type { ArcgisLayer, ArcgisRasterLayer, ArcgisSdk } from "./arcgis-sdk";
import { getPMTilesArchive } from "./layer-sync";
import { requestProtocolTile } from "./cesium-protocol-imagery";

type ArchivePlan = Extract<ArcgisLayerPlan, { kind: "archive" }>;
export type ArchiveTileReader = (
  z: number,
  x: number,
  y: number,
  signal: AbortSignal,
) => Promise<ArrayBuffer | Uint8Array | null>;

/** Bridge an archive to native SDK vector/raster tiles without fetching synthetic URLs. */
export function createArcgisArchiveLayer(
  sdk: ArcgisSdk,
  plan: ArchivePlan,
  properties: Record<string, unknown>,
  readTile?: ArchiveTileReader,
): { layer: ArcgisLayer; dispose(): void } {
  const lifetime = new AbortController();
  const archive = plan.format === "pmtiles" && !readTile ? getPMTilesArchive(plan.url) : undefined;
  const read: ArchiveTileReader =
    readTile ??
    (archive
      ? async (z, x, y, signal) => (await archive.getZxy(z, x, y, signal))?.data ?? null
      : (z, x, y, signal) =>
          requestProtocolTile(
            plan.url
              .replaceAll("{z}", String(z))
              .replaceAll("{x}", String(x))
              .replaceAll("{y}", String(y)),
            signal,
          ));
  const tile = async (z: number, x: number, y: number, signal?: AbortSignal) => {
    const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    combined.throwIfAborted();
    const bytes = await read(z, x, y, combined);
    combined.throwIfAborted();
    return bytes;
  };
  if (plan.tileType === "vector") {
    // SDK request interceptors return response data directly. Each native layer
    // owns its prefix and interceptor, so split views/restyles cannot collide.
    const prefix = `${globalThis.location?.origin ?? "https://geolibre.invalid"}/__arcgis_archive/${crypto.randomUUID()}/`;
    const interceptor = {
      urls: prefix,
      before: async ({
        url,
        requestOptions,
      }: {
        url: string;
        requestOptions?: { signal?: AbortSignal };
      }) => {
        if (url.split("?")[0] === prefix + "source.json") {
          const header = archive ? await archive.getHeader() : undefined;
          lifetime.signal.throwIfAborted();
          return {
            tilejson: "2.2.0",
            tiles: [prefix + "{z}/{x}/{y}.pbf"],
            ...plan.tileOptions,
            ...(header
              ? {
                  minzoom: header.minZoom,
                  maxzoom: header.maxZoom,
                  bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
                }
              : {}),
          };
        }
        const match = /^([0-9]+)\/([0-9]+)\/([0-9]+)\.pbf(?:\?|$)/.exec(url.slice(prefix.length));
        if (!match) throw new Error("Invalid archive tile request");
        const bytes = await tile(
          Number(match[1]),
          Number(match[2]),
          Number(match[3]),
          requestOptions?.signal,
        );
        // null means "perform the HTTP request" to the SDK. An empty tile must
        // instead return an empty buffer, which is a valid empty protobuf.
        if (!bytes) return new ArrayBuffer(0);
        return bytes instanceof ArrayBuffer ? bytes : bytes.slice().buffer;
      },
    };
    sdk.config.request.interceptors.push(interceptor);
    const dispose = () => {
      lifetime.abort();
      const index = sdk.config.request.interceptors.indexOf(interceptor);
      if (index >= 0) sdk.config.request.interceptors.splice(index, 1);
    };
    try {
      const source = { type: "vector", url: prefix + "source.json" };
      const layer = new sdk.layers.VectorTileLayer({
        ...properties,
        style: { version: 8, sources: { [plan.sourceId]: source }, layers: plan.styleLayers },
      });
      return { layer, dispose };
    } catch (error) {
      dispose();
      throw error;
    }
  }
  let maxZoom: Promise<number> | undefined;
  const Raster = sdk.layers.BaseTileLayer.createSubclass({
    load(this: ArcgisRasterLayer) {
      if (plan.bounds)
        this.fullExtent = sdk.webMercatorUtils.geographicToWebMercator(
          new sdk.Extent({
            xmin: plan.bounds[0],
            ymin: plan.bounds[1],
            xmax: plan.bounds[2],
            ymax: plan.bounds[3],
            spatialReference: { wkid: 4326 },
          }),
        );
    },
    async fetchTile(z: number, y: number, x: number, options?: { signal?: AbortSignal }) {
      maxZoom ??= (
        archive
          ? archive.getHeader().then((header) => header.maxZoom)
          : Promise.resolve(
              typeof plan.tileOptions.maxzoom === "number" ? plan.tileOptions.maxzoom : 24,
            )
      ).catch((error: unknown) => {
        maxZoom = undefined;
        throw error;
      });
      const nativeZoom = Math.min(z, await maxZoom);
      const factor = 2 ** (z - nativeZoom);
      const bytes = await tile(
        nativeZoom,
        Math.floor(x / factor),
        Math.floor(y / factor),
        options?.signal,
      );
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 256;
      if (bytes?.byteLength) {
        const bitmap = await createImageBitmap(
          new Blob([bytes instanceof ArrayBuffer ? bytes : bytes.slice().buffer]),
        );
        try {
          lifetime.signal.throwIfAborted();
          options?.signal?.throwIfAborted();
          canvas
            .getContext("2d")!
            .drawImage(
              bitmap,
              ((x % factor) * bitmap.width) / factor,
              ((y % factor) * bitmap.height) / factor,
              bitmap.width / factor,
              bitmap.height / factor,
              0,
              0,
              256,
              256,
            );
        } finally {
          bitmap.close();
        }
      }
      return canvas;
    },
  });
  return { layer: new Raster(properties), dispose: () => lifetime.abort() };
}
