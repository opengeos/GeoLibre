# AI Assistant

The **AI Assistant** is a "chat with your data" panel that turns plain-English
requests into GeoLibre's own operations — Spatial SQL, layer styling, map
control, and more — and applies them **through the app**, the same way you would
by hand. Open it from **Processing → AI Assistant** (top of the menu) or the
command palette. It docks as a resizable panel at the bottom of the window (drag
its top edge to resize, **✕** to close).

Because the assistant acts through the store rather than poking the map
directly, almost everything it does is **undoable** with **Ctrl/Cmd + Z**, and
every tool call (including the SQL it generates) is shown in the transcript so
you can see exactly what ran.

The assistant is **optional and disabled until you configure an API key**. No
data leaves your machine until you add a key and send a prompt.

## Setup: add an API key

The assistant is **provider-pluggable** — it uses the
[Strands Agents](https://strandsagents.com) SDK. Configure one (or more)
providers in **Settings → Environment Variables** as environment variables:

| Provider | Environment variable(s) | Default model |
| --- | --- | --- |
| Google Gemini | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | `gemini-3.5-flash` |
| Anthropic | `ANTHROPIC_API_KEY` | `claude-opus-4-8` |
| OpenAI | `OPENAI_API_KEY` | `gpt-5.5` |
| **Ollama** (local) | `OLLAMA_BASE_URL` (e.g. `http://localhost:11434`) | `llama3.2` |
| **Amazon Bedrock** | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (+ `AWS_REGION`, optional `AWS_SESSION_TOKEN`) | `global.anthropic.claude-sonnet-4-6` |
| **Custom** (OpenAI-compatible) | `OPENAI_COMPATIBLE_BASE_URL` (+ optional `OPENAI_COMPATIBLE_API_KEY`) and `OPENAI_COMPATIBLE_MODEL` | — |

- **Ollama** runs models on your own machine — no API key and nothing leaves your
  computer. Point `OLLAMA_BASE_URL` at your Ollama host (the `/v1` suffix is added
  automatically); set `OLLAMA_MODEL` to pick which pulled model to use.
- **Bedrock** calls AWS from the browser using your credentials (and the model
  id is an inference-profile id such as `global.anthropic.claude-sonnet-4-6`; set
  `BEDROCK_MODEL` to choose another).
- **Custom** covers any OpenAI-compatible endpoint — LiteLLM, vLLM, OpenRouter,
  Groq, Together, a local server, etc. — via its chat-completions API.

Hosted keys (and AWS credentials) are used **directly from your browser** to call
the provider; they are never sent to GeoLibre's servers. Saving the setting
enables the panel immediately — no reload needed.

Optional variables:

| Variable | Purpose |
| --- | --- |
| `GEOLIBRE_ASSISTANT_PROVIDER` | Force a provider (`google` / `anthropic` / `openai`) when several keys are set. |
| `GEOLIBRE_ASSISTANT_MODEL` | Pin a specific model id, overriding the default and the picker. |
| `TAVILY_API_KEY` | Enable reliable [web search](#what-it-can-do) (the keyless fallback is best-effort and may be blocked by the browser). |

When more than one provider key is configured, a **provider** dropdown appears in
the panel header; a **model** dropdown lets you switch models for the selected
provider. Your choice is remembered across sessions.

### Reading keys from your system environment (desktop)

On the **desktop app**, GeoLibre also reads the assistant's keys directly from
your operating system's environment variables — the ones you export from your
shell profile or set in the Windows *Environment Variables* dialog. Set a
supported variable in your OS environment, restart the app, and the matching
provider is configured automatically: you never type the key into Settings, and
because it is not entered there, it is **never written to the saved
`.geolibre.json` project file**. This is the recommended way to keep API keys out
of project files that you share or commit.

Only the following allowlisted names are read from your environment — GeoLibre
never reads any other system variable (your `PATH`, `HOME`, and the like never
reach the app), and this allowlist is enforced in the native backend, not just
the UI:

| Group | Variables read from the OS environment |
| --- | --- |
| Provider / model overrides | `GEOLIBRE_ASSISTANT_PROVIDER`, `GEOLIBRE_ASSISTANT_MODEL` |
| Google Gemini | `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Ollama | `OLLAMA_BASE_URL`, `OLLAMA_MODEL` |
| Custom (OpenAI-compatible) | `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_MODEL` |
| Web search | `TAVILY_API_KEY` |

**Precedence:** a value you enter in **Settings → Environment Variables** always
wins; the OS environment only fills in the gaps. In the AI settings, any field
supplied by the environment shows a note naming the variable backing it — leave
that field blank to keep using the environment value.

!!! warning "Amazon Bedrock is not sourced from the OS environment"
    Bedrock's `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` credentials (and the
    ambient `OLLAMA_HOST`) are deliberately **excluded** from OS-environment
    reading: developers commonly have AWS credentials exported in their shell for
    unrelated work, and silently adopting them could auto-activate Bedrock and
    bill their AWS account for LLM calls they never intended. To use Bedrock,
    enter the credentials in **Settings → Environment Variables**.

!!! note "Desktop only"
    Reading OS environment variables requires the native backend, so it applies
    to the **desktop app** only. The browser and Jupyter builds cannot read the
    system environment; there, enter keys in **Settings → Environment Variables**
    (or bake them in at build time). Changes to OS variables are picked up on the
    next app launch.

## Using it

Type a request and press **Ctrl/Cmd + Enter** (or click **Send**). The
assistant streams its reply, runs tools as needed, and reports what it did. While
it is working, **Send** becomes **Stop** — click it to cancel. **Clear** (the
eraser icon) starts a fresh conversation.

```text
show me all parcels larger than 1 hectare within 500 m of a river
color the counties by population using a graduated red ramp
buffer the roads by 100 m, then clip them to the county boundary
load the latest Sentinel-2 scene over this view
zoom to Africa, then switch to a dark basemap
add an OpenTopoMap basemap
```

## What it can do

The assistant works by calling a fixed set of tools — it cannot invent
operations, so its actions stay within GeoLibre's validated surface.

| Capability | What it does |
| --- | --- |
| **Inspect layers** | Lists loaded layers, their geometry, attribute fields, and SQL table names (schema only — never your full data). |
| **NL → Spatial SQL** | Generates and runs a **read-only** DuckDB Spatial SQL query through the [SQL Workspace](sql-workspace.md), and can add the result as a layer. |
| **Geoprocessing** | Runs the registered [processing](processing.md) algorithms (buffer, clip, dissolve, intersection, difference, union, spatial join, simplify, H3 grids, …) and chains them into multi-step pipelines, adding each result as a layer. |
| **Symbology** | Applies a **graduated** (numeric) or **categorized** (text) color ramp to a layer. |
| **Add data** | Adds a layer from a public GeoJSON URL, or an XYZ tile basemap by name (`osm`, `opentopomap`, `carto-dark`) or a custom `{z}/{x}/{y}` URL. |
| **Earth observation** | Searches the Microsoft [Planetary Computer](https://planetarycomputer.microsoft.com) STAC catalog (Sentinel-2, Landsat, NAIP, DEMs, …) and adds an item over the current view as a raster layer — tiles are signed server-side, so no credentials are needed. |
| **Map control** | Moves the camera (fit a layer or a bounding box), switches the basemap, toggles layer visibility/opacity, and removes layers. |
| **Web search** | Looks up current information online (best with `TAVILY_API_KEY`). |
| **Code fallback** | For tasks with no dedicated tool, runs a small **JavaScript** snippet against the live map (e.g. globe projection) or a **Python** snippet in the [Pyodide runtime](python-console.md). |

## Sample prompts

Prompts are free-form — these are starting points, not fixed commands. Refer to
layers by name; the assistant looks up the rest. You can also chain steps in one
message ("buffer the roads by 100 m **and then** clip to the county boundary")
or keep refining across turns ("now color it by area").

**Explore & query**

```text
what layers are loaded, and what fields does the parcels layer have?
how many parcels are larger than 1 hectare?
list the 10 most populous counties with their population
show parcels within 500 m of a river and add them as a layer
count points in each polygon of the districts layer
```

**Geoprocessing & analysis**

```text
buffer the roads by 100 meters
buffer the roads by 100 m, then clip the buffer to the county boundary
dissolve the parcels by zoning type
find where the floodplain overlaps the buildings (intersection)
create an H3 hex grid at resolution 8 over the points and count points per cell
compute centroids of the counties and add them as a layer
```

**Symbology**

```text
color the counties by population with a graduated red ramp
style the parcels categorized by land-use type
shade the tracts by median income using a viridis ramp with 7 classes
```

**Add data & imagery**

```text
load the latest Sentinel-2 scene over this view
add the most recent cloud-free Landsat image for this area
search the Planetary Computer for NAIP imagery here
add an OpenTopoMap basemap
add this GeoJSON: https://example.com/data.geojson
```

**Map control & styling**

```text
zoom to the parcels layer
fly to San Francisco
switch to a dark basemap
hide the buildings layer and set the parcels opacity to 0.5
remove the temporary buffer layer
```

**Advanced (code fallback)**

```text
switch the map to a 3D globe projection
enable terrain with hillshade exaggeration of 1.5
load a CSV from a URL with pandas and summarize its columns
```

## Safety and privacy

- **Acts through the store.** Layer, style, basemap, and add/remove actions go
  through the same one-way data flow as the rest of the app, so they are
  reconciled consistently and covered by **undo/redo**.
- **Auditable.** The generated SQL and every tool call appear in the transcript.
- **Read-only SQL.** The `run_sql` tool rejects anything that isn't a `SELECT` /
  `WITH` query.
- **Scoped context.** Only layer/table **names**, attribute **field names**, and
  the current view are sent to the model — not your feature data.
- **What leaves your browser.** When you send a prompt, it (plus that scoped
  context) is sent to your chosen LLM provider using your own key. Don't enable
  the assistant on sensitive data you can't share with that provider.

!!! note "Code-execution caveat"
    The JavaScript and Python fallbacks execute model-generated code in the app
    to cover requests no dedicated tool handles. Their direct map changes bypass
    the store and are **not undoable**. The code is shown in the transcript.

## Limitations

- Requires a provider API key; offline use is not supported.
- Subject to each provider's cost, rate limits, and your network's CORS/CSP
  policy (browser-side calls).
- The unofficial Google Maps tile endpoints are intentionally **not** included;
  use the listed officially-supported basemaps or supply your own XYZ URL.
