import { GEOLIBRE_WEB_URL } from "./url-builder.mjs";

const STORAGE_KEY = "baseUrl";

/** Trim and add the trailing slash `buildGeoLibreUrl` expects on a base URL. */
export function normalizeBaseUrl(raw) {
  const trimmed = raw.trim();
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

/** Parse a candidate base URL, accepting only http(s), or throw. */
export function parseBaseUrl(raw) {
  let url;
  try {
    url = new URL(normalizeBaseUrl(raw));
  } catch {
    throw new Error("Enter a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The URL must start with http:// or https://.");
  }
  return url.href;
}

/** The configured base URL, or the default when none is stored. */
export async function loadBaseUrl() {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  return stored[STORAGE_KEY] || GEOLIBRE_WEB_URL;
}

/** Persist a validated base URL. */
export async function saveBaseUrl(raw) {
  const href = parseBaseUrl(raw);
  await chrome.storage.sync.set({ [STORAGE_KEY]: href });
  return href;
}

/** Remove the stored base URL, reverting to the default. */
export async function resetBaseUrl() {
  await chrome.storage.sync.remove(STORAGE_KEY);
}
