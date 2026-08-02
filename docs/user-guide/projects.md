# Projects

A GeoLibre project captures your whole workspace in a single `.geolibre.json` file: the map view, the basemap, every layer with its source and style, map preferences, plugin state, and environment variables. Everything in this section lives under the **Project** menu.

!!! note "Some entries may be hidden"
    The Project menu is filtered by the active [UI profile](../ui-profiles.md), and a few entries are desktop-only. If an item described below is missing, check the profile in use and whether you are running the browser build.

![The Project menu](https://data.geolibre.app/images/geolibre-project-menu.webp)

## New

**Project → New...** starts a fresh project. GeoLibre offers to save the current project first, then resets the layers, map view, controls, and plugin state to defaults.

## Open

**Project → Open From** has two sources:

- **File...** opens a `.geolibre.json` file from disk (desktop app).
- **URL...** loads a public `.geolibre.json` from an HTTP or HTTPS URL. This works in the browser too and adds the project to your recent list.
- **Gallery...** browses the shared project gallery and opens any entry with one click.

**Project → Open Recent** lists the projects you have opened before, each with its name, path, and the time you last opened it. Click an entry to reopen it, use the small remove button to drop a single entry, or choose **Clear Recent Projects** to empty the list. On the desktop app the recent list persists across sessions; in the browser it tracks URL-based projects.

!!! note "Loading a project at startup"
    You can open a project directly by passing its URL with the `url` query parameter, for example `?url=https://share.geolibre.app/you/project.geolibre.json`. See [Embedding & Sharing](embedding.md).

## Save and Save As

- **Save** writes back to the project's existing file path.
- **Save As...** prompts for a new name and location.

Both capture the current map view, basemap, layers, styles, preferences, and plugin state at the moment you save. Projects that were opened from a URL have no writable local path, so both Save and Save As fall back to the save dialog. Saving requires the desktop app.

**Project → Duplicate project** copies the open project into a new, unsaved one, so you can branch off an experiment without touching the original file.

## Project history and crash recovery

GeoLibre autosaves the project as you work. Three seconds after a change settles — a layer added, a style edited, the camera moved — it writes a snapshot to your browser's local IndexedDB storage. Autosaves never touch your `.geolibre.json` file; only **Save** does that.

**Project → History...** lists the snapshots for the current project, newest first, each summarized by its layer count and zoom level. **Restore** loads a snapshot back into the workspace, as an undoable step so you can back out of it. There is no manual delete here — snapshots age out on their own once a cap is hit.

The store is capped, so history stays bounded: at most 20 snapshots per project, 10 MB per snapshot, and 50 MB in total. The oldest snapshots are dropped once a cap is hit, and a project too large to fit in a single snapshot is not autosaved.

!!! note "Crash recovery is a standalone-browser feature"
    In the browser build, and outside an embedded (iframe) session, GeoLibre marks the session open while you work. If the tab or browser goes away without closing cleanly and a newer autosave exists than your last explicit save, the next launch offers **Recover unsaved work?** with the option to restore or discard it. The desktop app and embedded deployments keep the history list but do not show this prompt.

Snapshots are stored per project — keyed by file path, or by name for a project you have not saved yet — and live only on the device that made them. They are not uploaded, not shared, and not part of the `.geolibre.json` file.

## Importing a QGIS project

**Project → Import → Import QGIS Project…** reads a QGIS `.qgs` or `.qgz` project and rebuilds it as a GeoLibre project: its layers, layer groups (including nested ones), group visibility, layer order, styling, and the saved map view.

The importer targets file-based vector layers plus rasters the app can open, and it reports what it could not bring across rather than failing the whole import — you get the project plus a per-layer list of skipped layers and the reason (an unsupported data provider, an unsupported file format, a missing source, a network share path, or a remote source). In the browser build, layers that reference a local path on disk are listed as skipped because a browser cannot reopen those paths; open the same project in GeoLibre Desktop to load them.

## Importing an ArcGIS Pro project

**Project → Import → Import ArcGIS Pro Project…** reads an ArcGIS Pro `.aprx` project or standalone `.mapx` map. GeoLibre reads the CIM JSON stored in the file directly, so ArcGIS Pro and ArcPy do not need to be installed.

An ArcGIS Pro project can contain several maps; GeoLibre imports its first 2D map. The importer preserves the saved extent, file-based feature layers, nested groups, visibility, simple symbols, and field-based labels. Shapefiles and the other vector formats supported by GeoLibre can be reopened by the desktop app. Unsupported sources such as file geodatabases, service layers, rasters, scenes, and network-share paths are listed after the rest of the project is imported. Local data paths cannot be reopened by the browser build.

## Templates

**Project → Save as template...** stores the current project as a reusable template in your personal library, with a name and an optional description. Enable **Strip data layers** to keep the basemap, layer groups, styles, legend, widgets, and layout while dropping the data layer content — useful for a house-style starting point that a team applies to new maps.

## Share

**Project → Share...** uploads the current project to `share.geolibre.app` and returns a public URL you can send to anyone or open in the live viewer. Sharing uses a personal API token, which you set once as the **Share.GeoLibre API token** in **Settings → Environment Variables**. The shared file is the same `.geolibre.json` the app saves locally, so anyone who opens the link sees the same layers, styles, and map view. See the [Sharing & Embedding tutorial](../tutorials/sharing-embedding.md).

## Export as HTML

**Project → Export as HTML...** writes the whole project to a single standalone HTML file that runs offline with no server. Host it anywhere, or open it straight from disk.

## Collaborate

**Project → Collaborate...** starts or joins a live session in which several people edit the same project at once, with presence cursors, chat, and per-participant permissions. The feature is off unless the build configures a relay URL — see [Collaboration](../collaboration.md).

## Offline basemap

**Project → Offline Basemap...** pre-caches the current map view's basemap tiles so the map still draws when the device is offline. See [Troubleshooting](troubleshooting.md) if tiles are missing after a download.

## Print

**Project → Print Layout...** opens the layout composer, which exports the current map to PNG or PDF. It carries a title block with an editable title and footer, a user-editable legend, an explicit map-scale input, page-size controls, a custom print extent, attribute-table and chart blocks, Atlas / map series generation (one page per feature, or a uniform series along a line), and Copy to Clipboard. The composer is backed by the MapLibre components plugin.

## Story maps

**Project → Story Map...** opens the scroll-driven story builder. See [Story Maps](storymaps.md).

## The project format

For the full schema of `.geolibre.json`, including how layers, styles, and plugin state are serialized, see [Reference → Project Format](../project-format.md).
