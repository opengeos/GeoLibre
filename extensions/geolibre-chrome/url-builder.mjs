export const GEOLIBRE_WEB_URL = "https://web.geolibre.app/";

/**
 * The Add Data dialog each detected service opens, as GeoLibre's `add` query
 * parameter names it. A Zarr store is a file format, but it opens through the
 * dialog too: a variable and value range must be picked before it can draw.
 */
const SERVICE_KINDS = {
  "XYZ / TMS": "xyz",
  WMS: "wms",
  WMTS: "wmts",
  WFS: "wfs",
  WCS: "wcs",
  "OGC API": "ogc-features",
  "ArcGIS Feature Service": "arcgis",
  "ArcGIS Map Service": "arcgis",
  "ArcGIS Image Service": "arcgis",
  "Vector tiles": "ogc-vector-tiles",
  Zarr: "zarr",
};

function httpUrl(raw, what) {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`GeoLibre can only open HTTP or HTTPS ${what} links.`);
  }
  return url;
}

function baseTarget(baseUrl) {
  const target = new URL(baseUrl);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("The GeoLibre base URL must start with http:// or https://.");
  }
  target.search = "";
  target.hash = "";
  return target;
}

/** Whether a selected entry opens through an Add Data dialog rather than `?data=`. */
export function isServiceEntry(dataset) {
  return Object.hasOwn(SERVICE_KINDS, dataset.format ?? "");
}

/** Whether a selected entry opens through GeoLibre's STAC browser (`?stac=`). */
export function isStacEntry(dataset) {
  return dataset.format === "STAC";
}

/** Write one service's `add`/`serviceUrl`/`serviceLayer`/`serviceStyle` parameters. */
function appendService(target, service) {
  httpUrl(service.url, "service");
  target.searchParams.set("add", SERVICE_KINDS[service.format]);
  // A tileset known only through its style has the style as its own URL, and
  // GeoLibre reads the tiles out of that document: handing the same URL over
  // as the service URL as well would have it parsed as TileJSON and fail.
  if (service.url !== service.styleUrl) target.searchParams.set("serviceUrl", service.url);
  // The layer and style the page was rendering: without them the dialog opens
  // on an endpoint whose layer field is empty and cannot be submitted.
  if (service.layer) target.searchParams.set("serviceLayer", service.layer);
  if (service.styleUrl) {
    target.searchParams.set("serviceStyle", httpUrl(service.styleUrl, "style").href);
  }
}

/** Write the repeated, position-paired `data`/`style`/`dataType` parameters. */
function appendData(target, datasets) {
  const entries = datasets.map((dataset) => ({
    dataUrl: httpUrl(dataset.url, "dataset"),
    styleUrl: dataset.styleUrl ? httpUrl(dataset.styleUrl, "style") : null,
    dataType: dataset.dataType ?? null,
  }));
  for (const entry of entries) target.searchParams.append("data", entry.dataUrl.href);
  if (entries.some((entry) => entry.styleUrl)) {
    for (const entry of entries) target.searchParams.append("style", entry.styleUrl?.href ?? "");
  }
  // Paired by position like `style`: a point cloud behind an extensionless
  // endpoint is opened as one only when its slot says `lidar`.
  if (entries.some((entry) => entry.dataType)) {
    for (const entry of entries) target.searchParams.append("dataType", entry.dataType ?? "");
  }
}

/**
 * Compatibility helper returning the first launch from a selection.
 */
export function buildGeoLibreUrl(datasets, baseUrl = GEOLIBRE_WEB_URL) {
  return buildGeoLibreUrls(datasets, baseUrl)[0];
}

/**
 * Build the GeoLibre links that open a whole selection, as few as possible.
 *
 * GeoLibre loads any number of `data` files in one launch, and alongside them
 * opens one Add Data dialog (`add`) and one STAC catalog (`stac`), each an
 * interactive step with a form of its own. So the first link carries every
 * file plus the first service and the first catalog, and each further service
 * or catalog gets a link of its own, opened in its own tab.
 *
 * @param {Array<object>} datasets The selected datasets and services.
 * @param {string} [baseUrl] The GeoLibre web app to open them in.
 * @returns {string[]} One or more GeoLibre URLs, the combined one first.
 */
export function buildGeoLibreUrls(datasets, baseUrl = GEOLIBRE_WEB_URL) {
  if (!Array.isArray(datasets) || datasets.length === 0) {
    throw new Error("Select at least one dataset.");
  }
  const services = datasets.filter(isServiceEntry);
  const catalogs = datasets.filter(isStacEntry);
  const files = datasets.filter((dataset) => !isServiceEntry(dataset) && !isStacEntry(dataset));
  const first = baseTarget(baseUrl);
  if (files.length) appendData(first, files);
  if (services.length) appendService(first, services[0]);
  if (catalogs.length) first.searchParams.set("stac", httpUrl(catalogs[0].url, "STAC").href);
  const urls = [first.href];
  for (const service of services.slice(1)) {
    const target = baseTarget(baseUrl);
    appendService(target, service);
    urls.push(target.href);
  }
  for (const catalog of catalogs.slice(1)) {
    const target = baseTarget(baseUrl);
    target.searchParams.set("stac", httpUrl(catalog.url, "STAC").href);
    urls.push(target.href);
  }
  return urls;
}
