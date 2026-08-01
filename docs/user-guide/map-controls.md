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

The **Print Layout** composer lives under the [Project menu](projects.md#print).

!!! note "Control position"
    Plugin-backed controls can be positioned in any map corner. For plugins that support it, set the corner from the [Plugins menu](plugins.md) (top left, top right, bottom left, or bottom right).

## Camera, overlay, and recording tools

The Controls menu also carries tools that move the camera, drape live data over the map, or capture what you see:

| Tool | Description |
| --- | --- |
| **Sun** | Simulate the sun's position and the day/night terminator for any date and time. |
| **Weather** | Overlay near-realtime **Clouds** (NASA satellite imagery, animated day by day) and **Precipitation** (RainViewer radar, animated over roughly the last two hours). |
| **Gridlines** | Draw a coordinate grid with edge labels, including a UTM easting/northing mode. |
| **Spinning Globe** | Slowly rotate the globe, optionally bounded to a region. |
| **Route Animation** | Animate a marker along a line layer with play/pause, speed, a trail, and camera follow. |
| **Flight Simulator** | Fly over terrain and 3D layers with continuous keyboard controls. |
| **Atmospheric Effects** | Render a deep-space backdrop, starfield, comets, and an atmospheric halo at low zoom. |
| **Directions** | Click the map to add waypoints and get a route. Waypoints are sent to the public OSRM demo server. |
| **Reverse Geocode** | Click the map to look up an address at those coordinates through the configured [geocoding provider](data-integrations.md#geocoding). |
| **Record Map Tour...** | Capture an animated keyframe tour to video, with per-keyframe recapture, hold and transition durations, and a saveable tour setup. |
| **Record Video...** | Record the map canvas, or a drawn bounding box, to a video file, optionally burning in on-map HTML, legend, and colorbar panels. |

!!! warning "Some tools call external services"
    Directions and Reverse Geocode send your coordinates to a third-party service — the OSRM demo server and your configured geocoding provider. Weather fetches overlay imagery from NASA and RainViewer. The rest of the table runs locally against tiles the map already fetches.

## Annotations and the Elements panel

The annotation tools draw on top of the map: **Text**, **Arrow**, **Rectangle highlight**, **Ellipse highlight**, **Freehand highlight**, **Pin marker**, **Sticky note**, and **Placed image**. Each has a color and a line width, and you can delete the last annotation or clear them all.

Annotations are saved with the project, and the **Elements** panel lists them so you can find and manage each one instead of hunting for it on the canvas. An element is anchored one of two ways: **At Point** pins it to a geographic coordinate so it moves with the map, or **Pinned to Extent** stretches it across a bounding box so it scales with the view.

## Review comments

Comments are anchored notes for review and feedback, kept separate from annotations because they are a conversation rather than map decoration.

- Activate the comment tool from the **Comments** panel on the right sidebar, then click the map to drop a pin and write the note. GeoLibre asks for your name once and remembers it.
- Each pin opens a thread you can reply to, resolve, reopen, or delete.
- Filter the panel by **Open**, **Resolved**, or **All**. Resolved pins are hidden from the map while the Open filter is active.
- In a live [collaboration](../collaboration.md) session, adding, replying, resolving, and deleting all sync to the other participants.

Comments are stored in the `.geolibre.json` file, so they travel with a shared or saved project even when no session is running.

## GPS tracking

**Controls → GPS Tracking...** follows a live position on the map, records a track log, and can digitize new features straight from the feed. Pick one of two entries under **Position source**:

- **This device** — the browser or OS geolocation API. This is the default and needs no extra hardware.
- **NMEA receiver (serial or Bluetooth)** — an external GPS/GNSS receiver, for survey-grade or high-rate positions. Choose a baud rate and use **Connect serial** or **Connect Bluetooth**; the dialog then reports the device name and a running count of parsed sentences and fixes.

!!! note "NMEA needs a Chromium browser"
    Reading a receiver uses the Web Serial and Web Bluetooth APIs, which Chromium browsers such as Chrome and Edge provide but Firefox and Safari do not. Most Bluetooth GPS receivers speak *classic* Bluetooth rather than Bluetooth Low Energy: pair those in your operating system's settings and they appear here as a serial port. Use **Connect Bluetooth** only for Bluetooth Low Energy receivers.

**Controls → Field Collection...** is the related tool for capturing observations against a custom form. See [Features](../features.md#field-data-collection).

## Map navigation basics

- **Pan**: drag the map, or use the arrow keys while the map has focus.
- **Zoom**: scroll wheel, pinch, the navigation control, or the `+` / `-` keys.
- **Rotate**: hold the right mouse button and drag, use the compass, or `Shift` + `←` / `→`.
- **Tilt**: hold `Ctrl`/`Cmd` and drag to tilt the map into a perspective view, or `Shift` + `↑` / `↓`.
- **Reset the view**: press `N` for north up, `U` for a top-down view, or `R` to reset both pitch and bearing. See [the interface guide](interface.md#command-palette-and-keyboard-shortcuts) for the full shortcut list.
