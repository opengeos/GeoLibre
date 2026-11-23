/**
 * The add-on id Firefox files the extension under. It must never change once
 * published: AMO, `storage.sync` and every installed copy key off it.
 */
export const FIREFOX_ADDON_ID = "open-data@geolibre.app";

/**
 * Firefox 140 (an ESR) is the first release to read
 * `data_collection_permissions`, which AMO requires of every new add-on.
 */
export const FIREFOX_MIN_VERSION = "140.0";

/** The browsers the extension is packaged for. */
export const EXTENSION_TARGETS = ["chrome", "firefox"];

/**
 * Derive the manifest for one browser from the checked-in Chrome manifest.
 *
 * The extension's code is the same on both: Firefox implements the `chrome.*`
 * namespace, `scripting.executeScript` and `activeTab` for Manifest V3, and the
 * extension has no background script whose form differs between the two. What
 * differs is only manifest metadata: Firefox needs a stable add-on id for
 * `storage.sync` and AMO, and a declaration that nothing is collected, while
 * the Chrome-only `minimum_chrome_version` key would only draw a warning.
 *
 * @param {object} manifest The Chrome manifest (`manifest.json`).
 * @param {"chrome" | "firefox"} target The browser to build for.
 * @returns {object} A new manifest object for that browser.
 */
export function manifestForTarget(manifest, target) {
  if (!EXTENSION_TARGETS.includes(target)) {
    throw new Error(`Unknown extension target "${target}".`);
  }
  const copy = structuredClone(manifest);
  if (target === "chrome") return copy;
  delete copy.minimum_chrome_version;
  copy.browser_specific_settings = {
    gecko: {
      id: FIREFOX_ADDON_ID,
      strict_min_version: FIREFOX_MIN_VERSION,
      data_collection_permissions: { required: ["none"] },
    },
  };
  return copy;
}
