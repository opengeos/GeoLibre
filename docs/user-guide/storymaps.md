# Story Maps

Story maps turn a project into a chapter-based narrative. The map moves between
saved views, and project layers can fade in and out. In-app presentations offer
manual navigation and autoplay, with the presenter always able to take control.
Standalone HTML exports retain their scroll-driven reading experience. The
feature is inspired by the
[maplibre-gl-storymaps](https://github.com/opengeos/maplibre-gl-storymaps)
template. Authoring and the in-app presentation run locally, though basemap
styles and any chapter images are still fetched from their URLs, and the
standalone HTML export loads MapLibre and scrollama from a CDN.

## Open the builder

Choose **Project → Story Map** to open the builder. The builder edits a story
that is saved inside the `.geolibre.json` project file, so it travels with your
project.

!!! tip "Try it instantly"
    When the story is empty, click **Load sample story** to populate a five-city
    world tour. Hit **Present** and use **Play automatically** to see it in action, then edit or
    replace the chapters with your own.

![The Story Map builder, with the story settings above and the chapter list below](https://assets.geolibre.app/images/geolibre-story-map.webp)

## Story settings

- **Title / Subtitle / Byline / Footer** appear in the presentation header and
  footer. The footer accepts inline HTML (for example, links and credits).
- **Panel theme** switches the chapter panels between light and dark.
- **Show markers** drops a marker at each chapter's center; pick its color.
- **Inset minimap** shows a small overview map in a chosen corner.
- **Hide chapter list** removes the navigation pane from the presentation, for a
  story meant to be read straight through.
- **Enable start view** adds an opening screen before the first chapter, carrying
  the story's title block. Choose what the map shows behind it: an **Empty
  screen**, a **Black screen**, a **Global view**, or a **Preview of first
  chapter**.
- **Enable closing slide** adds a final screen after the last chapter, for
  credits or a closing note. The same backdrop choices apply, plus **Hold on last
  chapter** to leave the camera where the story ended.

## Chapters

Click **Add chapter** to capture the current map view as a new chapter. Each
chapter has:

- **Title**, **Description** (inline HTML allowed), and an optional **Image URL**.
- **Panel alignment**: `left`, `center`, `right`, or `full`.
- **Map animation**: `flyTo`, `easeTo`, or `jumpTo`.
- **Hide panel** keeps the map transition but hides the text (useful for a pure
  map beat).
- **Rotate camera** slowly spins the view after the transition settles.
- **Stay duration (seconds)** controls how long autoplay stays at this chapter
  after the camera arrives. Leave it empty for the default of 15 seconds. Values
  from 1 to 3600 seconds are supported, including fractional seconds.

Use **Set to current view** to re-capture the camera after panning, zooming, or
tilting the map, and the map-pin button to fly to a chapter while editing.
Reorder chapters with the arrows and remove them with the trash icon.

## Import and export chapters

To author content outside GeoLibre, use **Import** / **Export** next to **Add
chapter**:

- **Export JSON** writes the whole story (settings and chapters); **Import JSON**
  reads it back (a full `.geolibre.json` project file also works).
- **Export CSV** writes one row per chapter (spreadsheet-friendly). **Import CSV**
  replaces the chapters while keeping your current story settings.

The CSV columns are `id, title, description, image, alignment, hidden, lng, lat,
zoom, pitch, bearing, mapAnimation, rotateAnimation, onChapterEnter,
onChapterExit, durationSeconds`. Columns are matched by name, so order is
flexible and you only need the ones you use; `lng`/`lat` set the chapter center,
and missing ids are
generated on import. The `onChapterEnter`/`onChapterExit` columns hold JSON and
can be left blank when authoring by hand. The optional `durationSeconds` column
sets the autoplay dwell time in seconds. A missing or blank cell keeps the
15-second default, so older CSV and JSON stories remain compatible.

### Layer effects

Under **On enter** and **On exit**, add layer fades that run as a chapter
becomes active or is left behind. Pick a project layer and a target opacity (and
optional transition duration). This is how you reveal or hide data as the story
progresses. The target opacity stands in for the layer's opacity, as the Layers
panel slider does, so the layer's style still applies: a polygon styled with a
45% fill shows that fill at an opacity of 1 and a fainter one at 0.2. Leaving the
presentation puts every layer back as it was.

## Present

Click **Present** to open a presentation over the live map. It starts paused;
use **Play automatically** to begin moving through the story. The countdown for each
chapter starts after its camera transition finishes. Playback ends at the last
step without looping. Press **Esc** or **Exit** to return to editing.

![A story map in presentation mode, with the chapter navigation pane, a chapter card, and the inset minimap over the live map](https://assets.geolibre.app/images/geolibre-story-map-present.webp)

A **navigation pane** on the left lists every chapter for a quick overview;
click any entry to jump straight to it. Toggle the pane with the list button next
to **Exit**. The map controls (navigation, fullscreen, globe, layer control)
stay usable during the presentation. Selecting a chapter, **Previous**, or
**Next** switches to that step and pauses, so a live discussion does not trigger
an unexpected advance.

### Pause and take control

Click **Pause** to stop the countdown, camera movement, and rotation at their
current position. Panning, zooming, rotating, searching, or starting a map tool
also pauses playback before the interaction. Playback never resumes because
the mouse has been idle.

While paused, explore a location and explain it at your own pace. **Return to
chapter view** restores the authored camera and stays paused; exploring the map
does not overwrite the saved chapter. When the explanation is finished, choose
**Autoplay next chapter** to move directly to the following step and continue
automatic playback. This does not replay the chapter you just discussed.

The mouse wheel over the map zooms it; over a chapter card it scrolls the text.
Use the chapter list or playback controls to change steps.

Each chapter card is **movable and resizable**: drag its title bar to reposition
it (double-click the bar to reset), or drag the bottom-right corner to resize, so
you can move a card aside and explore the map beneath it.

### Temporary annotations and measurements

Open **Presentation tools** to search for a place or latitude/longitude, place
a pin or text label, draw a line or area, or measure distance and area. Coordinate
searches are parsed locally; place names use the project's geocoding provider.
Measurements are surface distances and areas and do not include terrain height.

While drawing, click to add vertices and choose **Finish** or **Cancel drawing**.
Finish or cancel before changing chapters or exiting. Temporary drawing does not
edit the project's existing features. Switching chapters hides the current
chapter's marks and restores them when you return; switching rendering engines
also preserves marks and unfinished drawings within the current presentation.

Choose **Save as result layer** to keep a chapter's annotations as GeoJSON in the
project, then save the project file normally. Unsaved temporary annotations are
cleared when the presentation ends. Use the text toggle beside **Exit** to hide
the story text and leave more space for discussion.

**Space** plays or pauses, **Page Up / Page Down** navigate manually, and **Esc**
exits. These shortcuts do not override text inputs or open dialogs.

## Handout (PDF)

Click **Handout (PDF)** to export the story as a multi-page PDF, one page per
screen. Pick which screens to include, the paper size and orientation, and the
document title, subtitle, byline, and footer text drawn on every page. Each
chapter page shows the captured map view, the chapter photo beside it when the
chapter has one, and the chapter description.

**Clickable location markers** draws a marker at each chapter's location, its
tip on the chapter coordinate. Opened in a PDF viewer, clicking a marker opens
that coordinate in Google Maps, so a reader can navigate to the place. The
marker takes the story's **Marker color**, and the option starts on when **Show
markers** is enabled for the story.

## Export to HTML

Click **Export HTML** to save a self-contained `.html` page that reproduces the
story without GeoLibre. In-memory GeoJSON layers referenced by chapter effects
are inlined so the exported story behaves like the in-app preview. The page is a
single static file you can host anywhere (GitHub Pages, Netlify, S3, or any web
server).

The HTML export remains a separate scroll-driven player. The in-app autoplay
controls, interactive presentation tools, and temporary annotations are not
included in that export. Basemap tiles, remote images, and CDN scripts still
require access to their original URLs.
