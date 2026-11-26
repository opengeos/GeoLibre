import { GPX_PROXY_PATH } from "../components/layout/add-data/constants";

/** Route requests through a same-origin Vite proxy, defaulting to the feed route. */
export function proxyFeedRequestUrl(url: string, proxyPath = GPX_PROXY_PATH): string {
  const dev = Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);
  return dev ? proxyPath + "?url=" + encodeURIComponent(url) : url;
}
