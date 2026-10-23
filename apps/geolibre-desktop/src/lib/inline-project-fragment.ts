import { parseProject, type GeoLibreProject } from "@geolibre/core";
import { gzipSync, gunzipSync, strFromU8, strToU8 } from "fflate";

export const INLINE_PROJECT_FRAGMENT_KEY = "geolibreProject";
export const INLINE_VIEWER_FRAGMENT_KEY = "geolibreViewerFragment";

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Encode a redacted project for a URL fragment that is never sent to a server. */
export function encodeInlineProjectFragment(project: GeoLibreProject): string {
  return bytesToBase64Url(gzipSync(strToU8(JSON.stringify(project)), { level: 9 }));
}

export function parseInlineProjectFragment(hash: string): GeoLibreProject | null {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const encoded = params.get(INLINE_PROJECT_FRAGMENT_KEY);
  if (!encoded) return null;
  return parseProject(strFromU8(gunzipSync(base64UrlToBytes(encoded))));
}

/** Consume an inline payload and restore any viewer hash route it displaced. */
export function consumeInlineProjectFragment(
  locationLike: Pick<Location, "hash" | "pathname" | "search"> = window.location,
  historyLike: Pick<History, "replaceState"> = window.history,
): GeoLibreProject | null {
  if (!new URLSearchParams(locationLike.hash.replace(/^#/, "")).has(INLINE_PROJECT_FRAGMENT_KEY)) {
    return null;
  }
  const hash = locationLike.hash;
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const viewerFragment = params.get(INLINE_VIEWER_FRAGMENT_KEY) ?? "";
  // Remove the potentially large payload before parsing; malformed input must
  // not remain in history or be copied from the address bar.
  historyLike.replaceState(
    null,
    "",
    `${locationLike.pathname}${locationLike.search}${viewerFragment}`,
  );
  return parseInlineProjectFragment(hash);
}
