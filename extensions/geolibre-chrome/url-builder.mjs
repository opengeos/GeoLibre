export const GEOLIBRE_WEB_URL = "https://web.geolibre.app/";

/** Build the repeated data/style deep link consumed by GeoLibre. */
export function buildGeoLibreUrl(datasets, baseUrl = GEOLIBRE_WEB_URL) {
  if (!Array.isArray(datasets) || datasets.length === 0) {
    throw new Error("Select at least one dataset.");
  }
  const target = new URL(baseUrl);
  target.search = "";
  const serviceKinds = {
    "XYZ / TMS": "xyz",
    WMS: "wms",
    WMTS: "wmts",
    WFS: "wfs",
    "OGC API": "ogc-features",
    "ArcGIS Feature Service": "arcgis",
    "Vector tiles": "ogc-vector-tiles",
  };
  const services = datasets.filter((dataset) => serviceKinds[dataset.format]);
  if (services.length) {
    if (services.length > 1) throw new Error("Open one map service at a time.");
    // Nothing stops a selection holding a service and a file at once, and the
    // two open through different GeoLibre entry points.
    if (datasets.length !== 1) {
      throw new Error("A map service cannot be opened together with other data.");
    }
    const service = services[0];
    const serviceUrl = new URL(service.url);
    if (serviceUrl.protocol !== "http:" && serviceUrl.protocol !== "https:") {
      throw new Error("GeoLibre can only open HTTP or HTTPS service links.");
    }
    target.searchParams.set("add", serviceKinds[service.format]);
    target.searchParams.set("serviceUrl", service.url);
    // The layer and style the page was rendering: without them the dialog opens
    // on an endpoint whose layer field is empty and cannot be submitted.
    if (service.layer) target.searchParams.set("serviceLayer", service.layer);
    if (service.styleUrl) {
      const styleUrl = new URL(service.styleUrl);
      if (styleUrl.protocol !== "http:" && styleUrl.protocol !== "https:") {
        throw new Error("GeoLibre can only open HTTP or HTTPS style links.");
      }
      target.searchParams.set("serviceStyle", styleUrl.href);
    }
    return target.href;
  }
  const entries = datasets.map((dataset) => {
    const dataUrl = new URL(dataset.url);
    if (dataUrl.protocol !== "http:" && dataUrl.protocol !== "https:") {
      throw new Error("GeoLibre can only open HTTP or HTTPS dataset links.");
    }
    const styleUrl = dataset.styleUrl ? new URL(dataset.styleUrl) : null;
    if (styleUrl && styleUrl.protocol !== "http:" && styleUrl.protocol !== "https:") {
      throw new Error("GeoLibre can only open HTTP or HTTPS style links.");
    }
    return { dataUrl, styleUrl };
  });
  for (const entry of entries) target.searchParams.append("data", entry.dataUrl.href);
  if (entries.some((entry) => entry.styleUrl)) {
    for (const entry of entries) target.searchParams.append("style", entry.styleUrl?.href ?? "");
  }
  return target.href;
}
