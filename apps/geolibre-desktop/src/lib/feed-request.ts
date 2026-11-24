import { GPX_PROXY_PATH } from "../components/layout/add-data/constants";

/** Route GPX and GeoRSS requests through the same-origin Vite CORS proxy. */
export function proxyFeedRequestUrl(url: string): string {
  const dev = Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);
  return dev ? GPX_PROXY_PATH + "?url=" + encodeURIComponent(url) : url;
}
