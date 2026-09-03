import { fetchUrlBytes } from "../../../lib/native-http";
import { isTauri } from "../../../lib/is-tauri";
import { CSW_PROXY_PATH } from "./constants";

export type CswResourceKind = "wms" | "wfs" | "arcgis" | "geojson" | "unknown";

export interface CswResource {
  url: string;
  kind: CswResourceKind;
  name?: string;
}

export interface CswRecord {
  identifier: string;
  title: string;
  abstract: string;
  resources: CswResource[];
}

function hasLocalName(element: Element, name: string): boolean {
  return element.localName === name || element.tagName.split(":").pop() === name;
}

function childText(element: Element, localName: string): string {
  const node = Array.from(element.querySelectorAll("*")).find((candidate) =>
    hasLocalName(candidate, localName),
  );
  return (node?.textContent ?? "").trim();
}

export function classifyCswResource(url: string, scheme = ""): CswResourceKind {
  const value = `${scheme} ${url}`.toLowerCase();
  if (/\bwms\b|service=wms|\/wms(?:server)?(?:[/?]|$)/.test(value)) return "wms";
  if (/\bwfs\b|service=wfs|\/wfs(?:[/?]|$)/.test(value)) return "wfs";
  if (/arcgis|featureserver|mapserver|imageserver/.test(value)) return "arcgis";
  if (/geojson|\.geojson(?:[?#]|$)|[?&](?:f|format)=geojson/.test(value)) return "geojson";
  return "unknown";
}

export function parseCswRecords(xmlText: string): CswRecord[] {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("Could not parse the CSW response.");
  const root = doc.documentElement;
  if (root?.localName === "ExceptionReport" || root?.localName === "ServiceExceptionReport") {
    throw new Error(
      (root.textContent ?? "The CSW service returned an error.").trim().slice(0, 500),
    );
  }
  const elements = Array.from(doc.querySelectorAll("*")).filter((element) =>
    hasLocalName(element, "Record"),
  );
  return elements.map((record, index) => {
    const resources: CswResource[] = [];
    for (const localName of ["URI", "references"]) {
      for (const node of Array.from(record.querySelectorAll("*")).filter((element) =>
        hasLocalName(element, localName),
      )) {
        const url = (node.textContent ?? "").trim();
        if (!/^https?:\/\//i.test(url) || resources.some((item) => item.url === url)) continue;
        const scheme = node.getAttribute("protocol") ?? node.getAttribute("scheme") ?? "";
        resources.push({
          url,
          kind: classifyCswResource(url, scheme),
          name: node.getAttribute("name") ?? undefined,
        });
      }
    }
    return {
      identifier: childText(record, "identifier") || `record-${index}`,
      title: childText(record, "title") || childText(record, "identifier") || "Untitled dataset",
      abstract: childText(record, "abstract"),
      resources,
    };
  });
}

/** True when the endpoint is an absolute http(s) URL. A bare `https://` passes a
 * `^https?://` regex but makes {@link createCswGetRecordsUrl} throw, so callers
 * validate here to surface their own message instead of a raw `TypeError`. */
export function isHttpCswEndpoint(endpoint: string): boolean {
  try {
    const { protocol } = new URL(endpoint);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function createCswGetRecordsUrl(endpoint: string, keyword: string, maxRecords = 20): string {
  const url = new URL(endpoint);
  const operationKeys = new Set([
    "service",
    "request",
    "version",
    "typenames",
    "elementsetname",
    "resulttype",
    "maxrecords",
    "startposition",
    "constraint",
    "constraintlanguage",
    "constraint_language_version",
  ]);
  for (const key of Array.from(url.searchParams.keys())) {
    if (operationKeys.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.searchParams.set("service", "CSW");
  url.searchParams.set("request", "GetRecords");
  url.searchParams.set("version", "2.0.2");
  url.searchParams.set("typeNames", "csw:Record");
  url.searchParams.set("elementSetName", "full");
  url.searchParams.set("resultType", "results");
  url.searchParams.set("maxRecords", String(maxRecords));
  const term = keyword.trim();
  if (term) {
    url.searchParams.set("constraintLanguage", "CQL_TEXT");
    url.searchParams.set("constraint_language_version", "1.1.0");
    url.searchParams.set("constraint", `csw:AnyText LIKE '%${term.replaceAll("'", "''")}%'`);
  }
  return url.toString();
}

export async function searchCsw(endpoint: string, keyword: string, signal?: AbortSignal) {
  const fetchRecords = async (requestUrl: string) => {
    let text: string;
    if (isTauri()) {
      const bytes = await fetchUrlBytes(requestUrl, { context: "CSW GetRecords" });
      text = new TextDecoder().decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    } else {
      const url = import.meta.env.DEV
        ? `${CSW_PROXY_PATH}?url=${encodeURIComponent(requestUrl)}`
        : requestUrl;
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
      text = await response.text();
    }
    return parseCswRecords(text);
  };

  const term = keyword.trim();
  try {
    return await fetchRecords(createCswGetRecordsUrl(endpoint, term));
  } catch (error) {
    // A number of otherwise conforming CSW 2.0.2 servers reject wildcard CQL.
    // Fall back to a larger unfiltered page and filter locally so keyword search
    // remains useful rather than exposing the server's parser limitation.
    if (!term || signal?.aborted) throw error;
    const records = await fetchRecords(createCswGetRecordsUrl(endpoint, "", 100));
    const needle = term.toLocaleLowerCase();
    return records.filter((record) =>
      `${record.title} ${record.abstract} ${record.identifier}`
        .toLocaleLowerCase()
        .includes(needle),
    );
  }
}

/** Downloads a GeoJSON resource advertised by a CSW record using the same
 * CORS-safe desktop/dev transport as catalog requests. */
export async function fetchCswGeoJson(url: string): Promise<GeoJSON.FeatureCollection> {
  let text: string;
  if (isTauri()) {
    const bytes = await fetchUrlBytes(url, { context: "CSW GeoJSON resource" });
    text = new TextDecoder().decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  } else {
    const requestUrl = import.meta.env.DEV
      ? `${CSW_PROXY_PATH}?url=${encodeURIComponent(url)}`
      : url;
    const response = await fetch(requestUrl);
    if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
    text = await response.text();
  }
  return JSON.parse(text) as GeoJSON.FeatureCollection;
}
