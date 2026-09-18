# Agent skills

Skills that teach an AI coding agent to **use** GeoLibre — to build maps with
it, from a chat session, a script, or a notebook. They are for people driving
GeoLibre from an external agent, not for people working on GeoLibre's own source
(that is what the repo's `CLAUDE.md` covers).

| Skill | What it teaches |
| --- | --- |
| [`geolibre/`](geolibre/SKILL.md) | Author `.geolibre.json` projects: pick an entry point (`geolibre-mcp`, the Python package, hand-written JSON, the embed API), add and style layers, add legends and colorbars, and export a standalone HTML page. |

## Install

A skill is a directory with a `SKILL.md` at its root. Copy the one you want into
your agent's skills directory.

**Claude Code / Claude Desktop** — personal (all projects):

```bash
git clone --depth 1 https://github.com/opengeos/GeoLibre /tmp/geolibre
mkdir -p ~/.claude/skills
cp -r /tmp/geolibre/skills/geolibre ~/.claude/skills/
```

Or per-project, so it ships with a repo that builds maps:

```bash
mkdir -p .claude/skills
cp -r /tmp/geolibre/skills/geolibre .claude/skills/
```

Restart the agent, or start a new session, and it loads the skill on its own
when a request matches the `description` in the frontmatter.

**Other agents** — the format is plain Markdown with YAML frontmatter (`name`,
`description`), so most agent runtimes that support skills, or a project-level
instructions file, can consume it. If yours has no skill loader, paste
`SKILL.md` into your system prompt or `AGENTS.md`; it is written to stand on its
own, with the `references/` files loaded only when a task needs them.

## Companion setup

The skill's primary path is the MCP server, which ships with the Python package:

```bash
pip install "geolibre[mcp]"
claude mcp add geolibre -- geolibre-mcp --root ~/maps
```

It works without that — it falls back to the Python API and to writing project
JSON directly — but the MCP tools are the shortest route.

## Keeping it accurate

The skill mirrors things that live elsewhere in this repo: the MCP tool surface
(`python/src/geolibre/mcp/server.py`), the basemap and color-ramp catalogs
(`python/src/geolibre/basemaps.py`, `color_ramp.py`, `legends.py`), the project
schema (`docs/project-format.md`), and the embed parameters
(`docs/user-guide/embedding.md`). `python/tests/test_agent_skill.py` fails on
drift in the mechanical parts — tool names, `Map` methods, and the basemap,
color-ramp, legend-preset and layer-type lists. Prose it cannot check, so a
changed limit or caveat still has to be carried over by hand, in the same PR as
the change.
