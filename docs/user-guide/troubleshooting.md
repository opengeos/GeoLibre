# Troubleshooting

This page collects fixes for common problems when running GeoLibre Web in a browser. Most display glitches after an update come down to a stale browser cache, so start there.

## Stale browser cache

GeoLibre Web is a single-page app that browsers cache aggressively. After a new version ships, an outdated cached copy can leave you with display errors, missing or non-responsive controls, plugins that appear not to load, or stale data. The fix is to clear the cache and reload so the browser fetches the latest build.

Try these in order:

- **Hard refresh** the page to bypass the cache once:
    - **Windows / Linux**: `Ctrl + Shift + R` (Chrome, Edge, Firefox).
    - **macOS Chrome / Edge / Firefox**: `Cmd + Shift + R`.
    - **macOS Safari**: `Cmd + Option + R`.
- **Open the app in a private / incognito window** to confirm the problem is cache related. If it works there, the cache is the cause.
- **Clear the cached files** for the GeoLibre site if a hard refresh is not enough, then reload.

!!! note "Safari users"
    Safari caches web GIS apps aggressively, so it is the most common source of these issues. To empty Safari's cache, choose **Develop → Empty Caches** (`Cmd + Option + E`), or **Safari → Clear History**, then reload the page. If the **Develop** menu is hidden, enable it in **Safari → Settings → Advanced → Show features for web developers**.

A fresh page load against the latest build resolves the large majority of "the app looks broken after updating" reports.

## Plugins do not appear to activate

If a plugin's **Activate** action seems to do nothing, first rule out the stale-cache cause above with a hard refresh or a private window. Once you are on the latest build, an active plugin shows a checkmark next to its entry in the **Plugins** menu, and map controls (when the plugin provides one) appear at the configured corner of the map.

## Desktop-only features in the browser

Some capabilities require the desktop app and are unavailable in the browser build: local filesystem dialogs, local MBTiles, local raster file reads, and project save/open. If one of these is missing, you are likely running GeoLibre Web rather than the desktop app. See [Getting Started](../getting-started.md) for how the web, desktop, and Jupyter builds differ.
