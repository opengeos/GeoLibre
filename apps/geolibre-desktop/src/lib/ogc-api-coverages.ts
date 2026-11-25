import { shortestLongitudeExtent } from "@geolibre/core";
import { convertGeoTiffToCog, readGeoTiffInfo } from "@geolibre/processing";
import { readLimitedBody } from "../components/layout/add-data/helpers";
import { OGC_COVERAGE_PROXY_PATH } from "../components/layout/add-data/constants";
import { proxyFeedRequestUrl } from "./feed-request";
import { isTauri } from "./is-tauri";
import { parseOgcFeaturesUrl } from "./ogc-api-features";
import { normalizeFetchError } from "./ogc-json";
import { waitForWcsRequest, assertWcsTiff } from "./wcs";
import {
  CoverageError,
  coverageObject,
  coverageGridTiff,
  parseCoverageJson,
  MAX_COVERAGE_SAMPLES,
} from "./coverage-json";

const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const COVERAGE_REL = "http://www.opengis.net/def/rel/ogc/1.0/coverage";
const OWN_PARAMS = new Set([
  "f",
  "bbox",
  "bbox-crs",
  "datetime",
  "subset",
  "subset-crs",
  "crs",
  "properties",
  "scale-size",
  "scale-factor",
  "scale-axes",
]);
interface Link {
  href: string;
  rel: string;
  type: string;
}
export interface OgcCoverageCollection {
  id: string;
  title: string;
  url: string;
  links: Link[];
  bounds?: [number, number, number, number];
}

/** HTTP links only; query credentials are inherited only on the same origin. */
function linkUrl(href: string, base: string): string {
  const target = new URL(href, base),
    source = new URL(base);
  if (!/^https?:$/.test(target.protocol) || target.username || target.password)
    throw new CoverageError("response");
  if (source.origin === target.origin)
    for (const [key, value] of source.searchParams) {
      if (!OWN_PARAMS.has(key.toLowerCase()) && !target.searchParams.has(key))
        target.searchParams.append(key, value);
    }
  return target.href;
}

/** Ignore unusable advertised links without discarding other collections. */
function validLinkUrl(href: string, base: string): string | undefined {
  try {
    return linkUrl(href, base);
  } catch {
    return undefined;
  }
}

function links(document: Record<string, unknown>): Link[] {
  if (!Array.isArray(document.links)) return [];
  return document.links.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const l = coverageObject(raw);
    return typeof l.href === "string" && typeof l.rel === "string"
      ? [
          {
            href: l.href,
            rel: l.rel,
            type: typeof l.type === "string" ? l.type : "",
          },
        ]
      : [];
  });
}
const isTiff = (type: string) => /^image\/(?:tiff|geotiff)(?:;|$)/i.test(type.trim());
const isCoverageJson = (type: string) =>
  /^application\/(?:(?:prs\.coverage|vnd\.cov|cov)\+json|json)(?:;|$)/i.test(type.trim());
function coverageLink(items: Link[]): Link | undefined {
  return (
    items.find((l) => l.rel === COVERAGE_REL && isTiff(l.type)) ??
    items.find((l) => l.rel === COVERAGE_REL && isCoverageJson(l.type))
  );
}

/** Field selection applies to the preferred CoverageJSON representation only. */
export function ogcCoverageSupportsFieldSelection(
  collection: OgcCoverageCollection | undefined,
): boolean {
  const link = collection && coverageLink(collection.links);
  return Boolean(link && isCoverageJson(link.type));
}

async function bytes(
  url: string,
  signal: AbortSignal,
  maxBytes: number,
  accept: string,
  limitCode: "metadata" | "size" = "size",
): Promise<{ data: Uint8Array<ArrayBuffer>; url: string }> {
  signal.throwIfAborted();
  try {
    if (isTauri()) {
      const { fetchUrlResponse } = await import("./native-http");
      const value = await waitForWcsRequest(
        fetchUrlResponse(url, {
          timeoutSecs: 120,
          maxBytes,
          accept,
          discardErrorBody: true,
          context: "OGC API Coverages",
        }),
        signal,
      );
      signal.throwIfAborted();
      if (value.status < 200 || value.status >= 300)
        throw new Error(`OGC API HTTP ${value.status}`);
      const result =
        value.body.buffer instanceof ArrayBuffer
          ? new Uint8Array(value.body.buffer, value.body.byteOffset, value.body.byteLength)
          : new Uint8Array(value.body);
      if (result.byteLength > maxBytes) throw new CoverageError(limitCode);
      return { data: result, url: value.url };
    }
    const fetchUrl = proxyFeedRequestUrl(url, OGC_COVERAGE_PROXY_PATH);
    const response = await fetch(fetchUrl, {
      signal,
      headers: { Accept: accept },
    });
    // The protocol does not consume error bodies; cancel them and preserve
    // the status even when a server sends an oversized error page.
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`OGC API HTTP ${response.status}`);
    }
    const result = await readLimitedBody(response, maxBytes);
    signal.throwIfAborted();
    return {
      data: result,
      url:
        fetchUrl !== url
          ? response.headers.get("x-geolibre-final-url") || url
          : response.url || url,
    };
  } catch (error) {
    if (String(error).includes("download limit")) throw new CoverageError(limitCode);
    throw normalizeFetchError(error);
  }
}
async function json(
  url: string,
  signal: AbortSignal,
): Promise<{ document: Record<string, unknown>; url: string }> {
  const body = await bytes(url, signal, MAX_METADATA_BYTES, "application/json", "metadata");
  try {
    return {
      document: coverageObject(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.data)),
      ),
      url: body.url,
    };
  } catch {
    throw new CoverageError("response");
  }
}

/** Discover coverage collections from landing pages, catalogs or collection URLs. */
export async function discoverOgcCoverages(
  input: string,
  signal: AbortSignal,
): Promise<OgcCoverageCollection[]> {
  const abort = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  const parsed = parseOgcFeaturesUrl(input);
  const extra = new URLSearchParams(parsed.extraQuery);
  for (const key of [...extra.keys()]) if (OWN_PARAMS.has(key.toLowerCase())) extra.delete(key);
  extra.set("f", "json");
  let url = `${parsed.baseUrl}${
    parsed.collectionId
      ? `/collections/${encodeURIComponent(parsed.collectionId)}`
      : /\/collections\/?$/.test(new URL(input).pathname)
        ? "/collections"
        : new URL(input).pathname.endsWith("/")
          ? "/"
          : ""
  }?${extra}`;
  const seen = new Set<string>(),
    ids = new Set<string>(),
    result: OgcCoverageCollection[] = [];
  for (let page = 0; page < 50; page++) {
    if (seen.has(url)) throw new CoverageError("response");
    seen.add(url);
    const loaded = await json(url, abort);
    url = loaded.url;
    const doc = loaded.document;
    const docLinks = links(doc);
    if (!Array.isArray(doc.collections) && !coverageLink(docLinks)) {
      const data =
        docLinks.find((l) => l.rel === "data" && /json/.test(l.type)) ??
        docLinks.find((l) => l.rel === "data");
      if (!data) throw new CoverageError("empty");
      url = linkUrl(data.href, url);
      continue;
    }
    const collections = Array.isArray(doc.collections) ? doc.collections : [doc];
    for (const raw of collections) {
      const item = coverageObject(raw);
      if (typeof item.id !== "string" || !item.id || ids.has(item.id)) continue;
      const itemLinks = links(item);
      if (!coverageLink(itemLinks)) continue;
      const self = itemLinks.find((l) => l.rel === "self" && /json/.test(l.type));
      const itemUrl = self ? (validLinkUrl(self.href, url) ?? url) : url;
      const coverageLinks = itemLinks.flatMap((link) => {
        if (link.rel !== COVERAGE_REL || (!isTiff(link.type) && !isCoverageJson(link.type)))
          return [];
        const href = validLinkUrl(link.href, url);
        return href ? [{ ...link, href }] : [];
      });
      if (!coverageLinks.length) continue;
      const extent: Record<string, unknown> | undefined = item.extent
        ? coverageObject(item.extent)
        : undefined;
      const spatial: Record<string, unknown> | undefined = extent?.spatial
        ? coverageObject(extent.spatial)
        : undefined;
      const bbox = Array.isArray(spatial?.bbox) ? spatial.bbox[0] : null;
      // Collection bboxes default to CRS84. Other advertised CRSes need a
      // transform; do not put latitude-first/projected values in the form.
      const bounds =
        Array.isArray(bbox) &&
        bbox.length === 4 &&
        bbox.every((v) => typeof v === "number" && Number.isFinite(v)) &&
        (!spatial?.crs || /CRS84$/.test(String(spatial.crs)))
          ? (bbox as [number, number, number, number])
          : undefined;
      result.push({
        id: item.id,
        title: typeof item.title === "string" ? item.title : item.id,
        url: itemUrl,
        links: coverageLinks,
        ...(bounds ? { bounds } : {}),
      });
      ids.add(item.id);
      if (result.length > 5000) throw new CoverageError("metadata");
    }
    const next = docLinks.find((l) => l.rel === "next" && (!l.type || /json/.test(l.type)));
    if (!next) {
      if (!result.length) throw new CoverageError("empty");
      return result;
    }
    url = linkUrl(next.href, url);
  }
  throw new CoverageError("metadata");
}

/** Normalize a wrapped map view to one CRS84 box; crossing views need splitting. */
export function ogcCoverageViewBounds(bounds: readonly number[]): [number, number, number, number] {
  if (bounds.length !== 4 || !bounds.every(Number.isFinite)) throw new CoverageError("bbox");
  const longitude = shortestLongitudeExtent([[bounds[0], bounds[2]]]);
  const south = Math.max(-90, Math.min(90, bounds[1]));
  const north = Math.max(-90, Math.min(90, bounds[3]));
  if (!longitude || longitude[0] >= longitude[1] || longitude[1] > 180 || south >= north)
    throw new CoverageError("bbox");
  return [longitude[0], south, longitude[1], north];
}

export function ogcCoverageUrl(
  collection: OgcCoverageCollection,
  bounds: number[],
  options: { datetime?: string; subset?: string } = {},
): string {
  if (
    bounds.length !== 4 ||
    !bounds.every(Number.isFinite) ||
    bounds[0] >= bounds[2] ||
    bounds[1] >= bounds[3] ||
    bounds[0] < -180 ||
    bounds[2] > 180 ||
    bounds[1] < -90 ||
    bounds[3] > 90
  )
    throw new CoverageError("bbox");
  const advertised = coverageLink(collection.links);
  if (!advertised) throw new CoverageError("empty");
  const url = new URL(linkUrl(advertised.href, collection.url));
  for (const key of [...url.searchParams.keys()])
    if (["bbox", "bbox-crs"].includes(key.toLowerCase())) url.searchParams.delete(key);
  url.searchParams.set("bbox", bounds.join(","));
  if (options.datetime?.trim()) url.searchParams.set("datetime", options.datetime.trim());
  if (options.subset?.trim()) url.searchParams.set("subset", options.subset.trim());
  return url.href;
}

/** Download one bounded snapshot, resolving external CoverageJSON components. */
export async function downloadOgcCoverage(
  collection: OgcCoverageCollection,
  url: string,
  signal: AbortSignal,
  parameter = "",
): Promise<{ file: File; bands: string[] }> {
  const abort = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  const advertised = coverageLink(collection.links);
  if (!advertised) throw new CoverageError("empty");
  const loaded = await bytes(url, abort, MAX_DOWNLOAD_BYTES, advertised.type);
  let data = loaded.data;
  const documentUrl = loaded.url;
  let names: string[] = [];
  if (!isTiff(advertised.type)) {
    let doc: Record<string, unknown>;
    try {
      doc = coverageObject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)));
    } catch {
      throw new CoverageError("response");
    }
    let budget = MAX_DOWNLOAD_BYTES - data.byteLength;
    const component = async (href: string): Promise<unknown> => {
      if (budget <= 0) throw new CoverageError("size");
      const part = await bytes(
        linkUrl(href, documentUrl),
        abort,
        budget,
        "application/prs.coverage+json, application/json;q=0.9",
      );
      budget -= part.data.byteLength;
      try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(part.data));
      } catch {
        throw new CoverageError("response");
      }
    };
    if (typeof doc.domain === "string") doc.domain = await component(doc.domain);
    const ranges = coverageObject(doc.ranges);
    const selected = parameter.trim()
      ? parameter.split(",").map((s) => s.trim())
      : Object.keys(ranges);
    if (
      !selected.length ||
      selected.length > 256 ||
      selected.some((name) => !Object.hasOwn(ranges, name))
    )
      throw new CoverageError("grid");
    const resolved: Record<string, unknown> = Object.create(null);
    for (const name of selected) {
      const range = ranges[name];
      if (typeof range === "string") {
        resolved[name] = await component(range);
      } else resolved[name] = range;
    }
    const grid = parseCoverageJson({ ...doc, ranges: resolved });
    names = grid.names;
    data = new Uint8Array(coverageGridTiff(grid));
  }
  try {
    assertWcsTiff(data);
  } catch {
    throw new CoverageError("response");
  }
  const info = await readGeoTiffInfo(data);
  if (!info.ok) throw new CoverageError("response");
  if (info.width * info.height * info.bands > MAX_COVERAGE_SAMPLES) throw new CoverageError("size");
  if (!info.tiled)
    data = new Uint8Array(await convertGeoTiffToCog(data, { float64: true, signal: abort }));
  abort.throwIfAborted();
  return {
    file: new File(
      [data],
      `${collection.id.replace(/[^\p{L}\p{N}._-]/gu, "_") || "coverage"}.tif`,
      { type: "image/tiff" },
    ),
    bands: names,
  };
}
