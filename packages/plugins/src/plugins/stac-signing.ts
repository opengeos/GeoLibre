import type { GeoLibreLayer } from "@geolibre/core";
import { isAzureBlobHref } from "./stac-api";

const PLANETARY_COMPUTER_HOST = "planetarycomputer.microsoft.com";

/** Metadata key used to retain the unsigned STAC asset identity across project saves. */
export const STAC_ASSET_ACCESS_METADATA_KEY = "stacAssetAccess";

export interface StacAssetAccess {
  catalogUrl: string;
  collectionId: string;
  href: string;
}

type SasSigner = { signUrl(url: string, collectionId: string): Promise<string> };
let sasManager: Promise<SasSigner> | null = null;

function planetaryComputerSigner(): Promise<SasSigner> {
  sasManager ??= import("maplibre-gl-planetary-computer")
    .then((module) => new module.SASTokenManager())
    .catch((error) => {
      // Do not let one failed import disable signing for the rest of the session.
      sasManager = null;
      throw error;
    });
  return sasManager;
}

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
 * Microsoft's token endpoint.
 */
export function createStacAssetAccess(
  catalogUrl: string,
  collectionId: string | undefined,
  href: string,
): StacAssetAccess | null {
  if (
    catalogHost(catalogUrl) !== PLANETARY_COMPUTER_HOST ||
    !collectionId ||
    !isAzureBlobHref(href)
  ) {
    return null;
  }
  return { catalogUrl, collectionId, href };
}

/** Reads and validates persisted STAC asset access metadata from a layer. */
export function stacAssetAccessFromLayer(layer: GeoLibreLayer): StacAssetAccess | null {
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
  return createStacAssetAccess(candidate.catalogUrl, candidate.collectionId, candidate.href);
}

/**
 * Returns a fresh signed URL for a protected asset, or its unsigned URL when
 * signing is unavailable. The upstream manager caches tokens until they near
 * expiry, so calling this again during project restore is inexpensive.
 */
export async function readableStacAssetHref(
  access: StacAssetAccess | null,
  fallbackHref: string,
): Promise<string> {
  if (!access) return fallbackHref;
  try {
    return await (await planetaryComputerSigner()).signUrl(access.href, access.collectionId);
  } catch {
    return access.href;
  }
}

/** Re-signs a saved STAC-backed layer from its retained unsigned asset URL. */
export function readableStacLayerHref(layer: GeoLibreLayer, fallbackHref: string): Promise<string> {
  return readableStacAssetHref(stacAssetAccessFromLayer(layer), fallbackHref);
}
