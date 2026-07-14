# Map Controls & Tools

The **Controls** menu toggles two kinds of on-map helpers: the built-in MapLibre map controls, and the component panels that add tools like Measure and Bookmark. A check mark next to an item means it is currently shown.

![Controls menu](https://data.geolibre.app/images/geolibre-controls-menu.webp)

## Map controls

These are the standard MapLibre controls that sit in the map corners:

| Control | Description |
| --- | --- |
| **Navigation** | Zoom in/out and a compass to reset bearing. |
| **Fullscreen** | Expand the map to fill the screen. |
| **Geolocate** | Center the map on your current location. |
| **Globe** | Switch between the flat map and a 3D globe projection. |
| **Terrain** | Toggle terrain (3D elevation) rendering. |
| **Scale** | Show a scale bar. |
| **Attribution** | Show data attributions. |
| **MapLibre logo** | Show or hide the MapLibre logo. |

## Component tools

These are interactive panels provided by the MapLibre components plugin:

| Tool | Description |
| --- | --- |
| **Search** | Search for places by name and fly to the result. |
| **Colorbar** | Display a continuous color scale for raster values. |
| **Legend** | Show a legend describing the layers on the map. |
| **HTML** | Display custom HTML content in an on-map panel. |
| **Measure** | Measure distances and areas interactively. |
| **Bookmark** | Save named map views and jump back to them. |
| **Minimap** | Show an overview map of the current extent. |
| **View State** | Read and edit the exact center, zoom, bearing, and pitch. |

The **Print** tool lives under the [Project menu](projects.md#print).

!!! note "Control position"
    Plugin-backed controls can be positioned in any map corner. For plugins that support it, set the corner from the [Plugins menu](plugins.md) (top left, top right, bottom left, or bottom right).

## Map navigation basics

- **Pan**: drag the map, or use the arrow keys while the map has focus.
- **Zoom**: scroll wheel, pinch, the navigation control, or the `+` / `-` keys.
- **Rotate**: hold the right mouse button and drag, use the compass, or `Shift` + `←` / `→`.
- **Tilt**: hold `Ctrl`/`Cmd` and drag to tilt the map into a perspective view, or `Shift` + `↑` / `↓`.
- **Reset the view**: press `N` for north up, `U` for a top-down view, or `R` to reset both pitch and bearing. See [the interface guide](interface.md#command-palette-and-keyboard-shortcuts) for the full shortcut list.
