# 8. AI and Automation

!!! info "4:00 - 5:00 p.m."
    Lecture 15 min · Hands-on 25 min · Wrap-up 10 min · Open questions 4:50 -
    5:00

## Learning goals

By the end of this section you will be able to:

- Set up the AI Assistant with your own provider, or a local model, and know
  exactly what it sends where.
- Use the assistant to explore unfamiliar data, run spatial SQL, restyle
  layers, and author a Model Builder workflow, then **audit and undo** what
  it did.
- Check an AI answer against a number you already know.
- Script the live map from the in-browser **Python console**.
- Build the same kind of map from code with the `geolibre` Python package,
  and know where the MCP server, the agent skill, and the R package fit.
- Leave with a plan for moving one of your own workflows to this model.

## Lecture (15 min)

### Two directions for AI

AI reaches GeoLibre from two directions, and which one you want depends on
where you are working:

| | AI Assistant | MCP server (`geolibre-mcp`) | Agent skill |
| --- | --- | --- | --- |
| Runs | Inside the app, as a chat panel | Beside your AI client (Claude Desktop, Claude Code, an editor), headless | Inside a coding agent |
| Acts on | The live map you are looking at | A `.geolibre.json` file, or the open desktop map | Whatever entry point it picks: MCP, Python, or plain project JSON |
| Needs | A configured AI provider | `pip install "geolibre[mcp]"` and an MCP client | An agent runtime that loads skills |
| Output | Edits you can undo | A project file or a standalone HTML page | A map, built the way the skill teaches |

The **AI Assistant** is for someone already working in GeoLibre. The **MCP
server** and the **agent skill** are for an agent working *outside* GeoLibre
whose deliverable is a map. They compose: an agent writes a project, you open
it and keep refining it with the assistant.

### How the assistant works, and why you can trust it

The assistant does not draw on the map or edit files by itself. It calls **a
fixed set of tools**, the same operations the menus use:

| Capability | What it does |
| --- | --- |
| Inspect layers | Lists layers, geometry types, field names, and SQL table names (schema only, never the rows) |
| Natural language to spatial SQL | Writes and runs a **read-only** DuckDB query, optionally adding the result as a layer |
| Geoprocessing | Runs the registered tools (buffer, clip, dissolve, overlay, spatial join, H3 grids, and more) and chains them |
| Raster tools | Searches the Whitebox catalog and runs its tools in the browser |
| Model Builder | Authors a validated workflow from a description and opens it for review before anything runs |
| Symbology | Applies a graduated or categorized style and reports what it applied |
| Add data and map control | Adds a public GeoJSON or tile URL, fits the view, switches the basemap, changes visibility and opacity |
| Earth observation | Searches the Planetary Computer STAC catalog over the current view |
| Code fallback | Runs model-written JavaScript or Python when no tool fits |

Three properties follow from that design:

1. **It is auditable.** Every tool call, including the SQL it wrote, is
   printed in the transcript.
2. **It is undoable.** Tools act through the same project store as the rest
   of the app, so **Edit → Undo** reverses a restyle or a new layer.
3. **It is scoped.** The provider receives layer names, field names, and the
   current view, **not whole layers**. SQL runs locally in DuckDB, and what
   goes back to the model is the column names, the row count, and a preview
   of up to 10 result rows. Ask for counts and only the counts are sent; ask
   for individual records and those attribute values reach the provider.

!!! warning "The code fallback is the exception"
    When no tool fits, the assistant can run JavaScript against the map or
    Python in the browser. That code is shown in the transcript, but direct map
    changes made this way bypass the store and **cannot be undone**. Read the
    code before you rely on the result.

### Providers and privacy

The assistant is off until you configure a provider under
**Settings → AI providers**. Supported providers include Google Gemini,
Anthropic, OpenAI, the gateways OpenRouter, Vercel AI Gateway, TrustedRouter,
and UberLLM (one key, many models), Amazon Bedrock, any OpenAI-compatible
endpoint, and **Ollama**, which runs a model on your own machine.

- Keys are used **directly from your browser** and never pass through a
  GeoLibre server. In the web app they are stored in this browser's local
  storage. On the desktop app, the recommended route is to export the key in
  your shell profile, so it is never typed into Settings or written to a
  project.
- **No data leaves your machine until you send a prompt.** Then the prompt,
  the schema context, and tool results such as SQL previews go to the
  provider you chose.
- With **Ollama**, the model runs on your machine. Two optional features
  still send data elsewhere: the fast path for simple commands, when
  enabled, sends the request text and layer names to TypeSafe, and voice
  input in Chrome sends audio to Google. Leave both off for sensitive work.
  To use Ollama from the hosted web app, start it with
  `OLLAMA_ORIGINS=https://web.geolibre.app` so the page may call it.
- Layer and field names are metadata, and metadata can be sensitive. A layer
  named `2026_layoffs_by_site` says something even if no rows are sent. If you
  cannot share the schema, use Ollama or leave the assistant off.

### Automation without AI: Python and R

Not every repeatable workflow needs a language model. GeoLibre speaks Python
in both directions, and R from RStudio and Shiny:

| Surface | Where the code runs | What it drives |
| --- | --- | --- |
| **Python console** (**Processing → Python console**) | Your browser, through Pyodide | The live map, from inside the app, on any build |
| **Notebook panel** (**Processing → Jupyter notebook**) | JupyterLite in the browser (web), or a real JupyterLab server (desktop) | The live map, beside it |
| **`geolibre` Python package** | Your own Jupyter kernel, Dash, or Shiny | An embedded copy of the full app, synced through the project |
| **`geolibre` R package** | RStudio, Quarto, R Markdown, Shiny | An embedded map built with a pipe-friendly API |
| **MCP server** | Beside an AI client | Project files on disk, or the open desktop map |

They all read and write the same `.geolibre.json` format. A map started in a
notebook opens in the web app, a map saved in the web app reloads in a
notebook, and an MCP agent can edit either one.

!!! note "For QGIS and ArcGIS users"
    The Python console is the closest thing to the QGIS Python console, and its
    **Show editor** button gives you a script editor like QGIS's. The Model
    Builder plays the role of ModelBuilder or the QGIS graphical modeler, with
    **Copy Python script** to turn a model into code. The difference is that
    the AI Assistant can *author* a model for you and opens it for review
    instead of running it blind.

## Hands-on (25 min)

Start a new project: **Project → New...**. If GeoLibre asks **Save current
project?**, click **Save** to keep your Section 7 work (choose **Do not save**
only if you mean to discard unsaved changes). Name the new project
`NGIS 2026 - 8 AI and automation`, pick the **Positron** basemap, and click
**Create**. Then use **Add data → Vector layer** to load these two URLs (paste
each and click **Load**):

```text
https://data.source.coop/opengeos/data/workshops/ngis-2026/nv_counties.geojson
https://data.source.coop/opengeos/data/workshops/ngis-2026/nv_earthquakes.parquet
```

Close the **Add Vector Layer** panel. The Layers panel lists `nv_earthquakes`
and `nv_counties`, and the map shows 8,031 points over Nevada and eastern
California. Loading the earthquakes from **GeoParquet** rather than CSV keeps
`mag` numeric, which matters in Exercise 8.3.

!!! tip "No API key?"
    Exercises 8.1 to 8.5 need a provider. If you do not have one, pair up with
    a neighbor who does, or follow the instructor's screen, then do Exercise 8.6
    on your own: the Python console needs no key. Google AI Studio offers a free
    Gemini API key if you want one for later.

### Exercise 8.1: Set up the AI Assistant (6 min)

1. Choose **Processing → AI assistant**. The panel docks below the map and
   shows **Set up the AI assistant**, with a list of supported providers and
   the environment variable each one reads (for example `GEMINI_API_KEY` and
   `OLLAMA_BASE_URL`).
2. Click **Open Settings → AI providers**. Note the line at the top: keys you
   save here are stored in this browser's local storage.
3. Click **Add profile**. Give the profile a name, choose a provider, and fill
   in what it asks for:
    - **Google Gemini**, **Anthropic**, **OpenAI**, or a gateway: an
      **API key**, and optionally a **Model**.
    - **Ollama (local)**: a **Base URL** such as `http://localhost:11434`, then
      **Refresh model list** and pick a model you have pulled.
    - **Custom (OpenAI-compatible)**: a **Base URL**, a **Model** name, and an
      optional **API key**.
4. Click **Save profile**, then **Save settings**.
5. The assistant panel switches to chat mode. The profile name appears in its
   header, and the prompt box reads **Ask about your data...**.

!!! warning "Shared computers"
    A key saved in a lab or loaner browser stays in that browser's storage.
    Delete the profile at the end of the day, or use a private window.

### Exercise 8.2: Explore unfamiliar data (3 min)

The most underused job for an assistant is orientation. Type this into the
prompt box and press `Enter`:

```text
What layers are loaded, and what fields does each have?
```

The answer lists both layers with their geometry type and fields:

- `nv_counties`: MultiPolygon, 17 features, fields `GEOID`, `NAME`,
  `NAMELSAD`, `ALAND`, `AWATER`.
- `nv_earthquakes`: Point, 8,031 features, fields `time`, `latitude`,
  `longitude`, `depth`, `mag`, `magType`, `place`, `id`.

That is the layer schema, which is exactly what the assistant sends to the
provider. It never saw a single earthquake record to produce it.

### Exercise 8.3: Verify, then trust (5 min)

You computed several numbers by hand earlier today. Use them to test the
assistant.

1. Ask:

    ```text
    How many earthquakes in nv_earthquakes have a magnitude of 4 or more?
    ```

2. The transcript shows a `run_sql` line with the query it wrote, then the
   answer:

    ```sql
    SELECT COUNT(*) AS earthquake_count
    FROM nv_earthquakes
    WHERE mag >= 4
    ```

    **262 earthquakes have a magnitude of 4 or more.**

3. Ask a harder question that needs a spatial join:

    ```text
    Which Nevada county has the most earthquakes, and how many?
    ```

4. The assistant joins the two layers with `ST_Within` and reports
   **Esmeralda County, with 1,431**. That matches the per-county join you ran
   in the SQL workspace in Section 4.
5. Check the first answer yourself: open **Processing → SQL workspace**, paste
   the query from the transcript, and run it. You get the same 262.

!!! question "Discussion"
    Different models write different SQL for the same question, and a
    plausible answer can still be wrong (the wrong field, an inner join that
    silently drops counties, a magnitude cut-off of `> 4` instead of `>= 4`).
    What would you check before putting an AI-generated number in a report?
    Earlier in the day the earthquakes were loaded from CSV, where every column
    reaches SQL as text: would `WHERE mag >= 4` still work on that layer?

### Exercise 8.4: Restyle, then undo (3 min)

1. Ask:

    ```text
    Color nv_earthquakes by mag with a graduated plasma ramp, 5 quantile classes.
    ```

2. The transcript shows an `apply_symbology` call with every argument it
   used (`"mode":"graduated"`, `"color_ramp":"plasma"`, `"class_count":5`,
   `"scheme":"quantile"`), and the points recolor from dark purple (about
   M2.5) to yellow (the strongest events).
3. Choose **Edit → Undo** (the menu shows the shortcut, `Ctrl/Cmd+Z`). The
   earthquakes go back to the single color they had when you loaded them.
   **Edit → Redo** brings the style back.

![The AI Assistant answering with the SQL it ran and restyling the earthquake layer](https://data.source.coop/opengeos/data/workshops/ngis-2026/images/s08-ai-assistant.webp)

!!! tip "Undo from the menu"
    If the prompt box still has focus, `Ctrl+Z` undoes your typing instead of
    the map change. Click the map first, or use **Edit → Undo**.

### Exercise 8.5: Test the guardrails (2 min)

Ask the assistant to change the data:

```text
Delete every earthquake below magnitude 3 from the nv_earthquakes table.
```

It cannot. The SQL tool accepts only `SELECT` and `WITH` queries, so the reply
says the SQL interface is read-only and the original layer is unchanged. Some
models offer a filtered copy instead; in testing, one added a new layer of
the 2,830 events with `mag >= 3`, and another removed its own temporary copy
again and confirmed that `nv_earthquakes` still has 8,031 features. If a copy
is left in your Layers panel, remove it with its trash icon.

### Exercise 8.6: Script the map from the Python console (6 min)

No key is needed for this one: Python runs inside your browser.

1. Choose **Processing → Python console**. The first time, it shows
   **Downloading Python runtime** for a few seconds, then **Python console
   ready**.
2. Paste the code below into the input box and press `Ctrl+Enter`
   (`Cmd+Enter` on macOS):

    ```python
    base = "https://data.source.coop/opengeos/data/workshops/ngis-2026/"
    sites = await geolibre.load_geojson(base + "reno_sites.geojson", name="Reno-Tahoe sites")
    result = await geolibre.run_algorithm(
        "buffer", {"layer": sites, "distance": 10, "units": "kilometers"}
    )
    print(result["logs"])
    for layer in geolibre.layers:
        print(layer.name, layer.type, layer.visible)
    ```

3. The console prints `['Buffered 8 feature(s) by 10 kilometers (outside)']`,
   then one line per layer. `Reno-Tahoe sites` and a new `Buffer` layer
   appear in the Layers panel, and the map shows eight 10 km circles
   around Reno and Lake Tahoe. It is the same buffer you ran from the toolbox
   in Section 5, now as three lines of code.
4. Read the camera back:

    ```python
    geolibre.get_view()
    ```

    It returns a dictionary with `center`, `zoom`, `bearing`, `pitch`, and
    `bbox`, which reflect the map as you last left it.
5. Type `geolibre.` and press `Tab` to list the available methods:
   `add_geojson`, `fit_bounds`, `fly_to`, `get_view`, `identify`,
   `list_algorithms`, `run_algorithm`, `set_basemap`, `to_image`, and more.

![The in-browser Python console buffering the Reno-Tahoe sites](https://data.source.coop/opengeos/data/workshops/ngis-2026/images/s08-python-console.webp)

!!! warning "The console runs on the page"
    The console shares the browser's main thread so it can drive the map
    directly. A long loop freezes the interface until it finishes, so prefer
    `await geolibre.run_algorithm(...)` for heavy work. It is also sandboxed: it
    cannot read your disk.

### Exercise 8.7: The same map from Jupyter (if you finish early)

This one needs Python on your laptop or a hosted notebook. In any Jupyter
environment (JupyterLab, VS Code, or Google Colab):

```python
%pip install "geolibre[vector]"

import pandas as pd
import geopandas as gpd
from geolibre import Map

base = "https://data.source.coop/opengeos/data/workshops/ngis-2026/"

# Read the CSV with pandas and turn it into a GeoDataFrame
df = pd.read_csv(base + "nv_earthquakes.csv")
quakes = gpd.GeoDataFrame(
    df, geometry=gpd.points_from_xy(df.longitude, df.latitude), crs="EPSG:4326"
)
strong = quakes[quakes["mag"] >= 4]
print(len(quakes), len(strong))  # 8031 262

m = Map(center=(-117.5, 38.8), zoom=6, basemap="positron")
m.add_cog(base + "reno_tahoe_dem.tif", name="Reno-Tahoe DEM", colormap="terrain")
m.add_vector(base + "nv_counties.geojson", name="Nevada counties", fillOpacity=0)
m.add_choropleth(
    strong, column="mag", name="M4+ earthquakes", colormap="plasma", scheme="quantile"
)
m.set_map_legend("Nevada earthquakes, M4+")
m.save_project("my-workshop.geolibre.json")
m
```

What to notice:

- `print` shows **8031 262**: GeoPandas gives the same M4+ count as the
  assistant and the SQL workspace. Three independent routes, one answer.
- The full GeoLibre app renders inside the cell, with the 262 events
  graduated in five quantile classes (breaks at about 4.0, 4.12, 4.3, 4.59,
  and 7.1), the county outlines, the DEM, and a legend.
- `add_vector` stores only the URL, while `add_choropleth` computes the class
  breaks in Python and writes them into the project as an ordinary GeoLibre
  style, editable in the Style panel.
- `save_project` writes a file that opens unchanged in the web and desktop
  apps. It **redacts credentials** such as API keys by default; pass
  `keep_credentials=True` only for a trusted local file.

The finished project for this section is exactly what this cell saves.

### Bonus: Ask for a workflow, not a result

Back in the web app, with `Reno-Tahoe sites` loaded (Exercise 8.6), ask the
assistant:

```text
Create a Model Builder model that buffers the Reno-Tahoe sites layer by 10 kilometers and then dissolves the result.
```

The assistant searches the tool catalog, builds a two-step graph (Buffer, then
Dissolve), and opens it in **Model builder** without running it. Inspect the
wiring, then click **Run**. The log reads **Buffered 8 feature(s) by 10
kilometers (outside)**, **Dissolved 8 polygon(s) into 1 feature(s)**, and
**Run finished — 1 output(s) added.** A model is an artifact you can correct,
save with the project, rerun on next month's data, or export with **Copy
Python script**.

![A Model Builder model authored by the AI Assistant, after a successful run](https://data.source.coop/opengeos/data/workshops/ngis-2026/images/s08-model-builder.webp)

### Bonus: An agent that writes maps (instructor demo)

The MCP server lets an AI client author projects without a browser. Install
it and register it with your client:

```bash
pip install "geolibre[mcp]"
mkdir -p ~/maps
claude mcp add geolibre -- geolibre-mcp --root ~/maps
```

Then ask your agent for a map in words, for example *"Create
tahoe.geolibre.json centered on Lake Tahoe at zoom 9 with the Positron
basemap, add the DEM at
https://data.source.coop/opengeos/data/workshops/ngis-2026/reno_tahoe_dem.tif
with a terrain colormap, and export it as HTML."* The agent calls tools such
as `create_project`, `add_raster_layer`, `add_vector_layer`, `set_view`,
`describe_project`, and `export_html`, about 80 in all.

Two safety rules are worth seeing for yourself:

- **Every path is confined to `--root`.** Asking for
  `/tmp/outside.geolibre.json` fails with *Path ... is outside this server's
  workspace*.
- `describe_project` reports inlined features **as a count**, never echoing
  the data back through the model.

## Check your work

[Open the finished project](https://web.geolibre.app/?url=https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/08-ai-automation.geolibre.json){ .md-button .md-button--primary }

The finished project is the map from Exercise 8.7: the 262 M4+ earthquakes
graduated by magnitude, transparent Nevada county outlines, the Reno-Tahoe
DEM, and a legend titled **Nevada earthquakes, M4+**. The raw file is
[`08-ai-automation.geolibre.json`](https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/08-ai-automation.geolibre.json).

## Going further

- **Notebook panel.** Choose **Processing → Jupyter notebook**. In the web
  app it opens JupyterLite, a full Jupyter interface running in the browser,
  with `Explore_GeoLibre.ipynb` and `Welcome.ipynb` in the file browser. Run
  `Explore_GeoLibre.ipynb` top to bottom. Its desktop-only part skips itself
  on the web, because JupyterLite cannot wait for replies from the map.
- **Desktop relay.** In the desktop app, the same panel runs a real
  JupyterLab server with GeoPandas, rasterio, and GDAL. Copy its connection
  URL from the panel header to drive the map from VS Code, or let the MCP
  server's `live_*` tools read what you selected or drew on the open map.
- **Agent skill.** Copy `skills/geolibre/` from the GeoLibre repository into
  `~/.claude/skills/` so a coding agent knows which entry point to use and
  which mistakes to avoid. See [Agent Skill](../../agent-skill.md).
- **R.** In R, `install.packages("geolibre")`, then build a map with the
  pipe:

    ```r
    library(geolibre)
    base <- "https://data.source.coop/opengeos/data/workshops/ngis-2026/"
    m <- geolibre(center = c(-119.8, 39.4), zoom = 8, basemap = "positron") |>
      add_cog(paste0(base, "reno_tahoe_dem.tif"), name = "Reno-Tahoe DEM") |>
      add_vector(paste0(base, "nv_counties.geojson"), name = "Nevada counties")
    save_project(m, "nevada.geolibre.json")
    m
    ```

    The R widget loads the hosted app, so viewing it needs an internet
    connection unless you point `app_url` at a self-hosted copy.
- **Earth Engine and xarray.** The Python package adds `add_ee_layer` for
  Earth Engine objects and `add_raster` for xarray arrays.
- **Voice.** In Chrome, Edge, or Safari, the assistant's microphone button
  takes spoken requests through the same tools. Chrome sends the audio to
  Google's speech service, a destination separate from your AI provider.
- Read [AI Assistant](../../user-guide/ai-assistant.md),
  [Python Console](../../user-guide/python-console.md),
  [Model Builder](../../user-guide/model-builder.md),
  [Python Package](../../python.md), [Notebook](../../notebook.md),
  [MCP Server](../../mcp.md), and [R Package](../../r.md).

## Wrap-up (10 min)

Today you:

1. **Got started** with cloud-native GIS: the interface, your first map, and
   projects that reopen from a single link.
2. **Brought in data** where it lives: GeoJSON, CSV, FlatGeobuf, GeoParquet,
   COG, PMTiles, Zarr, OGC services, and a STAC catalog, all over HTTP.
3. **Visualized and styled** it: graduated and categorized symbols, labels,
   popups, raster ramps, legends, and layouts.
4. **Queried and edited** attributes, and ran spatial SQL in the browser.
5. **Analyzed and processed** it: buffers, terrain, the toolbox, and Model
   Builder, with no server.
6. Switched **rendering engines** and worked in **3D and time**: terrain,
   a billions-of-points LiDAR survey, and the Time Slider.
7. **Communicated and collaborated** with story maps, dashboards, share links,
   and embeds.
8. **Automated** it with an AI assistant you can audit, Python in and around
   the app, and agents that write maps.

Take two minutes to write down one dataset or workflow from your own job that
you could move to this model, and what is blocking it today (data format,
hosting, CORS, credentials, or habits). If an AI assistant is part of that
plan, write down how you would verify its answers.

**Keep learning**

- [GeoLibre documentation](../../index.md), [Tutorials](../../tutorials/index.md),
  and [Video Tutorials](../../tutorials/videos.md)
- [Gallery](../../gallery.md) of shared projects to open and fork
- Source code and issue tracker: [github.com/opengeos/GeoLibre](https://github.com/opengeos/GeoLibre)
- Questions, bugs, and feature requests: open an issue or a discussion on
  GitHub

---

**End of workshop, 5:00 p.m.** Thank you for attending! Return to the
[workshop overview](index.md).
