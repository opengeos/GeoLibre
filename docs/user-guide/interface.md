# Interface Overview

GeoLibre opens to a single workspace that is the same on desktop and in the browser. This page is a tour of that workspace so the rest of the User Guide can refer to its parts by name.

![GeoLibre interface overview](https://data.geolibre.app/images/geolibre-interface-overview.webp)

## The top toolbar

The toolbar across the top of the window groups every action into seven menus:

| Menu | What it does |
| --- | --- |
| **Project** | Create, open, save, share, and print projects. See [Projects](projects.md). |
| **Add Data** | Add layers from files, web services, cloud formats, 3D data, and databases. See [Adding Data](adding-data.md). |
| **Processing** | Run vector, raster, conversion, Whitebox, and SQL tools, plus the [AI Assistant](ai-assistant.md). See [Processing Tools](processing.md) and [SQL Workspace](sql-workspace.md). |
| **Controls** | Toggle map controls and component panels (Measure, Bookmark, Minimap, and more). See [Map Controls & Tools](map-controls.md). |
| **Plugins** | Activate built-in plugins and set their on-map position. See [Plugins & Marketplace](plugins.md). |
| **Settings** | Map preferences, layout, environment variables, project settings, and Manage Plugins. See [Settings & Preferences](settings.md). |
| **Help** | The command palette, keyboard shortcuts, diagnostics, feedback, update checks, and the About dialog. |

On the right side of the toolbar are the light/dark theme toggle and the editable project name.

!!! tip "Toolbar labels"
    On narrow windows the toolbar collapses to icon-only buttons. You can also force icon-only buttons from **Settings → Layout**, or with the `toolbar=icons` URL parameter. See [Embedding & Sharing](embedding.md).

## Command palette and keyboard shortcuts

Every menu and toolbar action is also reachable from the keyboard, so you don't have to hunt through nested menus.

- **Command palette** — press `Ctrl`/`Cmd` + `K` (or **Help → Command Palette**, or **Settings → Command Palette**) to open a searchable list of actions: Add Data sources, Processing tools, Controls, Plugins, and more. Type to filter, move the highlight with the arrow keys, and press `Enter` to run the highlighted command.
- **Keyboard shortcuts cheat sheet** — press `?` (or **Help → Keyboard Shortcuts**, or **Settings → Keyboard Shortcuts**) to see the full list of global shortcuts.

The built-in global shortcuts are:

| Shortcut | Action |
| --- | --- |
| `Ctrl`/`Cmd` + `K` | Open the command palette |
| `?` | Show the keyboard shortcuts |
| `Ctrl`/`Cmd` + `N` | New project |
| `Ctrl`/`Cmd` + `O` | Open project from file |
| `Ctrl`/`Cmd` + `S` | Save project |
| `Ctrl`/`Cmd` + `Shift` + `S` | Save project as… |
| `N` | Reset bearing (north up) |
| `U` | Reset pitch (top-down view) |
| `R` | Reset pitch and bearing |
| `[` | Previous view |
| `]` | Next view |

The single-key view shortcuts mirror Google Earth Pro (`N` for north up, `U` for top-down, `R` to reset the view) and work anywhere in the app.

While the map has keyboard focus, MapLibre's own navigation keys are also available:

| Key | Action |
| --- | --- |
| `+` / `-` | Zoom in / out |
| Arrow keys | Pan |
| `Shift` + `←` / `→` | Rotate |
| `Shift` + `↑` / `↓` | Tilt |

Shortcuts are ignored while you are typing in a text field, so they never interfere with search boxes or attribute editing. On macOS the `Cmd` key is used; on Windows and Linux the `Ctrl` key is used.

## The three panels

GeoLibre has three dockable panels around the map:

- **Layers panel** (left): the layer stack, including the basemap. Toggle visibility, change opacity, reorder layers, zoom to a layer, identify features, and open per-layer actions. See [Managing Layers](layers.md).
- **Style panel** (right): the styling controls for the selected layer, including data-driven styling for vector layers and image adjustments for rasters. See [Styling Layers](styling.md).
- **Attribute table** (bottom): the attributes of the selected vector or DuckDB layer. Expand it from the status bar. See [Attribute Table](attribute-table.md).

Each panel can be shown or hidden from **Settings → Layout**, and panels auto-hide on small screens. You can resize the Layers and Style panels by dragging their inner edge.

## The map

The map fills the center of the workspace. It uses MapLibre GL JS for vector and raster rendering, with deck.gl for point clouds, 3D tiles, and other advanced overlays. Pan by dragging, zoom with the scroll wheel or the on-map zoom buttons, **rotate** by holding the right mouse button and dragging, **tilt** by holding `Ctrl`/`Cmd` and dragging, and reset north with the compass button.

On-map controls such as zoom, globe, fullscreen, and the Layer Control appear in the corners. Which controls are shown is set from the [Controls menu](map-controls.md).

## The status bar

The status bar along the bottom shows the live cursor coordinates, zoom, bearing, and pitch, a button to expand the [Attribute Table](attribute-table.md), and a **Diagnostics** button (also under **Help**) that surfaces any runtime errors.

## Theme

Use the sun/moon button on the toolbar to switch between light and dark themes. The theme also follows your operating system preference by default, and you can set it for embeds with the `theme=dark` or `theme=light` URL parameter. See [Embedding & Sharing](embedding.md).

## Desktop and browser

The same UI runs as an installed desktop app (built with Tauri) and as a web app in the browser. The browser build covers most workflows, but features that need the local filesystem (file dialogs, local MBTiles and raster reads, project save/open, and the Python sidecar tools) require the desktop app. Each affected page notes these differences. See [Getting Started](../getting-started.md) for installation and [Downloads](../downloads.md) for installers.
