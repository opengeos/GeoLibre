# 7. Communicating and Collaborating

!!! info "3:00 - 4:00 p.m."
    Lecture 15 min · Hands-on 35 min · Break 3:50 - 4:00

## Learning goals

By the end of this section you will be able to:

- Summarize a layer with a dashboard of indicators, a chart, and a
  cross-filtering selector.
- Build a story map whose chapters move the camera and fade layers, then
  present it live: autoplay, pause for questions, and draw on the map.
- Choose between a project file, a `?url=` or `?data=` link, a share-server
  link, an embedded read-only viewer, and a standalone HTML export.
- Leave anchored review comments on a map, and know when a live
  collaboration session is the better tool.
- Capture field observations against a simple form.

## Lecture (15 min)

### One file carries the map, the story, and the dashboard

In most GIS stacks, explaining a map means leaving it: you export a figure to a
slide deck, rebuild the numbers in a BI tool, and publish a story in a separate
product that snapshots the map into something else. Every copy drifts from the
source.

GeoLibre keeps the explanation **inside the project**. A `.geolibre.json`
project file stores the story-map chapters, the dashboard widgets, and the
review comments next to the layers and styles. Whatever you share, embed, or
hand to a colleague carries all of them, and nothing needs to be kept in sync.

| Tool | Answers | Saved in the project? |
| --- | --- | --- |
| **Dashboard** (Processing → Dashboard) | "What are the numbers behind this map?" | Yes, the widgets. Selector choices reset on open |
| **Story map** (Project → Story map...) | "What is the argument, step by step?" | Yes, chapters and settings |
| **Review comments** (`C`, or the Comments rail) | "What should change?" | Yes, threads with replies and resolved state |
| **Live collaboration** (Project → Collaborate...) | "Can we work on this together, now?" | No: sessions are ephemeral; the project is not |
| **Field collection** (Controls → Field collection...) | "What did we see on the ground?" | Yes, as an ordinary GeoJSON layer |

!!! note "Coming from ArcGIS or QGIS"
    ArcGIS splits this work across Dashboards, StoryMaps, and Field Maps,
    each with its own item and publishing step. QGIS relies on print layouts
    and plugins such as qgis2web. In GeoLibre the presentation runs over the
    same live map you authored on, so you can pause it, pan, and draw while
    you talk. For a reader without the app, export a standalone HTML page or a
    PDF handout.

### Dashboards: lead with the headline number

The Dashboard panel docks below the map. Each widget binds to one layer:

| Widget | Reads best as |
| --- | --- |
| **Indicator** | One aggregate (Count, Sum, Average, Minimum, Maximum, Median) with an optional prefix and suffix |
| **Histogram** | The distribution of one numeric field |
| **Bar**, **Line**, **Scatter**, **Box plot**, **Pie** | Comparisons, trends, relationships, outliers, composition |
| **Selector** | Chips for a categorical field that **cross-filter every other widget on the same layer** |
| **List** | The top features by a sort field |

Two design rules are worth knowing. A selector never filters itself, so you
can always change your choice. And a selector's choice is a way of looking, not
a property of the data: it starts empty every time the dashboard opens and does
not filter the map. If readers should only ever see a subset, filter the
**layer** instead.

For skewed data such as earthquake magnitudes, prefer **Median** to
**Average**: most events sit just above the M2.5 cutoff, and a handful of large
ones pull the mean up.

### Story maps: chapters, effects, and a presenter that waits for you

A story map is a list of **chapters**. Each one stores a camera (center, zoom,
pitch, bearing), a title, a description (HTML allowed), an optional image, a
panel alignment, a map animation (`flyTo`, `easeTo`, or `jumpTo`), and a stay
duration for autoplay. **On enter** and **On exit** layer effects fade project
layers to a target opacity as a chapter starts or ends; that is what turns a
slideshow into an argument.

**Present** opens the story over the live map. It starts **paused**. **Play
automatically** runs it; each chapter's countdown starts only after its camera
arrives. **Any** deliberate interaction (panning, zooming, picking a chapter)
pauses playback, and nothing resumes it except you. **Return to chapter view**
restores the authored camera; **Autoplay next chapter** moves on and resumes.

**Presentation tools** turn the presentation into a whiteboard: search a place,
drop a pin or text, draw a line or outline an area, and measure distance or
area on the ellipsoid. Markup is temporary and per chapter. **Save as result
layer** keeps the current chapter's marks as a GeoJSON layer.

| Delivery | What the reader gets | Needs |
| --- | --- | --- |
| **Present** in the app | The live presenter with autoplay and markup | GeoLibre |
| **Export HTML** (story map) | A scroll-driven page; in-memory layers used by effects are inlined | A browser with network access for basemaps and the map library |
| **Handout (PDF)** | One page per chapter, with optional clickable location markers | A PDF viewer |

### Ways to share a project

A project is mostly **references** to data, so the right question is not "did
it save?" but "can the recipient reach every source?"

| Method | Result | Needs |
| --- | --- | --- |
| **Project → Save** | A small project file | Nothing |
| A public host plus `?url=` | `https://web.geolibre.app/?url=<project URL>` opens the whole project | A host that sends CORS headers (GitHub Pages, S3, Source Cooperative) |
| A `?data=` link | Opens one or more datasets directly, no project file. Repeat `data=` for several | Public data URLs |
| **Project → Share...** | A link on `share.geolibre.app`, with visibility, access role, expiry, and an optional password | A free share.geolibre.app sign-in |
| `&layout=viewer` in an `<iframe>` | An embedded, **read-only** map | A web page |
| **Project → Export → Export as HTML...** | One standalone HTML file of the whole project | Nothing to host |

When the Share dialog opens it runs a **share-readiness check**: it probes every
data source anonymously, the way a recipient would, and lists layers that will
not load (a local file, a host without CORS, a credential that is stripped on
upload, a private network address). The list informs; it never blocks the
upload.

`layout=viewer` is a real boundary, not a cosmetic preset: it removes every
authoring menu, the project shortcuts (`Ctrl+S`, `Ctrl+O`), the command
palette, drag-and-drop import, and plugins that write to the project, even if
the loaded project saved them active.

### Working together: comments versus live sessions

- **Review comments** are durable and asynchronous. Press `C` (or open the
  **Comments** panel), click the map, and write a note. Threads
  can be replied to, resolved, and reopened, and they are saved in the
  project file, so they travel with it by email or Git.
- **Live collaboration** (**Project → Collaborate...**) is synchronous and
  ephemeral. A host starts a session, chooses **Who can edit** (**Anyone can
  edit** or **Only you can edit (others watch)**), and shares a code, link, or
  QR code. Everyone sees each other's cursors and viewports, can chat, and
  receives whole-project snapshots. Sync is **last-write-wins**: two people
  restyling the same layer at the same moment will lose one change, so divide
  work by layer. Great for classrooms; for work spread over days, use
  comments and shared files.

## Hands-on (35 min)

You will build one project through the whole section: an earthquake dashboard,
a three-chapter story with a live markup moment, a review comment, a field
observation, and the sharing options around it.

### Exercise 7.1: Open data with one link (3 min)

1. Open this link. It loads the Nevada counties and the earthquake GeoParquet
   file directly, with no project file and no Add data dialog:

    ```text
    https://web.geolibre.app/?data=https://data.source.coop/opengeos/data/workshops/ngis-2026/nv_counties.geojson&data=https://data.source.coop/opengeos/data/workshops/ngis-2026/nv_earthquakes.parquet
    ```

2. The Layers panel lists `nv_earthquakes` above `nv_counties` (the last
   `data=` draws on top), and the map fits both layers.
3. Look at the address bar. GeoLibre has appended `&lat=...&lon=...&zoom=...`,
   and it keeps updating as you pan. Copying the address bar always captures
   the current view.

!!! tip "Nested URLs with their own `?`"
    If a data URL carries its own query string, percent-encode it (for example
    with JavaScript's `encodeURIComponent`). Otherwise its `&` is read as one
    of GeoLibre's own parameters, which is the most common cause of "the link
    loads the wrong thing."

### Exercise 7.2: An earthquake dashboard (7 min)

1. Choose **Processing → Dashboard**. The panel docks below the map and reads
   **No widgets yet. Add a chart to summarize a layer.**
2. Click **Add widget**. Set **Layer** to `nv_earthquakes`, **Chart type** to
   **Indicator**, keep **Aggregate: Count**, type ` events` (with a leading
   space) in **Suffix** and `Earthquakes` in **Title**. Click **Save**. The
   tile reads **8,031 events**.
3. Add a second **Indicator** on `nv_earthquakes`: **Aggregate: Maximum**,
   **Field: mag**, **Prefix** `M`, **Title** `Strongest`. It reads **M7.1**,
   the 2019 Ridgecrest earthquake in California.
4. Add a **Histogram** of **Field: mag** titled `Magnitude`. Nearly all of the
   8,031 events fall in the first two bins.
5. Add a **Selector** with **Category: magType**, titled `Magnitude type`.
   Chips appear for `mb`, `md`, `mh`, `ml`, `mlr`, `mw`, `mwr`, and `mww`.
6. Click **ml** (local magnitude). Every other widget recomputes: **6,497
   events**, strongest **M6.5** (the 2020 Monte Cristo Range earthquake).
   Click **mw** (moment magnitude) instead: **369 events**, strongest
   **M7.1**. Try **md**: **894 events**, strongest **M3.46**.
7. Click **Clear**. Notice that the map never changed: a selector filters
   widgets, not layers.
8. Add a **List** widget on `nv_earthquakes`. Under **Columns** tick `place`
   and `mag`, set **Sort by** to `mag`, keep **Direction: Descending**, set
   **Row limit** to `10`, and title it `Ten strongest`. The top rows read
   **Ridgecrest Earthquake Sequence 7.1**, **Monte Cristo Range, NV
   Earthquake 6.5**, and **Ridgecrest Earthquake Sequence 6.4**. Click **ml**
   in the selector again: the list re-ranks to local-magnitude events only,
   with Monte Cristo first, then three Hawthorne events at M5.5-5.6. Click
   **Clear**.
9. Close the dashboard with the **×** on its header to give the map room. The
   widgets stay in the project.

![The dashboard with the magnitude-type selector set to ml: 6,497 events, strongest M6.5](https://data.source.coop/opengeos/data/workshops/ngis-2026/images/s07-dashboard.webp)

!!! question "Discussion"
    The strongest `ml` event is M6.5 but the strongest overall is M7.1, and it
    is an `mw`. Seismic networks switch to moment magnitude for large events
    because local magnitude saturates. What would a reader conclude if the
    dashboard showed only an **Average** magnitude across all types?

### Exercise 7.3: Build a three-chapter story (9 min)

1. Choose **Project → Story map...**. Fill in **Title** `Ten Years of Nevada
   Earthquakes`, **Subtitle** `M2.5+ events, 2016-2025 (USGS ComCat)`, and
   **Byline** with your name.
2. Click **Add chapter**. It captures the current camera; the chapter card
   shows the coordinates, zoom, pitch, and bearing (for example
   `-117.0508, 38.5873 · z5.8 · p0 · b0`). Set **Chapter title** to `A restless
   state` and **Description** to a sentence such as *Nevada is one of the most
   seismically active states: 8,031 M2.5+ earthquakes in a decade.*
3. Click **Add chapter** again for chapter 2, then click its **Compose on
   map** button. The dialog steps aside and a **Composing chapter: Chapter 2**
   bar appears over the map.
4. While composing, choose **View → Set view...** and enter **Longitude**
   `-117.87`, **Latitude** `38.17`, **Zoom** `9.2`, **Pitch** `45`. Click
   **Go**, then **Save view and return to story map**. The chapter now reads
   `-117.8700, 38.1700 · z9.2 · p45 · b0`.
5. Title chapter 2 `Monte Cristo Range, May 2020` and describe the M6.5 event
   and its aftershocks, which make Esmeralda County the most active county of
   the decade.
6. Under chapter 2's **On enter**, click **Add layer effect**. Pick
   `nv_counties`, drag the **Opacity** slider to **0.2**, and keep
   **Transition (ms)** at 1000. When this chapter starts, the whole counties
   layer fades to 20% of its styled opacity, exactly as if you dragged its
   opacity slider in the Layers panel, so the aftershock cloud stands out.
   The layer's own style is untouched: exiting the presentation puts it back.
7. Add chapter 3 the same way with **Compose on map** and **Set view...**:
   longitude `-119.85`, latitude `39.35`, zoom `8.8`, pitch `30`. Title it
   `Close to home: Reno and Lake Tahoe`.
8. In the story settings at the top, tick **Show markers** and **Inset
   minimap**, tick **Enable start view**, and set its backdrop to **Global
   view**.

!!! tip "Refining a chapter"
    To adjust a camera later, click the chapter's **Compose on map** (the
    grid icon), pan or tilt by hand, and save. **Set to current view** does
    the same from wherever the map is now. The pin icon flies to a chapter
    while you edit.

### Exercise 7.4: Present, pause, and draw (6 min)

1. Click **Present**. The presenter opens on the start view: a globe with
   the story's title, subtitle, and byline above it, the chapter list at the
   top left, the minimap at the bottom left, and the status **Opening /
   closing slide · Paused for discussion**.
2. Click **Play automatically**. The status counts down from the default
   15-second stay (**Next in 14 s**, and so on), then flies to chapter 1 and
   counts down again.
3. While chapter 1 is playing, drag the map. Playback stops at once and the
   status reads **Paused for discussion**. Nothing will resume until you
   choose.
4. Click **2 Monte Cristo Range, May 2020** in the chapter list. The camera
   flies to the aftershock zone, tilts to 45°, and the counties fade to 0.2.
   The minimap shows a red dot in central Nevada.
5. Click **Presentation tools**, then **Measure distance**. Click the western
   end of the aftershock cloud, then its eastern end. The readout shows the
   length, **about 35 km** (34.72 and 36.01 km in our runs; your clicks will
   differ).
   Click **Finish**.
6. Click **Save as result layer**. The panel reports **Annotations saved as a
   project layer.**
7. Click **Exit**. Because you presented from the builder, the **Story map**
   dialog comes back; close it with its **×**. A `Presentation annotations ·
   Monte Cristo Range, May 2020` layer now sits in the Layers panel, and the
   counties are back at their full styled opacity.

![A chapter of the story with the counties faded, a chapter marker, and the inset minimap](https://data.source.coop/opengeos/data/workshops/ngis-2026/images/s07-story-chapter.webp)

![Measuring the Monte Cristo Range aftershock zone with the presentation tools](https://data.source.coop/opengeos/data/workshops/ngis-2026/images/s07-presentation-measure.webp)

!!! warning "Finish drawings before moving on"
    GeoLibre will not change chapters while a drawing is half done. If the
    arrows seem stuck, look for **Finish or cancel the current drawing before
    changing chapters** under the playback bar.

!!! question "Discussion"
    The markup you drew is gone when you leave the chapter unless you save
    it. Why is temporary-by-default the right choice for a live
    presentation to a committee or a classroom?

### Exercise 7.5: Leave a review comment (3 min)

1. With the map focused, press `C` to turn on the comment tool, then click
   near the aftershock zone. The **Add review comment** dialog shows
   **Anchored to (38.25, -117.88)** or similar.
2. Enter your name (asked once, then remembered) and a note such as *Check the
   aftershock zone length against the USGS event page.* Click **Post
   comment** (or press `Ctrl+Enter`).
3. A numbered pin **#1** appears on the map. Click the pin (or the
   **Comments** tab that now appears on the right-edge rail, under **Style**)
   to open the Comments panel. There you can see the thread, reply to it, and
   resolve it with the check mark. The filter at
   the top switches between **Open**, **Resolved**, and **All**; resolved
   pins disappear from the map while **Open** is selected.

### Exercise 7.6: Capture a field observation (4 min)

The same tools work on a phone in the field. Here you place the point by hand,
since a laptop has no GPS.

1. Choose **Controls → Field collection...**. **Collection layer** reads
   **New collection layer...**.
2. **Layer name**: `Felt reports`. **Geometry**: Point. In the first field,
   set **Label** `Shaking`, **Type** Choice, **Options (comma-separated)**
   `Not felt, Weak, Strong, Very strong`, and tick **Required**. Click
   **Create layer**.
3. Click **Pick on map**, then click anywhere on the map. The dialog shows the
   coordinates and a **Shaking*** dropdown.
4. Click **Save point** without choosing a value. The form refuses with **This
   field is required.** Choose **Strong** and click **Save point** again. It
   reports **Saved 1 point to Felt reports.**
5. Click **Done**. `Felt reports` is an ordinary vector layer: open its
   attribute table, style it, or export it like any other.

!!! tip "In the field"
    On a phone, **Use GPS** takes a high-accuracy fix instead of a map click,
    **Choose photo...** attaches one or more photos (up to 2 MB each), and
    **Controls → GPS tracking...** records a track log you can save as a layer
    or export as GPX. Choice fields beat free text: they make a misspelled
    species or damage class impossible.

### Exercise 7.7: Share it (3 min)

Try at least one of these. None of them publishes anything unless you go
through with a sign-in.

- **Read-only embed.** Open the link from Exercise 7.1 with
  `&layout=viewer` added at the end. The toolbar shrinks to View, Controls,
  and Help icons, and the Layers panel becomes a simple list. Press
  `Ctrl+S` or `Ctrl+K`: nothing happens. In a web page, the same URL goes in
  an iframe:

    ```html
    <iframe
      title="Nevada earthquakes"
      src="https://web.geolibre.app/?url=https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/07-communicating-collaborating.geolibre.json&layout=viewer"
      width="100%" height="600" style="border:0" loading="lazy"
      allow="fullscreen; geolocation">
    </iframe>
    ```

- **The share server.** Choose **Project → Share...**. Signed out, the dialog
  offers **Sign in to share.geolibre.app** (a popup consent page), or an API
  token pasted under **Settings → Environment variables**. After you sign in
  it asks for a title, **Visibility** (Unlisted, Public, Private, or
  Organization), an access role, a link expiry, and an optional password, and
  shows the share-readiness list before you upload.
- **A standalone file.** **Project → Export → Export as HTML...** writes one
  HTML file of the whole project that you can email or open from disk. Inside
  the story builder, **Export HTML** writes a scroll-driven page of just the
  story, and **Handout (PDF)** a printable version.

Save the project (**Project → Save**).

### Exercise 7.8: Bonus: a live session with a neighbor (if you finish early)

1. One person chooses **Project → Collaborate...**, enters a name, picks a
   color, keeps **Who can edit: Anyone can edit**, and clicks **Start
   session**. Share the **Session code**, the link, or the QR code.
2. The other person opens the link (or enters the code under **Join a
   session**). The guest arrives at the host's view and sees the same layers,
   including any added from a local file: snapshots embed local vector data.
3. Pan in one window and watch the other person's cursor and viewport
   rectangle. Send a chat message with your location attached.
4. Both of you change the color of the **same** layer within a second. One
   change is lost. That is last-write-wins, and it is why you should split
   work by layer.

!!! warning "Sessions are public relays"
    Anyone with the code can join an anonymous session. Do not put
    confidential data in a workshop session, and save your project locally
    before you start: a remote edit clears your undo history.

## Check your work

[Open the finished project](https://web.geolibre.app/?url=https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/07-communicating-collaborating.geolibre.json){ .md-button .md-button--primary }

The finished project opens straight into the story presentation on its globe
start view. Click **Exit**, then **Zoom to layer** on `nv_counties`, to reach
the map, the review comment, the saved measurement, and the `Felt reports`
layer. Open **Processing → Dashboard** to find the four widgets (add the
**List** widget from Exercise 7.2 yourself) and click the **#1** pin for the
review thread. Raw file:
[`07-communicating-collaborating.geolibre.json`](https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/07-communicating-collaborating.geolibre.json).

## Going further

- In the story builder, **Export → Export CSV** writes one row per chapter.
  Edit the descriptions in a spreadsheet and bring them back with **Import →
  Import CSV...**, which keeps your story settings. CSV is a practical way to
  hand the prose to a co-author while you own the camera positions.
- Add a **Hide panel** chapter between two others: a pure map beat with no
  text, so the audience actually looks at the map.
- Try **Load sample story** on an empty story for a five-city tour that shows
  every presenter control.
- Add `&theme=dark`, `&panels=collapsed`, or `&maponly` to a link to change
  how an embed looks.
- Read [Story Maps](../../user-guide/storymaps.md),
  [Sharing & Embedding](../../tutorials/sharing-embedding.md),
  [Embedding](../../user-guide/embedding.md),
  [Collaboration](../../collaboration.md), and
  [Field Collection](../../user-guide/field-collection.md).

---

**Break: 3:50 - 4:00.** Next: [8. AI and Automation](08-ai-automation.md)
