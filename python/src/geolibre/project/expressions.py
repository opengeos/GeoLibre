"""Filter expressions and floor-level filters."""

from __future__ import annotations

import json
import math
import re
from decimal import Decimal
from typing import Any, Iterable

#: Expression operators that can produce a boolean, which is what the app's
#: ``filterExpression`` must evaluate to (``normalizeLayer`` in
#: ``packages/core/src/project.ts`` validates it with ``expectedType:
#: "boolean"`` and silently drops anything else on load). The app's validator is
#: the authority; this is the structural pre-check that catches the common
#: mistakes (a bare property name, a numeric expression) before they are saved
#: and quietly discarded.
FILTER_EXPRESSION_OPERATORS = frozenset(
    {
        "==",
        "!=",
        "<",
        "<=",
        ">",
        ">=",
        "!",
        "all",
        "any",
        "in",
        "has",
        "!has",
        "within",
        "boolean",
        "to-boolean",
    }
)


#: Operators whose result type is whichever branch they return, mapped to the
#: indexes of those branches (``None`` for "the last argument"). A filter built
#: from one is boolean only when every branch is.
_POLYMORPHIC_OPERATORS = {"case", "match", "coalesce", "let"}


def _polymorphic_branches(expression: list[Any]) -> list[Any]:
    """Return the branches a ``case``/``match``/``coalesce``/``let`` can yield.

    Args:
        expression: An expression whose head is in ``_POLYMORPHIC_OPERATORS``.

    Returns:
        The argument expressions the result is taken from.
    """
    head, args = expression[0], expression[1:]
    if head == "case":
        # [cond, out, cond, out, ..., fallback]
        return [*args[1:-1:2], args[-1]] if args else []
    if head == "match":
        # [input, labels, out, labels, out, ..., fallback]
        return [*args[2:-1:2], args[-1]] if len(args) > 1 else []
    if head == "let":
        return args[-1:]
    return list(args)


def _yields_boolean(value: Any) -> bool:
    """Whether an expression (or literal) can only produce a boolean.

    Args:
        value: An expression array or a literal.

    Returns:
        ``True`` for a boolean literal, a boolean operator, or a polymorphic
        operator all of whose branches yield booleans.
    """
    if isinstance(value, bool):
        return True
    if not isinstance(value, list) or not value or not isinstance(value[0], str):
        return False
    if value[0] in FILTER_EXPRESSION_OPERATORS:
        return True
    if value[0] in _POLYMORPHIC_OPERATORS:
        branches = _polymorphic_branches(value)
        return bool(branches) and all(_yields_boolean(branch) for branch in branches)
    return False


def _parse_expression(expression: Any, what: str) -> list[Any]:
    """Coerce a MapLibre expression given as a list or a JSON string to a list.

    Args:
        expression: A list, or a JSON string encoding one.
        what: The argument name, for error messages.

    Returns:
        The expression as a non-empty list whose head is an operator string.

    Raises:
        ValueError: If the value is not a JSON array expression.
    """
    try:
        return _parse_expression_checked(expression, what)
    except RecursionError as exc:
        raise ValueError(f"{what} is nested too deeply") from exc


def _parse_expression_checked(expression: Any, what: str) -> list[Any]:
    """Do the work of :func:`_parse_expression` (which guards recursion depth).

    Args:
        expression: A list, or a JSON string encoding one.
        what: The argument name, for error messages.

    Returns:
        The expression as a JSON-clean list.

    Raises:
        ValueError: If the value is not a JSON array expression.
    """
    if isinstance(expression, str):
        try:
            expression = json.loads(expression)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{what} is not valid JSON: {exc.msg}") from exc
    if isinstance(expression, tuple):
        expression = list(expression)
    if not isinstance(expression, list) or not expression:
        raise ValueError(
            f"{what} must be a MapLibre expression array such as "
            '[">=", ["get", "population"], 100000]'
        )
    if not isinstance(expression[0], str):
        raise ValueError(f"{what} must start with an operator string, got {expression[0]!r}")
    try:
        return json.loads(json.dumps(expression, allow_nan=False))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{what} must be JSON-serializable: {exc}") from exc


def filter_expression(expression: Any) -> list[Any]:
    """Build a layer's persistent ``filterExpression``.

    Args:
        expression: A boolean MapLibre expression, as a list or a JSON string,
            e.g. ``[">=", ["get", "population"], 100000]``.

    Returns:
        The expression as a list, ready for the layer's ``filterExpression``.

    Raises:
        ValueError: If the expression is not an array, or its operator cannot
            produce a boolean.
    """
    parsed = _parse_expression(expression, "filter expression")
    try:
        yields_boolean = _yields_boolean(parsed)
    except RecursionError as exc:
        raise ValueError("filter expression is nested too deeply") from exc
    if not yields_boolean:
        raise ValueError(
            f"a layer filter must evaluate to true/false; this {parsed[0]!r} does not. "
            "Use a comparison such as ['==', ['get', 'field'], 'value'] or combine "
            "several with 'all' / 'any'"
        )
    return parsed


#: Mirror of ``LevelFilterMode`` in ``packages/core/src/types.ts``.
LEVEL_FILTER_MODES = ("all", "only", "below")


# ASCII digits only, as in the app's JavaScript `\d` (Python's `\d` also
# matches other scripts' digits, which the app reads as named floors).
_LEVEL_NUMBER = re.compile(r"^-?[0-9]+(?:\.[0-9]+)?$")


_LEVEL_RANGE = re.compile(r"^(-?[0-9]+(?:\.[0-9]+)?)\s*-\s*(-?[0-9]+(?:\.[0-9]+)?)$")


#: A span wider than this is read as its two ends (``MAX_RANGE_STEPS`` in level-filter.ts).
_LEVEL_MAX_RANGE_STEPS = 200


def _level_label(value: float) -> str:
    """Format a floor number exactly as JavaScript's ``String(number)`` does.

    The app labels floors with ``String(number)``, so a label written here must
    match it byte for byte, including where the two languages switch to
    exponent notation (JavaScript: below 1e-6 or from 1e21; Python's ``repr``:
    below 1e-4 or from 1e16).

    Args:
        value: A finite floor number.

    Returns:
        The label JavaScript would produce.
    """
    number = float(value)
    if math.isinf(number):  # a numeric text too long for a double
        return "Infinity" if number > 0 else "-Infinity"
    if number == 0:
        return "0"
    magnitude = abs(number)
    if 1e-6 <= magnitude < 1e21:
        if number.is_integer():
            return str(int(number))
        # Shortest round-trip digits, in plain positional notation.
        return format(Decimal(repr(number)), "f")
    # repr uses exponent notation below 1e-4 and from 1e16, so both ranges here have one.
    mantissa, _, exponent = repr(number).partition("e")
    mantissa = mantissa.removesuffix(".0")
    exp = int(exponent)
    return f"{mantissa}e{'+' if exp >= 0 else '-'}{abs(exp)}"


def parse_level_value(raw: Any) -> list[tuple[str, float | None]]:
    """Parse one level attribute into the floors it names.

    Mirrors ``parseLevelValue`` in ``packages/core/src/level-filter.ts``:
    numbers are taken as they are; text is split on ``;`` (OpenStreetMap's list
    separator) and each part read as a number, an integer span such as ``0-2``
    (every floor it covers), or a named floor such as ``G``.

    Args:
        raw: The attribute value.

    Returns:
        ``(label, ordinal)`` pairs; ``ordinal`` is ``None`` for a named floor.
    """
    if isinstance(raw, bool):
        return []
    if isinstance(raw, (int, float)):
        try:
            number = float(raw)
        except OverflowError:  # an integer too large for a double: no floor, as in the app
            return []
        return [(_level_label(number), number)] if math.isfinite(number) else []
    if not isinstance(raw, str):
        return []
    tokens: list[tuple[str, float | None]] = []
    for part in raw.split(";"):
        text = part.strip()
        if not text:
            continue
        if _LEVEL_NUMBER.match(text):
            tokens.append((_level_label(float(text)), float(text)))
            continue
        span = _LEVEL_RANGE.match(text)
        if span:
            lo, hi = sorted((float(span.group(1)), float(span.group(2))))
            if lo.is_integer() and hi.is_integer() and hi - lo <= _LEVEL_MAX_RANGE_STEPS:
                tokens.extend((_level_label(v), float(v)) for v in range(int(lo), int(hi) + 1))
            else:
                tokens.extend([(_level_label(lo), lo), (_level_label(hi), hi)])
            continue
        tokens.append((text, None))
    return tokens


def level_value_matches(raw: Any, level: str, mode: str) -> bool:
    """Whether a feature's level attribute falls on the chosen floor.

    Args:
        raw: The feature's level attribute.
        level: The chosen floor's label, e.g. ``"0"``.
        mode: ``"only"`` for that floor, ``"below"`` for it and every numbered
            floor under it, ``"all"`` for everything.

    Returns:
        True when the feature is drawn.
    """
    if mode == "all":
        return True
    text = level.strip()
    target = float(text) if _LEVEL_NUMBER.match(text) else None
    label = text if target is None else _level_label(target)
    for token_label, ordinal in parse_level_value(raw):
        if token_label == label:
            return True
        if mode == "below" and target is not None and ordinal is not None and ordinal <= target:
            return True
    return False


def level_filter(
    field: str,
    level: Any = None,
    *,
    mode: str | None = None,
    features: Iterable[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build a layer's floor picker link (``levelFilter``).

    Args:
        field: The feature property holding the floor, e.g. ``"level"``.
        level: The floor to show (``"0"``, ``-1``), or ``None`` for every floor.
        mode: ``"only"`` (the default once a level is given) or ``"below"`` to
            also show the floors under it.
        features: The layer's features, used to resolve the raw values that
            match. Without them the link is saved unresolved and the app
            resolves it once it has the layer's features (a local file it
            re-reads); a layer whose features the app never holds (vector
            tiles) is not narrowed.

    Returns:
        The ``levelFilter`` record.

    Raises:
        ValueError: If the field is blank or the mode is unknown.
    """
    if not isinstance(field, str) or not field.strip():
        raise ValueError("the floor field must be a non-empty property name")
    if level is None or mode == "all":
        # "all" draws every floor whatever the level, as the app's selectLevel does.
        if level is None and mode not in (None, "all"):
            raise ValueError("choose a level for the 'only' and 'below' modes")
        return {"field": field, "mode": "all", "level": None}
    if isinstance(level, bool) or not isinstance(level, (str, int, float)):
        raise ValueError(f"a floor level must be text or a number, got {level!r}")
    if isinstance(level, (int, float)):
        try:
            finite = math.isfinite(float(level))
        except OverflowError:
            finite = False
        if not finite:
            raise ValueError(f"a floor level must be a finite number, got {level!r}")
    label = level.strip() if isinstance(level, str) else _level_label(level)
    if not label:
        raise ValueError("a floor level must not be blank")
    if _LEVEL_NUMBER.match(label):
        label = _level_label(float(label))
    mode = mode or "only"
    if mode not in ("only", "below"):
        raise ValueError(f"mode must be one of {LEVEL_FILTER_MODES}, got {mode!r}")
    link: dict[str, Any] = {"field": field, "mode": mode, "level": label}
    if features is not None:
        values: list[Any] = []
        seen: set[Any] = set()
        for feature in features:
            raw = (feature.get("properties") or {}).get(field)
            if isinstance(raw, bool) or not isinstance(raw, (str, int, float)):
                continue
            key = (type(raw) is str, raw)
            if key in seen:
                continue
            seen.add(key)
            if level_value_matches(raw, label, mode):
                values.append(raw)
        link["values"] = values
    return link
