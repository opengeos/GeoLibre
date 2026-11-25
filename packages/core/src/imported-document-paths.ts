/** Rebase retained iOS data references before a layer reaches any reader. */
import type { GeoLibreLayer } from "./types";
import { hasPathTraversal, isAbsoluteFilesystemPath } from "./paths";

// Keep the shipped identifier/layout aligned with desktop file-io/paths.ts and
// tauri.ios.conf.json. The configuration regression pins this contract.
const COPY_PATH =
  /^\/.*\/Library\/Application Support\/org\.geolibre\.app\/picked-documents\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/data\/([^/]+)$/i;

function retainedDocumentSuffix(path: string): string | null {
  if (!isAbsoluteFilesystemPath(path) || hasPathTraversal(path)) return null;
  const match = COPY_PATH.exec(path);
  if (!match) return null;
  const [, selection, name] = match;
  if (
    name === "." ||
    name === ".." ||
    /[\\\x00-\x1f\x7f]/.test(name) ||
    name.length > 255 ||
    new TextEncoder().encode(name).length > 255
  )
    return null;
  return `${selection}/data/${name}`;
}

/** Keep the selection identity and file name, replacing only the container root. */
export function rebaseImportedDocumentPath(path: string, root: string): string {
  if (
    !root.startsWith("/") ||
    !isAbsoluteFilesystemPath(root) ||
    hasPathTraversal(root) ||
    !root.endsWith("/picked-documents")
  )
    return path;
  const suffix = retainedDocumentSuffix(path);
  return suffix === null ? path : `${root}/${suffix}`;
}

/** Only rewrite native local-media URLs, preserving tile coordinate templates. */
function mapMediaUrl(value: string, mapPath: (path: string) => string): string {
  const prefix = value.startsWith("pmtiles://") ? "pmtiles://" : "";
  const raw = prefix ? value.slice(prefix.length) : value;
  if (
    !/^(?:(?:geolibre-mbtiles|mbtiles|local-cog|local-pmtiles|asset):\/\/|http:\/\/(?:mbtiles|local-cog|local-pmtiles|asset)\.localhost\/)/i.test(
      raw,
    )
  )
    return value;
  try {
    const url = new URL(raw);
    const queryMedia =
      (["geolibre-mbtiles:", "mbtiles:", "local-cog:", "local-pmtiles:"].includes(url.protocol) &&
        ["localhost", "tile"].includes(url.host)) ||
      (url.protocol === "http:" &&
        ["mbtiles.localhost", "local-cog.localhost", "local-pmtiles.localhost"].includes(url.host));
    if (queryMedia) {
      const path = url.searchParams.get("path");
      if (!path) return value;
      const current = mapPath(path);
      if (current === path) return value;
      // Match the same decoded key as URLSearchParams.get, including encoded
      // key names. Preserve every other raw parameter and tile placeholder.
      const start = raw.indexOf("?") + 1;
      const hash = raw.indexOf("#", start);
      const end = hash === -1 ? raw.length : hash;
      const parameters = raw.slice(start, end).split("&");
      // An empty leading pair keeps a later '?' inside the parameter name.
      const index = parameters.findIndex((parameter) =>
        new URLSearchParams(`&${parameter}`).has("path"),
      );
      if (index === -1) return value;
      const key = parameters[index].split("=", 1)[0];
      parameters[index] = `${key}=${encodeURIComponent(current)}`;
      return prefix + raw.slice(0, start) + parameters.join("&") + raw.slice(end);
    }
    if (
      (url.protocol === "asset:" && url.host === "localhost") ||
      (url.protocol === "http:" && url.host === "asset.localhost")
    ) {
      const path = decodeURIComponent(
        /^\/%2f/i.test(url.pathname) ? url.pathname.slice(1) : url.pathname,
      );
      const current = mapPath(path);
      return current === path
        ? value
        : `${url.protocol}//${url.host}/${encodeURIComponent(current)}${url.search}${url.hash}`;
    }
  } catch {
    // Malformed/unsupported URLs remain for their normal validation path.
  }
  return value;
}

function mapImportedDocumentLayer(
  layer: GeoLibreLayer,
  mapPath: (path: string) => string,
): GeoLibreLayer {
  let result = layer;
  if (typeof layer.sourcePath === "string") {
    const path = mapPath(layer.sourcePath);
    if (path !== layer.sourcePath) result = { ...result, sourcePath: path };
  }
  for (const key of ["localFilePath", "localBytesUrl"]) {
    const value = layer.metadata[key];
    if (typeof value !== "string") continue;
    const next = key === "localFilePath" ? mapPath(value) : mapMediaUrl(value, mapPath);
    if (next !== value) result = { ...result, metadata: { ...result.metadata, [key]: next } };
  }
  if (typeof layer.source.url === "string") {
    const url = mapMediaUrl(layer.source.url, mapPath);
    if (url !== layer.source.url) result = { ...result, source: { ...result.source, url } };
  }
  if (Array.isArray(layer.source.tiles)) {
    const original = layer.source.tiles;
    const tiles = original.map((value) =>
      typeof value === "string" ? mapMediaUrl(value, mapPath) : value,
    );
    if (tiles.some((value, index) => value !== original[index])) {
      result = { ...result, source: { ...result.source, tiles } };
    }
  }
  return result;
}

/** The root is native runtime state, never a field supplied by a saved project. */
export function rebaseImportedDocumentLayer(
  layer: GeoLibreLayer,
  root: string | null,
): GeoLibreLayer {
  return root
    ? mapImportedDocumentLayer(layer, (path) => rebaseImportedDocumentPath(path, root))
    : layer;
}

/** Refuse publication before readers can discard copies whose root is unavailable. */
export function assertImportedDocumentCopiesAvailable(
  layers: readonly GeoLibreLayer[],
  failure: string | null,
): void {
  if (failure === null) return;
  for (const layer of layers) {
    if (hasImportedDocumentCopyReference(layer)) throw new Error(failure);
  }
}

/** Recognize retained references without changing the layer or following remote URLs. */
export function hasImportedDocumentCopyReference(layer: GeoLibreLayer): boolean {
  let retained = false;
  mapImportedDocumentLayer(layer, (path) => {
    retained ||= retainedDocumentSuffix(path) !== null;
    return path;
  });
  return retained;
}
