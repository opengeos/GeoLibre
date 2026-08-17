import type { FeatureCollection } from "geojson";
import { AsyncUnzipInflate, strFromU8, Unzip, UnzipPassThrough, type UnzipFile } from "fflate";

export interface DataUrlParameter {
  dataUrl: string;
  styleUrl: string | null;
}
const SERVICE_KINDS = new Set([
  "xyz",
  "wms",
  "wmts",
  "wfs",
  "ogc-features",
  "ogc-vector-tiles",
  "arcgis",
]);

export interface ServiceUrlParameter {
  kind: string;
  url: string;
  /** The requested layer: WMS `LAYERS`, WFS `typeName`, a tile source layer. */
  layer: string | null;
  /** A style document naming the source layers of a vector tileset. */
  styleUrl: string | null;
}

/** The service kinds addressed by a `{z}/{x}/{y}` tile template. */
const TILE_TEMPLATE_KINDS = new Set(["xyz", "wmts", "ogc-vector-tiles"]);

export function serviceUrlParameter(search: string): ServiceUrlParameter | null {
  const params = new URLSearchParams(search);
  const kind = params.get("add");
  const rawUrl = params.get("serviceUrl");
  // Only a tile template carries braces to restore. Rewriting them for every
  // kind would corrupt a WMS or ArcGIS URL whose query legitimately encodes a
  // brace, in a signed parameter or token, into one the server never sent.
  const parsed = httpUrl(rawUrl);
  const url =
    parsed && kind && TILE_TEMPLATE_KINDS.has(kind)
      ? parsed.replace(/%7B/gi, "{").replace(/%7D/gi, "}")
      : parsed;
  if (!kind || !SERVICE_KINDS.has(kind) || !url) return null;
  return {
    kind,
    url,
    layer: params.get("serviceLayer")?.trim() || null,
    styleUrl: httpUrl(params.get("serviceStyle")),
  };
}
export interface RemoteGeoJsonLayer {
  data: FeatureCollection;
  name: string;
  sourcePath: string;
}
export type RemoteData =
  | { kind: "cog"; name: string; url: string }
  | { kind: "pmtiles"; name: string; url: string }
  | { kind: "vector"; name: string; url: string; format: "geoparquet" }
  | { kind: "geojson"; layers: RemoteGeoJsonLayer[] };

const MAX_ZIP_GEOJSON_BYTES = 250 * 1024 * 1024;

// A `?data=` link points at an arbitrary third-party endpoint, so the response
// is buffered whole before anything about it is known. Refuse an advertised
// length past this ceiling rather than letting a mis-aimed link fill the tab's
// memory. A server that sends no Content-Length (chunked REST responses) is
// still bounded afterwards by the per-entry ZIP caps.
const MAX_DOWNLOAD_BYTES = 250 * 1024 * 1024;

/** Thrown when a ZIP's GeoJSON payload exceeds the import ceiling. */
export class ZipTooLargeError extends Error {
  constructor() {
    super("The ZIP's GeoJSON files are too large to import safely.");
    this.name = "ZipTooLargeError";
  }
}

function httpUrl(value: string | null): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Read remote-layer deep links without claiming the project loader's `url` parameter. */
export function dataUrlParameters(search: string): DataUrlParameter[] | null {
  const params = new URLSearchParams(search);
  const styles = params.getAll("style");
  const entries = params
    .getAll("data")
    .map((value, index) => {
      const dataUrl = httpUrl(value);
      return dataUrl ? { dataUrl, styleUrl: httpUrl(styles[index] ?? null) } : null;
    })
    .filter((entry): entry is DataUrlParameter => entry !== null);
  return entries.length ? entries : null;
}

export function remoteName(url: string): string {
  const basename = new URL(url).pathname.split("/").pop() || "data";
  // A literal `%` in the path (`.../100%.tif`) makes decoding throw, which would
  // surface as a raw "URI malformed" instead of this file's own errors.
  let name: string;
  try {
    name = decodeURIComponent(basename);
  } catch {
    name = basename;
  }
  return (
    name.replace(/\.(?:geojson|json|tiff?|cog|zip|pmtiles|geoparquet|parquet)$/i, "") || "data"
  );
}

function extension(url: string): string {
  return new URL(url).pathname.split(".").pop()?.toLowerCase() ?? "";
}

function parseFeatureCollection(text: string, source: string): FeatureCollection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} does not contain valid JSON.`, { cause: error });
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { type?: unknown }).type !== "FeatureCollection" ||
    !Array.isArray((parsed as { features?: unknown }).features)
  ) {
    throw new Error(`${source} is not a GeoJSON FeatureCollection.`);
  }
  return parsed as FeatureCollection;
}

async function fetchOk(url: string, signal: AbortSignal | undefined, fetchImpl: typeof fetch) {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      signal,
      headers: { Accept: "application/geo+json, application/json, application/zip, */*;q=0.8" },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error(`Could not fetch ${url}. The server may be unreachable or blocking CORS.`, {
      cause: error,
    });
  }
  if (!response.ok) throw new Error(`Could not fetch ${url}: HTTP ${response.status}.`);
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `${url} is too large to open from a URL (${Math.round(advertised / (1024 * 1024))} MB).`,
    );
  }
  return response;
}

/**
 * Buffer the response body, enforcing the ceiling as it streams so a server
 * that advertises no `Content-Length` (a chunked REST response, or one aimed at
 * exhausting the tab) is cut off at the limit rather than after the whole
 * payload has been read. Falls back to `arrayBuffer()` for a response with no
 * readable stream.
 */
async function readCappedBytes(response: Response, url: string): Promise<Uint8Array> {
  const tooLarge = () => new Error(`${url} is too large to open from a URL.`);
  const body = response.body;
  if (!body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_DOWNLOAD_BYTES) throw tooLarge();
    return bytes;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > MAX_DOWNLOAD_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return concatChunks(chunks, total);
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/**
 * Unzip the archive's GeoJSON members off the main thread, so a near-ceiling
 * archive does not freeze the UI while it inflates.
 *
 * The streaming API is used rather than `unzip()` so the ceiling is enforced on
 * the bytes as they are produced: an entry's declared `originalSize` is the
 * archive's own claim, and a hostile ZIP is free to understate it, so a check
 * made only once every entry is materialized would run after the memory it was
 * meant to prevent had already been allocated. The declared size is still
 * consulted first, as the cheap way to reject an honestly-large archive before
 * inflating anything.
 */
function unzipGeoJsonEntries(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    const entries: Record<string, Uint8Array> = {};
    const reading = new Set<UnzipFile>();
    let total = 0;
    let pending = 0;
    let pushed = false;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      // Stop the workers still inflating the other entries; without this they
      // keep producing the very bytes the ceiling just refused.
      for (const file of reading) file.terminate?.();
      reject(error);
    };
    const finishIfDone = () => {
      if (!settled && pushed && pending === 0) {
        settled = true;
        resolve(entries);
      }
    };

    const unzipper = new Unzip((file) => {
      if (file.name.endsWith("/") || !/\.(?:geojson|json)$/i.test(file.name)) return;
      const declared = file.originalSize ?? 0;
      if (declared > MAX_ZIP_GEOJSON_BYTES || total + declared > MAX_ZIP_GEOJSON_BYTES) {
        fail(new ZipTooLargeError());
        return;
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      pending += 1;
      reading.add(file);
      file.ondata = (error, chunk, final) => {
        if (settled) return;
        if (error) {
          fail(error);
          return;
        }
        total += chunk.length;
        if (total > MAX_ZIP_GEOJSON_BYTES) {
          fail(new ZipTooLargeError());
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
        if (final) {
          reading.delete(file);
          entries[file.name] = concatChunks(chunks, size);
          pending -= 1;
          finishIfDone();
        }
      };
      file.start();
    });
    unzipper.register(AsyncUnzipInflate);
    unzipper.register(UnzipPassThrough);
    unzipper.push(bytes, true);
    pushed = true;
    finishIfDone();
  });
}

/** Classify or fetch a supported data URL into startup-loadable layers. */
export async function fetchRemoteData(
  url: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<RemoteData> {
  const ext = extension(url);
  if (["tif", "tiff", "cog"].includes(ext)) return { kind: "cog", name: remoteName(url), url };
  if (ext === "pmtiles") return { kind: "pmtiles", name: remoteName(url), url };
  if (ext === "parquet" || ext === "geoparquet") {
    return { kind: "vector", name: remoteName(url), url, format: "geoparquet" };
  }
  const response = await fetchOk(url, options.signal, options.fetchImpl ?? fetch);
  const bytes = await readCappedBytes(response, url);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const disposition = response.headers.get("content-disposition")?.toLowerCase() ?? "";
  // REST export endpoints commonly have no filename suffix. Prefer their HTTP
  // metadata, then verify by the standard PKZIP signatures so a generic
  // `application/octet-stream` response still imports correctly.
  const zipSignature =
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06) ||
      (bytes[2] === 0x07 && bytes[3] === 0x08));
  const isZip =
    ext === "zip" ||
    contentType.includes("zip") ||
    /filename\*?=[^;]*\.zip(?:[;"']|$)/i.test(disposition) ||
    zipSignature;
  if (!isZip) {
    return {
      kind: "geojson",
      layers: [
        {
          data: parseFeatureCollection(strFromU8(bytes), url),
          name: remoteName(url),
          sourcePath: url,
        },
      ],
    };
  }

  let entries: Record<string, Uint8Array>;
  try {
    entries = await unzipGeoJsonEntries(bytes);
  } catch (error) {
    if (error instanceof ZipTooLargeError) throw error;
    throw new Error("The data URL is not a valid ZIP archive.", { cause: error });
  }
  const layers = Object.entries(entries).map(([name, contents]) => ({
    data: parseFeatureCollection(strFromU8(contents), name),
    name: name
      .split("/")
      .pop()!
      .replace(/\.(?:geojson|json)$/i, ""),
    sourcePath: `${url}#${name}`,
  }));
  if (!layers.length) throw new Error("The ZIP archive does not contain any GeoJSON files.");
  return { kind: "geojson", layers };
}

export async function fetchRemoteStyle(
  url: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<unknown> {
  const response = await fetchOk(url, options.signal, options.fetchImpl ?? fetch);
  // A `?style=` URL is as arbitrary as `?data=`, so it gets the same capped read
  // rather than buffering whatever the server chooses to stream.
  const text = strFromU8(await readCappedBytes(response, url));
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`The style at ${url} is not valid JSON.`, { cause: error });
  }
}

function styleSourceName(value: string): string {
  const basename = value.replaceAll("\\", "/").split("/").pop() ?? value;
  return basename
    .replace(/\.(?:geojson|json)$/i, "")
    .trim()
    .toLowerCase();
}

/**
 * Select the render layers intended for one file in a multi-GeoJSON archive.
 * A Mapbox layer whose `source` matches the GeoJSON filename stem is specific
 * to that file; layers without `source` are shared (labels/background rules,
 * or the backwards-compatible single-style form).
 */
export function mapboxStyleForDataLayer(style: unknown, layerName: string): unknown {
  if (!style || typeof style !== "object") return style;
  const document = style as { layers?: unknown };
  if (!Array.isArray(document.layers)) return style;
  const target = styleSourceName(layerName);
  const hasSourceSpecificLayers = document.layers.some((layer) =>
    Boolean(
      layer &&
      typeof layer === "object" &&
      typeof (layer as { source?: unknown }).source === "string",
    ),
  );
  if (!hasSourceSpecificLayers) return style;

  return {
    ...style,
    layers: document.layers.filter((layer) => {
      if (!layer || typeof layer !== "object") return true;
      const source = (layer as { source?: unknown }).source;
      return typeof source !== "string" || styleSourceName(source) === target;
    }),
  };
}

export interface RasterUrlStyle {
  mode?: "rgb" | "single" | "index";
  index?: string;
  bands?: number[];
  rescale?: [number, number][] | null;
  colormap?: string;
  reversed?: boolean;
  nodata?: number | "auto" | "off";
  opacity?: number;
  gamma?: number;
  stretch?: "linear" | "log" | "sqrt";
}

/** Validate a query-param raster style before passing it to maplibre-gl-raster. */
export function parseRasterUrlStyle(input: unknown): RasterUrlStyle {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("The remote raster style must be a JSON object.");
  }
  const candidate = input as Record<string, unknown>;
  const result: RasterUrlStyle = {};
  if (candidate.mode !== undefined) {
    if (candidate.mode !== "rgb" && candidate.mode !== "single" && candidate.mode !== "index")
      throw new Error("Raster style mode must be rgb, single, or index.");
    result.mode = candidate.mode;
  }
  if (candidate.index !== undefined) {
    if (typeof candidate.index !== "string" || !candidate.index.trim())
      throw new Error("Raster style index must be a non-empty string.");
    result.index = candidate.index;
  }
  if (candidate.bands !== undefined) {
    if (
      !Array.isArray(candidate.bands) ||
      !candidate.bands.length ||
      !candidate.bands.every(
        (band) => typeof band === "number" && Number.isInteger(band) && band > 0,
      )
    )
      throw new Error("Raster style bands must be positive integer band numbers.");
    result.bands = candidate.bands as number[];
  }
  if (candidate.rescale !== undefined) {
    if (candidate.rescale === null) result.rescale = null;
    else if (
      Array.isArray(candidate.rescale) &&
      candidate.rescale.length > 0 &&
      candidate.rescale.every(
        (range) =>
          Array.isArray(range) &&
          range.length === 2 &&
          range.every((value) => typeof value === "number" && Number.isFinite(value)),
      )
    )
      result.rescale = candidate.rescale as [number, number][];
    else throw new Error("Raster style rescale must be null or an array of [min, max] ranges.");
  }
  if (candidate.colormap !== undefined) {
    if (typeof candidate.colormap !== "string" || !candidate.colormap.trim())
      throw new Error("Raster style colormap must be a non-empty string.");
    result.colormap = candidate.colormap;
  }
  if (candidate.reversed !== undefined) {
    if (typeof candidate.reversed !== "boolean")
      throw new Error("Raster style reversed must be boolean.");
    result.reversed = candidate.reversed;
  }
  if (candidate.nodata !== undefined) {
    if (
      candidate.nodata !== "auto" &&
      candidate.nodata !== "off" &&
      !(typeof candidate.nodata === "number" && Number.isFinite(candidate.nodata))
    )
      throw new Error("Raster style nodata must be auto, off, or a finite number.");
    result.nodata = candidate.nodata as RasterUrlStyle["nodata"];
  }
  if (candidate.opacity !== undefined) {
    if (
      typeof candidate.opacity !== "number" ||
      !Number.isFinite(candidate.opacity) ||
      candidate.opacity < 0 ||
      candidate.opacity > 1
    )
      throw new Error("Raster style opacity must be between 0 and 1.");
    result.opacity = candidate.opacity;
  }
  if (candidate.gamma !== undefined) {
    if (
      typeof candidate.gamma !== "number" ||
      !Number.isFinite(candidate.gamma) ||
      candidate.gamma <= 0
    )
      throw new Error("Raster style gamma must be greater than zero.");
    result.gamma = candidate.gamma;
  }
  if (candidate.stretch !== undefined) {
    if (
      candidate.stretch !== "linear" &&
      candidate.stretch !== "log" &&
      candidate.stretch !== "sqrt"
    )
      throw new Error("Raster style stretch must be linear, log, or sqrt.");
    result.stretch = candidate.stretch;
  }
  if (Object.keys(result).length === 0) {
    throw new Error("The remote raster style does not contain any supported raster fields.");
  }
  return result;
}
