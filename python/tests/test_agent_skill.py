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
# A snake_case name that reads like an operation, so an agent could take it for
# a tool call: `add_geojson_layer`, `set_view`, `classify_layer`.
OPERATION = re.compile(
    r"^(add|set|list|run|classify|remove|update|style|export|create|describe)_[a-z0-9_]+$"
)
# The docs an agent reads while driving the MCP server. python-api.md is
# deliberately absent: it documents the Python API, where these names are real.
MCP_FACING = ("SKILL.md", "references/mcp-tools.md", "references/catalog.md")


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


def parameters(node: ast.FunctionDef) -> list[tuple[str, str | None]]:
    """Return a function's parameters as ``(name, default source)`` pairs.

    Annotations are dropped: the reference documents call shapes for an agent,
    not Python types, so it writes ``zoom=None`` where the server writes
    ``zoom: float | None = None``.

    Every parameter kind is represented, including the ``/`` and ``*``
    separators and ``*args``/``**kwargs``. No tool uses anything but plain
    positional-or-keyword parameters today, and reading only ``args`` would work
    — right up until the first tool takes a keyword-only argument, which this
    comparison would then silently ignore while claiming to check the signature.

    Args:
        node: The parsed function definition.

    Returns:
        One pair per parameter, in signature order, with ``None`` as the default
        for a parameter that has none. Separators appear as their own entries.
    """
    args = node.args
    collected: list[tuple[str, str | None]] = []

    def pair(arg: ast.arg, default: ast.expr | None) -> tuple[str, str | None]:
        return (arg.arg, ast.unparse(default) if default is not None else None)

    # `defaults` covers the tail of posonlyargs + args together.
    positional = args.posonlyargs + args.args
    defaults: list[ast.expr | None] = [None] * (len(positional) - len(args.defaults))
    defaults += list(args.defaults)
    for index, (arg, default) in enumerate(zip(positional, defaults, strict=True)):
        collected.append(pair(arg, default))
        if args.posonlyargs and index == len(args.posonlyargs) - 1:
            collected.append(("/", None))

    if args.vararg:
        collected.append((f"*{args.vararg.arg}", None))
    elif args.kwonlyargs:
        collected.append(("*", None))
    for arg, kw_default in zip(args.kwonlyargs, args.kw_defaults, strict=True):
        collected.append(pair(arg, kw_default))

    if args.kwarg:
        collected.append((f"**{args.kwarg.arg}", None))
    return collected


def mcp_tool_signatures() -> dict[str, list[tuple[str, str | None]]]:
    """Return every tool the MCP server registers, with its parameters.

    Parsed from the source rather than imported, so the check runs without the
    optional ``mcp`` SDK installed.

    Returns:
        A mapping of ``@server.tool()`` function name to its parameters.
    """
    source = (Path(mcp_package.__file__).parent / "server.py").read_text(encoding="utf-8")
    return {
        node.name: parameters(node)
        for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.FunctionDef)
        and any("server.tool" in ast.unparse(d) for d in node.decorator_list)
    }


def mcp_tool_names() -> set[str]:
    """Return the names of every tool the MCP server registers.

    Returns:
        The set of ``@server.tool()`` function names.
    """
    return set(mcp_tool_signatures())


def documented_signatures() -> dict[str, list[tuple[str, str | None]]]:
    """Parse the tool reference's signature blocks.

    A signature wraps across lines in the Markdown, so a line starting at column
    zero opens a new one and an indented line continues the previous.

    Returns:
        A mapping of documented tool name to its parameters.
    """
    blocks = re.findall(r"^```text\n(.*?)^```", read("references/mcp-tools.md"), re.M | re.S)
    signatures: list[str] = []
    for line in "\n".join(blocks).splitlines():
        if SIGNATURE.match(line):
            signatures.append(line)
        elif signatures and line.strip():
            signatures[-1] += " " + line.strip()
    parsed = {}
    for signature in signatures:
        # Wrapping the signature in a `def` is what lets ast do the parsing,
        # so a malformed one fails here rather than being quietly skipped.
        node = ast.parse(f"def {signature}: pass").body[0]
        assert isinstance(node, ast.FunctionDef)
        parsed[node.name] = parameters(node)
    return parsed


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
    """The reference's signature blocks match the server's tools, parameters included.

    The tool *set* is checked in both directions on purpose: a missing name is a
    new tool an agent will never learn about, an extra one is a call the server
    can no longer answer. Each tool's parameter names, order, and defaults are
    then diffed too, so renaming or reordering an argument in `server.py`
    without updating the reference fails here rather than reaching an agent as a
    call the server rejects.
    """
    documented = documented_signatures()
    server = mcp_tool_signatures()
    assert set(documented) == set(server)
    mismatched = {
        name: {"documented": documented[name], "server": server[name]}
        for name in sorted(documented)
        if documented[name] != server[name]
    }
    assert not mismatched, f"documented signatures have drifted: {mismatched}"


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
    assert on_map, "no Map calls found in the skill's prose — the scan is broken"
    assert not sorted(bare - tools), f"the skill names MCP tools that do not exist: {bare - tools}"
    missing = sorted(name for name in on_map if not hasattr(Map, name))
    assert not missing, f"the skill names Map methods that do not exist: {missing}"


def test_mcp_facing_docs_do_not_name_python_only_methods() -> None:
    """An operation named in the MCP docs is a tool, or is qualified as ``Map.``.

    `Map` carries methods with no MCP tool behind them — `add_choropleth`,
    `add_csv`, `run_algorithm`. Unqualified next to real tool names, they read
    as tools an agent can call, and the server rejects them as unknown. The
    convention is to write those as `Map.add_choropleth`, and this enforces it.
    """
    tools = mcp_tool_names()
    for name in MCP_FACING:
        prose = FENCE.sub("", read(name))
        named = {identifier.split("(", 1)[0] for identifier in BACKTICKED.findall(prose)}
        unqualified = sorted(n for n in named if OPERATION.fullmatch(n) and n not in tools)
        assert not unqualified, (
            f"{name} names {unqualified} as if it were an MCP tool; "
            "write it as `Map.<name>` if it is Python-only"
        )


def test_qualified_map_references_exist() -> None:
    """Every ``Map.<name>`` the skill writes is a real method on ``Map``."""
    named: set[str] = set()
    for path in sorted((SKILL_DIR / "references").glob("*.md")) + [SKILL_DIR / "SKILL.md"]:
        text = path.read_text(encoding="utf-8")
        named.update(match.group(1) for match in re.finditer(r"\bMap\.([a-z_][a-z0-9_]*)", text))
    assert named, "no `Map.<name>` references found — the scan is broken"
    missing = sorted(name for name in named if not hasattr(Map, name))
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
