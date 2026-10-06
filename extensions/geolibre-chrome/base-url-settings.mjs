import { GEOLIBRE_WEB_URL } from "./url-builder.mjs";

const STORAGE_KEY = "baseUrl";

/**
 * Parse a base URL and put it in the shape `buildGeoLibreUrl` expects: no query
 * string or fragment (the deep link replaces both anyway), and a pathname with
 * a trailing slash so a subpath instance keeps its subpath. Throws on input the
 * URL constructor rejects.
 */
export function normalizeBaseUrl(raw) {
  const url = new URL(raw.trim());
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url.href;
}

/** Parse a candidate base URL, accepting only http(s), or throw. */
export function parseBaseUrl(raw) {
  let href;
  try {
    href = normalizeBaseUrl(raw);
  } catch {
    throw new Error("Enter a valid URL.");
  }
  const { protocol } = new URL(href);
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error("The URL must start with http:// or https://.");
  }
  return href;
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
