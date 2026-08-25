/** Query marker added by the Python widget to local raster URLs in Colab. */
export const KERNEL_RANGE_PROXY_MARKER = "__geolibre_range_proxy";
/** Query parameter carrying a Range header through proxies that remove it. */
export const KERNEL_RANGE_QUERY = "__geolibre_range";
const KERNEL_CONTENT_RANGE_HEADER = "X-GeoLibre-Content-Range";

/**
 * Move a byte-range header into the URL for a marked kernel-local request.
 *
 * Colab's per-port proxy removes `Range` before forwarding a request to the
 * kernel. Its query string is preserved, so the Python local-file route can
 * reconstruct the same partial read and return the 206 geotiff.js requires.
 * Unmarked requests are returned untouched.
 */
export function rewriteKernelProxyRangeRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): [RequestInfo | URL, RequestInit | undefined] {
  const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return [input, init];
  }
  if (url.searchParams.get(KERNEL_RANGE_PROXY_MARKER) !== "1") {
    return [input, init];
  }

  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  const range = headers.get("Range");
  if (!range) return [input, init];

  url.searchParams.set(KERNEL_RANGE_QUERY, range);
  headers.delete("Range");

  if (input instanceof Request) {
    const request = new Request(url, input);
    return [request, { ...init, headers }];
  }
  return [url, { ...init, headers }];
}

/** Reconstruct the partial response after it has crossed the Colab proxy. */
export function restoreKernelProxyRangeResponse(response: Response): Response {
  if (response.status !== 200) return response;
  const contentRange = response.headers.get(KERNEL_CONTENT_RANGE_HEADER);
  if (!contentRange) return response;

  const headers = new Headers(response.headers);
  headers.set("Content-Range", contentRange);
  headers.delete(KERNEL_CONTENT_RANGE_HEADER);
  return new Response(response.body, {
    status: 206,
    statusText: "Partial Content",
    headers,
  });
}

let installed = false;

/** Install the narrowly scoped Colab Range-header compatibility wrapper. */
export function installKernelProxyRangeFetch(): void {
  if (installed || typeof globalThis.fetch !== "function") return;
  const browserFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const [rewrittenInput, rewrittenInit] = rewriteKernelProxyRangeRequest(input, init);
    const response = await browserFetch(rewrittenInput, rewrittenInit);
    return restoreKernelProxyRangeResponse(response);
  };
  installed = true;
}
