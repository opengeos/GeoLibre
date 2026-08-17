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

  const path = url.pathname;
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
  const isStyle =
    /\/style(?:s)?\.json$/i.test(path) ||
    /\/styles?\/[^/]+\.json$/i.test(path) ||
    /\/resources\/styles\/[^/]*\.json$/i.test(path);
  return isStyle ? { origin: url.origin, url: url.href } : null;
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

const MAX_TRACKED_DOCUMENTS = 200;

function remember(documents, documentId) {
  documents.add(documentId);
  // A long-lived single-page app can churn through frames without ever
  // navigating the tab, so keep the oldest ids from accumulating forever.
  if (documents.size > MAX_TRACKED_DOCUMENTS) {
    documents.delete(documents.values().next().value);
  }
}

/**
 * Track which documents belong to a tab's *current* page, so a request left in
 * flight by the page before it cannot be filed under the page after it.
 *
 * Chrome does not put a `documentId` on a navigation request: a `main_frame` or
 * `sub_frame` event describes a document that does not exist yet, and the id is
 * only ever seen afterwards, on the requests that document itself makes. A
 * page's documents therefore cannot be enumerated when it loads. What *can* be
 * known is which documents belonged to the pages before it, so each navigation
 * retires the ids seen so far and every later request is accepted unless its
 * document was retired. A request with no id at all is a navigation of the tab
 * being watched (a service URL opened directly) and belongs to the new page.
 */
export function createPageScope() {
  const tabs = new Map();

  const stateFor = (tabId) => {
    let state = tabs.get(tabId);
    if (!state) {
      state = {
        generation: 0,
        seen: new Set(),
        leaving: new Set(),
        retired: new Set(),
        navigating: false,
      };
      tabs.set(tabId, state);
    }
    return state;
  };

  return {
    /**
     * A navigation has started. Everything seen so far belongs to the page
     * being left, so mark it for retirement now rather than when the navigation
     * completes: a small tile or service request made by the *incoming* page
     * can finish before its own HTML does, and retiring at completion would
     * sweep up that new document along with the old ones.
     */
    beginPage(tabId) {
      const state = stateFor(tabId);
      for (const documentId of state.seen) remember(state.leaving, documentId);
      state.seen = new Set();
      state.navigating = true;
    },
    /** Retire the outgoing page's documents and open a new generation. */
    startPage(tabId) {
      const state = stateFor(tabId);
      // Without an observed navigation start there is no separate set to
      // retire, so fall back to retiring everything seen.
      const outgoing = state.navigating ? state.leaving : state.seen;
      for (const documentId of outgoing) remember(state.retired, documentId);
      state.leaving = new Set();
      if (!state.navigating) state.seen = new Set();
      state.navigating = false;
      state.generation += 1;
      return state.generation;
    },
    /** The current page's generation, for re-checking a queued write. */
    generation(tabId) {
      return stateFor(tabId).generation;
    },
    accepts(tabId, documentId) {
      const state = stateFor(tabId);
      if (!documentId) return true;
      if (state.retired.has(documentId)) return false;
      // A request from the outgoing page can still complete while its
      // replacement loads. It belongs to the page on screen, so it is accepted,
      // but its document stays marked for retirement: moving it back among the
      // incoming page's documents would let it outlive the navigation.
      if (!state.leaving.has(documentId)) remember(state.seen, documentId);
      return true;
    },
    forget(tabId) {
      tabs.delete(tabId);
    },
  };
}
