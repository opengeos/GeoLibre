import type { GeoLibreLayer } from "@geolibre/core";
import { isAzureBlobHref } from "./stac-api";

const PLANETARY_COMPUTER_HOST = "planetarycomputer.microsoft.com";
const PLANETARY_COMPUTER_SIGN_URL = "https://planetarycomputer.microsoft.com/api/sas/v1/sign";
const SIGNING_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/** Metadata key used to retain the unsigned STAC asset identity across project saves. */
export const STAC_ASSET_ACCESS_METADATA_KEY = "stacAssetAccess";

export interface StacAssetAccess {
  catalogUrl: string;
  collectionId: string;
  href: string;
}

const signedHrefCache = new Map<string, { href: string; expiresAt: number }>();

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

async function planetaryComputerSignedHref(href: string): Promise<string> {
  const cached = signedHrefCache.get(href);
  if (cached && cached.expiresAt - Date.now() > SIGNING_EXPIRY_BUFFER_MS) return cached.href;

  const endpoint = new URL(PLANETARY_COMPUTER_SIGN_URL);
  endpoint.searchParams.set("href", href);
  const response = await fetch(endpoint);
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
  signedHrefCache.set(href, { href: data.href, expiresAt });
  return data.href;
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
 * Returns a fresh signed URL for a protected asset, or its unsigned URL when
 * signing is unavailable. Signed URLs are cached until they near expiry, so
 * calling this again during project restore is inexpensive.
 */
export async function readableStacAssetHref(
  access: StacAssetAccess | null,
  fallbackHref: string,
): Promise<string> {
  if (!access) return fallbackHref;
  try {
    return await planetaryComputerSignedHref(access.href);
  } catch {
    return access.href;
  }
}

/** Re-signs a saved STAC-backed layer from its retained unsigned asset URL. */
export function readableStacLayerHref(layer: GeoLibreLayer, fallbackHref: string): Promise<string> {
  return readableStacAssetHref(stacAssetAccessFromLayer(layer, fallbackHref), fallbackHref);
}
