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

// A WFS request carries its feature type and encoding alongside the operation,
// and GeoLibre's WFS form asks for those separately from the endpoint.
const WFS_OPERATION_PARAMS = new Set([
  "count",
  "cql_filter",
  "featureid",
  "filter",
  "maxfeatures",
  "namespaces",
  "outputformat",
  "propertyname",
  "resourceid",
  "resulttype",
  "sortby",
  "srsname",
  "startindex",
  "typename",
  "typenames",
]);

// A WCS request names its coverage and subset alongside the operation; the
// WCS form asks for the endpoint and lists the coverages itself.
const WCS_OPERATION_PARAMS = new Set([
  "coverage",
  "coverageid",
  "identifier",
  "identifiers",
  "subset",
  "scalefactor",
  "scalesize",
  "resx",
  "resy",
  "interpolation",
  "rangesubset",
  "mediatype",
]);

/**
 * The URL without its fragment, and without its query unless `keepQuery`: a
 * signed file URL needs its token, a catalog document does not take one.
 */
function withoutQuery(url, keepQuery = false) {
  const plain = new URL(url.href);
  if (!keepQuery) plain.search = "";
  plain.hash = "";
  return plain.href;
}

/** A display name for a file request: its last path segment. */
function fileName(url, fallback) {
  const last = url.pathname.split("/").filter(Boolean).pop();
  if (!last) return fallback;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * The root of the Zarr store a request reads from. A viewer fetches the
 * store's consolidated metadata, its v3 `zarr.json` or array metadata, and
 * then chunk keys, all below one root, which is what GeoLibre opens.
 */
function zarrStoreUrl(url) {
  const root =
    url.pathname.match(/^(.*?\.zarr)(?:\/.*)?$/i)?.[1] ??
    url.pathname.match(/^(.*?)\/(?:\.zmetadata|\.zgroup|\.zattrs|zarr\.json)$/i)?.[1];
  if (root === undefined) return null;
  const store = new URL(url.href);
  store.pathname = root || "/";
  store.search = "";
  store.hash = "";
  return store.href;
}

/**
 * The STAC API root, or the API collection, a request was made against. Only
 * an API whose host or path names it STAC qualifies, so an ordinary OGC API
 * Features server keeps its own form.
 */
function stacApiUrl(url) {
  const segments = url.pathname.split("/");
  const inPath = segments.findIndex((segment) => segment.toLowerCase() === "stac");
  const inHost = /(?:^|\.)stac[.-]|(?:^|\.)stac$/i.test(url.hostname);
  if (inPath < 0 && !inHost) return null;
  const rest = url.pathname.match(
    /^(.*?)\/(?:search|conformance|queryables|collections(?:\/([^/]+)(?:\/(?:items|queryables)(?:\/[^/]*)?)?)?)\/?$/i,
  );
  if (!rest) return null;
  // On a path-named API the root sits at or below the `stac` segment; a
  // `search` in some unrelated route above it is not this API's.
  if (inPath >= 0 && rest[1].split("/").length - 1 < inPath) return null;
  const api = new URL(url.origin);
  api.pathname = rest[2] ? `${rest[1]}/collections/${rest[2]}` : rest[1] || "/";
  return api.href;
}

function serviceEndpoint(url, extraParams) {
  const endpoint = new URL(url.href);
  endpoint.hash = "";
  for (const key of [...endpoint.searchParams.keys()]) {
    const name = key.toLowerCase();
    if (OGC_OPERATION_PARAMS.has(name) || extraParams?.has(name)) {
      endpoint.searchParams.delete(key);
    }
  }
  return endpoint.href;
}

/**
 * The layer a request asked for, under whichever name its service gives the
 * parameter. Carrying it through means the Add Data dialog opens on the layer
 * the page was actually showing instead of an endpoint with an empty layer
 * field, which cannot be submitted.
 */
function requestedLayer(url, ...names) {
  for (const [key, value] of url.searchParams) {
    if (names.includes(key.toLowerCase()) && value.trim()) return value.trim();
  }
  return null;
}

function candidate(url, format, kind, name, canonicalUrl = url.href, layer = null) {
  return { url: canonicalUrl, name, format, kind, styleUrl: null, layer };
}

/** Restore the `{z}/{x}/{y}` braces `URLSearchParams` percent-encodes. */
function withTilePlaceholders(href) {
  return href.replaceAll("%7B", "{").replaceAll("%7D", "}");
}

/**
 * Rewrite a WMTS `GetTile` request into the tile template that produced it, by
 * putting the tile's own coordinates back as placeholders. Returns null for a
 * request that names no tile (a `GetCapabilities`), which has no template.
 */
function wmtsTileTemplate(url) {
  const template = new URL(url.href);
  template.hash = "";
  const coordinates = { tilematrix: "{z}", tilerow: "{y}", tilecol: "{x}" };
  let replaced = 0;
  for (const [key, value] of [...template.searchParams]) {
    const placeholder = coordinates[key.toLowerCase()];
    if (!placeholder) continue;
    // A tile coordinate is a plain number; anything else is already a template.
    if (!/^\d+$/.test(value) && placeholder !== value) return null;
    template.searchParams.set(key, placeholder);
    replaced += 1;
  }
  return replaced === 3 ? withTilePlaceholders(template.href) : null;
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
    return candidate(url, "WMS", "raster", "WMS service", endpoint, requestedLayer(url, "layers"));
  }
  if (service === "wmts" && /^(?:getcapabilities|gettile|getfeatureinfo)$/.test(request ?? "")) {
    // GeoLibre renders a WMTS layer straight from a tile template, so a GetTile
    // request is worth more as a template than as a bare endpoint: it already
    // names the layer, matrix set and format that a capabilities URL would have
    // to be parsed for.
    const template = wmtsTileTemplate(url);
    return candidate(
      url,
      "WMTS",
      "raster",
      "WMTS service",
      template ?? endpoint,
      requestedLayer(url, "layer"),
    );
  }
  if (
    service === "wfs" &&
    /^(?:getcapabilities|getfeature|describefeaturetype)$/.test(request ?? "")
  ) {
    return candidate(
      url,
      "WFS",
      "vector",
      "WFS service",
      serviceEndpoint(url, WFS_OPERATION_PARAMS),
      requestedLayer(url, "typename", "typenames"),
    );
  }

  if (
    service === "wcs" &&
    /^(?:getcapabilities|describecoverage|getcoverage)$/.test(request ?? "")
  ) {
    return candidate(
      url,
      "WCS",
      "raster",
      "WCS service",
      serviceEndpoint(url, WCS_OPERATION_PARAMS),
      requestedLayer(url, "coverageid", "coverage", "identifier"),
    );
  }

  const path = url.pathname;
  // Ahead of the generic tile rule: a cached MapServer tile is addressed
  // `tile/{z}/{y}/{x}`, row before column, so reading it as an XYZ template
  // would swap the axes. GeoLibre's ArcGIS form takes the service root and
  // reads the tiling scheme (or renders dynamically) from it instead. A
  // VectorTileServer is left to the style rule below, which opens it ready to
  // draw through the vector tile form.
  const arcgisService = path.match(/^(.*\/(MapServer|ImageServer))(?:\/.*)?$/i);
  if (arcgisService) {
    const label = arcgisService[2].toLowerCase() === "mapserver" ? "Map" : "Image";
    return candidate(
      url,
      `ArcGIS ${label} Service`,
      "raster",
      `ArcGIS ${label.toLowerCase()} service`,
      url.origin + arcgisService[1],
    );
  }

  // A STAC API is an OGC API Features server underneath, so its item requests
  // would otherwise be offered as plain features. The STAC browser lists the
  // collection's items and their assets, which the features form cannot. Only
  // an API that names itself STAC in its host or path is recognized: nothing
  // else in a URL tells the two apart.
  const stacApi = stacApiUrl(url);
  if (stacApi) return candidate(url, "STAC", "catalog", "STAC catalog", stacApi);
  if (/\/(?:catalog|collection)\.json$/i.test(path)) {
    return candidate(url, "STAC", "catalog", "STAC catalog", withoutQuery(url));
  }

  // A data file fetched by the page's own map library (OpenLayers reads KML and
  // GPX this way, and flatgeobuf streams by range request) is a dataset rather
  // than a service, and opens through the same `?data=` link as a page link.
  const zarrStore = zarrStoreUrl(url);
  if (zarrStore) return candidate(url, "Zarr", "raster", "Zarr store", zarrStore);
  if (/\/tileset\.json$/i.test(path)) {
    return candidate(url, "3D Tiles", "3d", "3D Tiles tileset", withoutQuery(url, true));
  }
  const file = path.match(/\.(fgb|flatgeobuf|gpx|kml|kmz)$/i)?.[1].toLowerCase();
  if (file) {
    const format = { fgb: "FlatGeobuf", flatgeobuf: "FlatGeobuf", gpx: "GPX" }[file] ?? "KML";
    return candidate(url, format, "vector", fileName(url, format), withoutQuery(url, true));
  }

  const arcgis = path.match(/^(.*\/(?:FeatureServer))(?:\/(\d+))?(?:\/query)?\/?$/i);
  if (arcgis) {
    // Keep the layer index the request named. Handed a bare `…/FeatureServer`,
    // GeoLibre resolves to the service's *first* feature layer, which silently
    // draws the wrong layer for a page that was showing any other one.
    const layerId = arcgis[2] ?? null;
    const endpoint = new URL(url.origin + arcgis[1] + (layerId === null ? "" : `/${layerId}`));
    return candidate(
      url,
      "ArcGIS Feature Service",
      "vector",
      "ArcGIS feature service",
      endpoint.href,
      layerId,
    );
  }

  // `/collections/<id>/items` is specific enough to stand on its own, but a
  // bare `/collections` is an ordinary REST and storefront route as well (a
  // shop's collection index sits at exactly that path), so it counts only with
  // an OGC format parameter alongside it. Response bodies are never read, so
  // the URL is all there is to judge by.
  if (
    /\/collections\/[^/]+\/items\/?$/i.test(path) ||
    (/\/collections\/?$/i.test(path) && params.has("f"))
  ) {
    const api = new URL(url.href);
    api.search = "";
    api.hash = "";
    return candidate(url, "OGC API", "vector", "OGC API service", api.href);
  }

  // A MapLibre-style renderer fetches its `.pbf` tiles from a web worker, and a
  // worker's requests are recorded in the worker's own timeline rather than the
  // document's, so the TileJSON the main thread fetched to find them can be the
  // only trace of the tileset. The body is never read, so a TileJSON describing
  // raster tiles is indistinguishable here and is offered as a vector tileset.
  if (/\/tile(?:s?|json)\.json$/i.test(path)) {
    return candidate(url, "Vector tiles", "vector", "Vector tile service");
  }

  const tile = path.match(/^(.*\/)(\d+)\/(\d+)\/(\d+)(\.(?:png|jpe?g|webp|gif|pbf|mvt))(?:\/)?$/i);
  if (tile) {
    const [zoom, column, row] = tile.slice(2, 5).map(Number);
    const dimension = 2 ** zoom;
    if (zoom > 30 || column >= dimension || row >= dimension) return null;
    const template = new URL(url.href);
    template.pathname = `${tile[1]}{z}/{x}/{y}${tile[5]}`;
    const templateUrl = withTilePlaceholders(template.href);
    const vector = /^\.(?:pbf|mvt)$/i.test(tile[5]);
    return candidate(
      url,
      vector ? "Vector tiles" : "XYZ / TMS",
      vector ? "vector" : "raster",
      vector ? "Vector tile service" : "XYZ / TMS service",
      templateUrl,
    );
  }

  // A tileset whose coordinates live in the query string still ends in `.pbf`,
  // so the extension alone is worth keeping — but a style's glyph ranges
  // (`/font/Open Sans Semibold/0-255.pbf`) are served the same way and are not
  // a tile service. Offering one would prefill Add Data with a URL that cannot
  // resolve as a layer.
  if (
    /\.(?:pbf|mvt)$/i.test(path) &&
    !/(?:^|\/)fonts?\//i.test(path) &&
    !/\/\d+-\d+\.pbf$/i.test(path)
  ) {
    return candidate(url, "Vector tiles", "vector", "Vector tile service");
  }
  return null;
}

/**
 * Recognize the style document a vector tileset is rendered through. A tile
 * template alone does not say which source layers it holds, so GeoLibre cannot
 * add the layer from it; the style names them. Pages fetch the style before the
 * tiles it points at, so one seen earlier on a tab explains the tiles that
 * follow from the same origin.
 */
export function classifyStyleRequest(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const path = url.pathname;
  // `…/style.json` and an ArcGIS `…/resources/styles/<name>.json` name themselves
  // as map styles. `…/styles/<name>.json` does not: a theme or configuration
  // endpoint is served at exactly that path. So the generic spelling is trusted
  // to explain a tileset already found at its origin, but never to become a
  // candidate of its own, where it would offer a page's theme file as a layer.
  const named = /\/styles?\.json$/i.test(path) || /\/resources\/styles\/[^/]*\.json$/i.test(path);
  const isStyle = named || /\/styles?\/[^/]+\.json$/i.test(path);
  return isStyle ? { origin: url.origin, url: url.href, named } : null;
}

/** Two entries describe the same thing only if they name the same layer. */
function candidateKey(entry) {
  return `${entry.url}\u0000${entry.layer ?? ""}`;
}

export function mergeServiceCandidates(...groups) {
  const merged = new Map();
  for (const entry of groups.flat()) {
    if (entry?.url && !merged.has(candidateKey(entry))) merged.set(candidateKey(entry), entry);
  }
  return [...merged.values()];
}

/**
 * The Resource Timing buffer holds every request a document made, so a busy
 * page can offer hundreds of tiles that collapse to a handful of services.
 * This bounds what an unusually varied page can put in front of the user.
 */
const MAX_SERVICE_CANDIDATES = 100;

/**
 * Turn the URLs a document has requested into the services GeoLibre can open.
 *
 * Tiles and the style that describes them are separate requests and arrive in
 * no fixed order, so the styles are collected first and paired afterwards: a
 * vector tileset is only addable with the source layers its style names.
 */
export function collectServiceCandidates(urls) {
  const stylesByOrigin = new Map();
  const services = [];
  for (const url of urls) {
    const style = classifyStyleRequest(url);
    // Keep a self-naming style over a generic one from the same origin. A page
    // that fetches its map style and later a theme file at `…/styles/<name>
    // .json` must still offer the map: letting the theme win would both strand
    // a worker-only tileset and hand an existing one the wrong style document.
    if (style && (!stylesByOrigin.get(style.origin)?.named || style.named)) {
      stylesByOrigin.set(style.origin, style);
    }
    const service = classifyServiceRequest(url);
    if (service) services.push(service);
  }
  for (const service of services) {
    if (service.format !== "Vector tiles" || service.styleUrl) continue;
    service.styleUrl = stylesByOrigin.get(new URL(service.url).origin)?.url ?? null;
  }
  const merged = mergeServiceCandidates(services);
  // Same reason as the TileJSON rule above: when a style names its tiles inline
  // there is no metadata request either, and the worker's tile requests are
  // invisible, so an origin that served a style but no tileset is offered
  // through the style itself. GeoLibre resolves a vector layer from a style URL
  // alone, reading the tile template and source layers out of the document.
  const fallbacks = [];
  for (const [origin, style] of stylesByOrigin) {
    if (!style.named) continue;
    const covered = merged.some(
      (entry) => entry.format === "Vector tiles" && new URL(entry.url).origin === origin,
    );
    if (covered) continue;
    fallbacks.push({
      url: style.url,
      name: "Vector tile style",
      format: "Vector tiles",
      kind: "vector",
      styleUrl: style.url,
      layer: null,
    });
  }
  // The cap is taken out of the ordinary services first. A page varied enough to
  // reach it is usually repeating layers of a few endpoints, while a fallback is
  // the only trace its origin leaves at all, so spending every slot before
  // reaching them would drop the one candidate that cannot be recovered.
  const room = Math.max(0, MAX_SERVICE_CANDIDATES - fallbacks.length);
  return [...merged.slice(0, room), ...fallbacks.slice(0, MAX_SERVICE_CANDIDATES)];
}
