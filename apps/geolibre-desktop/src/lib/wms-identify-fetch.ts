import type { WmsIdentifyFetcher } from "@geolibre/map";
import { tileErrorStatus } from "./tile-retry";

/** GetFeatureInfo answers are a few KB; cap the body so a runaway one can't stall IPC. */
const WMS_IDENTIFY_MAX_BYTES = 5 * 1024 * 1024;

type FetchBytes = (url: string) => Promise<number[] | Uint8Array>;

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Builds a GetFeatureInfo fetcher over a native byte fetcher. The native call
 * cannot be cancelled, so an abort rejects at once and the late body is
 * dropped. A non-2xx status comes back as a `Response` with that status rather
 * than a thrown error, so identify keeps probing the remaining info formats and
 * reports the status as it does for the webview `fetch`. The native command
 * returns no headers, so identify falls back to the requested INFO_FORMAT and
 * the body itself to tell JSON, HTML and plain text apart.
 *
 * @param fetchBytes Fetches a URL's body bytes, rejecting on a non-2xx status.
 * @returns A fetcher for `setWmsIdentifyFetcher`.
 */
export function createNativeWmsIdentifyFetcher(fetchBytes: FetchBytes): WmsIdentifyFetcher {
  return (url, signal) => {
    // Reject with the signal's own reason, as the native ArcGIS fetch does.
    if (signal.aborted) return Promise.reject(signal.reason ?? abortError());
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? abortError());
      signal.addEventListener("abort", onAbort, { once: true });
      fetchBytes(url)
        .then(
          (bytes) => resolve(new Response(Uint8Array.from(bytes))),
          (error: unknown) => {
            const status = tileErrorStatus(error);
            if (status !== null) resolve(new Response(null, { status }));
            else reject(error instanceof Error ? error : new Error(String(error)));
          },
        )
        .finally(() => signal.removeEventListener("abort", onAbort));
    });
  };
}

/**
 * Sends WMS GetFeatureInfo requests through the native `fetch_url_bytes`
 * command, the same client WMS tiles use. Desktop webviews enforce CORS
 * (WebView2 serves the app from `http://tauri.localhost`), so a server without
 * `Access-Control-Allow-Origin`, or an https-to-http redirect without it,
 * failed identify with "Failed to fetch" while its tiles drew fine (#2712).
 *
 * Loaded lazily and only in the desktop build.
 */
export async function installNativeWmsIdentifyFetch(): Promise<void> {
  const [{ setWmsIdentifyFetcher }, { fetchUrlBytes }] = await Promise.all([
    import("@geolibre/map"),
    import("./native-http"),
  ]);
  setWmsIdentifyFetcher(
    createNativeWmsIdentifyFetcher((url) =>
      fetchUrlBytes(url, { context: "WMS GetFeatureInfo", maxBytes: WMS_IDENTIFY_MAX_BYTES }),
    ),
  );
}
