const OGC_OPERATION_PARAMS = new Set([
  "bbox",
  "crs",
  "exceptions",
  "format",
  "height",
  "info_format",
  "layers",
  "layer",
  "query_layers",
  "request",
  "service",
  "srs",
  "styles",
  "style",
  "tilecol",
  "tilematrix",
  "tilematrixset",
  "tilerow",
  "transparent",
  "version",
  "width",
]);

function serviceEndpoint(url) {
  const endpoint = new URL(url.href);
  endpoint.hash = "";
  for (const key of [...endpoint.searchParams.keys()]) {
    if (OGC_OPERATION_PARAMS.has(key.toLowerCase())) endpoint.searchParams.delete(key);
  }
  return endpoint.href;
}

function candidate(url, format, kind, name, canonicalUrl = url.href) {
  return { url: canonicalUrl, name, format, kind, styleUrl: null };
}

/** Turn a completed browser request into a GeoLibre service candidate. */
export function classifyServiceRequest(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const params = new Map(
    [...url.searchParams].map(([key, value]) => [key.toLowerCase(), value.toLowerCase()]),
  );
  const service = params.get("service");
  const request = params.get("request");
  const endpoint = serviceEndpoint(url);
  if (service === "wms" && /^(?:getcapabilities|getmap|getfeatureinfo)$/.test(request ?? "")) {
    return candidate(url, "WMS", "raster", "WMS service", endpoint);
  }
  if (service === "wmts" && /^(?:getcapabilities|gettile|getfeatureinfo)$/.test(request ?? "")) {
    return candidate(url, "WMTS", "raster", "WMTS service", endpoint);
  }
  if (
    service === "wfs" &&
    /^(?:getcapabilities|getfeature|describefeaturetype)$/.test(request ?? "")
  ) {
    return candidate(url, "WFS", "vector", "WFS service", endpoint);
  }

  const path = url.pathname;
  const arcgis = path.match(/^(.*\/(?:FeatureServer))(?:\/\d+)?(?:\/query)?\/?$/i);
  if (arcgis) {
    const root = new URL(url.origin + arcgis[1]);
    return candidate(url, "ArcGIS Feature Service", "vector", "ArcGIS feature service", root.href);
  }

  if (/\/collections(?:\/[^/]+\/items)?\/?$/i.test(path)) {
    const api = new URL(url.href);
    api.search = "";
    api.hash = "";
    return candidate(url, "OGC API", "vector", "OGC API service", api.href);
  }

  const tile = path.match(/^(.*\/)(\d+)\/(\d+)\/(\d+)(\.(?:png|jpe?g|webp|gif|pbf|mvt))(?:\/)?$/i);
  if (tile) {
    const [zoom, column, row] = tile.slice(2, 5).map(Number);
    const dimension = 2 ** zoom;
    if (zoom > 30 || column >= dimension || row >= dimension) return null;
    const template = new URL(url.href);
    template.pathname = `${tile[1]}{z}/{x}/{y}${tile[5]}`;
    const templateUrl = template.href.replaceAll("%7B", "{").replaceAll("%7D", "}");
    const vector = /^\.(?:pbf|mvt)$/i.test(tile[5]);
    return candidate(
      url,
      vector ? "Vector tiles" : "XYZ / TMS",
      vector ? "vector" : "raster",
      vector ? "Vector tile service" : "XYZ / TMS service",
      templateUrl,
    );
  }

  if (/\.(?:pbf|mvt)$/i.test(path)) {
    return candidate(url, "Vector tiles", "vector", "Vector tile service");
  }
  return null;
}

export function mergeServiceCandidates(...groups) {
  const merged = new Map();
  for (const entry of groups.flat()) {
    if (entry?.url && !merged.has(entry.url)) merged.set(entry.url, entry);
  }
  return [...merged.values()];
}

/** Serialize asynchronous mutations independently for each browser tab. */
export function createTabTaskQueue() {
  const pending = new Map();
  return (tabId, task) => {
    const previous = pending.get(tabId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    pending.set(tabId, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (pending.get(tabId) === next) pending.delete(tabId);
      });
    return next;
  };
}

export function requestBelongsToPage(activeDocumentIds, requestDocumentId) {
  return Boolean(requestDocumentId) && activeDocumentIds?.has(requestDocumentId);
}
