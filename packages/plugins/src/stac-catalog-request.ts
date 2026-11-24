// Requests must survive the first lazy import without loading the catalog browser.
let requestedCatalogUrl = "";
let openActiveCatalog: ((url: string) => boolean) | undefined;

/** Connect a loaded browser, which accepts requests only while STAC owns the panel. */
export function provideStacCatalogRuntime(open: (url: string) => boolean): void {
  openActiveCatalog = open;
}

/** Drop a one-time request that activation did not consume. */
export function cancelStacCatalogRequest(): void {
  requestedCatalogUrl = "";
}

/** Open a catalog immediately when active, or queue its URL for the next STAC activation. */
export function requestStacCatalogUrl(url: string): void {
  if (!openActiveCatalog?.(url)) requestedCatalogUrl = url;
}

/** Take a queued URL exactly once; sibling catalog browsers leave it untouched. */
export function consumeStacCatalogRequest(): string {
  const url = requestedCatalogUrl;
  requestedCatalogUrl = "";
  return url;
}
