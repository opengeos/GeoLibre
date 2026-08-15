export const GEOLIBRE_WEB_URL = "https://web.geolibre.app/";

/** Build the repeated data/style deep link consumed by GeoLibre. */
export function buildGeoLibreUrl(datasets, baseUrl = GEOLIBRE_WEB_URL) {
  if (!Array.isArray(datasets) || datasets.length === 0) {
    throw new Error("Select at least one dataset.");
  }
  const target = new URL(baseUrl);
  target.search = "";
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
