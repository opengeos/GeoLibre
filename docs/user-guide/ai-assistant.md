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
providers in **Settings → Environment** as environment variables:

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

## Using it

Type a request and press **Ctrl/Cmd + Enter** (or click **Send**). The
assistant streams its reply, runs tools as needed, and reports what it did. While
it is working, **Send** becomes **Stop** — click it to cancel. **Clear** (the
eraser icon) starts a fresh conversation.

```text
show me all parcels larger than 1 hectare within 500 m of a river
color the counties by population using a graduated red ramp
buffer the roads by 100 m and add the result as a layer
zoom to Africa, then switch to a dark basemap
add an Esri World Imagery basemap
```

## What it can do

The assistant works by calling a fixed set of tools — it cannot invent
operations, so its actions stay within GeoLibre's validated surface.

| Capability | What it does |
| --- | --- |
| **Inspect layers** | Lists loaded layers, their geometry, attribute fields, and SQL table names (schema only — never your full data). |
| **NL → Spatial SQL** | Generates and runs a **read-only** DuckDB Spatial SQL query through the [SQL Workspace](sql-workspace.md), and can add the result as a layer. |
| **Symbology** | Applies a **graduated** (numeric) or **categorized** (text) color ramp to a layer. |
| **Add data** | Adds a layer from a public GeoJSON URL, or an XYZ tile basemap by name (`esri-imagery`, `esri-topo`, `osm`, `opentopomap`, `carto-dark`) or a custom `{z}/{x}/{y}` URL. |
| **Map control** | Moves the camera (fit a layer or a bounding box), switches the basemap, toggles layer visibility/opacity, and removes layers. |
| **Web search** | Looks up current information online (best with `TAVILY_API_KEY`). |
| **Code fallback** | For tasks with no dedicated tool, runs a small **JavaScript** snippet against the live map (e.g. globe projection) or a **Python** snippet in the [Pyodide runtime](python-console.md). |

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
