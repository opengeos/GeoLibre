import {
  fetchCapabilitiesText,
  proxyFeedRequestUrl,
  readLimitedBody,
} from "../components/layout/add-data/helpers";
import { WMS_PROXY_PATH } from "../components/layout/add-data/constants";
import { isTauri } from "./is-tauri";
import {
  assertWcsTiff,
  parseWcsCapabilities,
  parseWcsDescription,
  wcsRequestUrl,
  waitForWcsRequest,
  WcsError,
} from "./wcs";

// Capabilities and coverage descriptions are XML listings, orders of magnitude
// smaller than a coverage. Cap them so a defective or hostile endpoint cannot
// fill memory with a metadata response before parsing even starts.
const MAX_METADATA_BYTES = 32 * 1024 * 1024;

async function fetchWcsXml(url: string, signal: AbortSignal): Promise<string> {
  const result = await fetchCapabilitiesText(url, WMS_PROXY_PATH, signal, MAX_METADATA_BYTES).catch(
    (error: unknown) => {
      if (String(error).includes("download limit")) throw new WcsError("metadata");
      throw error;
    },
  );
  if (!result.ok) throw new Error(`WCS HTTP ${result.status}`);
  return result.text;
}

export async function discoverWcs(endpoint: string, signal: AbortSignal) {
  return parseWcsCapabilities(
    await fetchWcsXml(wcsRequestUrl(endpoint, "GetCapabilities"), signal),
  );
}

export async function describeWcs(endpoint: string, coverage: string, signal: AbortSignal) {
  return parseWcsDescription(
    await fetchWcsXml(wcsRequestUrl(endpoint, "DescribeCoverage", { COVERAGE: coverage }), signal),
    coverage,
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
          throw error instanceof Error ? error : new Error(String(error));
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
  assertWcsTiff(bytes);
  return new File([bytes], `${name.replace(/[^\p{L}\p{N}._-]/gu, "_") || "coverage"}.tif`, {
    type: "image/tiff",
  });
}
