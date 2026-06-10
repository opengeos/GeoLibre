# Projects

A GeoLibre project captures your whole workspace in a single `.geolibre.json` file: the map view, the basemap, every layer with its source and style, map preferences, plugin state, and environment variables. Everything in this section lives under the **Project** menu.

![The Project menu](https://data.geolibre.app/images/geolibre-project-menu.webp)

## New

**Project → New...** starts a fresh project. GeoLibre offers to save the current project first, then resets the layers, map view, controls, and plugin state to defaults.

## Open

**Project → Open From** has two sources:

- **File...** opens a `.geolibre.json` file from disk (desktop app).
- **URL...** loads a public `.geolibre.json` from an HTTP or HTTPS URL. This works in the browser too and adds the project to your recent list.

**Project → Open Recent** lists the projects you have opened before, each with its name, path, and the time you last opened it. Click an entry to reopen it, use the small remove button to drop a single entry, or choose **Clear Recent Projects** to empty the list. On the desktop app the recent list persists across sessions; in the browser it tracks URL-based projects.

!!! note "Loading a project at startup"
    You can open a project directly by passing its URL with the `url` query parameter, for example `?url=https://share.geolibre.app/you/project.geolibre.json`. See [Embedding & Sharing](embedding.md).

## Save and Save As

- **Save** writes back to the project's existing file path.
- **Save As...** prompts for a new name and location.

Both capture the current map view, basemap, layers, styles, preferences, and plugin state at the moment you save. Projects that were opened from a URL have no writable local path, so both Save and Save As fall back to the save dialog. Saving requires the desktop app.

## Share

**Project → Share...** uploads the current project to `share.geolibre.app` and returns a public URL you can send to anyone or open in the live viewer. Sharing uses a personal API token, which you set once as the **Share.GeoLibre API token** in **Settings → Environment Variables**. The shared file is the same `.geolibre.json` the app saves locally, so anyone who opens the link sees the same layers, styles, and map view. See the [Sharing & Embedding tutorial](../tutorials/sharing-embedding.md).

## Print

**Project → Print...** opens the Print panel, which exports the current map to a PDF or image. Choose the page size and orientation, then export. The Print panel is backed by the MapLibre components plugin.

## The project format

For the full schema of `.geolibre.json`, including how layers, styles, and plugin state are serialized, see [Reference → Project Format](../project-format.md).
