// Requests must survive the first lazy import without loading the catalog browser.
let requestedCatalogUrl = "";
let requestedCatalogToken: symbol | undefined;
let openActiveCatalog: ((url: string) => boolean) | undefined;

/** Connect a loaded browser, which accepts requests only while STAC owns the panel. */
export function provideStacCatalogRuntime(open: (url: string) => boolean): void {
  openActiveCatalog = open;
}

/** Drop an unconsumed request, optionally only if it belongs to the given caller. */
export function cancelStacCatalogRequest(token?: symbol): void {
  if (token !== undefined && token !== requestedCatalogToken) return;
  requestedCatalogUrl = "";
  requestedCatalogToken = undefined;
}

/** Open a catalog immediately when active, or queue its URL for the next STAC activation. */
export function requestStacCatalogUrl(url: string): void {
  beginStacCatalogRequest(url);
}

/** Open or queue a request and return a token that identifies its cancellation owner. */
export function beginStacCatalogRequest(url: string): symbol {
  const token = Symbol("STAC catalog request");
  if (!openActiveCatalog?.(url)) {
    requestedCatalogUrl = url;
    requestedCatalogToken = token;
  }
  return token;
}

/** Take a queued URL exactly once; sibling catalog browsers leave it untouched. */
export function consumeStacCatalogRequest(): string {
  const url = requestedCatalogUrl;
  cancelStacCatalogRequest();
  return url;
}
