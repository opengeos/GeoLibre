import type { GeoLibreLayer } from "@geolibre/core";
import { isAzureBlobHref } from "./stac-api";

const PLANETARY_COMPUTER_HOST = "planetarycomputer.microsoft.com";
const PLANETARY_COMPUTER_SIGN_URL = "https://planetarycomputer.microsoft.com/api/sas/v1/sign";
const SIGNING_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
/** How long one signing request may hang before it is given up on. */
const SIGNING_REQUEST_TIMEOUT_MS = 20 * 1000;

/** Metadata key used to retain the unsigned STAC asset identity across project saves. */
export const STAC_ASSET_ACCESS_METADATA_KEY = "stacAssetAccess";

export interface StacAssetAccess {
  catalogUrl: string;
  collectionId: string;
  href: string;
}

const signedHrefCache = new Map<string, { href: string; expiresAt: number }>();
const pendingSignedHrefs = new Map<string, Promise<string>>();
/** How many signed URLs are kept before the oldest ones are dropped. */
const SIGNED_HREF_CACHE_LIMIT = 200;

function catalogHost(catalogUrl: string): string | null {
  try {
    return new URL(catalogUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Builds the information needed to sign a Planetary Computer asset.
 *
 * Restricting the catalog host prevents a third-party STAC catalog that also
 * uses Azure storage from sending its collection and asset details to
 * Microsoft's signing endpoint. That endpoint validates the storage account
 * and container before returning a signed URL, so raw collection tokens never
 * enter the browser.
 */
export function createStacAssetAccess(
  catalogUrl: string,
  collectionId: string | undefined,
  href: string,
): StacAssetAccess | null {
  let assetUrl: URL;
  try {
    assetUrl = new URL(href);
  } catch {
    return null;
  }
  if (
    catalogHost(catalogUrl) !== PLANETARY_COMPUTER_HOST ||
    !collectionId ||
    assetUrl.protocol !== "https:" ||
    !isAzureBlobHref(href)
  ) {
    return null;
  }
  return { catalogUrl, collectionId, href };
}

/**
 * Signs one asset, sharing a request with any sign of the same asset that is
 * already in flight. Restoring a project signs every STAC-backed layer at
 * once, so layers that point at the same asset cost one round trip, not one
 * each -- the settled cache below only dedupes once a request has returned.
 */
function planetaryComputerSignedHref(href: string): Promise<string> {
  const cached = signedHrefCache.get(href);
  if (cached && cached.expiresAt - Date.now() > SIGNING_EXPIRY_BUFFER_MS) {
    return Promise.resolve(cached.href);
  }
  const inFlight = pendingSignedHrefs.get(href);
  if (inFlight) return inFlight;

  const request = requestSignedHref(href).finally(() => {
    pendingSignedHrefs.delete(href);
  });
  pendingSignedHrefs.set(href, request);
  return request;
}

/**
 * Drops entries that can no longer be served before the cache is allowed to
 * grow, so a long session that walks a whole catalog does not retain every
 * signed URL it ever minted.
 */
function rememberSignedHref(href: string, signed: string, expiresAt: number): void {
  if (signedHrefCache.size >= SIGNED_HREF_CACHE_LIMIT) {
    const now = Date.now();
    for (const [key, entry] of signedHrefCache) {
      if (entry.expiresAt - now <= SIGNING_EXPIRY_BUFFER_MS) signedHrefCache.delete(key);
    }
    // Still full: Map iterates in insertion order, so this drops the oldest.
    for (const key of signedHrefCache.keys()) {
      if (signedHrefCache.size < SIGNED_HREF_CACHE_LIMIT) break;
      signedHrefCache.delete(key);
    }
  }
  signedHrefCache.set(href, { href: signed, expiresAt });
}

async function requestSignedHref(href: string): Promise<string> {
  const endpoint = new URL(PLANETARY_COMPUTER_SIGN_URL);
  endpoint.searchParams.set("href", href);
  // Everyone waiting on this asset shares this request, and the entry that
  // makes that possible is only cleared once it settles, so it has to. A
  // signer that hangs would otherwise leave the asset unsignable for the rest
  // of the session. This timeout is the request's own: a caller cancelling its
  // wait never abandons the request for the others.
  const expiry = new AbortController();
  const timer = setTimeout(() => expiry.abort(), SIGNING_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, { signal: expiry.signal });
    if (!response.ok) throw new Error(`Planetary Computer signing failed: ${response.status}`);
    const data = (await response.json()) as Record<string, unknown>;
    if (typeof data.href !== "string" || typeof data["msft:expiry"] !== "string") {
      throw new Error("Planetary Computer returned an invalid signed URL");
    }
    const expiresAt = Date.parse(data["msft:expiry"]);
    const signedUrl = new URL(data.href);
    if (
      !Number.isFinite(expiresAt) ||
      signedUrl.protocol !== "https:" ||
      !sameAssetHref(data.href, href)
    ) {
      throw new Error("Planetary Computer returned a signed URL for a different asset");
    }
    rememberSignedHref(href, data.href, expiresAt);
    return data.href;
  } finally {
    clearTimeout(timer);
  }
}

/** Reads and validates persisted STAC asset access metadata from a layer. */
export function stacAssetAccessFromLayer(
  layer: GeoLibreLayer,
  currentHref?: string,
): StacAssetAccess | null {
  const value = layer.metadata[STAC_ASSET_ACCESS_METADATA_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<StacAssetAccess>;
  if (
    typeof candidate.catalogUrl !== "string" ||
    typeof candidate.collectionId !== "string" ||
    typeof candidate.href !== "string"
  ) {
    return null;
  }
  const access = createStacAssetAccess(
    candidate.catalogUrl,
    candidate.collectionId,
    candidate.href,
  );
  if (!access || (currentHref && !sameAssetHref(currentHref, access.href))) return null;
  return access;
}

function sameAssetHref(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return (
      leftUrl.protocol === rightUrl.protocol &&
      leftUrl.host.toLowerCase() === rightUrl.host.toLowerCase() &&
      leftUrl.pathname === rightUrl.pathname
    );
  } catch {
    return false;
  }
}

/**
 * Stops waiting for a signing request as soon as the caller's own signal
 * aborts.
 *
 * The request itself is left running: it is shared with every other caller
 * waiting on the same asset, and it fills the cache for the next one. Only
 * this caller walks away.
 */
function untilAborted(request: Promise<string>, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const abort = (): void =>
      reject(signal.reason ?? new DOMException("Signing was cancelled", "AbortError"));
    if (signal.aborted) {
      // The request still settles for the callers that are waiting on it.
      void request.catch(() => {});
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    request.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * Returns a fresh signed URL for a protected asset, or its unsigned URL when
 * signing is unavailable. Signed URLs are cached until they near expiry, so
 * calling this again during project restore is inexpensive.
 *
 * An aborted `signal` rejects rather than falling back: a cancelled add must
 * not carry on with a URL that cannot be read.
 */
export async function readableStacAssetHref(
  access: StacAssetAccess | null,
  fallbackHref: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!access) return fallbackHref;
  const request = planetaryComputerSignedHref(access.href);
  try {
    return await (signal ? untilAborted(request, signal) : request);
  } catch (error) {
    if (signal?.aborted) throw error;
    return access.href;
  }
}

/** Re-signs a saved STAC-backed layer from its retained unsigned asset URL. */
export function readableStacLayerHref(
  layer: GeoLibreLayer,
  fallbackHref: string,
  signal?: AbortSignal,
): Promise<string> {
  return readableStacAssetHref(stacAssetAccessFromLayer(layer, fallbackHref), fallbackHref, signal);
}
