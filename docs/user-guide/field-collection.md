# GPS Tracking & Field Collection

GeoLibre has two tools for work in the field, both on the **Controls** menu:

- **GPS Tracking...** streams a live position onto the map, records a track
  log, and captures points where you stand.
- **Field Collection...** captures point, line, or polygon observations against
  a form you define, with optional photos.

Both write ordinary GeoJSON layers, so everything they capture is saved with the
project, shows up in the [attribute table](attribute-table.md), and exports
through the usual **Layer actions → Export** formats. Neither has a server sync
or upload step: captures live in the project until you save or export it.

## GPS Tracking

**Controls → GPS Tracking...** opens the **GPS Tracking** dialog.

### Position source

Pick one entry under **Position source**:

- **This device** uses the browser or operating system's location service with
  high accuracy requested. In the Android and iOS apps the OS asks for location
  permission the first time. If permission is refused the dialog says so; allow
  location for the site (browser) or app (system settings) and press
  **Start GPS** again.
- **NMEA receiver (serial or Bluetooth)** reads an external GPS/GNSS receiver.
  Choose a **Baud rate** (4800, 9600, 19200, 38400, 57600, or 115200; 9600 by
  default, and remembered), then **Connect serial** or **Connect Bluetooth**.
  Once connected the dialog shows the device and a running count such as
  `1,204 sentences · 300 fixes` with the current fix quality (for example
  **RTK fixed**, **RTK float**, **Differential GPS**). **Disconnect** releases
  the receiver.

GeoLibre parses the GGA, RMC, VTG, GSA, and GST sentences from any talker (GP,
GN, GL, …). Accuracy comes from GST when the receiver sends it; otherwise it is
estimated from HDOP.

!!! note "NMEA needs a Chromium browser"
    The receiver is read through the Web Serial and Web Bluetooth APIs, which
    Chrome and Edge provide and Firefox and Safari do not. Most Bluetooth GPS
    receivers use *classic* Bluetooth: pair those in your operating system's
    settings and connect them as a serial port. **Connect Bluetooth** is for
    Bluetooth Low Energy receivers only.

### Following your position

**Start GPS** begins streaming. The map shows a blue dot, a heading arrow when a
heading is reported, and a translucent circle for the reported accuracy. The
readout lists the accuracy (`±4 m`), **Satellites**, altitude, speed in km/h,
and heading in degrees.

**Keep map centered on my position** (on by default) recenters the map on each
fix. Dragging the map turns it off.

When you close the dialog while GPS is running, a small floating panel stays in
the bottom corner of the map with the coordinates, accuracy, satellites, speed,
the track statistics, **Capture point**, a follow toggle, **Pause**/**Resume**,
and a button that reopens the dialog.

### Recording a track

Under **Track log**:

1. **Record track** clears any previous unsaved track and starts recording,
   turning GPS on if needed.
2. **Pause** stops logging; **Resume** continues in a new segment, so a gap is
   not drawn as a straight line.
3. While a track exists the dialog shows its point count, distance, and
   duration, with four actions:
    - **Save as layer** adds the track to the project as a line layer named like
      `GPS Track 2026-10-04 0930` (a MultiLineString when it has several
      segments), keeping each vertex's time, accuracy, and satellite count.
    - **Export GPX** writes GPX 1.1, one `<trkseg>` per segment.
    - **Export GeoJSON** writes the same track as GeoJSON.
    - **Discard** throws the track away.

Saving and exporting need at least two points.

!!! warning "Unsaved tracks are not kept"
    A track lives only in memory until you press **Save as layer** or export
    it. Closing the app or reloading the page loses an unsaved track.

### Capturing points

**Capture point** under **Digitize** adds a point at the current fix to a layer
named **GPS Points**, creating it on first use. Each point records `time`,
`accuracy_m`, `satellites_used`, `ele`, `speed_mps`, and `heading_deg`. To
capture into a layer of your choice, with a form, use
[Field Collection](#field-collection) instead.

### Logging filters

| Filter | Effect |
| --- | --- |
| **Min distance (m)** | Skip track fixes closer than this to the previous one. |
| **Min time (s)** | Skip track fixes sooner than this after the previous one. |
| **Max accuracy (m)** | Do not log fixes less accurate than this, and block **Capture point** while the fix is worse. |

Each is off at `0`. The filters are remembered between sessions.

## Field Collection

**Controls → Field Collection...** captures observations into a collection
layer against a custom form.

### Set up a collection layer

1. Under **Collection layer**, pick an existing collection layer or
   **New collection layer…**.
2. For a new layer, enter a **Layer name** and pick a **Geometry**: **Point**,
   **Line**, or **Polygon**. A layer holds one geometry type.
3. **Add field** for each attribute. Give it a **Label**, a **Type** (**Text**,
   **Number**, **Date**, or **Choice**), tick **Required** if it must be filled,
   and for a Choice field list the **Options (comma-separated)**.
4. **Create layer**.

A layer with no fields captures location-only observations. Property names are
derived from the labels. Fields have no default values.

If the layer has an [attribute form](attribute-table.md#attribute-forms)
configured, Field Collection uses it instead of the plain field list: its
aliases, dropdowns and checkboxes, number, range and date widgets, conditional
visibility, and constraints all apply.

### Capture an observation

For a **point**:

- **Use GPS** takes a single high-accuracy fix from this device (up to 15
  seconds). It does not read the NMEA receiver connected in GPS Tracking.
- **Pick on map** places the point where you click; `Esc` cancels.
- **Reposition point** moves a point you have already placed.

For a **line** or **polygon**, **Draw on map** opens a toolbar along the bottom
of the map. Click to add vertices, or **Add GPS vertex** to add one at your
current position; **Undo** removes the last vertex, and **Finish** (or a
double-click) closes the shape once it has enough vertices.

Fill in the form, attach photos if you like, and press **Save point**,
**Save line**, or **Save polygon**. Required fields are marked `*`, and the form
refuses an empty required field, a non-numeric number, or a choice outside the
listed options.

**Photo (optional)** → **Choose photo…** attaches one or more images, up to 2 MB
each. Photos are stored on the feature, so they travel with the project.

### Session behavior

**Done** ends the collection session. Closing the dialog with the X button or
`Esc` only hides it: an **Open Field Collection** pill stays on the map so you
can capture the next observation without setting up again.

The GPS accuracy shown while collecting is for your information and is not
stored on the feature. If you need per-point accuracy and satellite counts, use
**Capture point** in GPS Tracking.

## Working offline

Captures are kept in the project, so collecting needs no connection once the app
is loaded. Cache the basemap for the area before you go with
[Project → Offline Basemap...](projects.md#offline-basemap), and save the
project before closing the app.
