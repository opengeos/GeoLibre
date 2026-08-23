"""Drift checks for the user-facing agent skill in ``skills/geolibre``.

The skill restates things that live in code: the MCP server's tool surface and
the basemap / color-ramp / legend catalogs. Nothing else checks that copy, and a
stale skill fails silently — an agent calls a tool that no longer exists, or
names a basemap the app never had, with no build error anywhere. These tests are
that check.

They skip when the skill directory is absent, so an sdist or wheel install (which
ships only the package) stays green.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

import geolibre.mcp as mcp_package
from geolibre import Map
from geolibre.authoring import color_ramp_names
from geolibre.basemaps import BASEMAPS
from geolibre.legends import builtin_legend_names

SKILL_DIR = Path(__file__).resolve().parents[2] / "skills" / "geolibre"

pytestmark = pytest.mark.skipif(
    not SKILL_DIR.is_dir(), reason="the agent skill ships in the repo, not in the package"
)

# Inline code, one span at a time. `[^`\n]` rather than `[^`]` so an unbalanced
# backtick cannot swallow the rest of the document, and fenced blocks are
# stripped by FENCE first — three-backtick fences otherwise shift the pairing of
# every inline span after them, which silently emptied this scan.
BACKTICKED = re.compile(r"`([^`\n]+)`")
FENCE = re.compile(r"^```.*?^```", re.M | re.S)
# A tool name opening a line inside a signature block.
SIGNATURE = re.compile(r"^([a-z_][a-z0-9_]*)\(", re.M)


def read(name: str) -> str:
    """Read a file from the skill directory.

    Args:
        name: Path relative to ``skills/geolibre``.

    Returns:
        The file's text.
    """
    return (SKILL_DIR / name).read_text(encoding="utf-8")


def section(markdown: str, heading: str) -> str:
    """Return the body of one ``##`` section of a Markdown document.

    Args:
        markdown: The full document text.
        heading: The section's heading text, without the leading hashes.

    Returns:
        Everything between that heading and the next heading of the same or a
        higher level.
    """
    pattern = re.compile(
        rf"^(#{{2,3}}) {re.escape(heading)}\s*$(.*?)(?=^#{{1,3}} |\Z)", re.M | re.S
    )
    match = pattern.search(markdown)
    assert match, f"no '## {heading}' section found"
    return match.group(2)


def table_keys(body: str) -> set[str]:
    """Collect the backticked identifier in the first column of each table row.

    Args:
        body: A Markdown fragment containing a pipe table.

    Returns:
        The set of first-column identifiers, ignoring header and rule rows.
    """
    return {
        match.group(1)
        for line in body.splitlines()
        if (match := re.match(r"^\|\s*`([^`]+)`\s*\|", line))
    }


def mcp_tool_names() -> set[str]:
    """Return the names of every tool the MCP server registers.

    Parsed from the source rather than imported, so the check runs without the
    optional ``mcp`` SDK installed.

    Returns:
        The set of ``@server.tool()`` function names.
    """
    source = (Path(mcp_package.__file__).parent / "server.py").read_text(encoding="utf-8")
    return {
        node.name
        for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.FunctionDef)
        and any("server.tool" in ast.unparse(d) for d in node.decorator_list)
    }


def test_skill_frontmatter_is_well_formed() -> None:
    """SKILL.md carries the ``name``/``description`` frontmatter loaders require."""
    text = read("SKILL.md")
    assert text.startswith("---\n")
    parts = text.split("---\n", 2)
    assert len(parts) == 3, "the frontmatter block must be closed with ---"
    frontmatter = parts[1]
    assert re.search(r"^name: geolibre\s*$", frontmatter, re.M), "name must match the directory"
    assert re.search(r"^description:", frontmatter, re.M)
    # The description is the only thing a loader sees when deciding to load the
    # skill, so it has to carry enough trigger surface to be matched at all.
    assert len(frontmatter.split("description:", 1)[1].strip()) > 200


def test_documented_signatures_match_the_server_exactly() -> None:
    """The tool reference's signature blocks are the server's tool set, both ways.

    Checked in both directions on purpose: a missing name means a new tool an
    agent will never learn about, and an extra one means the reference documents
    a call the server can no longer answer.
    """
    blocks = re.findall(r"^```text\n(.*?)^```", read("references/mcp-tools.md"), re.M | re.S)
    documented = set(SIGNATURE.findall("\n".join(blocks)))
    assert documented == mcp_tool_names()


def test_skill_names_no_tool_that_does_not_exist() -> None:
    """Every call the skill's prose names exists, as an MCP tool or on ``Map``.

    The two are kept apart rather than accepting either: a bare ``tool(...)``
    must be an MCP tool even if ``Map`` happens to carry a method by that name,
    since the prose around it is telling an agent to call the server.
    """
    tools = mcp_tool_names()
    bare: set[str] = set()
    on_map: set[str] = set()
    for name in ("SKILL.md", "references/mcp-tools.md"):
        for identifier in BACKTICKED.findall(FENCE.sub("", read(name))):
            if not identifier.endswith(")"):
                continue
            base, _, args = identifier[:-1].partition("(")
            # Real call sites are `list_catalog()` or `set_view(bbox=...)`;
            # requiring empty-or-keyword arguments keeps prose shorthand such as
            # `http(s)` from reading as a call.
            if args and "=" not in args:
                continue
            if re.fullmatch(r"[a-z_][a-z0-9_]*", base):
                bare.add(base)
            elif re.fullmatch(r"m\.[a-z_][a-z0-9_]*", base):
                on_map.add(base[2:])
    # Both scans were silently empty once (see FENCE); fail loudly if that recurs.
    assert bare, "no tool calls found in the skill's prose — the scan is broken"
    assert not sorted(bare - tools), f"the skill names MCP tools that do not exist: {bare - tools}"
    missing = sorted(name for name in on_map if not hasattr(Map, name))
    assert not missing, f"the skill names Map methods that do not exist: {missing}"


def test_basemap_catalog_matches() -> None:
    """The skill's basemap table matches the shipped basemap names."""
    listed = table_keys(section(read("references/catalog.md"), "Basemaps"))
    assert listed == set(BASEMAPS)


def test_color_ramp_catalog_matches() -> None:
    """The skill's color-ramp list matches the shipped ramps."""
    body = section(read("references/catalog.md"), "Color ramps")
    listed: set[str] = set()
    for line in body.splitlines():
        if "·" in line:
            listed.update(BACKTICKED.findall(line))
    assert listed == set(color_ramp_names())


def test_legend_preset_catalog_matches() -> None:
    """The skill's legend-preset table matches the built-in presets."""
    listed = table_keys(section(read("references/catalog.md"), "Legend presets"))
    assert listed == set(builtin_legend_names())


def test_python_api_reference_is_real() -> None:
    """Every ``Map`` method the Python reference shows exists on ``Map``."""
    text = read("references/python-api.md")
    # Every `m.<name>` the reference shows, whether it is called (`m.fly_to(...)`),
    # a property (`m.layers`), or trailed by a comment. An earlier version
    # required either a `(` or the end of the line, which silently skipped
    # `m.layers  # ...` and `m.user_rois` mid-line — exactly the names a rename
    # would break. Reference examples always spell the receiver `m.`, so
    # requiring that prefix is what keeps this from matching prose.
    named = {match.group(1) for match in re.finditer(r"\bm\.([a-z_][a-z0-9_]*)\b", text)}
    missing = sorted(name for name in named if not hasattr(Map, name))
    assert not missing, f"the skill documents Map methods that do not exist: {missing}"


def test_layer_types_match_the_project_format_doc() -> None:
    """The skill's layer-type list matches ``docs/project-format.md``."""
    docs = (SKILL_DIR.parents[1] / "docs" / "project-format.md").read_text(encoding="utf-8")
    canonical = table_keys(section(docs, "Layer types"))
    assert canonical, "no layer-type table found in docs/project-format.md"
    for name in ("references/catalog.md", "references/project-json.md"):
        listed: set[str] = set()
        for line in section(read(name), "Layer types").splitlines():
            listed.update(BACKTICKED.findall(line))
        assert listed == canonical, f"{name} lists layer types that have drifted"


def test_references_are_all_linked_and_present() -> None:
    """Every reference file exists and is pointed at from SKILL.md."""
    skill = read("SKILL.md")
    files = sorted(p.name for p in (SKILL_DIR / "references").glob("*.md"))
    assert files, "the skill has no reference files"
    for name in files:
        # As inline code, the convention SKILL.md uses, rather than any raw
        # occurrence: a bare substring check would still pass if an edit left
        # the path behind in prose after dropping the pointer itself.
        assert f"`references/{name}`" in skill, (
            f"references/{name} is never pointed at from SKILL.md"
        )
