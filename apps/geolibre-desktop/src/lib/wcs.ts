/** WCS 1.0.0 and 2.0.1 KVP discovery and numerical GeoTIFF subset requests. */
export type WcsBounds = [number, number, number, number];
export interface WcsCoverage {
  name: string;
  title: string;
  bounds?: WcsBounds;
  version?: "2.0.1";
  formats?: string[];
  profiles?: string[];
  crses?: string[];
}
/** CRSes GeoLibre can request: bounds are entered in lon/lat and projected. */
export const WCS_CRSES = ["EPSG:4326", "EPSG:3857"] as const;
export type WcsCrs = (typeof WCS_CRSES)[number];
export interface WcsDescription {
  format: string;
  /** The CRS to request, chosen from what the coverage advertises. */
  crs: WcsCrs;
  /** Every CRS advertised for both requests and output, upper-cased. */
  crses?: string[];
  version?: "2.0.1";
  /** Coverage-axis names, independent of envelope order and grid-axis names. */
  axes?: { x: string; y: string };
  gridAxes?: { x: string; y: string };
  nativeCrs?: string;
  crsExtension?: boolean;
}

/** Stop waiting for a native request promptly; still observe its settlement. */
export function waitForWcsRequest<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    request.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export class WcsError extends Error {
  constructor(
    public readonly code:
      | "url"
      | "xml"
      | "version"
      | "empty"
      | "format"
      | "bounds"
      | "size"
      | "metadata"
      | "grid"
      | "response",
    message?: string,
  ) {
    super(message ?? code);
  }
}

// Remove stale KVP operation parameters case-insensitively, keeping vendor
// parameters (including authentication) intact on every subsequent request.
const OPERATION_KEYS = new Set([
  "service",
  "request",
  "version",
  "acceptversions",
  "coverage",
  "coverages",
  "identifier",
  "identifiers",
  "coverageid",
  "bbox",
  "crs",
  "response_crs",
  "width",
  "height",
  "depth",
  "resx",
  "resy",
  "resz",
  "format",
  "time",
  "interpolation",
  "exceptions",
  "subset",
  "rangesubset",
  "store",
  "scalesize",
  "scalefactor",
  "scaleaxes",
  "scaleextent",
  "subsettingcrs",
  "outputcrs",
  "mediatype",
]);

export function wcsRequestUrl(
  endpoint: string,
  request: string,
  parameters: Record<string, string> = {},
): string {
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    throw new WcsError("url");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new WcsError("url");
  // Accept the ImageServer URL shared by ArcGIS catalogs as a convenience.
  // WCS is published under /services/, not /rest/services/.
  if (/\/ImageServer\/?$/i.test(url.pathname)) {
    url.pathname =
      url.pathname.replace(/\/rest\/services\//i, "/services/").replace(/\/$/, "") + "/WCSServer";
  }
  for (const key of [...url.searchParams.keys()]) {
    if (OPERATION_KEYS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.hash = "";
  for (const [key, value] of Object.entries({
    SERVICE: "WCS",
    VERSION: "1.0.0",
    REQUEST: request,
    ...parameters,
  }))
    url.searchParams.set(key, value);
  return url.href;
}

function elements(parent: Document | Element, name: string): Element[] {
  return Array.from(parent.querySelectorAll("*")).filter(
    (el) => el.localName.split(":").pop() === name,
  );
}
function content(parent: Element, name: string): string {
  return elements(parent, name)[0]?.textContent?.trim() ?? "";
}
function xmlDocument(xml: string, root: string, expectedVersion = "1.0.0"): Document {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (elements(doc, "parsererror").length) throw new WcsError("xml");
  const exception = elements(doc, "ServiceException")[0] ?? elements(doc, "ExceptionText")[0];
  if (exception) throw new WcsError("response", exception.textContent?.trim().slice(0, 500));
  // Root names and version attributes must agree with the selected protocol.
  // WCS 1 descriptions and WCS 2 descriptions may omit the version attribute;
  // their distinct roots still identify the response. Content validation below
  // rejects metadata that cannot serve the requested numerical raster.
  if (doc.documentElement?.localName.split(":").pop() !== root) throw new WcsError("version");
  const version = doc.documentElement.getAttribute("version");
  if (version && version !== expectedVersion) throw new WcsError("version");
  return doc;
}

export function validWcsBounds(bounds: readonly number[]): bounds is WcsBounds {
  const [w, s, e, n] = bounds;
  return (
    bounds.length === 4 &&
    bounds.every(Number.isFinite) &&
    w >= -180 &&
    e <= 180 &&
    s >= -90 &&
    n <= 90 &&
    w < e &&
    s < n
  );
}

export function parseWcsCapabilities(xml: string): WcsCoverage[] {
  let doc: Document;
  try {
    doc = xmlDocument(xml, "WCS_Capabilities");
  } catch (error) {
    if (!(error instanceof WcsError) || error.code !== "version") throw error;
    return parseWcs2Capabilities(xmlDocument(xml, "Capabilities", "2.0.1"));
  }
  const result: WcsCoverage[] = [];
  for (const entry of elements(doc, "CoverageOfferingBrief")) {
    const name = content(entry, "name");
    if (!name || result.some((item) => item.name === name)) continue;
    const envelope = elements(entry, "lonLatEnvelope")[0];
    const coordinates = envelope
      ? elements(envelope, "pos").flatMap((pos) =>
          (pos.textContent ?? "").trim().split(/\s+/).map(Number),
        )
      : [];
    result.push({
      name,
      title: content(entry, "label") || name,
      ...(validWcsBounds(coordinates) ? { bounds: coordinates } : {}),
    });
  }
  if (!result.length) throw new WcsError("empty");
  return result;
}

/** Retain WCS 2 discovery metadata needed to negotiate a numerical subset. */
function parseWcs2Capabilities(doc: Document): WcsCoverage[] {
  const texts = (name: string) => [
    ...new Set(
      elements(doc, name)
        .map((el) => el.textContent?.trim() ?? "")
        .filter(Boolean),
    ),
  ];
  const formats = texts("formatSupported");
  const profiles = texts("Profile");
  const crses = texts("crsSupported");
  const result: WcsCoverage[] = [];
  for (const entry of elements(doc, "CoverageSummary")) {
    const name = content(entry, "CoverageId");
    if (!name || result.some((item) => item.name === name)) continue;
    const envelope = elements(entry, "WGS84BoundingBox")[0];
    const coordinates = envelope
      ? [content(envelope, "LowerCorner"), content(envelope, "UpperCorner")].flatMap((value) =>
          value.split(/\s+/).map(Number),
        )
      : [];
    result.push({
      name,
      title: content(entry, "Title") || name,
      version: "2.0.1",
      formats,
      profiles,
      crses,
      ...(validWcsBounds(coordinates) ? { bounds: coordinates } : {}),
    });
  }
  if (!result.length) throw new WcsError("empty");
  return result;
}

export function parseWcsDescription(
  xml: string,
  coverage: string,
  service?: WcsCoverage,
): WcsDescription {
  if (service?.version === "2.0.1") return parseWcs2Description(xml, coverage, service);
  const doc = xmlDocument(xml, "CoverageDescription");
  const entry = elements(doc, "CoverageOffering").find(
    (item) => content(item, "name") === coverage,
  );
  if (!entry) throw new WcsError("empty");
  const formats = elements(entry, "supportedFormats")[0];
  const format =
    formats &&
    elements(formats, "formats")
      .map((el) => el.textContent?.trim() ?? "")
      .find((value) => /^(?:GeoTIFF|GTiff|image\/(?:x-)?tiff(?:;.*)?)$/i.test(value));
  if (!format) throw new WcsError("format");
  const crs = elements(entry, "supportedCRSs")[0];
  const [both, requests, responses] = crs
    ? ["requestResponseCRSs", "requestCRSs", "responseCRSs"].map((tag) =>
        elements(crs, tag).flatMap((el) =>
          (el.textContent ?? "").trim().toUpperCase().split(/\s+/).filter(Boolean),
        ),
      )
    : [[], [], []];
  // A CRS is usable when the coverage accepts it for both the request bbox
  // and the output grid. nativeCRSs alone does not imply reprojection support.
  const crses = [...new Set([...both, ...requests.filter((value) => responses.includes(value))])];
  return { format, crs: defaultWcsCrs(crses), crses };
}

/** Normalize the EPSG forms used by GML envelopes and the CRS extension. */
function epsgCrs(value: string): string | undefined {
  if (
    /^(?:OGC:CRS84|urn:ogc:def:crs:OGC:[^:]*:CRS84|https?:\/\/www\.opengis\.net\/def\/crs\/OGC\/[^/]*\/CRS84)$/i.test(
      value,
    )
  )
    return "EPSG:4326";
  const match = value.match(/(?:^EPSG:|\/EPSG\/[^/]*\/|:EPSG:[^:]*:)(\d+)$/i);
  return match ? `EPSG:${match[1]}` : undefined;
}

/** Read the described axes rather than assuming Lat/Long or a grid order. */
function parseWcs2Description(xml: string, coverage: string, service: WcsCoverage): WcsDescription {
  const doc = xmlDocument(xml, "CoverageDescriptions", "2.0.1");
  const entry = elements(doc, "CoverageDescription").find(
    (item) => content(item, "CoverageId") === coverage,
  );
  if (!entry) throw new WcsError("empty");
  const format = [...(service.formats ?? []), content(entry, "nativeFormat")].find((value) =>
    /^(?:GeoTIFF|GTiff|image\/(?:x-)?(?:geo)?tiff(?:;.*)?)$/i.test(value),
  );
  if (!format) throw new WcsError("format");
  const profiles = service.profiles ?? [];
  // Scaling is required to honor the user's pixel cap before downloading.
  if (!profiles.some((value) => /WCS_service-extension_scaling\//i.test(value)))
    throw new WcsError("grid");
  const envelope = elements(entry, "Envelope")[0];
  const grid = elements(entry, "RectifiedGrid")[0];
  const nativeName = envelope?.getAttribute("srsName")?.trim() ?? "";
  const nativeCrs = epsgCrs(nativeName) ?? nativeName;
  const axes = envelope?.getAttribute("axisLabels")?.trim().split(/\s+/) ?? [];
  const gridAxes = grid ? content(grid, "axisLabels").split(/\s+/) : [];
  const label = /^[\p{L}_][\p{L}\p{N}_.:-]*$/u;
  if (
    !nativeCrs ||
    !grid ||
    axes.length !== 2 ||
    gridAxes.length !== 2 ||
    ![...axes, ...gridAxes].every((value) => label.test(value)) ||
    new Set(axes).size !== 2 ||
    new Set(gridAxes).size !== 2 ||
    grid.getAttribute("dimension") !== "2"
  )
    throw new WcsError("grid");
  const axisKind = (value: string) => {
    const name = value.toLowerCase().split(":").at(-1);
    if (["x", "e", "east", "easting", "lon", "long", "longitude"].includes(name ?? "")) return "x";
    if (["y", "n", "north", "northing", "lat", "latitude"].includes(name ?? "")) return "y";
    return undefined;
  };
  const x = axes.findIndex((value) => axisKind(value) === "x");
  const y = axes.findIndex((value) => axisKind(value) === "y");
  if (x < 0 || y < 0 || x === y) throw new WcsError("grid");
  const vectors = elements(grid, "offsetVector").map((el) =>
    (el.textContent ?? "").trim().split(/\s+/).map(Number),
  );
  if (
    vectors.length !== 2 ||
    vectors.some((vector) => vector.length !== 2 || !vector.every(Number.isFinite))
  )
    throw new WcsError("grid");
  const gridX = vectors.findIndex((vector) => vector[x] !== 0 && vector[y] === 0);
  const gridY = vectors.findIndex((vector) => vector[y] !== 0 && vector[x] === 0);
  if (gridX < 0 || gridY < 0 || gridX === gridY) throw new WcsError("grid");
  const crsExtension = profiles.some((value) => /WCS_service-extension_crs\//i.test(value));
  const crses = [
    ...new Set((service.crses ?? []).map(epsgCrs).filter((value): value is string => !!value)),
  ];
  if (!crsExtension && !WCS_CRSES.includes(nativeCrs as WcsCrs)) throw new WcsError("grid");
  return {
    version: "2.0.1",
    format,
    crs: crsExtension ? defaultWcsCrs(crses) : (nativeCrs as WcsCrs),
    crses: crsExtension ? crses : [nativeCrs],
    nativeCrs,
    crsExtension,
    axes: { x: axes[x], y: axes[y] },
    gridAxes: { x: gridAxes[gridX], y: gridAxes[gridY] },
  };
}

/**
 * Picks the request CRS for a coverage from its advertised list.
 *
 * Advertised lists are often incomplete (PDOK lists only its national grid yet
 * serves EPSG:4326 and EPSG:3857), so an unadvertised coverage still gets a
 * lon/lat attempt and the server's own exception is surfaced if it refuses.
 */
export function defaultWcsCrs(crses: readonly string[]): WcsCrs {
  return WCS_CRSES.find((value) => crses.includes(value)) ?? "EPSG:4326";
}

const MERCATOR_RADIUS = 6378137;
const MERCATOR_MAX_LATITUDE = 85.0511287798066;

/** Projects lon/lat bounds to the request CRS's own units. */
export function projectWcsBounds(bounds: WcsBounds, crs: WcsCrs): WcsBounds {
  if (crs === "EPSG:4326") return bounds;
  const x = (lon: number) => (MERCATOR_RADIUS * lon * Math.PI) / 180;
  const y = (lat: number) => {
    const clamped = Math.max(-MERCATOR_MAX_LATITUDE, Math.min(MERCATOR_MAX_LATITUDE, lat));
    return MERCATOR_RADIUS * Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360));
  };
  const [w, s, e, n] = bounds;
  return [x(w), y(s), x(e), y(n)];
}

export function wcsCoverageUrl(
  endpoint: string,
  coverage: string,
  bounds: WcsBounds,
  width: number,
  height: number,
  description: WcsDescription,
): string {
  if (!coverage.trim()) throw new WcsError("empty");
  if (!validWcsBounds(bounds)) throw new WcsError("bounds");
  if (![width, height].every((n) => Number.isInteger(n) && n >= 1 && n <= 4096))
    throw new WcsError("size");
  // Web Mercator stops short of the poles, so a polar box can collapse.
  const bbox = projectWcsBounds(bounds, description.crs);
  if (!(bbox[0] < bbox[2] && bbox[1] < bbox[3])) throw new WcsError("bounds");
  if (description.version === "2.0.1") {
    const { axes, gridAxes, nativeCrs, crsExtension } = description;
    if (!axes || !gridAxes || (!crsExtension && nativeCrs !== description.crs))
      throw new WcsError("grid");
    const url = new URL(
      wcsRequestUrl(endpoint, "GetCoverage", {
        VERSION: "2.0.1",
        COVERAGEID: coverage,
        FORMAT: description.format,
        SCALESIZE: `${gridAxes.x}(${width}),${gridAxes.y}(${height})`,
        ...(crsExtension
          ? {
              SUBSETTINGCRS: `http://www.opengis.net/def/crs/EPSG/0/${description.crs.split(":")[1]}`,
              OUTPUTCRS: `http://www.opengis.net/def/crs/EPSG/0/${description.crs.split(":")[1]}`,
            }
          : {}),
      }),
    );
    url.searchParams.append("SUBSET", `${axes.x}(${bbox[0]},${bbox[2]})`);
    url.searchParams.append("SUBSET", `${axes.y}(${bbox[1]},${bbox[3]})`);
    return url.href;
  }
  return wcsRequestUrl(endpoint, "GetCoverage", {
    COVERAGE: coverage,
    BBOX: bbox.join(","),
    CRS: description.crs,
    RESPONSE_CRS: description.crs,
    WIDTH: String(width),
    HEIGHT: String(height),
    FORMAT: description.format,
  });
}

/** Locate a byte sequence without decoding binary raster payloads as text. */
function byteIndex(
  bytes: Uint8Array,
  needle: Uint8Array,
  start: number,
  end = bytes.length,
): number {
  outer: for (let i = start; i <= end - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Extract the single TIFF from WCS multipart output, preserving every byte. */
export function wcsTiffBytes<T extends ArrayBufferLike>(bytes: Uint8Array<T>): Uint8Array<T> {
  if (bytes[0] !== 45 || bytes[1] !== 45) {
    assertWcsTiff(bytes);
    return bytes;
  }
  const firstLine = new TextDecoder().decode(bytes.subarray(0, 80));
  const boundary = /^--([0-9A-Za-z'()+_,\-./:=? ]{1,70})\r?\n/.exec(firstLine);
  if (!boundary) throw new WcsError("response");
  const encoder = new TextEncoder();
  const delimiter = encoder.encode(`\n--${boundary[1]}`);
  let position = boundary[0].length;
  let raster: Uint8Array<T> | undefined;
  for (let part = 0; part < 32; part++) {
    const limit = Math.min(bytes.length, position + 16384);
    const crlf = byteIndex(bytes, encoder.encode("\r\n\r\n"), position, limit);
    const lf = byteIndex(bytes, encoder.encode("\n\n"), position, limit);
    const headerEnd = crlf < 0 ? lf : lf < 0 ? crlf : Math.min(crlf, lf);
    if (headerEnd < 0) throw new WcsError("response");
    const headers = new TextDecoder().decode(bytes.subarray(position, headerEnd));
    const bodyStart = headerEnd + (headerEnd === crlf ? 4 : 2);
    let next = byteIndex(bytes, delimiter, bodyStart);
    // A boundary-like byte sequence inside a TIFF is not a MIME delimiter.
    while (next >= 0) {
      const suffix = next + delimiter.length;
      const closing = bytes[suffix] === 45 && bytes[suffix + 1] === 45;
      const afterClose = suffix + 2;
      if (
        bytes[suffix] === 10 ||
        (bytes[suffix] === 13 && bytes[suffix + 1] === 10) ||
        (closing &&
          (afterClose === bytes.length ||
            bytes[afterClose] === 10 ||
            (bytes[afterClose] === 13 && bytes[afterClose + 1] === 10)))
      )
        break;
      next = byteIndex(bytes, delimiter, next + 1);
    }
    if (next < 0) throw new WcsError("response");
    if (/^content-type:\s*image\/(?:geo|x-)?tiff(?:\s*;[^\r\n]*)?\s*$/im.test(headers)) {
      const encoding = /^content-transfer-encoding:\s*([^\r\n]*)/im
        .exec(headers)?.[1]
        .trim()
        .toLowerCase();
      if (raster || (encoding && !["binary", "8bit"].includes(encoding)))
        throw new WcsError("response");
      raster = bytes.subarray(bodyStart, bytes[next - 1] === 13 ? next - 1 : next);
      assertWcsTiff(raster);
    }
    position = next + delimiter.length;
    if (bytes[position] === 45 && bytes[position + 1] === 45) {
      if (!raster) throw new WcsError("response");
      return raster;
    }
    position += bytes[position] === 13 ? 2 : 1;
  }
  throw new WcsError("response");
}

/** Reject XML/HTML error bodies even when the server returns HTTP 200. */
export function assertWcsTiff(bytes: Uint8Array): void {
  const little = bytes[0] === 0x49 && bytes[1] === 0x49;
  const big = bytes[0] === 0x4d && bytes[1] === 0x4d;
  if (
    bytes.length >= 8 &&
    ((little && [42, 43].includes(bytes[2]) && bytes[3] === 0) ||
      (big && bytes[2] === 0 && [42, 43].includes(bytes[3])))
  )
    return;
  const text = new TextDecoder().decode(bytes.slice(0, 8192));
  if (text.trimStart().startsWith("<")) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    const exception = elements(doc, "ServiceException")[0] ?? elements(doc, "ExceptionText")[0];
    if (exception) throw new WcsError("response", exception.textContent?.trim().slice(0, 500));
  }
  throw new WcsError("response");
}
