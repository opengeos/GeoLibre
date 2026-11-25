import {
  fetchCapabilitiesText,
  proxyFeedRequestUrl,
  readLimitedBody,
} from "../components/layout/add-data/helpers";
import { WMS_PROXY_PATH } from "../components/layout/add-data/constants";
import { convertGeoTiffToCog, readGeoTiffInfo } from "@geolibre/processing";
import { isTauri } from "./is-tauri";
import {
  wcsTiffBytes,
  parseWcsCapabilities,
  parseWcsDescription,
  wcsRequestUrl,
  waitForWcsRequest,
  WcsError,
  type WcsCoverage,
} from "./wcs";

// Capabilities and coverage descriptions are XML listings, orders of magnitude
// smaller than a coverage. Cap them so a defective or hostile endpoint cannot
// fill memory with a metadata response before parsing even starts.
const MAX_METADATA_BYTES = 32 * 1024 * 1024;

/** Give native HTTP refusals the same status form as browser fetch failures. */
function normalizeWcsHttpError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  const status = /^Request failed with status\s*:?\s*(\d{3})\b/.exec(message)?.[1];
  return status ? new Error(`WCS HTTP ${status}`) : error;
}

async function fetchWcsXml(url: string, signal: AbortSignal): Promise<string> {
  const result = await fetchCapabilitiesText(url, WMS_PROXY_PATH, signal, MAX_METADATA_BYTES).catch(
    (error: unknown) => {
      if (String(error).includes("download limit")) throw new WcsError("metadata");
      // Native non-2xx requests reject with a string, whereas browser fetch
      // supplies a status. Keep the WCS retry policy identical on both hosts.
      throw normalizeWcsHttpError(error);
    },
  );
  if (!result.ok) throw new Error(`WCS HTTP ${result.status}`);
  return result.text;
}

export async function discoverWcs(endpoint: string, signal: AbortSignal) {
  try {
    return parseWcsCapabilities(
      await fetchWcsXml(
        wcsRequestUrl(endpoint, "GetCapabilities", {
          VERSION: "2.0.1",
          ACCEPTVERSIONS: "2.0.1,1.0.0",
        }),
        signal,
      ),
    );
  } catch (error) {
    signal.throwIfAborted();
    // Retry legacy discovery only for a protocol/operation refusal, not for
    // a network, authentication, size or cancellation failure. Some legacy
    // services use 500/501 for an unsupported version; retry those once too.
    const refused =
      error instanceof WcsError
        ? error.code === "version" || error.code === "response"
        : error instanceof Error && /^WCS HTTP (400|404|406|500|501)$/.test(error.message);
    if (!refused) throw error;
    return parseWcsCapabilities(
      await fetchWcsXml(wcsRequestUrl(endpoint, "GetCapabilities"), signal),
    );
  }
}

export async function describeWcs(
  endpoint: string,
  coverage: string,
  signal: AbortSignal,
  service?: WcsCoverage,
) {
  return parseWcsDescription(
    await fetchWcsXml(
      wcsRequestUrl(
        endpoint,
        "DescribeCoverage",
        service?.version === "2.0.1"
          ? { VERSION: "2.0.1", COVERAGEID: coverage }
          : { COVERAGE: coverage },
      ),
      signal,
    ),
    coverage,
    service,
  );
}

const MAX_BYTES = 128 * 1024 * 1024;

/** Fetch the complete subset once: WCS responses need not support byte ranges. */
export async function downloadWcs(url: string, name: string, signal: AbortSignal): Promise<File> {
  const abort = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  abort.throwIfAborted();
  let bytes: Uint8Array<ArrayBuffer>;
  if (isTauri()) {
    const { fetchUrlBytes } = await import("./native-http");
    bytes = new Uint8Array(
      await waitForWcsRequest(
        fetchUrlBytes(url, {
          context: "WCS GetCoverage",
          timeoutSecs: 120,
          maxBytes: MAX_BYTES,
        }).catch((error: unknown) => {
          if (String(error).includes("download limit")) throw new WcsError("size");
          const normalized = normalizeWcsHttpError(error);
          throw normalized instanceof Error ? normalized : new Error(String(normalized));
        }),
        abort,
      ),
    );
    abort.throwIfAborted();
    if (bytes.byteLength > MAX_BYTES) throw new WcsError("size");
  } else {
    const response = await fetch(proxyFeedRequestUrl(url), { signal: abort });
    if (!response.ok) throw new Error(`WCS HTTP ${response.status}`);
    bytes = await readLimitedBody(response, MAX_BYTES).catch((error: unknown) => {
      if (String(error).includes("download limit")) throw new WcsError("size");
      throw error;
    });
  }
  bytes = wcsTiffBytes(bytes);
  // MapServer and GDAL-backed services (e.g. PDOK) answer with a striped
  // GeoTIFF, which the raster panel cannot stream as tiles. The whole subset is
  // already in memory and bounded by MAX_BYTES, so re-encode it as a COG here
  // rather than failing the layer and falling back to the generic prompt.
  // A header the wasm reader cannot parse is left to the raster panel's own
  // decoder rather than guessed at.
  const info = await readGeoTiffInfo(bytes).catch(() => null);
  let raster: Uint8Array = bytes;
  if (info?.ok && !info.tiled) raster = await convertGeoTiffToCog(bytes);
  abort.throwIfAborted();
  return new File(
    [raster as BlobPart],
    `${name.replace(/[^\p{L}\p{N}._-]/gu, "_") || "coverage"}.tif`,
    {
      type: "image/tiff",
    },
  );
}
