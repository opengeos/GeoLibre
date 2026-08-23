# Agent skill

GeoLibre ships an **agent skill** — a `SKILL.md` that teaches an external AI
coding agent (Claude Code, Claude Desktop, or any runtime that loads skills) how
to build GeoLibre maps on your behalf.

It lives in the repository at
[`skills/geolibre/`](https://github.com/opengeos/GeoLibre/tree/main/skills/geolibre).

## What it is for

GeoLibre already has an in-app [AI Assistant](user-guide/ai-assistant.md), which
chats with your data *inside* the running app and applies changes through the
app's own store. The skill covers the other direction: an agent working
**outside** GeoLibre — in your terminal, your editor, or a notebook — that
should produce a GeoLibre map as its output.

| | AI Assistant | Agent skill |
| --- | --- | --- |
| Runs | Inside the app | In your agent, outside the app |
| Acts on | The live map you are looking at | A `.geolibre.json` file on disk |
| Needs | A configured AI provider | An agent that loads skills |
| Output | Edits you can undo with Ctrl/Cmd + Z | A project file and/or a standalone HTML page |

They compose: an agent authors the project, you open it in GeoLibre and keep
working with the Assistant.

## What it teaches

- **Which entry point to use** — the [MCP server](mcp.md) for a chat session,
  the [Python package](python.md) for notebooks and scripts, hand-written
  [project JSON](project-format.md) when nothing is installed, and the
  [embed API](user-guide/embedding.md) for a live instance in a page.
- **The authoring workflow** — create a project, add layers, frame the camera,
  style or classify, add a legend or colorbar, export a shareable HTML page.
- **The rules that are easy to get wrong** — that `classify_layer` needs inlined
  GeoJSON, that a local file path does not travel to a recipient, that a `bbox`
  resolves to a camera approximately, that basemap and color-ramp names should
  come from `list_catalog` rather than a guess, and that `export_html`'s
  `app_url` is a trust boundary.

## Install

```bash
git clone --depth 1 https://github.com/opengeos/GeoLibre /tmp/geolibre
mkdir -p ~/.claude/skills
cp -r /tmp/geolibre/skills/geolibre ~/.claude/skills/
```

Use `.claude/skills/` inside a project instead of `~/.claude/skills/` to scope
it to one repository. Start a new agent session afterwards; the skill loads
itself when a request matches.

For the shortest path, install the MCP server the skill prefers:

```bash
pip install "geolibre[mcp]"
claude mcp add geolibre -- geolibre-mcp --root ~/maps
```

The skill still works without it — it falls back to the Python API and to
writing project JSON directly.

## Other agent runtimes

`SKILL.md` is plain Markdown with YAML frontmatter, so most agent runtimes that
support skills can load it as-is. If yours has no skill loader, paste the file
into your system prompt or `AGENTS.md` — it is written to stand on its own, and
its `references/` files are only read when a task needs them.
