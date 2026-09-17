/** WCS 1.0.0 KVP discovery and numerical GeoTIFF subset requests. */
export type WcsBounds = [number, number, number, number];
export interface WcsCoverage {
  name: string;
  title: string;
  bounds?: WcsBounds;
}
export interface WcsDescription {
  format: string;
  crs: string;
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
      | "crs"
      | "bounds"
      | "size"
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
function xmlDocument(xml: string, root: string): Document {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (elements(doc, "parsererror").length) throw new WcsError("xml");
  const exception = elements(doc, "ServiceException")[0] ?? elements(doc, "ExceptionText")[0];
  if (exception) throw new WcsError("response", exception.textContent?.trim().slice(0, 500));
  // The root element name is the version gate: WCS 1.1 and 2.x answer
  // `GetCapabilities` with `Capabilities` and `DescribeCoverage` with
  // `CoverageDescriptions`, so they are rejected here. A document rooted at the
  // 1.0.0 element is taken at its word when it omits the `version` attribute
  // rather than failed on a detail its own root name already settles; the
  // coverage, format, and CRS checks below still reject what it cannot serve.
  if (doc.documentElement?.localName.split(":").pop() !== root) throw new WcsError("version");
  const version = doc.documentElement.getAttribute("version");
  if (version && version !== "1.0.0") throw new WcsError("version");
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
  const doc = xmlDocument(xml, "WCS_Capabilities");
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

export function parseWcsDescription(xml: string, coverage: string): WcsDescription {
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
  const supported = crs
    ? ["requestResponseCRSs", "requestCRSs", "responseCRSs"].map((tag) =>
        elements(crs, tag).flatMap((el) => (el.textContent ?? "").trim().split(/\s+/)),
      )
    : [[], [], []];
  // Request and output must both support longitude/latitude. Do not infer
  // reprojection support from nativeCRSs alone.
  const has4326 = (list: string[]) => list.some((value) => value.toUpperCase() === "EPSG:4326");
  if (!has4326(supported[0]) && !(has4326(supported[1]) && has4326(supported[2])))
    throw new WcsError("crs");
  return { format, crs: "EPSG:4326" };
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
  return wcsRequestUrl(endpoint, "GetCoverage", {
    COVERAGE: coverage,
    BBOX: bounds.join(","),
    CRS: description.crs,
    RESPONSE_CRS: description.crs,
    WIDTH: String(width),
    HEIGHT: String(height),
    FORMAT: description.format,
  });
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
