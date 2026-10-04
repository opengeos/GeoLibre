/**
 * Helpers for a layer's user-authored catalog metadata
 * ({@link LayerDescriptiveMetadata}, issue #2858): normalization for the
 * project file, field validation for the Metadata dialog, and the STAC 1.0
 * Item export.
 */
import type {
  GeoLibreLayer,
  LayerDescriptiveMetadata,
  LayerMetadataContact,
  LayerMetadataLink,
  LayerMetadataTemporalExtent,
} from "./types";

/** STAC specification version the Item export targets. */
export const STAC_VERSION = "1.0.0";

/** Schema URL of the STAC processing extension, declared for `processing:lineage`. */
export const STAC_PROCESSING_EXTENSION =
  "https://stac-extensions.github.io/processing/v1.1.0/schema.json";

/** URL schemes a metadata link (or asset) may use. */
const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:", "ftp:", "s3:", "gs:", "mailto:"]);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;
/** The STAC 1.0 `license` pattern (an SPDX identifier, `various` or `proprietary`). */
const STAC_LICENSE_PATTERN = /^[\w\-.+]+$/;

/**
 * Trim a value to a non-empty string, or `undefined`.
 *
 * @param value - Any value.
 * @returns The trimmed string, or `undefined` for a non-string or blank value.
 */
function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Split comma-separated keyword text into a clean keyword list.
 *
 * @param text - Text such as `"roads, transport,  osm"`.
 * @returns The trimmed, non-empty keywords with case-insensitive duplicates removed.
 */
export function parseMetadataKeywords(text: string): string[] {
  return normalizeKeywords(text.split(","));
}

function normalizeKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const entry of value) {
    const keyword = cleanString(entry);
    if (!keyword) continue;
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    keywords.push(keyword);
  }
  return keywords;
}

function normalizeContact(value: unknown): LayerMetadataContact | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const contact: LayerMetadataContact = {};
  const name = cleanString(raw.name);
  const email = cleanString(raw.email);
  const organization = cleanString(raw.organization);
  if (name) contact.name = name;
  if (email) contact.email = email;
  if (organization) contact.organization = organization;
  return Object.keys(contact).length > 0 ? contact : undefined;
}

function normalizeTemporalExtent(value: unknown): LayerMetadataTemporalExtent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const extent: LayerMetadataTemporalExtent = {};
  const start = cleanString(raw.start);
  const end = cleanString(raw.end);
  if (start) extent.start = start;
  if (end) extent.end = end;
  return Object.keys(extent).length > 0 ? extent : undefined;
}

function normalizeLinks(value: unknown): LayerMetadataLink[] {
  if (!Array.isArray(value)) return [];
  const links: LayerMetadataLink[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    const href = cleanString(raw.href);
    // A link is its address: a row with only a label is an unfinished edit.
    if (!href) continue;
    const link: LayerMetadataLink = { href };
    const rel = cleanString(raw.rel);
    const title = cleanString(raw.title);
    if (rel) link.rel = rel;
    if (title) link.title = title;
    links.push(link);
  }
  return links;
}

/**
 * Normalize a raw descriptive-metadata value (from a project file, a plugin or
 * the Metadata dialog): keep only string fields, trim them, and drop empty
 * fields, empty keywords and links without an address.
 *
 * Values are not validated here — a malformed email or date in a hand-edited
 * file is kept so the dialog can show and fix it rather than silently lose it.
 *
 * @param value - Any value.
 * @returns The cleaned record, or `undefined` when nothing is left, so an
 *   empty record is never written to a project.
 */
export function normalizeLayerDescriptiveMetadata(
  value: unknown,
): LayerDescriptiveMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const metadata: LayerDescriptiveMetadata = {};
  for (const key of ["title", "abstract", "license", "attribution", "lineage"] as const) {
    const text = cleanString(raw[key]);
    if (text) metadata[key] = text;
  }
  const keywords = normalizeKeywords(raw.keywords);
  if (keywords.length > 0) metadata.keywords = keywords;
  const contact = normalizeContact(raw.contact);
  if (contact) metadata.contact = contact;
  const temporalExtent = normalizeTemporalExtent(raw.temporalExtent);
  if (temporalExtent) metadata.temporalExtent = temporalExtent;
  const links = normalizeLinks(raw.links);
  if (links.length > 0) metadata.links = links;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/**
 * Whether a string is a plausible email address (`local@domain.tld`).
 *
 * @param value - The candidate address.
 * @returns `true` when it has the shape of an email address.
 */
export function isValidMetadataEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

/**
 * Whether a string is an absolute URL with a scheme a metadata link may use
 * (http, https, ftp, s3, gs, mailto). Script and data URLs are rejected.
 *
 * @param value - The candidate URL.
 * @returns `true` when it parses as an allowed absolute URL.
 */
export function isValidMetadataUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return ALLOWED_LINK_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}

/**
 * Whether the calendar fields name a real day (rejecting e.g. February 30).
 *
 * @param year - Four-digit year.
 * @param month - Month, 1-12.
 * @param day - Day of month.
 * @returns `true` when the date exists.
 */
function isRealDate(year: number, month: number, day: number): boolean {
  // setUTCFullYear, not Date.UTC: the latter maps years 0-99 to 1900-1999.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * Whether a string is an ISO 8601 date (`YYYY-MM-DD`) or date-time
 * (`YYYY-MM-DDTHH:MM[:SS[.fff]][Z|±HH:MM]`) naming a real instant.
 *
 * @param value - The candidate date.
 * @returns `true` when it is a valid ISO 8601 date or date-time.
 */
export function isValidMetadataDate(value: string): boolean {
  const text = value.trim();
  const dateOnly = DATE_ONLY_PATTERN.exec(text);
  if (dateOnly) return isRealDate(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]));
  const dateTime = DATE_TIME_PATTERN.exec(text);
  if (!dateTime) return false;
  if (!isRealDate(Number(dateTime[1]), Number(dateTime[2]), Number(dateTime[3]))) return false;
  const hours = Number(dateTime[4]);
  const minutes = Number(dateTime[5]);
  const seconds = dateTime[6] === undefined ? 0 : Number(dateTime[6]);
  return hours < 24 && minutes < 60 && seconds < 60;
}

/**
 * Convert a validated metadata date to an RFC 3339 UTC date-time, as STAC
 * requires. A date-only bound covers its whole day: a start becomes the first
 * second of the day, an end the last. A date-time without an offset is read
 * as UTC so the export does not depend on the exporting machine's time zone.
 *
 * @param value - A date accepted by {@link isValidMetadataDate}.
 * @param bound - Whether the value starts or ends an interval.
 * @returns The RFC 3339 date-time, or `null` for an invalid date.
 */
export function metadataDateToRfc3339(value: string, bound: "start" | "end"): string | null {
  const text = value.trim();
  if (!isValidMetadataDate(text)) return null;
  if (DATE_ONLY_PATTERN.test(text)) {
    return `${text}T${bound === "start" ? "00:00:00" : "23:59:59"}Z`;
  }
  // A compact `+HHMM` offset passes validation but is not an ECMAScript
  // date-time format, so spell it `+HH:MM` before parsing.
  const normalized = text.replace(" ", "T").replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  const parsed = new Date(hasOffset ? normalized : `${normalized}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Why a metadata field failed {@link validateLayerDescriptiveMetadata}. */
export type LayerMetadataIssueCode = "email" | "url" | "date" | "dateOrder";

/** One validation failure, addressed by a dotted field path. */
export interface LayerMetadataIssue {
  /**
   * The failing field: `contact.email`, `temporalExtent.start`,
   * `temporalExtent.end`, or `links.<index>.href`.
   */
  field: string;
  code: LayerMetadataIssueCode;
}

/**
 * Validate the fields of a descriptive-metadata record that have a format:
 * the contact email, the temporal-extent dates (and their order), and the
 * link URLs. Free-text fields are not checked.
 *
 * @param metadata - The record to check (normalized or a dialog draft).
 * @returns Every failure found; empty when the record is valid.
 */
export function validateLayerDescriptiveMetadata(
  metadata: LayerDescriptiveMetadata | undefined,
): LayerMetadataIssue[] {
  const issues: LayerMetadataIssue[] = [];
  if (!metadata) return issues;
  const email = cleanString(metadata.contact?.email);
  if (email && !isValidMetadataEmail(email)) issues.push({ field: "contact.email", code: "email" });
  const start = cleanString(metadata.temporalExtent?.start);
  const end = cleanString(metadata.temporalExtent?.end);
  const startValid = start ? isValidMetadataDate(start) : true;
  const endValid = end ? isValidMetadataDate(end) : true;
  if (!startValid) issues.push({ field: "temporalExtent.start", code: "date" });
  if (!endValid) issues.push({ field: "temporalExtent.end", code: "date" });
  if (start && end && startValid && endValid) {
    const startTime = Date.parse(metadataDateToRfc3339(start, "start") ?? "");
    const endTime = Date.parse(metadataDateToRfc3339(end, "end") ?? "");
    if (startTime > endTime) issues.push({ field: "temporalExtent.end", code: "dateOrder" });
  }
  (metadata.links ?? []).forEach((link, index) => {
    const href = cleanString(link?.href);
    if (href && !isValidMetadataUrl(href)) {
      issues.push({ field: `links.${index}.href`, code: "url" });
    }
  });
  return issues;
}

/** A STAC 1.0 link object. */
export interface StacLink {
  href: string;
  rel: string;
  type?: string;
  title?: string;
}

/** A STAC 1.0 asset object. */
export interface StacAsset {
  href: string;
  type?: string;
  title?: string;
  roles?: string[];
}

/** A STAC 1.0 provider object. */
export interface StacProvider {
  name: string;
  description?: string;
  roles?: string[];
  url?: string;
}

/** The STAC 1.0 Item {@link buildLayerStacItem} produces. */
export interface StacItem {
  type: "Feature";
  stac_version: string;
  stac_extensions: string[];
  id: string;
  geometry: Record<string, unknown> | null;
  bbox?: [number, number, number, number];
  properties: Record<string, unknown> & { datetime: string | null };
  links: StacLink[];
  assets: Record<string, StacAsset>;
}

/** Options for {@link buildLayerStacItem}. */
export interface LayerStacItemOptions {
  /** The layer's extent in EPSG:4326 as `[west, south, east, north]`. */
  bbox?: readonly number[] | null;
  /** Where the layer's data can be fetched from, when it has a source URL. */
  assetHref?: string | null;
  /** Clock used for `datetime` when no temporal extent is recorded. */
  now?: Date;
}

/**
 * Validate a WGS84 bounding box.
 *
 * @param bbox - Candidate `[west, south, east, north]`.
 * @returns The box, or `null` when it is not four finite in-range numbers.
 */
function validBbox(
  bbox: readonly number[] | null | undefined,
): [number, number, number, number] | null {
  if (!bbox || bbox.length !== 4) return null;
  if (!bbox.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  const [west, south, east, north] = bbox;
  if (south < -90 || north > 90 || south > north) return null;
  if (west < -180 || west > 180 || east < -180 || east > 180) return null;
  return [west, south, east, north];
}

/**
 * The GeoJSON geometry covering a bounding box: a Point for a degenerate box,
 * a MultiPolygon split at the antimeridian when `west > east` (the STAC
 * convention for a box crossing it), otherwise a Polygon.
 *
 * @param bbox - A box accepted by {@link validBbox}.
 * @returns The footprint geometry.
 */
function bboxGeometry([west, south, east, north]: [number, number, number, number]): Record<
  string,
  unknown
> {
  if (west === east && south === north) return { type: "Point", coordinates: [west, south] };
  // Degenerate on one axis only (e.g. points sharing one longitude): a line,
  // not a zero-area polygon.
  if (west === east || south === north) {
    return {
      type: "LineString",
      coordinates: [
        [west, south],
        [east, north],
      ],
    };
  }
  const ring = (w: number, e: number) => [
    [w, south],
    [e, south],
    [e, north],
    [w, north],
    [w, south],
  ];
  if (west > east) {
    return { type: "MultiPolygon", coordinates: [[ring(west, 180)], [ring(-180, east)]] };
  }
  return { type: "Polygon", coordinates: [ring(west, east)] };
}

/** Media types by data-file extension, for the Item's data asset. */
const ASSET_MEDIA_TYPES: Record<string, string> = {
  geojson: "application/geo+json",
  json: "application/json",
  tif: "image/tiff; application=geotiff",
  tiff: "image/tiff; application=geotiff",
  parquet: "application/vnd.apache.parquet",
  geoparquet: "application/vnd.apache.parquet",
  fgb: "application/vnd.flatgeobuf",
  pmtiles: "application/vnd.pmtiles",
  gpkg: "application/geopackage+sqlite3",
  kml: "application/vnd.google-earth.kml+xml",
  kmz: "application/vnd.google-earth.kmz",
  csv: "text/csv",
  zip: "application/zip",
  las: "application/vnd.las",
  laz: "application/vnd.laszip",
  zarr: "application/vnd+zarr",
};

/**
 * Guess the media type of a layer's data asset from the URL's extension, or
 * the layer type when the URL has none (a COG is flagged cloud-optimized).
 *
 * @param href - The asset URL.
 * @param layerType - The layer's type.
 * @returns The media type, or `undefined` when it cannot be told.
 */
export function stacAssetMediaType(
  href: string,
  layerType: GeoLibreLayer["type"],
): string | undefined {
  let path = href;
  try {
    path = new URL(href).pathname;
  } catch {
    // Not an absolute URL: read the extension off the raw text.
  }
  const extension = /\.([a-z0-9]+)$/i.exec(path.replace(/\/+$/, ""))?.[1]?.toLowerCase();
  if (layerType === "cog" && (extension === "tif" || extension === "tiff" || !extension)) {
    return "image/tiff; application=geotiff; profile=cloud-optimized";
  }
  if (extension && ASSET_MEDIA_TYPES[extension]) return ASSET_MEDIA_TYPES[extension];
  if (layerType === "geojson" && !extension) return "application/geo+json";
  return undefined;
}

/**
 * Build a STAC 1.0 Item describing a layer from its descriptive metadata.
 *
 * Mapping: `id` is the layer id; `geometry`/`bbox` come from the WGS84 extent
 * (a `null` geometry, as STAC allows, when the extent is unknown); `title`
 * falls back to the layer name; `abstract` becomes `description`; the contact
 * becomes a `producer` provider; `lineage` becomes `processing:lineage` (with
 * the processing extension declared); the temporal extent becomes `datetime`
 * or `start_datetime`/`end_datetime` (with `datetime` set to the export time
 * when none is recorded, since STAC requires one); links keep their `rel`
 * (default `related`); and a source URL becomes the `data` asset.
 *
 * A license that is not an SPDX-style identifier (STAC 1.0's pattern) is
 * exported as `proprietary`, with the original text kept in
 * `geolibre:license`; the attribution is kept in `geolibre:attribution`.
 *
 * @param layer - The layer to describe.
 * @param options - Extent, asset URL and clock; see {@link LayerStacItemOptions}.
 * @returns The STAC Item, ready to `JSON.stringify`.
 */
export function buildLayerStacItem(
  layer: Pick<GeoLibreLayer, "id" | "name" | "type" | "descriptiveMetadata">,
  options: LayerStacItemOptions = {},
): StacItem {
  const metadata = normalizeLayerDescriptiveMetadata(layer.descriptiveMetadata) ?? {};
  const now = options.now ?? new Date();
  const properties: StacItem["properties"] = { datetime: null };
  properties.title = metadata.title ?? layer.name;
  if (metadata.abstract) properties.description = metadata.abstract;
  if (metadata.keywords?.length) properties.keywords = [...metadata.keywords];

  const start = metadata.temporalExtent?.start
    ? metadataDateToRfc3339(metadata.temporalExtent.start, "start")
    : null;
  const end = metadata.temporalExtent?.end
    ? metadataDateToRfc3339(metadata.temporalExtent.end, "end")
    : null;
  // Compared as instants: the two bounds may be spelled differently
  // (`…T00:00:00Z` from a date, `…T00:00:00.000Z` from a date-time).
  if (start && end && Date.parse(start) !== Date.parse(end)) {
    properties.start_datetime = start;
    properties.end_datetime = end;
  } else {
    // STAC needs a datetime unless both interval bounds are known: an instant
    // or a one-sided interval exports its known bound, and a layer with no
    // temporal extent is stamped with the export time.
    properties.datetime = start ?? end ?? now.toISOString();
  }

  if (metadata.license) {
    if (STAC_LICENSE_PATTERN.test(metadata.license)) {
      properties.license = metadata.license;
    } else {
      properties.license = "proprietary";
      properties["geolibre:license"] = metadata.license;
    }
  }
  const contact = metadata.contact;
  const providerName = contact?.organization ?? contact?.name ?? contact?.email;
  if (contact && providerName) {
    const person = [
      contact.organization && contact.name ? contact.name : undefined,
      contact.email,
    ].filter(Boolean);
    const provider: StacProvider = { name: providerName, roles: ["producer"] };
    if (person.length > 0) provider.description = `Contact: ${person.join(", ")}`;
    properties.providers = [provider];
  }
  if (metadata.attribution) properties["geolibre:attribution"] = metadata.attribution;

  const extensions: string[] = [];
  if (metadata.lineage) {
    properties["processing:lineage"] = metadata.lineage;
    extensions.push(STAC_PROCESSING_EXTENSION);
  }

  const links: StacLink[] = (metadata.links ?? [])
    .filter((link) => isValidMetadataUrl(link.href))
    .map((link) => ({
      href: link.href,
      rel: link.rel ?? "related",
      ...(link.title ? { title: link.title } : {}),
    }));

  const assets: Record<string, StacAsset> = {};
  const assetHref = cleanString(options.assetHref);
  if (assetHref) {
    const type = stacAssetMediaType(assetHref, layer.type);
    assets.data = {
      href: assetHref,
      ...(type ? { type } : {}),
      title: properties.title as string,
      roles: ["data"],
    };
  }

  const bbox = validBbox(options.bbox);
  return {
    type: "Feature",
    stac_version: STAC_VERSION,
    stac_extensions: extensions,
    id: layer.id,
    geometry: bbox ? bboxGeometry(bbox) : null,
    ...(bbox ? { bbox } : {}),
    properties,
    links,
    assets,
  };
}
